// biome-ignore-all lint/suspicious/noExplicitAny: discriminated union spreads need `as any` to satisfy TS when updating shared fields across Mode variants
/**
 * Projects management screen (select mode, wizard step 3 + Board modal).
 *
 * Displays existing projects with their cwds; supports:
 *   c — create a new project (calls backend createProject)
 *   j — join an existing project by remoteProjectId
 *   e — edit displayName / add-remove cwds (local only)
 *   m — migrate the project's data into another project (backend /project/change)
 *   d — delete a self-created project (calls backend del-mine)
 *   l — leave a joined project (calls backend leave)
 */
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type React from 'react';
import { useState } from 'react';
import { createApiClient } from '../api/client';
import {
  createProject as apiCreate,
  deleteMyProjectData as apiDelete,
  joinProject as apiJoin,
  leaveProject as apiLeave,
} from '../api/work-memory';
import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { applyTextKey } from '../components/textEditing';
import { computeWindow, moveIndex } from '../components/windowing';
import {
  type Config,
  DEFAULT_TANKA_ENV,
  type Project,
  type ProjectCwd,
  projectsForEnv,
  type TankaEnv,
} from '../config/config';
import {
  countScienceSessions,
  foldPath,
  isIgnoredCwd,
  isScienceCwd,
  owningWorktree,
  scanSessionCwds,
  scienceExportCwds,
  syntheticCwdFor,
} from '../discovery/sessions';
import { clip, padEndWidth } from '../format';
import { useAsync } from '../hooks/useAsync';
import { useConfig } from '../hooks/useConfig';
import { useScreenInput } from '../hooks/useScreenInput';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { MigrateModal } from '../modals/MigrateModal';
import { refreshScienceExportInteractive } from '../sync';
import { theme } from '../theme';

// ─── sub-screen states ──────────────────────────────────────

type Mode =
  | { kind: 'list' }
  | {
      kind: 'create';
      name: string;
      // `nameDirty` tracks whether the user typed into the name field; while
      // false, toggling a cwd auto-prefills the name from the first picked cwd.
      nameDirty: boolean;
      field: 'cwds' | 'name';
      cwdPicked: Set<string>;
      cwdIdx: number;
      error: string | null;
      busy: boolean;
    }
  | {
      kind: 'join';
      remoteId: string;
      name: string;
      nameDirty: boolean;
      field: 'cwds' | 'name' | 'remoteId';
      cwdPicked: Set<string>;
      cwdIdx: number;
      error: string | null;
      busy: boolean;
    }
  | {
      kind: 'edit';
      projectId: string;
      name: string;
      field: 'name' | 'cwds';
      cwdPicked: Set<string>;
      cwdIdx: number;
      error: string | null;
    }
  // migrate delegates entirely to <MigrateModal> (input, busy, error live there)
  | { kind: 'migrate'; projectId: string }
  | {
      kind: 'confirm-delete';
      projectId: string;
      busy: boolean;
      error: string | null;
    }
  | {
      kind: 'confirm-leave';
      projectId: string;
      busy: boolean;
      error: string | null;
    };

interface ScannedCwdItem {
  cwd: string;
  root: string;
  name: string;
  sessionCount: number;
  usedByProjectId?: string;
}

// ─── helpers ────────────────────────────────────────────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scanAvailableCwds(config: Config, env: TankaEnv): ScannedCwdItem[] {
  const scanned = scanSessionCwds().filter((s) => !isIgnoredCwd(s.cwd));
  const usedCwds = new Map<string, string>();
  for (const p of projectsForEnv(config, env)) {
    for (const cid of p.cwdIds) {
      const c = config.cwds.find((x) => x.id === cid);
      if (c) usedCwds.set(foldPath(c.cwd), p.id);
    }
  }

  const seen = new Set<string>();
  const items: ScannedCwdItem[] = [];
  for (const sc of scanned) {
    const root = owningWorktree(sc.cwd);
    const key = foldPath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      cwd: root,
      root,
      name: basename(root) || root,
      sessionCount: sc.sessionCount,
      usedByProjectId: usedCwds.get(key),
    });
  }
  // Exported claude-science projects are pickable cwds too (each project ≡ one
  // cwd). They carry no path — name comes from the exported project.json and the
  // count from the exported session tree, both via the science-aware helpers.
  for (const cwd of scienceExportCwds()) {
    const key = foldPath(cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      cwd,
      root: cwd,
      name: syntheticCwdFor(cwd).name,
      sessionCount: countScienceSessions(cwd),
      usedByProjectId: usedCwds.get(key),
    });
  }
  // Science projects float to the top; within each group, most sessions first.
  return items.sort((a, b) => {
    const as = isScienceCwd(a.cwd);
    const bs = isScienceCwd(b.cwd);
    if (as !== bs) return as ? -1 : 1;
    return b.sessionCount - a.sessionCount;
  });
}

