import { execFileSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProjectCwd } from '../config/config';
import { scienceExportDir } from '../config/paths';

/**
 * Discover the raw coding-agent session files that touched a given project, so a caller can
 * upload them (deduped by session id) for browsing.
 *
 * tanka-wm's session-discovery core. It started as a port of the work-memory Electron
 * prototype's discovery module and has since forked to fit this bun CLI — the 'all'-mode
 * helpers below (discoverAllSessions / syntheticProjectFor) are this project's own additions.
 *
 * Claude Code stores per-project sessions under ~/.claude/projects/<encoded-cwd>/ (the dir name
 * is the absolute cwd with every non-alphanumeric char turned into a dash). Discovery is
 * exact-only: a session counts iff its cwd is EXACTLY one of the roots (each registered cwd plus
 * its git worktrees), so we open only the encoded dir of each root and never a root's
 * subdirectories. A session run in a subdirectory surfaces on its own — under that subdir's cwd —
 * not folded into an ancestor.
 *
 * Codex stores rollouts under ~/.codex/sessions/<date>/<rollout>.jsonl — no per-cwd dir to key on,
 * so we probe every rollout's head for session_meta.payload.{cwd,id} and keep the exact-cwd matches.
 *
 * Claude Cowork (Claude Code running in a Claude Desktop sandbox) stores sessions under Claude
 * Desktop's appData dir (macOS ~/Library/Application Support, Windows %APPDATA%, Linux ~/.config)
 * in Claude/local-agent-mode-sessions/ as .../local_<uuid>/ dirs, each beside a local_<uuid>.json
 * metadata file. The transcript's own cwd is a throwaway sandbox path,
 * so we scope on the metadata's userSelectedFolders[] (overlapping a registered root in either
 * direction) and upload the session's local_<uuid>/audit.jsonl.
 *
 * Dedup is per (agent, id) — a session that shows up under multiple match-paths only counts once.
 */

export type SessionAgent =
  | 'claude-code'
  | 'codex'
  | 'cowork'
  | 'claude-science';

/**
 * claude-science sessions have no working directory — they live in an org's
 * SQLite DB (org → project → session), not on a cwd. We encode a science
 * project as a synthetic cwd so it can flow through the whole cwd-keyed
 * pipeline (config.cwds, project-map, sync) unchanged. Format:
 *
 *   claude-science://<org_id>/<proj_id>
 *
 * The `//` matters: `claude-science://x` is NOT an absolute path, so
 * `path.resolve()` mangles it into `<process.cwd()>/claude-science:/x`
 * (collapsing `//` → `/`). That collapse is a deterministic fingerprint of a
 * leaked `path.resolve` — `project-map` asserts against it on write. Every
 * cwd-as-directory touchpoint (worktree folding, fs probes, git) must branch
 * on `isScienceCwd` and skip the directory logic; a science session already
 * carries its project attribution and never needs path matching.
 */
export const SCIENCE_CWD_PREFIX = 'claude-science://';

export function isScienceCwd(cwd: string): boolean {
  return cwd.startsWith(SCIENCE_CWD_PREFIX);
}

/** Build the synthetic cwd for an org/project pair. */
export function scienceCwd(orgId: string, projId: string): string {
  return `${SCIENCE_CWD_PREFIX}${orgId}/${projId}`;
}

/**
 * Parse a science cwd back into its org/project ids, or null if malformed.
 * Strict on purpose — this doubles as the input validator for user-supplied
 * cwds (migrate --cwd): a projId containing '/' (e.g. a shell-completion
 * trailing slash) would bind a project-map key that discovery's canonical
 * `scienceCwd(org, proj)` form can never match, silently re-routing uploads.
 */
