/**
 * Headless incremental sync — discover sessions, upload files to S3, then
 * POST /sync to register them with the work-memory backend. Drives both the
 * `tanka-wm sync` cron command and the Board's "sync now" action.
 *
 * Two run modes (config.mode):
 *   'all'    — re-discover every coding-agent session on the machine; each
 *              cwd lazily creates a remote project via the API on first sync.
 *   'select' — only the sessions of the user's configured projects.
 *
 * Manifest namespace = remoteProjectId (both modes). For all mode, cwds that
 * have never synced (no mapping yet) are treated as "new" and get a namespace
 * after their remote project is lazily created.
 */
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import type { AxiosInstance } from 'axios';

import { createApiClient, listProjects, syncProject } from './api';
import type { SyncSessionItem } from './api/types';
import { createProject as apiCreateProject } from './api/work-memory';
import {
  DEFAULT_SCIENCE_DIR,
  ensureDeviceIdentity,
  ensureProjectsEnv,
  expandHome,
  loadConfig,
  loadCredentials,
  type Project,
  projectsForEnv,
  type TankaEnv,
} from './config/config';
import { scienceExportDir, scienceExportLockPath } from './config/paths';
import {
  lookupRemoteProjectId,
  pruneProjectMap,
  recordProjectMapping,
} from './config/project-map';
import {
  buildSidecarSnapshot,
  dropProjectManifest,
  loadManifest,
  pruneManifest,
  reconcileManifest,
  recordUpload,
  sidecarDelta,
  uploadStatus,
} from './config/uploads';
import { runScienceExport } from './discovery/science-export';
import {
  discoverAllSessions,
  discoverSessionsForProject,
  type SessionRef,
  syntheticCwdFor,
} from './discovery/sessions';
import { log } from './log';
import { acquireScienceExportLock, acquireSyncLock } from './sync-lock';
import {
  TokenExpiredError,
  type UploadOutcome,
  type UploadProgress,
  uploadSession,
} from './upload/tanka-client';

export interface SyncEvent {
  phase: 'discover' | 'upload' | 'done';
  project?: string;
  session?: string;
  index?: number;
  total?: number;
  fileProgress?: UploadProgress;
  projectIndex?: number;
  projectTotal?: number;
  projectName?: string;
}

export interface SyncResult {
  uploaded: number;
  failed: number;
  skipped: number;
  cleaned: number;
  errors: string[];
  /** true when the run was skipped because another sync held the lock */
  lockSkipped?: boolean;
}

export interface SyncOptions {
  /** select mode: limit to this remoteProjectId (matches the manifest namespace). */
  remoteProjectId?: string;
  /** all mode: limit to this cwd. */
  cwd?: string;
  /**
   * Limit to a single session id and force-upload it even if up-to-date —
   * the `u` single-session action. When set, the normal "skip current" filter
   * is bypassed for that one session.
   */
  sessionId?: string;
  onEvent?: (e: SyncEvent) => void;
}

const DEFAULT_LOOKBACK_DAYS = 14;
// backend caps /sync sessions[] at 500; stay well under (see APPLY_BATCH_SIZE in tanka-client.ts)
const SYNC_BATCH_SIZE = 300;
const SYNC_MAX_RETRIES = 3;

async function ensureRemoteProject(
  client: AxiosInstance,
  env: TankaEnv,
  cwdPath: string,
  displayName: string,
): Promise<string> {
  const existing = lookupRemoteProjectId(env, cwdPath);
  if (existing) return existing;
  const resp = await apiCreateProject(client, {
    displayName,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    reportLanguage: 'en',
  });
  const remoteId = resp.projectId;
  recordProjectMapping(env, cwdPath, remoteId);
  log('info', 'sync', `created remote project ${remoteId} for ${displayName}`);
  return remoteId;
}

