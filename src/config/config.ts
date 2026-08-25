/**
 * Config + credentials persistence.
 *
 *   ~/.tanka-wm/config.json       projects (0644)
 *   ~/.tanka-wm/credentials.json  Tanka upload token (0600)
 *
 * The split keeps the secret token in a tighter-permission file and lets
 * config.json be safely shared / version-diffed.
 *
 * The upload *environment* lives in credentials.json alongside the token (it
 * selects which Tanka base URL the token is for — they belong together, and a
 * headless `sync` reads both from the file with no env vars involved). The base
 * URL for each environment is resolved via TANKA_API_URL_<ENV> environment
 * variables (see upload/tanka-client.ts — inlined at compile time by --define).
 *
 * Concept mapping (aligned with the Tanka work-memory backend):
 *   ProjectCwd  — a working directory entry (one cwd string).
 *   Project     — the backend project entity; has a name and references
 *                 multiple cwds by id (1:N in select mode, 1:1 in all mode).
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { configPath, credentialsPath, tuiHome } from './paths';

/** Literal stored in config for the claude-science data directory. */
export const DEFAULT_SCIENCE_DIR = '~/.claude-science';

/**
 * Claude Code's default config directory — the fallback root when neither the
 * CLAUDE_CONFIG_DIR environment variable nor a recorded snapshot points
 * elsewhere. Sessions live under `<dir>/projects/`.
 */
export const DEFAULT_CLAUDE_CONFIG_DIR = '~/.claude';

/**
 * Expand a leading `~` / `~/…` to the user's home directory. We persist the
 * literal `~/.claude-science` (portable across machines and accounts) and
 * expand only at the point of use — so every reader must funnel through here
 * rather than sprinkling `.replace('~', …)`. A non-tilde path is returned
 * untouched; `~user` (another user's home) is intentionally NOT supported.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** A working directory entry — was `Project` before the concept rename. */
export interface ProjectCwd {
  /** slug — matches /^[A-Za-z0-9][A-Za-z0-9_-]*$/ */
  id: string;
  name: string;
  /** the single absolute cwd whose coding-agent sessions belong to this entry */
  cwd: string;
}

/**
 * A project entity aligned with the Tanka backend (was `ProjectGroup`).
 * Membership is EXCLUSIVE — a cwd id appears in at most one project's `cwdIds`.
 */
export interface Project {
  /** local slug, unique among projects in this config */
  id: string;
  /** backend 12-char nanoid returned by createProject / provided when joining */
  remoteProjectId: string;
  /** display name (editable locally; backend has no update endpoint) */
  name: string;
  /** ids of the cwds in this project */
  cwdIds: string[];
  /** whether this project was created by us or joined from someone else */
  origin: 'created' | 'joined';
  /**
   * The Tanka environment this project belongs to. A project's remoteProjectId
   * is issued by exactly one env's backend, so env is an intrinsic property of
   * the project — the Board / sync only ever show projects of the *current*
   * credentials.env. Optional only for backward compat with pre-env configs;
   * `ensureProjectsEnv` backfills it on first load.
   */
  env?: TankaEnv;
}

/**
 * The Tanka deployment a token targets. Each maps to a base URL constant in
 * upload/tanka-client.ts. `prod` is the default for anything unspecified.
 */
export type TankaEnv = 'dev' | 'test' | 'uat' | 'prod';
export const TANKA_ENVS: readonly TankaEnv[] = ['dev', 'test', 'uat', 'prod'];
export const DEFAULT_TANKA_ENV: TankaEnv = 'prod';

export interface Credentials {
  /** raw apiKey from /open/auth/mcp/api-key/work-memory; sent as the `token` header */
  token: string;
  /** which Tanka environment this token is for; selects the upload base URL */
  env: TankaEnv;
}

/**
 * Run mode — chosen in the wizard's first step.
 *   'all'    — every coding-agent session on the machine, re-discovered each
 *              sync (new dirs auto-included); no cwd list to maintain.
 *   'select' — only the sessions belonging to the cwds the user picked.
 */
export type RunMode = 'all' | 'select';
export const RUN_MODES: readonly RunMode[] = ['all', 'select'];

/**
 * Where the first-run wizard is up to. 'done' (or absent on a pre-existing
 * config) means the app boots straight to the Board.
 */