export function parseScienceCwd(
  cwd: string,
): { orgId: string; projId: string } | null {
  if (!isScienceCwd(cwd)) return null;
  const rest = cwd.slice(SCIENCE_CWD_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const projId = rest.slice(slash + 1);
  if (projId.includes('/')) return null; // trailing slash / extra segments
  return { orgId: rest.slice(0, slash), projId };
}

export interface SidecarFile {
  /** path relative to the sidecar dir, POSIX "/"-separated (e.g. "subagents/agent-a1.jsonl") */
  relPath: string;
  /** absolute path on disk */
  absPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SessionRef {
  /** session/rollout id — the dedup key */
  id: string;
  agent: SessionAgent;
  /** absolute path to the session .jsonl */
  path: string;
  /** cwd the session ran in (best-effort) */
  cwd: string;
  sizeBytes: number;
  mtimeMs: number;
  /**
   * Config snapshot the session recorded for itself — model, agent version, git branch, start
   * time, … (best-effort, extracted from the file's head). Values are strings; absent keys are
   * omitted.
   */
  meta: Record<string, string>;
  /**
   * Files in the sibling <id>/ sidecar dir Claude Code writes next to the transcript — subagent
   * transcripts (subagents/agent-*.jsonl) and spilled large tool outputs (tool-results/*).
   * Empty when there's no sidecar dir (and always empty for Codex / Cowork).
   */
  sidecarFiles: SidecarFile[];
}

const HEAD_BYTES = 64 * 1024;

function readHead(file: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * How Claude Code names a project's session dir: every non-alphanumeric char in the absolute cwd
 * collapses to '-'. That's path separators *and* the drive colon, dots, underscores, spaces, and
 * non-ASCII like CJK — e.g. `C:\数据\工作\dyj\dyj_autotest` → `C--------dyj-dyj-autotest`. Mirrors
 * Claude Code's own `cwd.replace(/[^a-zA-Z0-9]/g, '-')`; only swapping separators (the old rule)
 * never matched on Windows or any non-ASCII path.
 */
export function claudeEncodedDir(absCwd: string): string {
  return absCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Case-fold a path for comparison. Windows paths (drive letters especially) are case-insensitive,
 * and Claude Code logs a cwd's drive letter inconsistently — the same session can record both
 * `d:\…` and `D:\…` minutes apart — so on Windows we must compare case-insensitively or we silently
 * drop half a project's sessions. POSIX paths are case-sensitive, so this is a no-op off Windows.
 */
export function foldPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * True iff `candidate` is at or beneath any of `roots`. `fold` defaults to `foldPath` (the
 * platform-aware case folder); it's a parameter only so tests can force Windows-style
 * case-insensitive matching on a POSIX CI runner.
 */
export function cwdMatchesAny(
  candidate: string | undefined,
  roots: readonly string[],
  fold: (p: string) => string = foldPath,
): candidate is string {
  if (!candidate) return false;
  const r = fold(path.resolve(candidate));
  for (const root of roots) {
    const rt = fold(root);
    if (r === rt || r.startsWith(rt + path.sep)) return true;
  }
  return false;
}

/**
 * True iff `candidate` resolves to EXACTLY one of `roots` — exact-only matching, the counterpart to
 * cwdMatchesAny's at-or-beneath test. A session in a subdirectory of a root does NOT match; only a
 * session whose cwd is the root itself (a registered cwd or one of its git worktrees) does. `fold`
 * defaults to the platform case-folder (overridable for tests, exactly as in cwdMatchesAny).
 */
export function cwdEqualsAny(
  candidate: string | undefined,
  roots: readonly string[],
  fold: (p: string) => string = foldPath,
): candidate is string {
  if (!candidate) return false;
  // A science cwd is a synthetic identifier, not a path — `path.resolve` would
  // mangle it (and its roots are stored un-resolved), so compare verbatim.
  if (isScienceCwd(candidate)) return roots.some((root) => candidate === root);
  const r = fold(path.resolve(candidate));
  return roots.some((root) => r === fold(root));
}

/**
 * True iff `folder` overlaps any root — equal, an ancestor, or a descendant. Cowork's
 * userSelectedFolders is the access-granted directory and can sit on either side of a registered
 * cwd, so containment is tested both ways.
 *
 * Case-folds with `foldPath` (overridable for tests): Cowork now runs on Windows too — its sessions
 * live under `%APPDATA%\Claude` — where the same drive-letter case drift that bites Claude Code
 * (`C:\…` vs `c:\…`) would otherwise silently drop a project's Cowork sessions. POSIX is a no-op.
 */
function folderOverlapsAny(
  folder: string,
  roots: readonly string[],
  fold: (p: string) => string = foldPath,
): boolean {
  const f = fold(path.resolve(folder));
  for (const root of roots) {
    const rt = fold(root);
    if (f === rt || f.startsWith(rt + path.sep) || rt.startsWith(f + path.sep))
      return true;
  }
  return false;
}

/**
 * Pick the root a Cowork session anchors to, or undefined when it's out of scope. Takes the raw
 * `userSelectedFolders` metadata value (any shape) and filters it to strings internally.
 *
 * A session that named folders anchors to the first one overlapping a root (case-folded; skipped
 * when none do) — the original rule. A session that granted NO folder — an absent array, or a
 * present-but-empty one — ran in Cowork's default workspace root (`coworkDefaultRoot`, ~/Claude),
 * so it anchors there iff that root is itself registered: an opt-in catch-all. "Folder-less" is
 * judged on the RAW grant, not the string-filtered list — a non-empty grant we couldn't parse (e.g.
 * non-string junk) means the user pointed Cowork *somewhere*, so it is NOT swept into the catch-all;
 * an unmatched grant likewise never falls back. Returns a `path.resolve`d path either way (the
 * matched grant or coworkDefaultRoot), so the contract is uniform for callers.
 */
export function coworkAnchorFor(
  userSelectedFolders: unknown,
  roots: readonly string[],
  coworkDefaultRoot: string,
  fold: (p: string) => string = foldPath,
): string | undefined {
  const granted = Array.isArray(userSelectedFolders) ? userSelectedFolders : [];
  const folders = granted.filter((x): x is string => typeof x === 'string');
  // Resolve roots once up front so the overlap check and the catch-all compare the same normalised
  // form. Registered cwds always arrive as full absolute paths, but a caller (or test) may hand us
  // a trailing slash or "."/".." segment, and folderOverlapsAny itself only resolves the folder side.
  const resolved = roots.map((r) => path.resolve(r));
  const matched = folders.find((f) => folderOverlapsAny(f, resolved, fold));
  if (matched) return path.resolve(matched);
  // ~/Claude shows up resolved to e.g. /Users/<me>/Claude or C:\Users\<me>\Claude. Compare folded
  // (case-insensitive on Windows) but return the unfolded path so the recorded cwd keeps real casing.
  const def = path.resolve(coworkDefaultRoot);
  const defFolded = fold(def);
  if (granted.length === 0 && resolved.some((r) => fold(r) === defFolded))
    return def;
  return undefined;
}

/**
 * List a cwd's git worktrees as absolute paths. Empty array when the dir isn't a git repo, git
 * isn't installed, or the command fails — we always degrade silently. Includes the cwd's own
 * root worktree, so callers can dedup against it.
 */
function gitWorktreesFor(cwd: string): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['-C', cwd, 'worktree', 'list', '--porcelain'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const out: string[] = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree '))
        out.push(path.resolve(line.slice('worktree '.length).trim()));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve every registered cwd into the union {cwd, ...its-git-worktrees}, deduped.
 *
 * A cwd's worktrees are folded in ONLY when the cwd is itself a worktree root. Run from a mere
 * SUBDIRECTORY of a repo, `git worktree list` returns the PARENT repo's worktrees (main first) —
 * adding those as roots would pull the parent's sessions into a subdir project (app-web's session
 * list showing omne-next's). So a subdir (or non-git dir) contributes only itself. Same worktree-root
 * test as owningWorktree. `worktreesOf` defaults to gitWorktreesFor (injectable for tests).
 */
export function expandToWorktreeUnion(
  cwds: readonly string[],
  worktreesOf: (cwd: string) => string[] = gitWorktreesFor,
): string[] {
  const seen = new Set<string>();
  for (const c of cwds) {
    // A science cwd has no filesystem path and no worktrees — pass it through
    // verbatim (path.resolve would mangle the URI and git would find nothing).
    if (isScienceCwd(c)) {
      seen.add(c);
      continue;
    }
    const abs = path.resolve(c);
    if (!seen.has(abs)) seen.add(abs);
    const wts = worktreesOf(abs);
    if (!wts.some((w) => foldPath(w) === foldPath(abs))) continue;
    for (const w of wts) {
      if (!seen.has(w)) seen.add(w);
    }
  }
  return [...seen];
}

function setMeta(
  meta: Record<string, string>,
  key: string,
  val: unknown,
): void {
  if (!(key in meta) && typeof val === 'string' && val.trim())
    meta[key] = val.trim();
}

/**
 * Loose shapes for the head-of-file JSON we probe. Every field is `unknown` — we read only a
 * handful and guard each at the use site — so a malformed or unexpected transcript can't throw
 * here. These exist to type the `JSON.parse` result without pretending the payload is precise.
 */
interface ClaudeHeadLine {
  cwd?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  version?: unknown;
  gitBranch?: unknown;
  timestamp?: unknown;
  model?: unknown;
  message?: { model?: unknown };
}

interface CodexHeadLine {
  payload?: CodexHeadLine;
  cwd?: unknown;
  id?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  model?: unknown;
  cli_version?: unknown;
  codex_version?: unknown;
  originator?: unknown;
}

interface CoworkMeta {
  userSelectedFolders?: unknown;
  sessionId?: unknown;
  model?: unknown;
  title?: unknown;
  createdAt?: unknown;
}

function probeClaude(head: string): {
  cwd?: string;
  id?: string;
  meta: Record<string, string>;
} {
  let cwd: string | undefined;
  let id: string | undefined;
  const meta: Record<string, string> = {};
  for (const line of head.split('\n').slice(0, 50)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: ClaudeHeadLine;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!id && typeof o.sessionId === 'string') id = o.sessionId;
    if (!id && typeof o.session_id === 'string') id = o.session_id;
    setMeta(meta, 'version', o.version);
    setMeta(meta, 'gitBranch', o.gitBranch);
    setMeta(meta, 'startedAt', o.timestamp);
    setMeta(meta, 'model', o.message?.model ?? o.model);
    if (cwd && id && meta.model && meta.version) break;
  }
  return { cwd, id, meta };
}

function probeCodex(head: string): {
  cwd?: string;
  id?: string;
  meta: Record<string, string>;
} {
  let cwd: string | undefined;
  let id: string | undefined;
  const meta: Record<string, string> = {};
  for (const line of head.split('\n').slice(0, 50)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: CodexHeadLine;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const p = o.payload && typeof o.payload === 'object' ? o.payload : o;
    if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!id && typeof p.id === 'string') id = p.id;
    if (!id && typeof p.session_id === 'string') id = p.session_id;
    setMeta(meta, 'startedAt', p.timestamp ?? o.timestamp);
    setMeta(meta, 'model', p.model);
    setMeta(meta, 'version', p.cli_version ?? p.codex_version);
    setMeta(meta, 'originator', p.originator);
    if (cwd && id && meta.model) break;
  }
  return { cwd, id, meta };
}

function walkJsonl(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * OS metadata files that Finder/Explorer drop into any browsed directory —
 * never session data, so the walker skips them at every depth. AppleDouble
 * companions (`._<name>`, written by macOS on non-native volumes and by
 * archive extraction) are matched by prefix in the walk itself; no agent's
 * real sidecar files start with `._`.
 */
const OS_JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Recursively list every file under a session's sidecar dir, returning each with its POSIX
 * relative path. Depth-limited (the real tree is shallow) and silently degrading.
 */
export function walkSidecar(root: string): SidecarFile[] {
  const out: SidecarFile[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (OS_JUNK_FILES.has(e) || e.startsWith('._')) continue;
      const abs = path.join(dir, e);
      const childRel = rel ? `${rel}/${e}` : e;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, childRel, depth + 1);
      else
        out.push({
          relPath: childRel,
          absPath: abs,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
        });
    }
  };
  walk(root, '', 0);
  return out;
}

/**
 * Claude Desktop's appData dir holding Cowork's local-agent-mode-sessions, per platform: macOS
 * `~/Library/Application Support`, Windows `%APPDATA%` (…\AppData\Roaming), and Linux `~/.config`
 * (Electron's appData default). Params are injectable so tests can exercise every platform branch
 * from a single host.
 */
export function coworkSessionsRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const tail = ['Claude', 'local-agent-mode-sessions'];
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim()
      ? env.APPDATA
      : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, ...tail);
  }
  if (platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', ...tail);
  // Linux / others: Electron's appData honours $XDG_CONFIG_HOME, falling back to ~/.config.
  const xdg = env.XDG_CONFIG_HOME?.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(xdg, ...tail);
}

