// biome-ignore-all lint/suspicious/noExplicitAny: DB rows are heterogeneous JSON.
/**
 * Export claude-science's org / project / session data from its per-org SQLite
 * DBs into a directory tree that tanka-wm's session discovery can then sync.
 *
 * This is a TypeScript port of the `export_project.py` reference exporter,
 * running on `bun:sqlite` so the shipped binary needs no python. The tree it
 * writes (per org → project → session) is the input `discoverScienceSessions`
 * reads back:
 *
 *   <outDir>/
 *   └── <org_id>/
 *       ├── org.json
 *       └── <proj_id>/
 *           ├── project.json
 *           └── sessions/
 *               └── <root_frame_uuid>/
 *                   ├── meta.json              root frame + cost/token, written LAST
 *                   ├── session.jsonl          whole tree's raw messages
 *                   ├── artifacts/             _artifacts.jsonl + <artifact_id>/v… (all versions)
 *                   └── details/               chat-frames / execution-log / verification-checks /
 *                                              system-prompts / compaction-archives / branch-archives
 *
 * Data lives at:
 *   <scienceDir>/orgs/<org>/operon-cli.db      one SQLite DB per org
 *   <scienceDir>/orgs/<org>/artifacts/<path>   artifact bytes (DB stores only the path)
 *   <scienceDir>/active-org.json               name of the currently active org
 *
 * Async: every filesystem op uses `node:fs/promises` so the export never blocks
 * the event loop (it runs on the Board's discovery path). The DB reads use
 * `bun:sqlite`, which is synchronous-only — Bun ships no async SQLite — but the
 * awaited file writes between them yield the loop; moving the DB fully
 * off-thread would need a Worker.
 *
 * Incremental: each session carries an `_export_signature`; a session whose
 * signature is unchanged is left untouched. `meta.json` is written last so its
 * presence means "this dir is fully written" — a crash mid-write leaves no
 * meta.json and the next run redoes it.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { scienceCwd } from './sessions';

/** Statuses that mean a frame has stopped running. Anything else is "live". */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'error']);

/** details/ tables: [table, key column, output filename]. Empty tables are skipped. */
const DETAIL_TABLES: ReadonlyArray<[string, string, string]> = [
  // agent cell execution — the sha256 of files_written, exit_status, kernel_id
  // exist only here (the `source` column duplicates session.jsonl's tool_use).
  ['execution_log', 'frame_id', 'execution-log.jsonl'],
  // REVIEWER's structured audit verdicts: claim/evidence/verdict/source_ref.
  ['verification_checks', 'root_frame_id', 'verification-checks.jsonl'],
  // per-frame system prompts — required to reproduce a run.
  ['frame_system_prompts', 'frame_id', 'system-prompts.jsonl'],
  // both hold conversation history NOT present in session.jsonl → must export:
  ['compaction_archives', 'frame_id', 'compaction-archives.jsonl'], // compacted-away
  ['frame_branch_archives', 'frame_id', 'branch-archives.jsonl'], // branched/reverted-away
];

export interface ScienceExportOptions {
  /** claude-science data dir, already expanded (no leading `~`). */
  scienceDir: string;
  /** where the tree is written (tuiHome()/claude_science_export). */
  outDir: string;
  /** limit to one org / project (parity with the CLI flags; optional). */
  onlyOrg?: string;
  onlyProject?: string;
}

/** One project's summary — enough for discovery + the select-mode picker. */
export interface ScienceProjectInfo {
  orgId: string;
  projId: string;
  name: string | null;
  /** synthetic cwd (claude-science://org/proj). */
  cwd: string;
  /** number of exported sessions (root frames). */
  sessions: number;
  /** false when any frame is still running (half snapshot). */
  complete: boolean;
}

export interface ScienceExportSummary {
  projects: ScienceProjectInfo[];
  /** project ids with a live frame at export time. */
  incomplete: string[];
  integrity: { missing: string[]; mismatch: string[] };
  /** human-readable warnings (orphan artifacts, schema drift, …). */
  warnings: string[];
  counts: { created: number; updated: number; skipped: number; pruned: number };
}

type Row = Record<string, any>;
type Query = (sql: string, ...params: any[]) => Row[];