export type WizardStep = 'mode' | 'projects' | 'tanka' | 'cron' | 'done';
const WIZARD_STEPS: readonly WizardStep[] = [
  'mode',
  'projects',
  'tanka',
  'cron',
  'done',
];

export interface Config {
  version: 1;
  cwds: ProjectCwd[];
  /** projects (select mode only); absent when none exist */
  projects?: Project[];
  /** chosen run mode; absent until the wizard's first step records it */
  mode?: RunMode;
  /** absent until the wizard records progress (or detects a pre-existing setup) */
  wizardStep?: WizardStep;
  /** stable UUID for this installation, auto-generated on first run */
  deviceId?: string;
  /** user-editable device label, pre-filled from platform hostname */
  deviceName?: string;
  /**
   * claude-science data directory, stored as a literal (default
   * `~/.claude-science`, see DEFAULT_SCIENCE_DIR). Expand with `expandHome`
   * before touching the filesystem. Absent means "use the default".
   */
  scienceDir?: string;
  /**
   * Snapshot of the CLAUDE_CONFIG_DIR environment variable, recorded on every
   * run that can see it (see `ensureClaudeConfigDir`). It exists solely for the
   * scheduled/cron path, which inherits no shell environment and therefore has
   * no other way to learn where Claude Code actually keeps its sessions.
   *
   * A snapshot goes stale the moment the user re-points CLAUDE_CONFIG_DIR and
   * doesn't run tanka-wm interactively again. That is tolerable only because
   * discovery treats the resolved directories as a SET (see
   * `claudeRootCandidates` in discovery/sessions.ts) rather than as the one true
   * root: a stale entry costs one extra empty directory to scan, it never
   * shadows the live one. Absent means "no non-default dir has been seen".
   */
  claudeConfigDir?: string;
}

export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function emptyConfig(): Config {
  return { version: 1, cwds: [] };
}

/** Write JSON atomically (tmp file + rename) so a crash never leaves a half file. */
function atomicWriteJson(path: string, value: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* best effort — some filesystems reject chmod */
  }
}

/** True once the config file exists — i.e. setup has been run at least once. */
export function configExists(): boolean {
  return existsSync(configPath());
}

/**
 * Load config.json, falling back to an empty config when absent or corrupt.
 * Handles migration from the pre-rename format where `projects` held cwd entries
 * and `groups` held project groups (now `cwds` and `projects` respectively).
 */
export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<
      string,
      unknown
    >;

    // ── migrate: old `projects` (cwd entries) → `cwds`; old `groups` → `projects` ──
    const rawCwds = Array.isArray(raw.cwds)
      ? raw.cwds
      : Array.isArray(raw.projects)
        ? raw.projects
        : [];
    const rawProjects = Array.isArray(raw.projects)
      ? // If raw.projects contains objects with cwdIds → new format; if they have cwd → old format (cwd entries, not projects).
        (raw.projects as unknown[]).some(
          (p) => !!p && typeof p === 'object' && 'cwdIds' in p,
        )
        ? raw.projects
        : Array.isArray(raw.groups)
          ? raw.groups
          : []
      : Array.isArray(raw.groups)
        ? raw.groups
        : [];

    // Normalise project entries: old `projectIds` field → `cwdIds`
    const migrateProject = (
      p: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (Array.isArray(p.projectIds) && !Array.isArray(p.cwdIds)) {
        return { ...p, cwdIds: p.projectIds };
      }
      return p;
    };

    const cwds = rawCwds.filter(isProjectCwd);
    const projects = (rawProjects as unknown[])
      .map((p) =>
        p && typeof p === 'object'
          ? migrateProject(p as Record<string, unknown>)
          : p,
      )
      .filter(isProject)
      .map(normalizeProjectEnv);

    return {
      version: 1,
      cwds,
      ...(projects.length ? { projects } : {}),
      ...(raw.mode === 'all' || raw.mode === 'select'
        ? { mode: raw.mode as RunMode }
        : {}),
      ...(typeof raw.wizardStep === 'string' &&
      WIZARD_STEPS.includes(raw.wizardStep as WizardStep)
        ? { wizardStep: raw.wizardStep as WizardStep }
        : {}),
      ...(typeof raw.deviceId === 'string' ? { deviceId: raw.deviceId } : {}),
      ...(typeof raw.deviceName === 'string'
        ? { deviceName: raw.deviceName }
        : {}),
      ...(typeof raw.scienceDir === 'string'
        ? { scienceDir: raw.scienceDir }
        : {}),
      ...(typeof raw.claudeConfigDir === 'string'
        ? { claudeConfigDir: raw.claudeConfigDir }
        : {}),
    };
  } catch {
    return emptyConfig();
  }
}