/** Find every Cowork session-metadata file (local_<uuid>.json) under a root, depth-limited. */
function walkCoworkMetas(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const isMeta = /^local_[0-9a-fA-F-]+\.json$/;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (isMeta.test(e)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Light index fields lifted from a science session's meta.json into
 * SessionRef.meta (strings only, absent keys omitted). The full meta.json is
 * uploaded verbatim as a sidecar; this is just what the Board/sync surface. */
function readScienceMeta(sessionDir: string): Record<string, string> {
  const meta: Record<string, string> = {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path.join(sessionDir, 'meta.json'), 'utf8'));
  } catch {
    return meta;
  }
  const put = (key: string, val: unknown): void => {
    if (val === null || val === undefined) return;
    const s = String(val).trim();
    if (s) meta[key] = s;
  };
  put('model', raw.model);
  put('effort', raw.effort);
  put('status', raw.status);
  put('name', raw.name);
  put('agentName', raw.agent_name);
  put('taskSummary', raw.task_summary);
  // Guard the Date conversion: a corrupt meta.json could carry NaN/Infinity or
  // an out-of-range epoch, and `new Date(x).toISOString()` throws on those.
  if (typeof raw.created_at === 'number' && Number.isFinite(raw.created_at)) {
    try {
      put('startedAt', new Date(raw.created_at).toISOString());
    } catch {
      /* out-of-range epoch → omit startedAt */
    }
  }
  return meta;
}