function generateCwdId(name: string, existing: Set<string>): string {
  let id = slug(name) || 'cwd';
  const base = id;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ─── component ──────────────────────────────────────────────

/** Initial mode for direct-action entry from the Board. */
export type ProjectsInitialAction =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; projectId: string }
  | { kind: 'confirm-delete'; projectId: string }
  | { kind: 'confirm-leave'; projectId: string };

export function ProjectsScreen({
  onDone,
  onCancel,
  onBack,
  onCancelAll,
  wizardLabel,
  initialAction,
}: {
  onDone: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onCancelAll?: () => void;
  wizardLabel?: string;
  initialAction?: ProjectsInitialAction;
}): React.ReactElement {
  const { config, credentials, setConfig } = useConfig();
  const tankaEnv: TankaEnv = credentials?.env ?? DEFAULT_TANKA_ENV;
  const { rows, columns } = useTerminalSize();
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>(() => {
    if (!initialAction || initialAction.kind === 'list')
      return { kind: 'list' };
    if (initialAction.kind === 'create')
      return {
        kind: 'create',
        name: '',
        nameDirty: false,
        field: 'cwds',
        cwdPicked: new Set(),
        cwdIdx: 0,
        error: null,
        busy: false,
      };
    if (initialAction.kind === 'edit') {
      const p = projectsForEnv(config, tankaEnv).find(
        (x) => x.id === initialAction.projectId,
      );
      if (!p) return { kind: 'list' };
      const picked = new Set<string>();
      for (const cid of p.cwdIds) {
        const c = config.cwds.find((x) => x.id === cid);
        if (c) picked.add(foldPath(c.cwd));
      }
      return {
        kind: 'edit',
        projectId: p.id,
        name: p.name,
        field: 'name',
        cwdPicked: picked,
        cwdIdx: 0,
        error: null,
      };
    }
    if (initialAction.kind === 'confirm-delete')
      return {
        kind: 'confirm-delete',
        projectId: initialAction.projectId,
        busy: false,
        error: null,
      };
    if (initialAction.kind === 'confirm-leave')
      return {
        kind: 'confirm-leave',
        projectId: initialAction.projectId,
        busy: false,
        error: null,
      };
    return { kind: 'list' };
  });
  const [scanNonce, setScanNonce] = useState(0);

  const cwdScan = useAsync<ScannedCwdItem[]>(async () => {
    // Refresh the science export first (best-effort, lock-guarded, async) so
    // newly created science projects appear as pickable cwds. Uses the
    // configured science dir, defaulting when unset (Tanka step sets it later).
    // An unchanged pass is cheap (aggregate queries only), so re-running on
    // config edits is fine.
    await refreshScienceExportInteractive(config.scienceDir);
    return scanAvailableCwds(config, tankaEnv);
  }, [scanNonce, config.cwds, config.projects, tankaEnv]);
  const cwdItems = cwdScan.data ?? [];

  const projects = projectsForEnv(config, tankaEnv);
  const selC = Math.min(sel, Math.max(0, projects.length - 1));
  const selectedProject = projects[selC] ?? null;
  const bodyH = Math.max(4, rows - 10);

  const persistProject = (project: Project, cwdPaths: string[]): void => {
    const existingCwdIds = new Set(config.cwds.map((c) => c.id));
    const newCwds: ProjectCwd[] = [];
    const cwdIds: string[] = [];
    for (const cwd of cwdPaths) {
      const existing = config.cwds.find(
        (c) => foldPath(c.cwd) === foldPath(cwd),
      );
      if (existing) {
        cwdIds.push(existing.id);
      } else {
        const id = generateCwdId(basename(cwd), existingCwdIds);
        existingCwdIds.add(id);
        newCwds.push({ id, name: basename(cwd) || cwd, cwd });
        cwdIds.push(id);
      }
    }
    const fullProject = { ...project, cwdIds };
    const nextCwds = [...config.cwds, ...newCwds];
    // Dedup by BOTH id AND remoteProjectId: a legacy/hand-edited config could
    // hold an entry with a slug id but the same remoteProjectId — filtering on id
    // alone would leave two projects pointing at one remote project (Board dupes,
    // delete/leave only catching one). remoteProjectId is the real identity.
    const nextProjects = [
      ...(config.projects ?? []).filter(
        (p) =>
          p.id !== project.id && p.remoteProjectId !== project.remoteProjectId,
      ),
      fullProject,
    ];
    setConfig({ ...config, cwds: nextCwds, projects: nextProjects });
  };

  const removeProject = (projectId: string): void => {
    const nextProjects = (config.projects ?? []).filter(
      (p) => p.id !== projectId,
    );
    setConfig({
      ...config,
      projects: nextProjects.length > 0 ? nextProjects : undefined,
    });
  };

  // ── create flow ──
  const doCreate = async (
    m: Extract<Mode, { kind: 'create' }>,
  ): Promise<void> => {
    const name = m.name.trim();
    if (!name) {
      setMode({ ...m, error: 'name is required', field: 'name' });
      return;
    }
    const picked = cwdItems.filter((c) => m.cwdPicked.has(foldPath(c.cwd)));
    if (picked.length === 0) {
      setMode({ ...m, error: 'select at least one cwd', field: 'cwds' });
      return;
    }

    setMode({ ...m, busy: true, error: null });
    try {
      if (!credentials) throw new Error('token not configured');
      const client = createApiClient(credentials);
      const resp = await apiCreate(client, {
        displayName: name,
        lookbackDays: 14,
        reportLanguage: 'en',
      });
      // Local id = remoteProjectId: it's globally unique (a backend nanoid), so
      // two same-named projects can't collide and silently overwrite each other
      // in config the way a slug(name) id would. It's also the manifest namespace.
      const project: Project = {
        id: resp.projectId,
        remoteProjectId: resp.projectId,
        name,
        cwdIds: [],
        origin: 'created',
        env: tankaEnv,
      };
      persistProject(
        project,
        picked.map((c) => c.cwd),
      );
      setMode({ kind: 'list' });
      setScanNonce((n) => n + 1);
    } catch (e: unknown) {
      setMode({
        ...m,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── join flow ──
  const doJoin = async (m: Extract<Mode, { kind: 'join' }>): Promise<void> => {
    const remoteId = m.remoteId.trim();
    const name = m.name.trim();
    if (!remoteId) {
      setMode({ ...m, error: 'project ID is required', field: 'remoteId' });
      return;
    }
    if (!name) {
      setMode({ ...m, error: 'name is required', field: 'name' });
      return;
    }
    const picked = cwdItems.filter((c) => m.cwdPicked.has(foldPath(c.cwd)));
    if (picked.length === 0) {
      setMode({ ...m, error: 'select at least one cwd', field: 'cwds' });
      return;
    }

    setMode({ ...m, busy: true, error: null });
    try {
      if (!credentials) throw new Error('token not configured');
      const client = createApiClient(credentials);
      await apiJoin(client, remoteId);
      // Local id = remoteProjectId (unique). Joining the same project twice then
      // maps to the same id → idempotent replace, never a silent collision.
      const project: Project = {
        id: remoteId,
        remoteProjectId: remoteId,
        name,
        cwdIds: [],
        origin: 'joined',
        env: tankaEnv,
      };
      persistProject(
        project,
        picked.map((c) => c.cwd),
      );
      setMode({ kind: 'list' });
      setScanNonce((n) => n + 1);
    } catch (e: unknown) {
      setMode({
        ...m,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── delete flow ──
  const doDelete = async (
    m: Extract<Mode, { kind: 'confirm-delete' }>,
  ): Promise<void> => {
    setMode({ ...m, busy: true, error: null });
    try {
      const p = projects.find((x) => x.id === m.projectId);
      if (!p) throw new Error('project not found');
      if (!credentials) throw new Error('token not configured');
      const client = createApiClient(credentials);
      await apiDelete(client, p.remoteProjectId);
      removeProject(m.projectId);
      setMode({ kind: 'list' });
      setScanNonce((n) => n + 1);
    } catch (e: unknown) {
      setMode({
        ...m,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── leave flow ──
  const doLeave = async (
    m: Extract<Mode, { kind: 'confirm-leave' }>,
  ): Promise<void> => {
    setMode({ ...m, busy: true, error: null });
    try {
      const p = projects.find((x) => x.id === m.projectId);
      if (!p) throw new Error('project not found');
      if (!credentials) throw new Error('token not configured');
      const client = createApiClient(credentials);
      await apiLeave(client, p.remoteProjectId);
      removeProject(m.projectId);
      setMode({ kind: 'list' });
      setScanNonce((n) => n + 1);
    } catch (e: unknown) {
      setMode({
        ...m,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── input handling ──
  useScreenInput((input, key) => {
    if (mode.kind === 'confirm-delete') {
      if (mode.busy) return;
      if (input === 'y' || input === 'Y') {
        void doDelete(mode);
        return;
      }
      if (key.escape || input === 'n' || input === 'N') {
        setMode({ kind: 'list' });
        return;
      }
      return;
    }
    if (mode.kind === 'confirm-leave') {
      if (mode.busy) return;
      if (input === 'y' || input === 'Y') {
        void doLeave(mode);
        return;
      }
      if (key.escape || input === 'n' || input === 'N') {
        setMode({ kind: 'list' });
        return;
      }
      return;
    }
    if (
      mode.kind === 'create' ||
      mode.kind === 'join' ||
      mode.kind === 'edit'
    ) {
      if (mode.kind !== 'edit' && 'busy' in mode && mode.busy) return;
      if (key.escape) {
        setMode({ kind: 'list' });
        return;
      }
      if (key.tab) {
        const fields =
          mode.kind === 'join'
            ? (['cwds', 'name', 'remoteId'] as const)
            : (['cwds', 'name'] as const);
        const idx = fields.indexOf(mode.field as any);
        const next = fields[(idx + 1) % fields.length]!;
        setMode({ ...mode, field: next } as any);
        return;
      }
      if (mode.field === 'cwds') {
        const available = cwdItems.filter(
          (c) =>
            !c.usedByProjectId ||
            (mode.kind === 'edit' && c.usedByProjectId === mode.projectId),
        );
        if (key.upArrow || input === 'k') {
          setMode({
            ...mode,
            cwdIdx: moveIndex(mode.cwdIdx, -1, available.length),
          } as any);
          return;
        }
        if (key.downArrow || input === 'j') {
          setMode({
            ...mode,
            cwdIdx: moveIndex(mode.cwdIdx, 1, available.length),
          } as any);
          return;
        }
        if (input === ' ' && available[mode.cwdIdx]) {
          const k = foldPath(available[mode.cwdIdx]!.cwd);
          const next = new Set(mode.cwdPicked);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          const patch: any = { ...mode, cwdPicked: next };
          // create/join: until the user has manually edited the name, keep it
          // synced to the first picked cwd's name (in display order).
          if (mode.kind !== 'edit' && !mode.nameDirty) {
            const firstPicked = available.find((c) =>
              next.has(foldPath(c.cwd)),
            );
            patch.name = firstPicked?.name ?? '';
          }
          setMode(patch);
          return;
        }
        if (key.return) {
          if (mode.kind === 'create') void doCreate(mode);
          else if (mode.kind === 'join') void doJoin(mode);
          else if (mode.kind === 'edit') {
            const name = mode.name.trim();
            if (!name) {
              setMode({ ...mode, error: 'name is required', field: 'name' });
              return;
            }
            const picked = cwdItems.filter((c) =>
              mode.cwdPicked.has(foldPath(c.cwd)),
            );
            if (picked.length === 0) {
              setMode({
                ...mode,
                error: 'select at least one cwd',
                field: 'cwds',
              });
              return;
            }
            const p = projects.find((x) => x.id === mode.projectId);
            if (p)
              persistProject(
                { ...p, name },
                picked.map((c) => c.cwd),
              );
            setMode({ kind: 'list' });
            setScanNonce((n) => n + 1);
          }
          return;
        }
      } else {
        if (key.return) {
          if (mode.kind === 'create') void doCreate(mode);
          else if (mode.kind === 'join') void doJoin(mode);
          else if (mode.kind === 'edit') {
            const next = mode.field === 'name' ? 'cwds' : 'name';
            setMode({ ...mode, field: next } as any);
          }
          return;
        }
        if (mode.field === 'name') {
          const nextName = applyTextKey(mode.name, input, key);
          setMode({
            ...mode,
            name: nextName,
            error: null,
            // Only mark dirty when the text actually changed — a bare arrow/ctrl
            // keypress on the name field shouldn't stop the cwd-driven auto-fill.
            // (edit has no nameDirty field; the extra key is harmless under `as any`.)
            ...(mode.kind !== 'edit' && nextName !== mode.name
              ? { nameDirty: true }
              : {}),
          } as any);
        } else if (mode.kind === 'join' && mode.field === 'remoteId') {
          setMode({
            ...mode,
            remoteId: applyTextKey(mode.remoteId, input, key),
            error: null,
          });
        }
      }
      return;
    }

    // ── list mode ──
    if (key.escape) {
      (onBack ?? onCancel)();
      return;
    }
    if (input === 'C' && onCancelAll) {
      onCancelAll();
      return;
    }
    if (key.return) {
      onDone();
      return;
    }
    // NB: list mode uses arrow keys only for navigation — `j` is reserved for
    // "join" and `k` would be the only vim key left, so drop both for clarity.
    if (key.upArrow) {
      setSel(moveIndex(selC, -1, projects.length));
      return;
    }
    if (key.downArrow) {
      setSel(moveIndex(selC, 1, projects.length));
      return;
    }

    if (input === 'c') {
      setMode({
        kind: 'create',
        name: '',
        nameDirty: false,
        field: 'cwds',
        cwdPicked: new Set(),
        cwdIdx: 0,
        error: null,
        busy: false,
      });
      return;
    }
    if (input === 'j') {
      setMode({
        kind: 'join',
        remoteId: '',
        name: '',
        nameDirty: false,
        field: 'cwds',
        cwdPicked: new Set(),
        cwdIdx: 0,
        error: null,
        busy: false,
      });
      return;
    }
    if (input === 'e' && selectedProject) {
      const picked = new Set<string>();
      for (const cid of selectedProject.cwdIds) {
        const c = config.cwds.find((x) => x.id === cid);
        if (c) picked.add(foldPath(c.cwd));
      }
      setMode({
        kind: 'edit',
        projectId: selectedProject.id,
        name: selectedProject.name,
        field: 'name',
        cwdPicked: picked,
        cwdIdx: 0,
        error: null,
      });
      return;
    }
    if (input === 'm' && selectedProject) {
      setMode({ kind: 'migrate', projectId: selectedProject.id });
      return;
    }
    if (input === 'd' && selectedProject?.origin === 'created') {
      setMode({
        kind: 'confirm-delete',
        projectId: selectedProject.id,
        busy: false,
        error: null,
      });
      return;
    }
    if (input === 'l' && selectedProject?.origin === 'joined') {
      setMode({
        kind: 'confirm-leave',
        projectId: selectedProject.id,
        busy: false,
        error: null,
      });
      return;
    }
    if (input === 'r') {
      setScanNonce((n) => n + 1);
      return;
    }
    // migrate mode: deactivated — <MigrateModal>'s own useScreenInput owns the
    // keys (one active handler per screen, per the hook's convention).
  }, mode.kind !== 'migrate');

  // ── render ──
  const subtitle = wizardLabel
    ? `${wizardLabel} · ${projects.length} project(s)`
    : `${projects.length} project(s)`;

  if (mode.kind === 'confirm-delete' || mode.kind === 'confirm-leave') {
    const p = projects.find((x) => x.id === mode.projectId);
    const action = mode.kind === 'confirm-delete' ? 'Delete' : 'Leave';
    const note =
      mode.kind === 'confirm-delete'
        ? 'This will delete your data on the server.'
        : 'Your synced data will be kept on the server.';
    return (
      <ScreenFrame title="Projects" subtitle={subtitle}>
        <Box flexDirection="column">
          <Text>
            {`${action} project `}
            <Text color={theme.brand}>{`‹${p?.name ?? mode.projectId}›`}</Text>
            {' ?'}
          </Text>
          <Text color={theme.dim}>{note}</Text>
          <Text> </Text>
          {mode.busy ? (
            <Spinner label={`${action.toLowerCase()}ing…`} />
          ) : (
            <Text>
              <Text color={theme.warn}>y</Text>
              {` = ${action.toLowerCase()}    `}
              <Text color={theme.dim}>n / esc = cancel</Text>
            </Text>
          )}
          {mode.error ? (
            <Text color={theme.err}>{`✗ ${mode.error}`}</Text>
          ) : null}
        </Box>
      </ScreenFrame>
    );
  }

  if (mode.kind === 'migrate') {
    const p = projects.find((x) => x.id === mode.projectId);
    // p can only vanish through the modal's own migration (merge into an
    // existing target), and that transition also leaves migrate mode — so the
    // fall-through below is unreachable in practice, just a safe default.
    if (p)
      return (
        <MigrateModal
          source={{
            kind: 'project',
            name: p.name,
            remoteProjectId: p.remoteProjectId,
          }}
          onClose={() => setMode({ kind: 'list' })}
          onDone={() => {
            setMode({ kind: 'list' });
            setScanNonce((n) => n + 1);
          }}
        />
      );
  }

  if (mode.kind === 'create' || mode.kind === 'join' || mode.kind === 'edit') {
    const title =
      mode.kind === 'create'
        ? 'Create project'
        : mode.kind === 'join'
          ? 'Join project'
          : 'Edit project';
    const editingProject =
      mode.kind === 'edit'
        ? projects.find((p) => p.id === mode.projectId)
        : undefined;
    const available = cwdItems.filter(
      (c) =>
        !c.usedByProjectId ||
        (mode.kind === 'edit' && c.usedByProjectId === mode.projectId),
    );
    const cwdH = Math.max(2, bodyH - 8);
    const win = computeWindow(available, mode.cwdIdx, cwdH);
    return (
      <ScreenFrame
        title="Projects"
        subtitle={`${subtitle} · ${title}`}
        footer={
          <HintBar
            hints={[
              ['tab', 'field'],
              ['space', 'toggle cwd'],
              ['enter', 'save'],
              ['esc', 'cancel'],
            ]}
          />
        }
      >
        <Box flexDirection="column">
          {/* cwds first */}
          <Box>
            <Text color={mode.field === 'cwds' ? theme.brand : theme.dim}>
              {mode.field === 'cwds' ? '❯ ' : '  '}
            </Text>
            <Text color={mode.field === 'cwds' ? theme.text : theme.dim}>
              cwds
            </Text>
          </Box>
          {cwdScan.status === 'loading' ? (
            <Spinner label="scanning…" />
          ) : (
            <Box flexDirection="column">
              {win.hiddenAbove > 0 ? (
                <Text color={theme.dim}>{`    ↑ ${win.hiddenAbove} more`}</Text>
              ) : null}
              {available.length === 0 ? (
                <Text color={theme.dim}>{'    (no cwds discovered)'}</Text>
              ) : (
                win.items.map((c, i) => {
                  const idx = win.start + i;
                  const active = idx === mode.cwdIdx && mode.field === 'cwds';
                  const checked = mode.cwdPicked.has(foldPath(c.cwd));
                  return (
                    <Text key={c.cwd} color={active ? theme.brand : undefined}>
                      {`    ${active ? '❯ ' : '  '}`}
                      <Text
                        color={checked ? theme.ok : theme.dim}
                      >{`[${checked ? '✓' : ' '}] `}</Text>
                      {padEndWidth(clip(c.name, 24), 24)}
                      <Text
                        color={theme.dim}
                      >{` ${String(c.sessionCount).padStart(4)} sess  ${clip(c.cwd, Math.max(8, columns - 50))}`}</Text>
                    </Text>
                  );
                })
              )}
              {win.hiddenBelow > 0 ? (
                <Text color={theme.dim}>{`    ↓ ${win.hiddenBelow} more`}</Text>
              ) : null}
            </Box>
          )}
          {/* then display name */}
          <Box marginTop={1}>
            <Text color={mode.field === 'name' ? theme.brand : theme.dim}>
              {mode.field === 'name' ? '❯ ' : '  '}
            </Text>
            <Text color={mode.field === 'name' ? theme.text : theme.dim}>
              {'display name'.padEnd(14)}
            </Text>
            <TextInput
              value={mode.name}
              focused={mode.field === 'name'}
              placeholder="—"
            />
          </Box>
          {/* then remote project id (join) */}
          {mode.kind === 'join' ? (
            <Box>
              <Text color={mode.field === 'remoteId' ? theme.brand : theme.dim}>
                {mode.field === 'remoteId' ? '❯ ' : '  '}
              </Text>
              <Text color={mode.field === 'remoteId' ? theme.text : theme.dim}>
                {'project ID  '.padEnd(14)}
              </Text>
              <TextInput
                value={mode.remoteId}
                focused={mode.field === 'remoteId'}
                placeholder="12-char nanoid"
              />
            </Box>
          ) : null}
          {mode.kind === 'edit' && editingProject ? (
            <Box>
              <Text color={theme.dim}>{'  '}</Text>
              <Text color={theme.dim}>{'project ID  '.padEnd(14)}</Text>
              <Text color={theme.dim}>
                {`${editingProject.remoteProjectId}  · ${editingProject.origin}`}
              </Text>
            </Box>
          ) : null}
          {'busy' in mode && mode.busy ? <Spinner label="saving…" /> : null}
          {mode.error ? (
            <Text color={theme.err}>{`  ✗ ${mode.error}`}</Text>
          ) : null}
        </Box>
      </ScreenFrame>
    );
  }

  // ── list mode ──
  const listH = Math.max(2, bodyH - 2);
  const pWin = computeWindow(projects, selC, listH);
  return (
    <ScreenFrame
      title="Projects"
      subtitle={subtitle}
      footer={
        <HintBar
          hints={[
            ['↑↓', 'move'],
            ['c', 'create'],
            ['j', 'join'],
            ...(selectedProject
              ? [
                  ['e', 'edit'] as [string, string],
                  ['m', 'migrate'] as [string, string],
                ]
              : []),
            ...(selectedProject?.origin === 'created'
              ? [['d', 'delete'] as [string, string]]
              : []),
            ...(selectedProject?.origin === 'joined'
              ? [['l', 'leave'] as [string, string]]
              : []),
            ['r', 'rescan'],
            ['enter', 'confirm'],
            ['esc', onBack ? 'back' : 'cancel'],
            ...(onCancelAll ? [['C', 'cancel all'] as [string, string]] : []),
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {projects.length === 0 ? (
          <Box flexDirection="column">
            <Text color={theme.dim}>No projects configured.</Text>
            <Text color={theme.dim}>
              Press <Text color={theme.accent}>c</Text> to create or{' '}
              <Text color={theme.accent}>j</Text> to join one.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {pWin.hiddenAbove > 0 ? (
              <Text color={theme.dim}>{`  ↑ ${pWin.hiddenAbove} more`}</Text>
            ) : null}
            {pWin.items.map((p, i) => {
              const idx = pWin.start + i;
              const active = idx === selC;
              const cwdPaths = p.cwdIds.map(
                (cid) => config.cwds.find((c) => c.id === cid)?.cwd ?? cid,
              );
              return (
                <Box key={p.id} flexDirection="column">
                  <Text
                    color={active ? theme.brand : undefined}
                    bold={active}
                    wrap="truncate"
                  >
                    {active ? '❯ ' : '  '}
                    {padEndWidth(clip(p.name, 24), 24)}
                    <Text
                      color={theme.dim}
                    >{`  ${p.remoteProjectId}  · ${p.origin}  · ${p.cwdIds.length} cwd(s)`}</Text>
                  </Text>
                  {cwdPaths.map((cwd) => (
                    <Text key={cwd} color={theme.dim} wrap="truncate">
                      {`    ${clip(cwd, Math.max(8, columns - 10))}`}
                    </Text>
                  ))}
                </Box>
              );
            })}
            {pWin.hiddenBelow > 0 ? (
              <Text color={theme.dim}>{`  ↓ ${pWin.hiddenBelow} more`}</Text>
            ) : null}
          </Box>
        )}
      </Box>
    </ScreenFrame>
  );
}