/**
 * Ensure `deviceId` (stable UUID) and `deviceName` (platform hostname) exist
 * in the config. Called once at startup — both TUI and headless `sync` paths.
 * Writes to disk only when a field was missing; no-op on subsequent runs.
 */
export function ensureDeviceIdentity(config: Config): Config {
  let changed = false;
  let next = config;
  if (!next.deviceId) {
    next = { ...next, deviceId: randomUUID() };
    changed = true;
  }
  if (!next.deviceName) {
    next = { ...next, deviceName: defaultDeviceName() };
    changed = true;
  }
  if (changed) saveConfig(next);
  return next;
}

/**
 * Record the current CLAUDE_CONFIG_DIR into the config, so the scheduled/cron
 * path — which inherits no shell environment — can still find Claude Code's
 * sessions. Called at startup next to {@link ensureDeviceIdentity}, from both
 * the TUI and the headless `sync`.
 *
 * Rules, in order:
 *   - variable unset (every cron run, and any shell that doesn't export it):
 *     leave the existing snapshot ALONE. Absence of the variable is not
 *     evidence that the directory changed, and clearing the snapshot here would
 *     erase the only clue the cron path has.
 *   - variable set to the default `~/.claude`: drop the snapshot — the default
 *     root is always scanned anyway, so recording it is pure noise.
 *   - variable set to anything else: store it verbatim (the value the user
 *     exported, `~` and all; readers expand it).
 *
 * Writes to disk only when the stored value actually changes.
 */
export function ensureClaudeConfigDir(config: Config): Config {
  const raw = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return config;

  const isDefault =
    expandHome(raw).replace(/[/\\]+$/, '') ===
    expandHome(DEFAULT_CLAUDE_CONFIG_DIR);
  const want = isDefault ? undefined : raw;
  if (want === config.claudeConfigDir) return config;

  const next = { ...config };
  if (want === undefined) delete next.claudeConfigDir;
  else next.claudeConfigDir = want;
  saveConfig(next);
  return next;
}