/**
 * Run the claude-science export (SQLite → export dir) so discovery sees a fresh
 * session tree. Best-effort: any failure is logged and swallowed so it can't
 * abort a sync that would otherwise upload other agents' sessions.
 *
 * Self-guarding, so both callers (a sync's export step and an interactive Board
 * refresh) share one implementation:
 *   - Windows: claude-science is macOS/Linux-only, so the export is a hard
 *     no-op — never touch the DB or spawn the exporter there.
 *   - No `orgs/` dir under the science dir: nothing to export, return before
 *     taking any lock (keeps the Board's per-refresh cost to a single stat for
 *     the majority who don't use claude-science).
 *   - Otherwise hold the *science-export* lock (NOT the sync lock) for the
 *     export's duration so an interactive refresh and a sync/cron export can't
 *     rewrite the same session dirs at once. A held lock → another export is
 *     already running → skip (discovery tolerates it; the next run self-heals).
 */
async function refreshScienceExport(
  scienceDir: string | undefined,
): Promise<void> {
  if (process.platform === 'win32') return; // claude-science: macOS/Linux only
  // EVERYTHING below sits in one try: acquireScienceExportLock (mkdirSync /
  // openSync can throw on an unwritable state dir) must not escape either —
  // a throw here would abort the whole sync / error the Board's discovery.
  try {
    const dir = expandHome(scienceDir ?? DEFAULT_SCIENCE_DIR);
    const outDir = scienceExportDir();
    // Cheap gate: skip the lock entirely when there is neither a source to
    // export NOR a previously exported tree to prune (the source-removed case
    // still needs a run so runScienceExport can clear the stale tree).
    if (!existsSync(join(dir, 'orgs')) && !existsSync(outDir)) return;
    const lock = acquireScienceExportLock();
    if (!lock) return; // another export mid-write; it covers this refresh
    // Heartbeat: the lock machinery steals any lock older than STALE_MS by
    // mtime alone, even from a LIVE holder — a first-time export of a huge
    // dataset running past that would get its staging wiped by a second
    // writer. Touching the file keeps its mtime fresh, so stealers fall into
    // the "read the pid, it's alive, don't steal" branch instead.
    const heartbeat = setInterval(
      () => {
        try {
          const now = new Date();
          utimesSync(scienceExportLockPath(), now, now);
        } catch {
          /* lock gone (stolen/cleaned) — nothing to keep alive */
        }
      },
      5 * 60 * 1000,
    );
    try {
      const s = await runScienceExport({ scienceDir: dir, outDir });
      for (const w of s.warnings) log('warn', 'sync', `science-export: ${w}`);
      if (s.projects.length > 0) {
        const c = s.counts;
        log(
          'info',
          'sync',
          `science-export: ${s.projects.length} project(s) — ` +
            `+${c.created} ~${c.updated} .${c.skipped} -${c.pruned}` +
            (s.incomplete.length
              ? ` (${s.incomplete.length} still running)`
              : ''),
        );
      }
    } finally {
      clearInterval(heartbeat);
      lock.release();
    }
  } catch (e: unknown) {
    log(
      'warn',
      'sync',
      `science-export failed (skipping science sessions this run): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * Refresh the science export from an interactive context (the Board / cwd
 * picker) so newly-created or updated science projects show up. Thin wrapper:
 * `refreshScienceExport` already self-guards (Windows no-op, existence gate,
 * science-export lock), and crucially does NOT take the *sync* lock — so a
 * routine display refresh can never make a concurrent `runSync` report "another
 * sync is already running". Best-effort, never throws.
 */
export async function refreshScienceExportInteractive(
  scienceDir: string | undefined,
): Promise<void> {
  await refreshScienceExport(scienceDir);
}

/**
 * The agent type sent to the backend. `cowork` is a Claude Desktop variant of
 * Claude Code and folds into `claude-code`; `codex` and `claude-science` pass
 * through as their own enums (the backend recognises both). A whitelist, not a
 * narrowing default — an unknown agent falls back to `claude-code` rather than
 * being silently mislabelled as a science session.
 */
type SyncAgent = 'claude-code' | 'codex' | 'claude-science';
function syncAgent(agent: string): SyncAgent {
  if (agent === 'codex') return 'codex';
  if (agent === 'claude-science') return 'claude-science';
  return 'claude-code';
}

/**
 * Classify a sidecar file into a `sidecarType` tag by its session-relative
 * path. claude-science groups its sidecars by top-level dir: `details/*` →
 * "details", `artifacts/**` → "artifacts", and the lone `meta.json` → "meta".
 * Claude Code's sidecars are keyed by their own subdir prefixes.
 */
export function classifySidecar(agent: string, relPath: string): string {
  if (agent === 'claude-science') {
    const slash = relPath.indexOf('/');
    if (slash > 0) return relPath.slice(0, slash); // 'details' | 'artifacts'
    return relPath.replace(/\.[^.]+$/, ''); // 'meta.json' → 'meta'
  }
  if (relPath.startsWith('subagents/')) return 'subagent';
  if (relPath.startsWith('tool-results/')) return 'tool-result';
  return 'sidecar';
}

/**
 * Build one SyncSessionItem per uploaded file. The transcript is the primary
 * session; each sidecar file is its own item carrying `parentSessionId` +
 * `sidecarType` in meta so the backend can relate them back.
 */
function buildSyncItems(
  ref: SessionRef,
  outcome: UploadOutcome,
  deviceId: string,
  deviceName: string,
): SyncSessionItem[] {
  const sidecarByRel = new Map(ref.sidecarFiles.map((f) => [f.relPath, f]));
  const baseMeta = { ...ref.meta, detailType: ref.agent, deviceId, deviceName };

  return outcome.files.map((f): SyncSessionItem => {
    if (f.relPath === 'transcript.jsonl') {
      return {
        id: ref.id,
        agent: syncAgent(ref.agent),
        path: ref.path,
        cwd: ref.cwd,
        mtimeMs: Math.round(ref.mtimeMs),
        sizeBytes: ref.sizeBytes,
        meta: baseMeta,
        fileId: f.fileId,
        objectStorageUri: f.url,
      };
    }
    const sc = sidecarByRel.get(f.relPath);
    return {
      id: `${ref.id}/${f.relPath}`,
      agent: syncAgent(ref.agent),
      path: sc?.absPath ?? f.relPath,
      cwd: ref.cwd,
      mtimeMs: Math.round(sc?.mtimeMs ?? ref.mtimeMs),
      sizeBytes: f.sizeBytes,
      meta: {
        ...baseMeta,
        parentSessionId: ref.id,
        sidecarType: classifySidecar(ref.agent, f.relPath),
        sidecarPath: f.relPath,
      },
      fileId: f.fileId,
      objectStorageUri: f.url,
    };
  });
}

/**
 * POST /sync in batches of SYNC_BATCH_SIZE with per-batch retry. Throws on
 * any batch failure after SYNC_MAX_RETRIES attempts — the caller treats the
 * entire session as failed and does not update the manifest.
 */
async function syncBatched(
  client: AxiosInstance,
  projectId: string,
  items: SyncSessionItem[],
): Promise<void> {
  for (let i = 0; i < items.length; i += SYNC_BATCH_SIZE) {
    const chunk = items.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
        const syncResp = await syncProject(client, projectId, {
          lookbackDays: DEFAULT_LOOKBACK_DAYS,
          sessions: chunk,
        });
        if (Array.isArray(syncResp?.errors) && syncResp.errors.length > 0) {
          throw new Error(
            `backend reported ${syncResp.errors.length} item error(s): ${JSON.stringify(
              syncResp.errors,
            ).slice(0, 200)}`,
          );
        }
        lastError = undefined;
        break;
      } catch (e: unknown) {
        if (e instanceof TokenExpiredError) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < SYNC_MAX_RETRIES) {
          const delayMs = 1000 * 2 ** (attempt - 1);
          log(
            'warn',
            'sync',
            `sync batch ${batchNum} attempt ${attempt} failed: ${lastError.message} — retrying in ${delayMs}ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    if (lastError) throw lastError;
  }
}

/**
 * Fetch the set of remoteProjectIds the current user belongs to on the server,
 * following cursor pagination so a user with more projects than one page still
 * gets a complete set. Used for pre-validation (skip / self-heal projects that
 * were deleted server-side).
 *
 * Returns an empty set on a *transient* failure (network), which callers MUST
 * treat as "pre-validation unavailable, don't skip anything" — never as "no
 * projects exist". A 401 is fatal and re-thrown so the whole sync aborts with a
 * clear TokenExpiredError instead of silently degrading.
 */
async function fetchRemoteProjectIds(
  client: AxiosInstance,
): Promise<Set<string>> {
  const PAGE = 500;
  const MAX_PAGES = 50;
  const ids = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  try {
    do {
      // listProjects returns the unwrapped `data` (typed any) — its shape varies
      // across backend versions, so probe the common envelopes defensively.
      const resp = await listProjects(client, {
        pageSize: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      const items =
        resp?.content ?? resp?.list ?? (Array.isArray(resp) ? resp : []);
      for (const it of items) {
        if (it?.projectId) ids.add(String(it.projectId));
      }
      cursor = resp?.cursor ?? resp?.nextCursor ?? undefined;
      pages += 1;
      // A full page with no continuation cursor means the backend doesn't speak
      // the cursor pagination we assume (e.g. page-number paging) — we may have
      // only the first page. Acting on a partial list would wrongly skip/delete
      // still-existing projects, so degrade to "pre-validation unavailable".
      if (!cursor && items.length >= PAGE) {
        log(
          'warn',
          'sync',
          'project list looks paginated in an unsupported way — skipping pre-validation this run',
        );
        return new Set();
      }
    } while (cursor && pages < MAX_PAGES);
    // Hit the page cap while a cursor still pointed further — list is incomplete.
    if (cursor) {
      log(
        'warn',
        'sync',
        `project list exceeded ${MAX_PAGES}-page cap — skipping pre-validation this run`,
      );
      return new Set();
    }
    return ids;
  } catch (e: unknown) {
    if (e instanceof TokenExpiredError) throw e; // auth failure is fatal
    const msg = e instanceof Error ? e.message : String(e);
    log(
      'warn',
      'sync',
      `project pre-validation unavailable (${msg}) — proceeding without it`,
    );
    return new Set();
  }
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const lock = acquireSyncLock();
  if (!lock) {
    log('warn', 'sync', 'another sync is already running — skipping this run');
    return {
      uploaded: 0,
      failed: 0,
      skipped: 0,
      cleaned: 0,
      errors: [],
      lockSkipped: true,
    };
  }
  try {
    return await runSyncLocked(opts);
  } finally {
    lock.release();
  }
}

async function runSyncLocked(opts: SyncOptions): Promise<SyncResult> {
  let config = ensureDeviceIdentity(loadConfig());
  const credentials = loadCredentials();
  if (!credentials) {
    log('error', 'sync', 'aborted — Tanka token is not configured');
    throw new Error('Tanka token is not configured');
  }
  const { token, env } = credentials;
  config = ensureProjectsEnv(config, env);
  const deviceId = config.deviceId ?? '';
  const deviceName = config.deviceName ?? '';
  const apiClient = createApiClient(credentials);

  // Refresh the claude-science export before discovery so its session tree is
  // current. Cheap + incremental (unchanged sessions skip via signature). Held
  // under the sync lock. A failure here must not sink the whole sync — other
  // agents' sessions still upload — so log and carry on.
  await refreshScienceExport(config.scienceDir);

  const result: SyncResult = {
    uploaded: 0,
    failed: 0,
    skipped: 0,
    cleaned: 0,
    errors: [],
  };
  let manifest = loadManifest(env);

  const pruneScope = (ns: string, refs: readonly SessionRef[]): void => {
    const pruned = pruneManifest(
      env,
      manifest,
      ns,
      new Set(refs.map((r) => r.id)),
    );
    manifest = pruned.manifest;
    result.cleaned += pruned.removed;
    if (pruned.removed > 0) {
      log('info', 'sync', `${ns}: pruned ${pruned.removed} stale record(s)`);
    }
  };

  const uploadOneRef = async (
    remoteProjectId: string,
    ref: SessionRef,
    i: number,
    total: number,
    pCtx?: { projectIndex: number; projectTotal: number; projectName: string },
  ): Promise<void> => {
    opts.onEvent?.({
      phase: 'upload',
      project: remoteProjectId,
      session: ref.id,
      index: i,
      total,
      ...pCtx,
    });
    try {
      const delta = sidecarDelta(
        manifest,
        remoteProjectId,
        ref.id,
        ref.sidecarFiles,
      );

      const outcome = await uploadSession(
        token,
        env,
        ref,
        (fileProgress) =>
          opts.onEvent?.({
            phase: 'upload',
            project: remoteProjectId,
            session: ref.id,
            index: i,
            total,
            fileProgress,
            ...pCtx,
          }),
        remoteProjectId,
        delta,
      );

      const syncItems = buildSyncItems(ref, outcome, deviceId, deviceName);
      await syncBatched(apiClient, remoteProjectId, syncItems);

      manifest = recordUpload(env, manifest, {
        projectId: remoteProjectId,
        sessionId: ref.id,
        agent: syncAgent(ref.agent),
        uploadedAt: new Date().toISOString(),
        fileCount: outcome.fileCount,
        sizeBytes: outcome.sizeBytes,
        transcriptMtimeMs: Math.round(ref.mtimeMs),
        transcriptSizeBytes: ref.sizeBytes,
        sidecars: buildSidecarSnapshot(ref.sidecarFiles),
      });
      result.uploaded += 1;
      log(
        'info',
        'sync',
        `synced ${remoteProjectId}/${ref.id} (${outcome.fileCount} files, ${ref.sidecarFiles.length - delta.length} unchanged sidecars skipped)`,
      );
    } catch (e: unknown) {
      if (e instanceof TokenExpiredError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      result.failed += 1;
      result.errors.push(`${remoteProjectId}/${ref.id}: ${msg}`);
      log('error', 'sync', `failed ${remoteProjectId}/${ref.id}: ${msg}`);
    }
  };

  if (config.mode === 'all') {
    let refs = discoverAllSessions();

    // Self-heal (full-scan runs only): if a mapped remote project was deleted
    // server-side, drop the stale mapping + its orphaned manifest shard so the
    // cwd is lazily re-created below. Gated on a non-empty, fully-paginated list
    // (an empty set means "couldn't validate", never "everything is gone").
    if (!opts.cwd && !opts.sessionId) {
      const knownRemoteIds = await fetchRemoteProjectIds(apiClient);
      if (knownRemoteIds.size > 0) {
        const dropped = pruneProjectMap(env, knownRemoteIds);
        if (dropped.length > 0) {
          for (const rid of dropped) {
            dropProjectManifest(env, rid);
            log(
              'warn',
              'sync',
              `remote project ${rid} deleted server-side — dropped mapping; its cwd will be recreated`,
            );
          }
          manifest = loadManifest(env);
        }
      }
    }

    // Resolve remoteProjectId for each cwd (undefined = never synced)
    const remoteIdFor = (cwd: string): string | undefined =>
      lookupRemoteProjectId(env, cwd);

    if (opts.cwd) {
      const cwd = opts.cwd;
      const ns = remoteIdFor(cwd) ?? syntheticCwdFor(cwd).id;
      opts.onEvent?.({ phase: 'discover', project: ns });
      refs = refs.filter((r) => r.cwd === cwd);
      if (remoteIdFor(cwd)) pruneScope(ns, refs);
    } else {
      opts.onEvent?.({ phase: 'discover' });
      const live = new Map<string, Set<string>>();
      for (const r of refs) {
        const rid = remoteIdFor(r.cwd);
        if (!rid) continue;
        let s = live.get(rid);
        if (!s) {
          s = new Set();
          live.set(rid, s);
        }
        s.add(r.id);
      }
      const reconciled = reconcileManifest(env, manifest, live);
      manifest = reconciled.manifest;
      result.cleaned += reconciled.removed;
      if (reconciled.removed > 0) {
        log('info', 'sync', `pruned ${reconciled.removed} stale record(s)`);
      }
    }

    const pending = opts.sessionId
      ? refs.filter((r) => r.id === opts.sessionId) // force-upload one session
      : refs.filter((r) => {
          const rid = remoteIdFor(r.cwd);
          if (!rid) return true;
          return uploadStatus(manifest, rid, r) !== 'current';
        });
    if (!opts.sessionId) result.skipped += refs.length - pending.length;

    // Group by cwd for lazy project creation + progress
    const byCwd = new Map<string, SessionRef[]>();
    for (const r of pending) {
      let arr = byCwd.get(r.cwd);
      if (!arr) {
        arr = [];
        byCwd.set(r.cwd, arr);
      }
      arr.push(r);
    }

    const cwds = [...byCwd.keys()];
    log(
      'info',
      'sync',
      `all: ${refs.length} sessions, ${pending.length} to upload across ${cwds.length} directories`,
    );

    let pi = 0;
    for (const cwd of cwds) {
      pi += 1;
      const cwdRefs = byCwd.get(cwd)!;
      const displayName = syntheticCwdFor(cwd).name;
      const pCtx = {
        projectIndex: pi,
        projectTotal: cwds.length,
        projectName: displayName,
      };

      let remoteId: string;
      try {
        remoteId = await ensureRemoteProject(apiClient, env, cwd, displayName);
      } catch (e: unknown) {
        if (e instanceof TokenExpiredError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        log(
          'error',
          'sync',
          `failed to create project for ${displayName}: ${msg}`,
        );
        result.failed += cwdRefs.length;
        for (const r of cwdRefs)
          result.errors.push(`${displayName}/${r.id}: ${msg}`);
        continue;
      }

      log('info', 'sync', `${displayName}: ${cwdRefs.length} to upload`);
      let i = 0;
      for (const ref of cwdRefs) {
        i += 1;
        await uploadOneRef(remoteId, ref, i, cwdRefs.length, pCtx);
      }
    }
  } else {
    // select mode — pre-validate remote projects exist
    const remoteIds = await fetchRemoteProjectIds(apiClient);

    const envProjects = projectsForEnv(config, env);
    const projects: Project[] = opts.remoteProjectId
      ? envProjects.filter((p) => p.remoteProjectId === opts.remoteProjectId)
      : envProjects;
    const cwdById = new Map(config.cwds.map((c) => [c.id, c]));

    let pi = 0;
    for (const project of projects) {
      pi += 1;
      // Pre-validation only applies to projects WE created: listProjects is the
      // authoritative membership list for those, so absence == deleted. A joined
      // project may legitimately be absent depending on backend semantics, so we
      // never skip a joined project on list-membership — let /sync be the judge
      // (a genuinely-gone project then surfaces as a per-session failure, not a
      // silent skip). A skipped created-project is counted as a failure so the
      // headless `sync` exits non-zero and the user notices.
      if (
        project.origin === 'created' &&
        remoteIds.size > 0 &&
        !remoteIds.has(project.remoteProjectId)
      ) {
        const m = `${project.name}: remote project ${project.remoteProjectId} not found on server — skipping (delete or re-create it locally)`;
        log('warn', 'sync', m);
        result.failed += 1;
        result.errors.push(m);
        continue;
      }
      const cwdPaths = project.cwdIds
        .map((cid) => cwdById.get(cid)?.cwd)
        .filter((c): c is string => !!c);
      // Guard against config drift (e.g. a hand-edited config.json): a project
      // whose cwdIds all dangle would discover zero sessions and then prune the
      // whole manifest as "all gone". Skip instead of destroying upload state.
      if (cwdPaths.length === 0) {
        log(
          'warn',
          'sync',
          `${project.name}: no valid cwds (config drift?) — skipping without pruning`,
        );
        continue;
      }
      const pCtx = {
        projectIndex: pi,
        projectTotal: projects.length,
        projectName: project.name,
      };
      opts.onEvent?.({
        phase: 'discover',
        project: project.remoteProjectId,
        ...pCtx,
      });
      const refs = discoverSessionsForProject(cwdPaths);
      pruneScope(project.remoteProjectId, refs);
      const pending = opts.sessionId
        ? refs.filter((r) => r.id === opts.sessionId) // force-upload one session
        : refs.filter(
            (r) =>
              uploadStatus(manifest, project.remoteProjectId, r) !== 'current',
          );
      if (!opts.sessionId) result.skipped += refs.length - pending.length;
      log(
        'info',
        'sync',
        `${project.name}: ${refs.length} sessions, ${pending.length} to upload`,
      );
      let i = 0;
      for (const ref of pending) {
        i += 1;
        await uploadOneRef(
          project.remoteProjectId,
          ref,
          i,
          pending.length,
          pCtx,
        );
      }
    }
  }

  opts.onEvent?.({ phase: 'done' });
  log(
    result.failed > 0 ? 'warn' : 'info',
    'sync',
    `done — ${result.uploaded} uploaded, ${result.failed} failed, ${result.skipped} up-to-date, ${result.cleaned} cleaned`,
  );
  return result;
}