/**
 * The science sidecar allowlist: `meta.json` plus anything under `details/` or
 * `artifacts/` — the only shapes `runScienceExport` writes. The export tree is
 * a real directory the user can browse, so an "everything but session.jsonl"
 * rule would sweep stray files (Finder droppings, hand-made notes) into the
 * upload; only the exporter's own output rides along.
 */
function isScienceSidecar(relPath: string): boolean {
  return (
    relPath === 'meta.json' ||
    relPath.startsWith('details/') ||
    relPath.startsWith('artifacts/')
  );
}

/**
 * Build SessionRefs for one science cwd by reading its exported session tree
 * (written by `runScienceExport`). Each `sessions/<uuid>/` dir yields one ref:
 * `session.jsonl` is the transcript (the upload layer renames it to
 * `transcript.jsonl`), and the allowlisted export shapes — meta.json,
 * details/*, artifacts/* — ride along as sidecars (see `isScienceSidecar`).
 * A dir with no session.jsonl is a half-written export and is skipped.
 * `exportDir` is injectable for tests.
 */
export function discoverScienceSessions(
  cwd: string,
  exportDir: string = scienceExportDir(),
): SessionRef[] {
  const parsed = parseScienceCwd(cwd);
  if (!parsed) return [];
  const sessionsRoot = path.join(
    exportDir,
    parsed.orgId,
    parsed.projId,
    'sessions',
  );
  if (!isDir(sessionsRoot)) return [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(sessionsRoot).filter((d) =>
      isDir(path.join(sessionsRoot, d)),
    );
  } catch {
    return [];
  }
  const out: SessionRef[] = [];
  for (const id of dirs) {
    const sessionDir = path.join(sessionsRoot, id);
    const mainPath = path.join(sessionDir, 'session.jsonl');
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(mainPath);
    } catch {
      continue; // no transcript → half-written export, skip
    }
    const sidecarFiles = walkSidecar(sessionDir).filter((f) =>
      isScienceSidecar(f.relPath),
    );
    out.push({
      id,
      agent: 'claude-science',
      path: mainPath,
      cwd,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      meta: readScienceMeta(sessionDir),
      sidecarFiles,
    });
  }
  return out;
}

