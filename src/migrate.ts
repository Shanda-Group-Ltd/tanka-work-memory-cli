/**
 * Project data migration — the client side of POST /project/change.
 *
 * Order matters: the backend moves the server-side data first; only after that
 * succeeds is the local state re-pointed at the target — the upload manifest
 * shard (sync progress), the all-mode project-map, and the select-mode config
 * entry — so subsequent syncs report to the target project instead of
 * recreating data under the source. The whole operation runs under the sync
 * lock so a concurrent cron sync can't write the source namespace mid-move.
 *
 * Two entry points:
 *  - runMigrate(sourceId, targetId)   — by project id (CLI default, select TUI)
 *  - runMigrateForCwd(dir, targetId)  — by directory (all mode): a mapped dir
 *    migrates its project's data; an unmapped dir has nothing to move yet, so
 *    it JOINS the target project and records the cwd binding instead — the
 *    first sync then uploads there directly (no lazy create).
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { createApiClient } from './api/client';
import { changeProject, joinProject } from './api/work-memory';
import {
  type Config,
  type Credentials,
  loadConfig,
  loadCredentials,
  remapConfigProject,
  resolveProjectId,
  saveConfig,
} from './config/config';
import {
  lookupRemoteProjectId,
  recordProjectMapping,
  remapProjectId,
} from './config/project-map';
import { migrateProjectManifest } from './config/uploads';
import {
  isScienceCwd,
  owningWorktree,
  parseScienceCwd,
} from './discovery/sessions';
import { acquireSyncLock, type SyncLock } from './sync-lock';

export interface MigrateOptions {
  /**
   * Use this config instead of reading config.json — the TUI passes its
   * context state here so the re-pointed config flows back through React
   * (via `persistConfig` = setConfig) instead of silently diverging on disk.
   */
  config?: Config;
  /** persist hook for the re-pointed config; defaults to saveConfig (config.json) */
  persistConfig?: (config: Config) => void;
  /** credentials override (TUI context); defaults to loadCredentials() */
  credentials?: Credentials | null;
}

/**
 * Discriminated by what actually happened: a data move reports the local
 * re-point stats; a join (unmapped dir, nothing to move) only names the
 * target it bound to — the shapes are distinct so callers can't misread
 * one action's stats as the other's.
 */
export type MigrateResult =
  | {
      action: 'migrated';
      sourceRemoteId: string;
      targetRemoteId: string;
      /** manifest records (sync progress) moved into the target namespace */
      manifestMoved: number;
      /** all-mode cwd mappings re-pointed at the target */
      cwdsRemapped: number;
      /** whether a select-mode project entry was rewritten / merged */
      configUpdated: boolean;
    }
  | { action: 'joined'; targetRemoteId: string };

/** Shared core: server call first, local re-point on success. Caller holds the lock. */
async function moveProjectData(
  credentials: Credentials,
  config: Config,
  source: string,
  target: string,
  persistConfig: (config: Config) => void,
): Promise<MigrateResult> {
  if (source === target)
    throw new Error('source and target are the same project');
  await changeProject(createApiClient(credentials), source, target);

  const env = credentials.env;
  const manifestMoved = migrateProjectManifest(env, source, target);
  const cwdsRemapped = remapProjectId(env, source, target);
  const updated = remapConfigProject(config, env, source, target);
  if (updated) persistConfig(updated);

  return {
    action: 'migrated',
    sourceRemoteId: source,
    targetRemoteId: target,
    manifestMoved,
    cwdsRemapped,
    configUpdated: updated !== null,
  };
}

function withLock<T>(fn: (lock: SyncLock) => Promise<T>): Promise<T> {
  const lock = acquireSyncLock();
  if (!lock) throw new Error('another sync is running — try again later');
  return fn(lock).finally(() => lock.release());
}

function requireCredentials(opts: MigrateOptions): Credentials {
  const credentials = opts.credentials ?? loadCredentials();
  if (!credentials)
    throw new Error('token not configured — run the TUI wizard first');
  return credentials;
}

/**
 * Migrate one project's data into another, by project id. Each argument is a
 * local project id or a raw remoteProjectId (same resolution as `sync [proj]`).
 */
export function runMigrate(
  sourceArg: string,
  targetArg: string,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const credentials = requireCredentials(opts);
  return withLock(async () => {
    // Load config under the lock so the re-pointed version saved below can't
    // clobber a concurrent writer's changes (injected config follows the TUI's
    // "loaded once, mutated through context" model instead).
    const config = opts.config ?? loadConfig();
    const env = credentials.env;
    return moveProjectData(
      credentials,
      config,
      resolveProjectId(config, env, sourceArg),
      resolveProjectId(config, env, targetArg),
      opts.persistConfig ?? saveConfig,
    );
  });
}

/**
 * Migrate by DIRECTORY (all mode). The directory is resolved and folded to its
 * owning git worktree (matching how sync records project-map keys), then:
 *  - mapped → its remote project's data moves to the target (normal migrate);
 *  - unmapped → join the target project + record the cwd→target binding, so
 *    the first sync uploads there directly. Holding the sync lock here also
 *    keeps the project-map write from racing a concurrent cron sync.
 */
export function runMigrateForCwd(
  cwdArg: string,
  targetArg: string,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const credentials = requireCredentials(opts);
  return withLock(async () => {
    const config = opts.config ?? loadConfig();
    const env = credentials.env;
    // A science cwd is a synthetic identifier: don't resolve it (path.resolve
    // mangles the URI) or fold it to a worktree (git finds nothing) — use it
    // verbatim as the project-map key. Anything science-shaped (the loose
    // `claude-science:` prefix catches single-slash typos that path.resolve
    // would otherwise mangle into an internal-assertion error downstream) must
    // parse as a full org/proj URI, or the user gets a clear input error here.
    let cwd: string;
    // 'claude-science:/' (not the bare 'claude-science:') so a REAL relative
    // directory named e.g. `claude-science:notes` (colon is legal on POSIX)
    // still resolves as a path; the slash-ful forms are unambiguous URIs/typos.
    if (cwdArg.startsWith('claude-science:/')) {
      if (!parseScienceCwd(cwdArg))
        throw new Error(
          `invalid claude-science cwd "${cwdArg}" — expected claude-science://<org_id>/<proj_id>`,
        );
      cwd = cwdArg;
    } else {
      cwd = owningWorktree(path.resolve(cwdArg));
    }
    const target = resolveProjectId(config, env, targetArg);

    const source = lookupRemoteProjectId(env, cwd);
    if (source) {
      return moveProjectData(
        credentials,
        config,
        source,
        target,
        opts.persistConfig ?? saveConfig,
      );
    }

    // No mapping. Require the directory to actually exist before joining —
    // a mapped-but-deleted dir is a valid migrate source above, but an
    // unmapped non-directory is almost certainly a typo or a project id. A
    // science cwd is never a real directory, so skip the guard: an unmapped
    // science project legitimately joins the target (first sync uploads there).
    if (!isScienceCwd(cwd)) {
      let isDir = false;
      try {
        isDir = statSync(cwd).isDirectory();
      } catch {
        /* missing — handled below */
      }
      if (!isDir)
        throw new Error(
          `${cwd} is not a directory (and has no project mapping) — pass a project id instead?`,
        );
    }

    await joinProject(createApiClient(credentials), target);
    recordProjectMapping(env, cwd, target);
    return { action: 'joined', targetRemoteId: target };
  });
}