function defaultDeviceName(): string {
  if (process.platform === 'darwin') {
    try {
      const { execSync } =
        require('node:child_process') as typeof import('node:child_process');
      const name = execSync('scutil --get ComputerName', {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (name) return name;
    } catch {
      /* fall through */
    }
  }
  return hostname();
}

export function saveConfig(config: Config): void {
  atomicWriteJson(configPath(), config, 0o644);
}

export function loadCredentials(): Credentials | null {
  try {
    const raw = JSON.parse(
      readFileSync(credentialsPath(), 'utf8'),
    ) as Partial<Credentials>;
    if (typeof raw.token === 'string' && raw.token.length > 0) {
      // migrate pre-env credentials (token only) → prod; reject bad env values
      const env =
        typeof raw.env === 'string' && TANKA_ENVS.includes(raw.env)
          ? raw.env
          : DEFAULT_TANKA_ENV;
      return { token: raw.token, env };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function saveCredentials(creds: Credentials): void {
  atomicWriteJson(credentialsPath(), creds, 0o600);
}

/** Absolute home dir, exposed for the "where is my config" line in the UI. */
export function configHome(): string {
  return tuiHome();
}

function isProjectCwd(p: unknown): p is ProjectCwd {
  return (
    !!p &&
    typeof p === 'object' &&
    typeof (p as ProjectCwd).id === 'string' &&
    typeof (p as ProjectCwd).name === 'string' &&
    typeof (p as ProjectCwd).cwd === 'string'
  );
}

function isProject(g: unknown): g is Project {
  if (
    !g ||
    typeof g !== 'object' ||
    typeof (g as Project).id !== 'string' ||
    typeof (g as Project).name !== 'string' ||
    !Array.isArray((g as Project).cwdIds) ||
    !(g as Project).cwdIds.every((x) => typeof x === 'string')
  )
    return false;
  const p = g as Project;
  if (typeof p.remoteProjectId !== 'string' || p.remoteProjectId.length === 0)
    return false;
  if (p.origin !== 'created' && p.origin !== 'joined') return false;
  return true;
}

/**
 * A hand-edited config can carry an invalid `env` string on a project. Rather
 * than letting it make the project invisible in every env (no env would ever
 * match it), drop the bad value so the project falls back to "no env" and gets
 * shown under / backfilled to the current env. Never discards the project itself.
 */
function normalizeProjectEnv(p: Project): Project {
  if (p.env === undefined || TANKA_ENVS.includes(p.env)) return p;
  const next = { ...p };
  delete next.env;
  return next;
}

/**
 * The configured projects belonging to `env`. A legacy project with no `env`
 * (pre-env config) is treated as the current env so it stays visible until
 * `ensureProjectsEnv` backfills it. This is the single read-path for select
 * mode display / scan — never read `config.projects` directly for those (doing
 * so leaks other envs' projects into the current view).
 */
export function projectsForEnv(config: Config, env: TankaEnv): Project[] {
  return (config.projects ?? []).filter((p) => (p.env ?? env) === env);
}

/**
 * Backfill `env` on legacy projects that predate env-scoping, persisting the
 * result. A project's remoteProjectId is issued by one env's backend, so a
 * project with no env is assumed to belong to `env` (the caller's current
 * credentials.env). MUST be called only where credentials are known to exist —
 * i.e. the sync path — never from the TUI on a possibly-absent token, which
 * would permanently mislabel projects as the default env. No-op once every
 * project has an env.
 */
export function ensureProjectsEnv(config: Config, env: TankaEnv): Config {
  if (!config.projects?.some((p) => p.env === undefined)) return config;
  const projects = config.projects.map((p) =>
    p.env === undefined ? { ...p, env } : p,
  );
  const next = { ...config, projects };
  saveConfig(next);
  return next;
}

/**
 * Resolve a user-supplied project argument to a remoteProjectId: accepts a
 * local project id or a raw remoteProjectId; unknown values pass through
 * verbatim (all-mode / foreign projects). Shared by `sync [proj]` and migrate
 * so the two commands can't drift on resolution semantics.
 */
export function resolveProjectId(
  config: Config,
  env: TankaEnv,
  arg: string,
): string {
  return (
    projectsForEnv(config, env).find(
      (p) => p.id === arg || p.remoteProjectId === arg,
    )?.remoteProjectId ?? arg
  );
}

/**
 * Re-point a select-mode project at a new remoteProjectId — the config half of
 * a server-side project data migration (`/project/change`). If a project for
 * `targetRemoteId` already exists in the same env, the source's cwds are merged
 * into it and the source entry is dropped (cwd membership is exclusive within
 * an env); otherwise the source entry itself is rewritten to the target id
 * (the local id follows, matching the id === remoteProjectId convention).
 * Returns the updated config, or `null` when no project references the source.
 */
export function remapConfigProject(
  config: Config,
  env: TankaEnv,
  sourceRemoteId: string,
  targetRemoteId: string,
): Config | null {
  const inEnv = projectsForEnv(config, env);
  const source = inEnv.find((p) => p.remoteProjectId === sourceRemoteId);
  if (!source) return null;
  const target = inEnv.find((p) => p.remoteProjectId === targetRemoteId);
  const projects = (config.projects ?? [])
    .filter((p) => p !== source || target === undefined)
    .map((p) => {
      if (target !== undefined && p === target)
        return { ...p, cwdIds: [...new Set([...p.cwdIds, ...source.cwdIds])] };
      if (target === undefined && p === source)
        return { ...p, id: targetRemoteId, remoteProjectId: targetRemoteId };
      return p;
    });
  return { ...config, projects };
}

/**
 * The project a cwd belongs to within a given env, or undefined. Membership is
 * exclusive *within an env* — the same cwd can belong to a test project and a
 * prod project at once (each env's backend has its own project for it), so the
 * env scopes the lookup.
 */
export function projectForCwd(
  config: Config,
  cwdId: string,
  env: TankaEnv,
): Project | undefined {
  return projectsForEnv(config, env).find((p) => p.cwdIds.includes(cwdId));
}