/** Per-org accumulator. Fresh for each org so one org's integrity/counts never
 * bleed into another's org.json; `runScienceExport` sums them for the summary. */
interface Stats {
  missing: string[];
  mismatch: string[];
  created: number;
  updated: number;
  skipped: number;
  pruned: number;
  warnings: string[];
}

function emptyStats(): Stats {
  return {
    missing: [],
    mismatch: [],
    created: 0,
    updated: 0,
    skipped: 0,
    pruned: 0,
    warnings: [],
  };
}

/** Deterministic JSON with sorted keys; Uint8Array (BLOB) → hex so the
 * signature hash is content-sensitive and never throws on binary columns. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: any): any {
  if (v instanceof Uint8Array) return `<b:${Buffer.from(v).toString('hex')}>`;
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function writeJsonl(file: string, rows: Row[]): Promise<void> {
  await writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/**
 * Atomic JSON write (tmp + rename), for files rewritten in place on EVERY run
 * (project.json / org.json) while other processes may be mid-read — a Board
 * refresh reads them without holding the export lock. Session-dir files don't
 * need this: they are built in staging and swapped in whole.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

/** True iff the path exists (async replacement for existsSync). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove immediate sub-directories of `parent` whose name is not in `keep`, and
 * return the names removed. Files (e.g. org.json) and unreadable entries are
 * left untouched. Used to drop export dirs whose source project/org was deleted
 * — the session-level prune only cleans within a still-present project, so
 * without this a removed project or org would linger as a phantom cwd forever.
 */
