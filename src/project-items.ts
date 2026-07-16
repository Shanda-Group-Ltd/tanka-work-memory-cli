/**
 * Shared "one row per project" derivation for the Board's PROJECTS panel and
 * the `tanka-wm projects` CLI — a single source of truth so the two views
 * can't drift. All mode: one item per discovered cwd (the remote project may
 * not exist yet). Select mode: one item per configured project of the env.
 */
import { type Config, projectsForEnv, type TankaEnv } from './config/config';
import { lookupRemoteProjectId } from './config/project-map';
import {
  cwdEqualsAny,
  discoverSessionsForProject,
  expandToWorktreeUnion,
  isScienceCwd,
  type SessionRef,
  syntheticCwdFor,
} from './discovery/sessions';

export interface ProjectItem {
  name: string;
  cwdPaths: string[];
  /** manifest namespace (remoteProjectId once known, synthetic id otherwise) */
  ns: string;
  /** backend project id — undefined in all mode until the first sync creates it */
  remoteProjectId?: string;
  /** select-mode provenance; absent in all mode */
  origin?: 'created' | 'joined';
  /** session count — populated by allModeItems (free from the sweep); absent in select mode */
  sessions?: number;
}

/** All mode: group already-discovered sessions by cwd — one item per directory. */
export function allModeItems(
  refs: readonly SessionRef[],
  env: TankaEnv,
): ProjectItem[] {
  const count = new Map<string, number>();
  for (const r of refs) count.set(r.cwd, (count.get(r.cwd) ?? 0) + 1);
  return [...count.entries()]
    .map(([cwd, sessions]) => {
      const s = syntheticCwdFor(cwd);
      const remoteProjectId = lookupRemoteProjectId(env, cwd);
      return {
        name: s.name,
        cwdPaths: [cwd],
        ns: remoteProjectId ?? s.id,
        remoteProjectId,
        sessions,
      };
    })
    .sort(
      scienceFirst(
        (it) => it.cwdPaths[0],
        (a, b) => a.name.localeCompare(b.name),
      ),
    );
}

/**
 * A comparator that floats claude-science items to the top, then falls back to
 * `then` within each group. `cwdOf` extracts the item's primary cwd.
 */
function scienceFirst<T>(
  cwdOf: (it: T) => string | undefined,
  then: (a: T, b: T) => number,
): (a: T, b: T) => number {
  return (a, b) => {
    const as = isScienceCwd(cwdOf(a) ?? '');
    const bs = isScienceCwd(cwdOf(b) ?? '');
    if (as !== bs) return as ? -1 : 1;
    return then(a, b);
  };
}

/** Select mode: one item per configured project of `env`. */
export function selectModeItems(config: Config, env: TankaEnv): ProjectItem[] {
  const cwdById = new Map(config.cwds.map((c) => [c.id, c]));
  return projectsForEnv(config, env)
    .map((p) => ({
      name: p.name,
      cwdPaths: p.cwdIds
        .map((cid) => cwdById.get(cid)?.cwd)
        .filter((c): c is string => !!c),
      ns: p.remoteProjectId,
      remoteProjectId: p.remoteProjectId,
      origin: p.origin,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Per-item session counts from a SINGLE discovery sweep over the union of all
 * items' cwds — instead of one full machine scan per item. Attribution reuses
 * discovery's own membership rule (a ref belongs to the item whose
 * worktree-expanded roots contain the ref's cwd), and select-mode cwd
 * membership is exclusive within an env, so it's unambiguous. Returns counts
 * aligned by index with `items`.
 */
export function sessionCountsForItems(items: readonly ProjectItem[]): number[] {
  const rootsPerItem = items.map((it) => expandToWorktreeUnion(it.cwdPaths));
  const refs = discoverSessionsForProject(items.flatMap((it) => it.cwdPaths));
  const counts = items.map(() => 0);
  for (const ref of refs) {
    const i = rootsPerItem.findIndex((roots) => cwdEqualsAny(ref.cwd, roots));
    if (i >= 0) counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts;
}
