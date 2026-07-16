/**
 * All-mode cwd → remoteProjectId mapping.
 *
 * In all mode every cwd is its own project. The first sync for a cwd lazily
 * creates a remote project via the API and records the mapping here so
 * subsequent syncs reuse the same remoteProjectId.
 *
 * Keys are case-folded cwd paths (via `foldPath`) so Windows drive-letter
 * drift and macOS case-insensitivity can't create duplicates.
 *
 * File: `~/.tanka-wm/project-map/<env>.json` (one per Tanka env)
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { foldPath } from '../discovery/sessions';
import type { TankaEnv } from './config';
import { projectMapPath } from './paths';

export type ProjectMap = Record<string, string>;

export function loadProjectMap(env: TankaEnv): ProjectMap {
  try {
    const raw = JSON.parse(
      readFileSync(projectMapPath(env), 'utf8'),
    ) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as ProjectMap;
    }
  } catch {
    /* missing or corrupt — start fresh */
  }
  return {};
}

export function saveProjectMap(env: TankaEnv, map: ProjectMap): void {
  const path = projectMapPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o644);
  } catch {
    /* best effort */
  }
}

/**
 * Guard against a science cwd key that a stray `path.resolve` has mangled.
 * `claude-science://x` is not an absolute path, so `path.resolve` prepends the
 * process cwd AND collapses the `//` to `/` — leaving `…/claude-science:/x`.
 * That single-slash form is a deterministic fingerprint: a genuine science cwd
 * always keeps its `//`. Persisting the mangled key would write a
 * process-cwd-dependent entry no later lookup can reproduce, so we fail loud at
 * the map boundary rather than corrupt the map. See `isScienceCwd` for the
 * touchpoints that must branch to keep this from firing.
 */
function assertUnmangledScienceKey(cwdPath: string): void {
  if (
    cwdPath.includes('claude-science:/') &&
    !cwdPath.includes('claude-science://')
  )
    throw new Error(
      `mangled science cwd key "${cwdPath}" — a path.resolve() leaked through; ` +
        'the science cwd must reach project-map verbatim (see isScienceCwd)',
    );
}

export function lookupRemoteProjectId(
  env: TankaEnv,
  cwdPath: string,
): string | undefined {
  assertUnmangledScienceKey(cwdPath);
  const map = loadProjectMap(env);
  return map[foldPath(cwdPath)];
}

export function recordProjectMapping(
  env: TankaEnv,
  cwdPath: string,
  remoteProjectId: string,
): void {
  assertUnmangledScienceKey(cwdPath);
  const map = loadProjectMap(env);
  map[foldPath(cwdPath)] = remoteProjectId;
  saveProjectMap(env, map);
}

/**
 * Re-point every cwd mapped to `sourceRemoteId` at `targetRemoteId` — the
 * all-mode half of a server-side project data migration (`/project/change`):
 * subsequent syncs of those cwds report to the target project instead of
 * recreating data under the source. Returns the number of cwds re-pointed.
 */
export function remapProjectId(
  env: TankaEnv,
  sourceRemoteId: string,
  targetRemoteId: string,
): number {
  const map = loadProjectMap(env);
  let changed = 0;
  for (const [key, remoteId] of Object.entries(map)) {
    if (remoteId === sourceRemoteId) {
      map[key] = targetRemoteId;
      changed += 1;
    }
  }
  if (changed > 0) saveProjectMap(env, map);
  return changed;
}

/**
 * Drop mappings whose remoteProjectId is NOT in `validRemoteIds` — i.e. the
 * remote project was deleted server-side. The next sync then re-runs lazy
 * creation for that cwd (self-heal). Returns the remoteProjectIds that were
 * dropped so the caller can also forget their manifest shards.
 *
 * Pass only a *trusted* set: an empty/partial `validRemoteIds` (e.g. from a
 * failed `listProjects`) would wrongly nuke every mapping, so callers must gate
 * this on a non-empty, fully-paginated project list.
 */
export function pruneProjectMap(
  env: TankaEnv,
  validRemoteIds: Set<string>,
): string[] {
  const map = loadProjectMap(env);
  const dropped: string[] = [];
  let changed = false;
  for (const [key, remoteId] of Object.entries(map)) {
    if (!validRemoteIds.has(remoteId)) {
      delete map[key];
      dropped.push(remoteId);
      changed = true;
    }
  }
  if (changed) saveProjectMap(env, map);
  return dropped;
}