async function pruneDirs(parent: string, keep: Set<string>): Promise<string[]> {
  const pruned: string[] = [];
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return pruned;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const p = join(parent, name);
    try {
      if (!(await stat(p)).isDirectory()) continue;
    } catch {
      continue;
    }
    await rm(p, { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

// ── one project ──────────────────────────────────────────────────────
async function exportProject(
  q: Query,
  orgDir: string,
  prow: Row,
  projDir: string,
  stats: Stats,
): Promise<ScienceProjectInfo> {
  const proj = prow.id as string;
  // Sessions are built here then rename()d into sessions/ — see dumpSession.
  const stagingRoot = join(projDir, '.staging');

  const frames = q(
    'SELECT * FROM frames WHERE project_id=? ORDER BY created_at',
    proj,
  );
  const kids = new Map<string | null, Row[]>();
  for (const f of frames) {
    const k = f.parent_frame_id as string | null;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(f);
  }
  // conversation_type='uploads' is a pseudo-session: 0 messages, 0 artifacts,
  // completed on creation — just the host of the is_user_uploads_folder. Real
  // user uploads (is_user_upload=1) hang off agent sessions, not here, so skip.
  const allRoots = kids.get(null) ?? [];
  const roots = allRoots
    .filter((f) => f.conversation_type !== 'uploads')
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

  // Signature inputs are COUNTS, not bodies — aggregate up front so a
  // fully-unchanged project (the common incremental case) never materializes
  // its message history. Full rows are loaded lazily, per re-exported session.
  const msgCountBy = new Map<string, number>();
  for (const r of q(
    'SELECT frame_id, COUNT(*) AS n FROM frame_messages WHERE frame_id IN ' +
      '(SELECT id FROM frames WHERE project_id=?) GROUP BY frame_id',
    proj,
  ))
    msgCountBy.set(r.frame_id as string, r.n as number);

  // execution_log full rows are only ever exported via DETAIL_TABLES; here the
  // count is all the signature/meta need.
  const cellCountBy = new Map<string, number>();
  for (const r of q(
    'SELECT frame_id, COUNT(*) AS n FROM execution_log WHERE frame_id IN ' +
      '(SELECT id FROM frames WHERE project_id=?) GROUP BY frame_id',
    proj,
  ))
    cellCountBy.set(r.frame_id as string, r.n as number);

  const arts = q(
    'SELECT a.filename, a.id AS artifact_id, a.root_frame_id, a.is_user_upload, ' +
      'a.is_ephemeral, a.sort_order, v.id AS version_id, v.version_number, ' +
      'v.frame_id AS produced_by, v.content_type, v.size_bytes, v.checksum, ' +
      'v.storage_path, v.language, v.code_description, v.created_at AS version_created_at ' +
      'FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id ' +
      'WHERE a.project_id=? ORDER BY a.sort_order, v.version_number',
    proj,
  );
  const artsByRoot = new Map<string, Row[]>();
  for (const a of arts) {
    const k = a.root_frame_id as string;
    (artsByRoot.get(k) ?? artsByRoot.set(k, []).get(k)!).push(a);
  }

  // "uploads is an empty shell" — warn (never silently drop) if it isn't.
  for (const f of allRoots.filter((x) => x.conversation_type === 'uploads')) {
    const nM = msgCountBy.get(f.id) ?? 0;
    const nA = arts.filter((a) => a.root_frame_id === f.id).length;
    if (nM || nA)
      stats.warnings.push(
        `${proj} uploads frame ${String(f.id).slice(0, 8)} has ${nM} msg / ${nA} artifact but was skipped — check the filter assumption`,
      );
  }

  // Artifacts hung on a non-root frame get exported by nobody — warn. Use
  // allRoots (not roots): artifacts on an uploads frame are already covered by
  // the shell check above, so exclude them to avoid double-reporting.
  const rootIds = new Set(allRoots.map((r) => r.id));
  const orphans = [...artsByRoot.keys()].filter((k) => !rootIds.has(k));
  if (orphans.length) {
    const n = orphans.reduce((s, o) => s + (artsByRoot.get(o)?.length ?? 0), 0);
    stats.warnings.push(
      `${proj} ${n} artifact(s) hang on non-exported roots, not exported: ${orphans.map((o) => o.slice(0, 8))}`,
    );
  }

  const live = frames.filter((f) => !TERMINAL.has(f.status));

  const dumpArtifacts = async (fr: Row, fd: string): Promise<void> => {
    const aa = artsByRoot.get(fr.id) ?? [];
    if (!aa.length) return;
    const ad = join(fd, 'artifacts');
    await mkdir(ad, { recursive: true });
    for (const a of aa) {
      const orig = a.storage_path as string;
      // Layout should always be <project_id>/<artifact_id>/v<hash>_<name>.
      // storage_path is an unconstrained text column, so validate rather than
      // assume: an absolute path would re-anchor the read outside the source
      // tree; <3 segments would strip the <artifact_id>/ layer and let same-name
      // artifacts silently clobber; `..` would write outside the session dir.
      const parts = orig.split('/');
      if (
        parts.length !== 3 ||
        orig.startsWith('/') ||
        parts.some((p) => p === '..' || p === '')
      ) {
        stats.mismatch.push(orig);
        stats.warnings.push(`${proj} malformed storage_path, skipped: ${orig}`);
        continue;
      }
      const src = join(orgDir, 'artifacts', orig);
      // Strip the project_id segment (already inside the project dir); keep the
      // <artifact_id>/ layer — it guarantees uniqueness, no dedup needed.
      const rel = parts.slice(1).join('/');
      const dst = join(ad, rel);
      let copied = false;
      try {
        const st = await stat(src);
        if (st.isFile()) {
          await mkdir(dirname(dst), { recursive: true });
          await copyFile(src, dst);
          if (st.size !== a.size_bytes) stats.mismatch.push(orig);
          copied = true;
        } else {
          stats.missing.push(orig); // exists but not a regular file
        }
      } catch {
        stats.missing.push(orig); // absent
      }
      // Rewrite to the session-relative path ONLY when the bytes are actually
      // there — a manifest row must never advertise a file the copy skipped.
      // Missing files keep the original source path plus an explicit marker.
      if (copied) a.storage_path = `artifacts/${rel}`;
      else a._export_missing = true;
    }
    await writeJsonl(join(ad, '_artifacts.jsonl'), aa);
  };

  // details/ rows — needed before the skip check because the signature hashes
  // them (verification_checks status flips are in-place UPDATEs only the hash
  // sees). ONE query per table per project, grouped by key, instead of five
  // per session (the old N+1). Empty tables are omitted (→ no empty files).
  const detailsByKey = new Map<string, Map<string, Row[]>>();
  for (const [tbl, col, fname] of DETAIL_TABLES) {
    let rows: Row[];
    try {
      // ORDER BY rowid: the rows are hashed into _export_signature, and an
      // unordered SELECT's row order is at the query planner's mercy — an
      // index added upstream would flip every signature (→ full re-export
      // AND re-upload) with zero data change.
      rows = q(
        `SELECT * FROM ${tbl} WHERE ${col} IN (SELECT id FROM frames WHERE project_id=?) ORDER BY rowid`,
        proj,
      );
    } catch (e) {
      // MUST abort (per-org catch keeps the old export intact), not degrade:
      // swallowing this would drop the table from every session's signature
      // AND snapshot — a mass re-export that silently deletes the table's
      // data locally and supersedes it remotely on the next sync. A stale
      // export is recoverable; a degraded one is not.
      throw new Error(
        `${proj} read ${tbl} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const grouped = new Map<string, Row[]>();
    for (const r of rows) {
      const k = r[col] as string;
      (grouped.get(k) ?? grouped.set(k, []).get(k)!).push(r);
    }
    if (rows.length) detailsByKey.set(fname, grouped);
  }

  /** Assemble one session's detail rows from the project-wide grouped maps
   * (tree order → deterministic, so signatures stay stable across runs). */
  const detailRows = (tree: Row[]): Map<string, Row[]> => {
    const out = new Map<string, Row[]>();
    for (const [, , fname] of DETAIL_TABLES) {
      const grouped = detailsByKey.get(fname);
      if (!grouped) continue;
      const rows = tree.flatMap((x) => grouped.get(x.id) ?? []);
      if (rows.length) out.set(fname, rows);
    }
    return out;
  };

  const dumpSession = async (
    fr: Row,
    fd: string,
  ): Promise<'created' | 'updated' | 'skipped'> => {
    const tree = [
      fr,
      ...frames.filter((x) => x.root_frame_id === fr.id && x.id !== fr.id),
    ];
    const aa = artsByRoot.get(fr.id) ?? [];
    const details = detailRows(tree);

    const treeMsgCount = tree.reduce(
      (s, x) => s + (msgCountBy.get(x.id) ?? 0),
      0,
    );
    const treeCellCount = tree.reduce(
      (s, x) => s + (cellCountBy.get(x.id) ?? 0),
      0,
    );
    const meta: Row = { ...fr };
    meta._message_count = msgCountBy.get(fr.id) ?? 0;
    meta._cell_count = cellCountBy.get(fr.id) ?? 0;
    meta._child_count = (kids.get(fr.id) ?? []).length;
    meta._tree_frame_count = tree.length;
    meta._tree_message_count = treeMsgCount;
    meta._tree_cell_count = treeCellCount;
    // Incremental signature. Any change → re-export this session.
    // max(updated_at) over the whole tree (not the root's own) avoids relying
    // on the "root updates when a child updates" coupling (observed but not
    // guaranteed). frame_messages has no updated_at, so frames.updated_at is
    // the only probe for in-place message rewrites (streaming finalize). The
    // other terms catch add/remove that leave updated_at unchanged.
    const detailFp: Record<string, [number, string]> = {};
    for (const [fn, rows] of details)
      detailFp[fn] = [rows.length, sha16(canonicalJson(rows))];
    meta._export_signature = {
      tree_updated_at: Math.max(...tree.map((x) => x.updated_at ?? 0)),
      tree_frames: tree.length,
      tree_messages: treeMsgCount,
      tree_cells: treeCellCount,
      artifact_versions: aa.length,
      artifact_latest: aa.length
        ? Math.max(...aa.map((a) => a.version_created_at ?? 0))
        : 0,
      // verification_checks status flips (open→resolved) are UPDATEs to
      // existing rows with no updated_at column — only the hash sees them.
      details: detailFp,
    };

    const metaPath = join(fd, 'meta.json');
    let action: 'created' | 'updated' | 'skipped';
    if (await exists(metaPath)) {
      try {
        const prev = JSON.parse(await readFile(metaPath, 'utf8'));
        if (
          canonicalJson(prev._export_signature) ===
          canonicalJson(meta._export_signature)
        )
          return 'skipped';
      } catch {
        /* corrupt meta.json → treat as needing re-export */
      }
      action = 'updated';
    } else {
      action = 'created';
    }

    // Build the new snapshot in a staging dir OUTSIDE sessions/ (discovery
    // never looks there), then swap it into place with rm + rename. A
    // concurrent reader (a sync mid-upload) sees either the old complete dir,
    // ENOENT (upload fails → not recorded → retried next run), or the new
    // complete dir — never a half-written file at its final path.
    const sdir = join(stagingRoot, fr.id);
    const md = join(sdir, 'details');
    await mkdir(md, { recursive: true });
    await dumpArtifacts(fr, sdir);
    await writeJsonl(join(md, 'chat-frames.jsonl'), tree);
    // Message bodies are loaded HERE, per re-exported session — a signature
    // skip above never touches them. The tree is expressed as a subquery
    // (root + its root_frame_id descendants) rather than an IN (?,?,…) list,
    // so a huge tree can't blow SQLite's bound-parameter limit. Whole tree's
    // raw messages, one per line (0 bytes when there are none, mirroring the
    // Python exporter).
    const msgs = q(
      'SELECT * FROM frame_messages WHERE frame_id=? OR frame_id IN ' +
        '(SELECT id FROM frames WHERE root_frame_id=? AND id!=?) ORDER BY idx',
      fr.id,
      fr.id,
      fr.id,
    );
    const msgsByFrame = new Map<string, Row[]>();
    for (const m of msgs) {
      const k = m.frame_id as string;
      (msgsByFrame.get(k) ?? msgsByFrame.set(k, []).get(k)!).push(m);
    }
    const msgLines: string[] = [];
    for (const x of tree)
      for (const m of msgsByFrame.get(x.id) ?? [])
        msgLines.push(JSON.stringify(m));
    await writeFile(
      join(sdir, 'session.jsonl'),
      msgLines.length ? `${msgLines.join('\n')}\n` : '',
    );
    for (const [fname, rows] of details)
      await writeJsonl(join(md, fname), rows);

    // meta.json written LAST within staging: its presence = dir fully built.
    // A crash before the swap leaves the final dir untouched (old snapshot or
    // absent) and the leftover staging dir is wiped on the next run.
    await writeFile(join(sdir, 'meta.json'), JSON.stringify(meta, null, 2));

    // The swap. rm+rename isn't one atomic step, but the vulnerable window is
    // two syscalls — and a reader landing inside it gets ENOENT, not torn data.
    if (await exists(fd)) await rm(fd, { recursive: true, force: true });
    await mkdir(dirname(fd), { recursive: true });
    await rename(sdir, fd);
    return action;
  };

  await mkdir(projDir, { recursive: true });
  await writeJsonAtomic(join(projDir, 'project.json'), prow);

  // Wipe any staging leftover from a crashed run before building new ones.
  await rm(stagingRoot, { recursive: true, force: true });

  let sessionCount = 0;
  for (const r of roots) {
    // One bad session (corrupt rows, ENOSPC, …) must not freeze the rest of
    // the project/org forever — its OLD export dir stays intact (staging +
    // swap), the error is surfaced, and the loop moves on.
    try {
      const act = await dumpSession(r, join(projDir, 'sessions', r.id));
      stats[act] += 1;
      sessionCount += 1;
    } catch (e) {
      stats.warnings.push(
        `${proj} session ${String(r.id).slice(0, 8)} export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // All sessions swapped into place — drop the (now empty) staging area.
  await rm(stagingRoot, { recursive: true, force: true });

  // Prune stale session dirs: ones gone from the DB (deleted or turned into
  // uploads) are removed so incremental runs don't accumulate forever. Only
  // touches dirs inside this project. Same pruneDirs semantics as the
  // project- and org-level prunes.
  for (const name of await pruneDirs(
    join(projDir, 'sessions'),
    new Set(roots.map((r) => r.id)),
  )) {
    stats.pruned += 1;
    stats.warnings.push(`${proj} pruned stale session ${name.slice(0, 8)}`);
  }

  return {
    orgId: '', // filled by caller
    projId: proj,
    name: (prow.name as string) ?? null,
    cwd: '', // filled by caller
    sessions: sessionCount,
    complete: live.length === 0,
  };
}

// ── one org ──────────────────────────────────────────────────────────
async function exportOrg(
  orgDir: string,
  outOrgDir: string,
  onlyProject: string | undefined,
  activeName: string | null,
  priorNames: Map<string, string>,
): Promise<{ projects: ScienceProjectInfo[]; stats: Stats } | null> {
  const dbPath = join(orgDir, 'operon-cli.db');
  if (!(await exists(dbPath))) return null;
  const orgId = basename(orgDir);
  const stats = emptyStats(); // fresh per org — never shared across orgs
  const db = new Database(dbPath, { readonly: true });
  let out: ScienceProjectInfo[];
  try {
    // The platform wakes REVIEWER to backfill, so the DB may be written
    // concurrently during export. Without a transaction each SELECT is its own
    // snapshot: a child frame added after `frames` is read gets its messages
    // read by a later SELECT yet dropped (tree built from a stale `frames`),
    // and `complete` skews to the first snapshot. A WAL read transaction pins
    // the whole org to one snapshot without blocking the writer. BEGIN is
    // inside the try so a failure still hits the `finally` that closes the db.
    db.exec('BEGIN');
    const q: Query = (sql, ...params) =>
      db.query(sql).all(...(params as any)) as Row[];
    let projs = q('SELECT * FROM projects ORDER BY created_at');
    if (onlyProject) projs = projs.filter((p) => p.id === onlyProject);
    // A filtered run that matches nothing has nothing to do. A FULL run with
    // zero projects must still fall through: the prune below is what removes
    // the export dir of an org's LAST deleted project — returning early here
    // would leave it as a phantom cwd forever.
    if (!projs.length && onlyProject) return null;
    await mkdir(outOrgDir, { recursive: true });
    out = [];
    for (const p of projs) {
      const info = await exportProject(
        q,
        orgDir,
        p,
        join(outOrgDir, p.id),
        stats,
      );
      info.orgId = orgId;
      info.cwd = scienceCwd(orgId, info.projId);
      out.push(info);
    }
  } finally {
    try {
      db.exec('COMMIT');
    } catch {
      /* already closed / no active txn */
    }
    db.close();
  }

  const name = activeName ?? priorNames.get(orgId) ?? null;
  const nameSource = activeName
    ? 'active-org.json'
    : priorNames.has(orgId)
      ? 'carried-forward'
      : null;
  if (!onlyProject) {
    // Drop export dirs of projects deleted from the DB (a full-org run knows the
    // complete project set; a single-project run must not touch its siblings).
    const gone = await pruneDirs(outOrgDir, new Set(out.map((p) => p.projId)));
    for (const g of gone) {
      stats.pruned += 1;
      stats.warnings.push(`${orgId} pruned deleted project ${g}`);
    }
    const org = {
      org_id: orgId,
      org_name: name,
      org_name_source: nameSource,
      dir: orgId,
      projects: out.map((p) => ({
        project_id: p.projId,
        name: p.name,
        sessions: p.sessions,
        complete: p.complete,
      })),
      // Per-org integrity only — `stats` is this org's alone.
      integrity: {
        missing_files: stats.missing,
        size_mismatches: stats.mismatch,
      },
    };
    await writeJsonAtomic(join(outOrgDir, 'org.json'), org);
  }
  return { projects: out, stats };
}

/**
 * Run the full export. Reads `<scienceDir>/orgs/*​/operon-cli.db` and writes the
 * session tree under `outDir`. Safe to call every sync — unchanged sessions are
 * skipped via their signature. Returns a summary for discovery + the picker.
 */
export async function runScienceExport(
  opts: ScienceExportOptions,
): Promise<ScienceExportSummary> {
  const { scienceDir, outDir, onlyOrg, onlyProject } = opts;
  const orgsRoot = join(scienceDir, 'orgs');
  const summary: ScienceExportSummary = {
    projects: [],
    incomplete: [],
    integrity: { missing: [], mismatch: [] },
    warnings: [],
    counts: { created: 0, updated: 0, skipped: 0, pruned: 0 },
  };
  let rootIsDir = false;
  try {
    rootIsDir = (await stat(orgsRoot)).isDirectory();
  } catch {
    /* no orgs dir → nothing to export */
  }
  if (!rootIsDir) {
    // Source removed (claude-science uninstalled / scienceDir repointed): the
    // export tree is a derived cache, so clear it rather than leave phantom
    // projects in discovery forever. Worst case (transient unmount) the next
    // run with the source back simply re-exports. Full runs only — a filtered
    // run must not read "I skipped it" as "it was deleted".
    if (!onlyOrg && !onlyProject) {
      const gone = await pruneDirs(outDir, new Set());
      for (const g of gone) {
        summary.counts.pruned += 1;
        summary.warnings.push(`pruned org ${g} (source removed)`);
      }
      // Remove outDir itself too (rm also sweeps stray files pruneDirs skips):
      // leaving an empty dir would keep sync.ts's cheap existsSync gate failing
      // open, re-running this prune-only pass on every refresh forever.
      await rm(outDir, { recursive: true, force: true });
    }
    return summary;
  }

  let orgNames: string[] = [];
  try {
    orgNames = await readdir(orgsRoot);
  } catch {
    return summary;
  }
  const orgDirs: string[] = [];
  for (const n of orgNames.sort()) {
    const p = join(orgsRoot, n);
    try {
      if ((await stat(p)).isDirectory()) orgDirs.push(p);
    } catch {
      /* skip unreadable entry */
    }
  }
  const filtered = onlyOrg
    ? orgDirs.filter((p) => basename(p) === onlyOrg)
    : orgDirs;

  // Org display name for the active org only; others carry forward from a
  // prior export's org.json.
  let activeOrgId: string | null = null;
  let activeOrgName: string | null = null;
  try {
    const a = JSON.parse(
      await readFile(join(scienceDir, 'active-org.json'), 'utf8'),
    );
    activeOrgId = a.org_uuid ?? null;
    activeOrgName = a.org_name ?? null;
  } catch {
    /* missing/corrupt → names fall back to carried-forward */
  }
  // Must read prior org.json names before any rmtree could destroy them.
  const priorNames = new Map<string, string>();
  try {
    for (const n of await readdir(outDir)) {
      try {
        const o = JSON.parse(
          await readFile(join(outDir, n, 'org.json'), 'utf8'),
        );
        if (o.org_name) priorNames.set(o.org_id ?? n, o.org_name);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* outDir doesn't exist yet */
  }

  await mkdir(outDir, { recursive: true });

  for (const orgDir of filtered) {
    const orgId = basename(orgDir);
    try {
      const res = await exportOrg(
        orgDir,
        join(outDir, orgId),
        onlyProject,
        activeOrgId === orgId ? activeOrgName : null,
        priorNames,
      );
      if (!res) continue;
      summary.projects.push(...res.projects);
      // Aggregate per-org stats into the cumulative summary.
      summary.integrity.missing.push(...res.stats.missing);
      summary.integrity.mismatch.push(...res.stats.mismatch);
      summary.warnings.push(...res.stats.warnings);
      summary.counts.created += res.stats.created;
      summary.counts.updated += res.stats.updated;
      summary.counts.skipped += res.stats.skipped;
      summary.counts.pruned += res.stats.pruned;
    } catch (e) {
      // One bad org must not sink the others — record and move on.
      summary.warnings.push(
        `org ${orgId} export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Drop export dirs of orgs removed from the source. Only on a full run: a
  // filtered run (onlyOrg/onlyProject) deliberately skips other orgs, so their
  // absence from this pass must not be read as deletion. `orgDirs` (every dir
  // under orgs/, DB-less ones included) is the authoritative live set.
  if (!onlyOrg && !onlyProject) {
    const gone = await pruneDirs(
      outDir,
      new Set(orgDirs.map((p) => basename(p))),
    );
    for (const g of gone) {
      summary.counts.pruned += 1;
      summary.warnings.push(`pruned deleted org ${g}`);
    }
  }

  summary.incomplete = summary.projects
    .filter((p) => !p.complete)
    .map((p) => p.projId);
  return summary;
}