/**
 * Count a science project's sessions without building full SessionRefs — one
 * `statSync` per session dir (checking the transcript exists), no `walkSidecar`
 * over every artifact/detail file. For the picker's session-count column, where
 * only the number matters.
 */
export function countScienceSessions(
  cwd: string,
  exportDir: string = scienceExportDir(),
): number {
  const parsed = parseScienceCwd(cwd);
  if (!parsed) return 0;
  const sessionsRoot = path.join(
    exportDir,
    parsed.orgId,
    parsed.projId,
    'sessions',
  );
  if (!isDir(sessionsRoot)) return 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  let n = 0;
  for (const id of dirs) {
    try {
      if (statSync(path.join(sessionsRoot, id, 'session.jsonl')).isFile())
        n += 1;
    } catch {
      /* no transcript → half-written, don't count */
    }
  }
  return n;
}

/**
 * Discover sessions across all of a project's registered cwds plus their git worktrees.
 *
 * Empty `cwds` is treated as "discover nothing" (returns []) — a project with no registered
 * cwds simply has nothing to sweep.
 */
export function discoverSessionsForProject(
  cwds: readonly string[],
): SessionRef[] {
  const out: SessionRef[] = [];
  const seen = new Set<string>();
  const add = (ref: SessionRef): void => {
    const key = `${ref.agent}:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  // ── claude-science ───────────────────────────────────────
  // Science cwds are synthetic identifiers, not directories: they map to an
  // already-exported session tree, not an agent store. Handle them first and
  // keep them out of the worktree/encoded-dir machinery below (which would
  // mangle the URI via path.resolve and find nothing).
  const scienceCwds = cwds.filter(isScienceCwd);
  for (const c of scienceCwds)
    for (const ref of discoverScienceSessions(c)) add(ref);

  const regularCwds = cwds.filter((c) => !isScienceCwd(c));
  const roots = expandToWorktreeUnion(regularCwds);
  if (roots.length === 0) return out;
  const fastDirNames = new Set(roots.map((r) => foldPath(claudeEncodedDir(r))));

  // ── Claude Code ──────────────────────────────────────────
  const ccRoot = path.join(os.homedir(), '.claude', 'projects');
  if (isDir(ccRoot)) {
    let dirNames: string[] = [];
    try {
      dirNames = readdirSync(ccRoot).filter((d) => isDir(path.join(ccRoot, d)));
    } catch {
      /* ignore */
    }
    for (const d of dirNames) {
      // Exact-only: a Claude Code session lives in the encoded dir of its own cwd, so a root's
      // sessions are in the root's encoded dir and nowhere else. Skip every dir that isn't some
      // root's — that's what drops a root's subdirectory sessions (and spares reading every
      // unrelated project dir's file heads, the old "slow path" cost).
      if (!fastDirNames.has(foldPath(d))) continue;
      const dirPath = path.join(ccRoot, d);
      let files: string[] = [];
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const fp = path.join(dirPath, f);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(fp);
        } catch {
          continue;
        }
        const probed = probeClaude(readHead(fp));
        // claudeEncodedDir is lossy — every non-alphanumeric char collapses to '-', so `/a/foo-bar`,
        // `/a/foo/bar` and `/a/foo_bar` share the encoded dir name and their sessions co-locate. The
        // dir-name match alone is therefore NOT proof a file's cwd is a root: when the head carries a
        // cwd, require it to BE a root (true exact-only); only a head with no cwd falls back to the
        // dir-name match (our only evidence then). Without this, a sibling cwd's session would leak in.
        if (probed.cwd && !cwdEqualsAny(probed.cwd, roots)) continue;
        const fallbackId = f.replace(/\.jsonl$/, '');
        // Claude Code's sibling <id>/ dir holds subagent transcripts and spilled tool outputs.
        const sidecarDir = path.join(dirPath, fallbackId);
        const sidecarFiles = isDir(sidecarDir) ? walkSidecar(sidecarDir) : [];
        // cwd comes from the file head; fall back to the root whose encoded name is this dir.
        const resolvedCwd = probed.cwd
          ? path.resolve(probed.cwd)
          : (roots.find((r) => foldPath(claudeEncodedDir(r)) === foldPath(d)) ??
            roots[0]!);
        add({
          id: probed.id ?? fallbackId,
          agent: 'claude-code',
          path: fp,
          cwd: resolvedCwd,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          meta: probed.meta,
          sidecarFiles,
        });
      }
    }
  }

  // ── Codex ────────────────────────────────────────────────
  const cxRoot = path.join(os.homedir(), '.codex', 'sessions');
  if (isDir(cxRoot)) {
    for (const fp of walkJsonl(cxRoot, 4)) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      const probed = probeCodex(readHead(fp));
      // Exact-only, like Claude: a rollout counts iff its cwd is a root itself (or one of its
      // worktrees), never a root's subdirectory.
      if (probed.id && cwdEqualsAny(probed.cwd, roots)) {
        add({
          id: probed.id,
          agent: 'codex',
          path: fp,
          cwd: path.resolve(probed.cwd),
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          meta: probed.meta,
          sidecarFiles: [],
        });
      }
    }
  }

  // ── Claude Cowork ────────────────────────────────────────
  const cwRoot = coworkSessionsRoot();
  // ~/Claude — Cowork's default workspace root (the dir the desktop app drops sessions into when
  // the user grants no specific folder). Passed to coworkAnchorFor so a project registering it as
  // a cwd becomes the catch-all for folder-less Cowork sessions.
  const coworkDefaultRoot = path.join(os.homedir(), 'Claude');
  if (isDir(cwRoot)) {
    for (const metaPath of walkCoworkMetas(cwRoot, 4)) {
      let m: CoworkMeta;
      try {
        m = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        continue;
      }
      const anchor = coworkAnchorFor(
        m.userSelectedFolders,
        roots,
        coworkDefaultRoot,
      );
      if (!anchor) continue;
      const auditPath = path.join(
        metaPath.replace(/\.json$/, ''),
        'audit.jsonl',
      );
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(auditPath);
      } catch {
        continue;
      }
      const id =
        typeof m.sessionId === 'string' && m.sessionId
          ? m.sessionId
          : path.basename(metaPath, '.json');
      const meta: Record<string, string> = {};
      setMeta(meta, 'model', m.model);
      setMeta(meta, 'title', m.title);
      if (typeof m.createdAt === 'number')
        setMeta(meta, 'startedAt', new Date(m.createdAt).toISOString());
      add({
        id,
        agent: 'cowork',
        path: auditPath,
        cwd: path.resolve(anchor),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        meta,
        sidecarFiles: [],
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Cheap count for dashboards. */
export function countSessionsForProject(cwds: readonly string[]): number {
  try {
    return discoverSessionsForProject(cwds).length;
  } catch {
    return 0;
  }
}

/** Read a session .jsonl (or sidecar file) from disk; '' on any error. */
export function readSessionFile(absPath: string): string {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

/** The git repository root containing `cwd`, or null when it isn't in a repo. */
export function gitRootOf(cwd: string): string | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const root = out.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export interface ScannedCwd {
  /** absolute working directory a coding agent recorded sessions for */
  cwd: string;
  agent: SessionAgent;
  sessionCount: number;
}

/**
 * Sweep every agent's session store for the distinct cwds they recorded, with
 * per-agent session counts — the input to the TUI's "auto-scan → generate
 * projects" flow. Cheap by design: one cwd-probe per Claude Code project dir
 * (all files in a dir share a cwd), not one probe per file.
 */
export function scanSessionCwds(): ScannedCwd[] {
  const out: ScannedCwd[] = [];

  // Claude Code — one dir per cwd
  const ccRoot = path.join(os.homedir(), '.claude', 'projects');
  if (isDir(ccRoot)) {
    let dirNames: string[] = [];
    try {
      dirNames = readdirSync(ccRoot).filter((d) => isDir(path.join(ccRoot, d)));
    } catch {
      /* ignore */
    }
    for (const d of dirNames) {
      const dirPath = path.join(ccRoot, d);
      let files: string[] = [];
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      if (files.length === 0) continue;
      const probed = probeClaude(readHead(path.join(dirPath, files[0]!)));
      if (probed.cwd) {
        out.push({
          cwd: path.resolve(probed.cwd),
          agent: 'claude-code',
          sessionCount: files.length,
        });
      }
    }
  }

  // Codex — sessions scattered by date; tally by probed cwd
  const cxRoot = path.join(os.homedir(), '.codex', 'sessions');
  if (isDir(cxRoot)) {
    const counts = new Map<string, number>();
    for (const fp of walkJsonl(cxRoot, 4)) {
      const probed = probeCodex(readHead(fp));
      if (probed.cwd) {
        const c = path.resolve(probed.cwd);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    for (const [cwd, sessionCount] of counts)
      out.push({ cwd, agent: 'codex', sessionCount });
  }

  // Cowork — anchor on the metadata's userSelectedFolders. Deliberately NO ~/Claude catch-all here
  // (unlike discoverSessionsForProject): this is reverse inference (session → cwd) with no
  // registered roots in hand, so a folder-less session has no cwd to propose. Those sessions
  // surface once the user registers ~/Claude as a cwd and discoverSessionsForProject runs.
  const cwRoot = coworkSessionsRoot();
  if (isDir(cwRoot)) {
    const counts = new Map<string, number>();
    for (const metaPath of walkCoworkMetas(cwRoot, 4)) {
      let m: CoworkMeta;
      try {
        m = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        continue;
      }
      const folders: string[] = Array.isArray(m.userSelectedFolders)
        ? m.userSelectedFolders.filter(
            (x: unknown): x is string => typeof x === 'string',
          )
        : [];
      if (folders[0]) {
        const c = path.resolve(folders[0]);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    for (const [cwd, sessionCount] of counts)
      out.push({ cwd, agent: 'cowork', sessionCount });
  }

  return out;
}

/** cwd path segments excluded everywhere as self-noise — work-memory tooling's own dirs. */
const IGNORED_CWD_SEGMENTS = ['.work-memory'];

/** True when a cwd should be excluded from discovery/auto-scan (tooling self-noise). */
export function isIgnoredCwd(cwd: string): boolean {
  return IGNORED_CWD_SEGMENTS.some((seg) => cwd.includes(seg));
}

/**
 * The main worktree that OWNS `cwd`: its repo's main worktree when `cwd` is itself a worktree root,
 * else `cwd` unchanged. `worktreesOf` returns a cwd's worktrees with the main worktree FIRST (git's
 * documented ordering) — [] for a non-git or failed lookup; defaults to gitWorktreesFor.
 *
 * The subtlety this guards: `git worktree list` run from a mere SUBDIRECTORY of the main worktree
 * (e.g. omne-next/app-web) still returns the repo's worktrees with the main worktree first — but
 * app-web is NOT a worktree, just a subdir, and exact-only treats it as its own cwd. So we fold ONLY
 * when `cwd` is actually one of its own worktree roots; a subdir (or non-git dir) stays itself.
 * This is the single grouping rule shared by 'all'-mode folding and the select-mode ScanModal.
 */
export function owningWorktree(
  cwd: string,
  worktreesOf: (cwd: string) => string[] = gitWorktreesFor,
): string {
  // A science cwd is a synthetic identifier with no worktrees — returning it
  // verbatim also spares a doomed `git -C claude-science://…` subprocess that
  // foldWorktreesToOwner would otherwise spawn per science cwd per call.
  if (isScienceCwd(cwd)) return cwd;
  const wts = worktreesOf(cwd);
  const f = foldPath(cwd);
  return wts.some((w) => foldPath(w) === f) ? wts[0]! : cwd;
}

/**
 * Fold each ref's cwd to its owning main worktree (owningWorktree), so an 'all'-mode directory list
 * groups a repo's worktrees under one entry instead of scattering them — while subdirectories of a
 * repo stay on their own cwd. Memoised per distinct cwd, so each repo costs at most one git call.
 * Mutates and returns `refs` (method A: the ref's cwd becomes the owning root; the real path is
 * still on `ref.path`).
 */
export function foldWorktreesToOwner(
  refs: SessionRef[],
  worktreesOf: (cwd: string) => string[] = gitWorktreesFor,
): SessionRef[] {
  const ownerOf = new Map<string, string>();
  const owner = (cwd: string): string => {
    const hit = ownerOf.get(cwd);
    if (hit !== undefined) return hit;
    const o = owningWorktree(cwd, worktreesOf);
    ownerOf.set(cwd, o);
    return o;
  };
  for (const ref of refs) ref.cwd = owner(ref.cwd);
  return refs;
}

/**
 * Discover EVERY coding-agent session on the machine — the 'all' run mode.
 * The search set is every cwd scanSessionCwds() found, plus the Cowork default
 * root (~/Claude) so folder-less Cowork sessions are caught by the same
 * catch-all discoverSessionsForProject uses. Re-scanned on each call, so newly
 * used directories are picked up automatically. Sessions whose cwd lives under
 * a work-memory tooling dir (e.g. `.work-memory`) are excluded as self-noise.
 * Each surviving session's cwd is then folded to its owning main git worktree
 * (foldWorktreesToOwner), so a repo's worktrees group under one directory entry
 * rather than scattering across the list.
 */
export function discoverAllSessions(): SessionRef[] {
  const cwds = scanSessionCwds().map((s) => s.cwd);
  cwds.push(path.join(os.homedir(), 'Claude')); // Cowork catch-all for folder-less sessions
  cwds.push(...scienceExportCwds()); // exported claude-science projects (each its own cwd)
  const refs = discoverSessionsForProject(cwds).filter(
    (r) => !isIgnoredCwd(r.cwd),
  );
  return foldWorktreesToOwner(refs, gitWorktreesFor);
}

/**
 * Enumerate the synthetic cwds of every exported science project — one per
 * `<exportDir>/<org>/<proj>/` dir that has a `sessions/` subdir. Feeds 'all'
 * mode: each becomes its own project, lazily mapped like any other cwd.
 */
export function scienceExportCwds(
  exportDir: string = scienceExportDir(),
): string[] {
  if (!isDir(exportDir)) return [];
  const out: string[] = [];
  let orgs: string[] = [];
  try {
    orgs = readdirSync(exportDir).filter((o) => isDir(path.join(exportDir, o)));
  } catch {
    return [];
  }
  for (const org of orgs) {
    const orgDir = path.join(exportDir, org);
    let projs: string[] = [];
    try {
      projs = readdirSync(orgDir).filter((p) =>
        isDir(path.join(orgDir, p, 'sessions')),
      );
    } catch {
      continue;
    }
    for (const proj of projs) out.push(scienceCwd(org, proj));
  }
  return out;
}

/** Read a science project's display name from its exported project.json. */
function readScienceProjectName(cwd: string): string | undefined {
  const parsed = parseScienceCwd(cwd);
  if (!parsed) return undefined;
  try {
    const p = path.join(
      scienceExportDir(),
      parsed.orgId,
      parsed.projId,
      'project.json',
    );
    const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: unknown };
    return typeof j.name === 'string' && j.name.trim() ? j.name : undefined;
  } catch {
    return undefined;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Attribute a session to a project derived purely from its own cwd — no git,
 * no user list. Used in 'all' mode for wmmeta + groupId. Two distinct cwds
 * sharing a basename collide on id, which is harmless: groupId still includes
 * the unique session id.
 */
export function syntheticCwdFor(cwd: string): ProjectCwd {
  // Science cwds carry no path — derive id from the project id and the display
  // name from the exported project.json (falling back to the id), so 'all' mode
  // creates the remote project under its real name, not "proj_xxxx".
  if (isScienceCwd(cwd)) {
    const parsed = parseScienceCwd(cwd);
    const projId = parsed?.projId ?? cwd;
    return {
      id: slugify(projId) || 'sessions',
      name: readScienceProjectName(cwd) ?? projId,
      cwd,
    };
  }
  const base = path.basename(cwd);
  return { id: slugify(base) || 'sessions', name: base || cwd, cwd };
}
