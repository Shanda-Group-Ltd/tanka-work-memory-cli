/**
 * The Board — the whole TUI. A persistent multi-panel view: a Projects panel,
 * a Sessions master-detail panel, an activity-log strip, and a stats header.
 * Secondary functions (Tanka config, cron, auto-scan, project edit, log) open
 * as modals; reading a transcript is the only full drill-in.
 *
 * In 'all' mode the Projects panel lists virtual projects derived per-cwd from
 * every discovered session (read-only — not user-managed); in 'select' mode it
 * lists the user's configured projects.
 */

import { Box, Text, useApp } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../components/Spinner';
import { computeWindow, moveIndex } from '../components/windowing';
import { DEFAULT_TANKA_ENV, type TankaEnv } from '../config/config';
import {
  loadManifest,
  type UploadManifest,
  type UploadStatusKind,
  uploadStatus,
} from '../config/uploads';
import {
  discoverAllSessions,
  discoverSessionsForProject,
  foldWorktreesToOwner,
  isScienceCwd,
  type SessionRef,
} from '../discovery/sessions';
import { clip, fmtAge, fmtBytes, fmtRelTime, shortId } from '../format';
import { useAsync } from '../hooks/useAsync';
import { useConfig } from '../hooks/useConfig';
import { useScreenInput } from '../hooks/useScreenInput';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { log, readLogTail } from '../log';
import { CronModal } from '../modals/CronModal';
import { HelpModal } from '../modals/HelpModal';
import { LogModal } from '../modals/LogModal';
import { MigrateModal, type MigrateSource } from '../modals/MigrateModal';
import { useNav } from '../navigation';
import {
  allModeItems,
  type ProjectItem,
  selectModeItems,
} from '../project-items';
import { schedulerStatus } from '../scheduler';
import {
  refreshScienceExportInteractive,
  runSync,
  type SyncResult,
} from '../sync';
import { agentColor, theme } from '../theme';
import { type ProjectsInitialAction, ProjectsScreen } from './ProjectsScreen';
import { TankaConfigScreen } from './TankaConfigScreen';

const AGENT_TAG: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CDX',
  cowork: 'CW',
  'claude-science': 'CS',
};
const LOG_LINES = 3;
const PROJECT_INFO_HEIGHT = 2 + 1 + 1;

type ModalKind =
  | 'tanka'
  | 'cron'
  | 'log'
  | 'help'
  | { kind: 'projects'; action: ProjectsInitialAction }
  | { kind: 'migrate'; source: MigrateSource };
type Busy = {
  title: string;
  subtitle: string;
  detail: string;
  done: number;
  total: number;
} | null;

interface Toast {
  title: string;
  lines: string[];
  ok: boolean;
}

const TOAST_MS = 4000;

function syncResultToast(title: string, r: SyncResult): Toast {
  const lines: string[] = [];
  const s = (n: number) => (n === 1 ? 'session' : 'sessions');
  if (r.uploaded > 0) lines.push(`${r.uploaded} ${s(r.uploaded)} uploaded`);
  if (r.skipped > 0) lines.push(`${r.skipped} ${s(r.skipped)} up-to-date`);
  if (r.failed > 0) lines.push(`${r.failed} ${s(r.failed)} failed`);
  if (r.cleaned > 0) lines.push(`${r.cleaned} ${s(r.cleaned)} cleaned`);
  if (r.lockSkipped) lines.push('skipped (another sync running)');
  if (lines.length === 0) lines.push('nothing to do');
  for (const e of r.errors.slice(0, 3)) lines.push(`  ${e}`);
  return { title, lines, ok: r.failed === 0 };
}

function errorToast(title: string, e: unknown): Toast {
  return {
    title,
    lines: [e instanceof Error ? e.message : String(e)],
    ok: false,
  };
}

function statusIcon(s: UploadStatusKind): { icon: string; color: string } {
  if (s === 'new') return { icon: '·', color: theme.dim };
  if (s === 'changed') return { icon: '⟳', color: theme.warn };
  return { icon: '✓', color: theme.ok };
}

export function Board(): React.ReactElement {
  const { exit } = useApp();
  const { config, credentials, restartWizard } = useConfig();
  const nav = useNav();
  const { rows, columns } = useTerminalSize();

  const mode = config.mode ?? 'select';
  const isAll = mode === 'all';
  const tankaEnv: TankaEnv = credentials?.env ?? DEFAULT_TANKA_ENV;
  const [projIdx, setProjIdx] = useState(0);
  const [focus, setFocus] = useState<'projects' | 'sessions'>('projects');
  const [sessIdx, setSessIdx] = useState(0);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((t: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  const [listNonce, setListNonce] = useState(0); // bump → re-discover the project/dir list
  const [sessNonce, setSessNonce] = useState(0); // bump → re-discover only the current sessions
  const [manifest, setManifest] = useState<UploadManifest>(() =>
    loadManifest(tankaEnv),
  );
  const [cron, setCron] = useState(() => schedulerStatus());
  const [logTail, setLogTail] = useState<string[]>(() =>
    readLogTail(LOG_LINES),
  );

  // Re-load manifest when the active env changes (e.g. user switches env in
  // Tanka settings) — closeModal's loadManifest(tankaEnv) captures the pre-
  // update value due to React batching, so this effect ensures correctness.
  useEffect(() => {
    setManifest(loadManifest(tankaEnv));
  }, [tankaEnv]);

  // Refresh the whole list (and, since the selection may change, the sessions too).
  const refreshList = (): void => {
    setListNonce((n) => n + 1);
    setSessNonce((n) => n + 1);
  };
  const refreshSessions = (): void => setSessNonce((n) => n + 1);

  // ── discovery ─────────────────────────────────────────────
  const allDiscovery = useAsync<SessionRef[]>(async () => {
    if (!isAll) return [];
    // Refresh the science export before discovering so the list + counts
    // reflect the live claude-science DB (discovery only READS the export).
    // Lock-guarded, incremental, and fully async so it never blocks the Ink
    // render; one export covers all science projects.
    await refreshScienceExportInteractive(config.scienceDir);
    return discoverAllSessions();
  }, [isAll, listNonce, config.scienceDir]);

  // Unified display list — one item per "project" in the left panel, derived
  // by the shared project-items module (same source of truth as the CLI).
  const displayItems = useMemo<ProjectItem[]>(
    () =>
      isAll
        ? allModeItems(allDiscovery.data ?? [], tankaEnv)
        : selectModeItems(config, tankaEnv),
    [isAll, config, tankaEnv, allDiscovery.data],
  );

  const projIdxC = Math.min(projIdx, Math.max(0, displayItems.length - 1));
  const selected = displayItems[projIdxC] ?? null;
  const ns = selected?.ns ?? '';

  // Sessions for the selected item — all cwdPaths discovered together.
  const cwdKey = selected?.cwdPaths.join('\0') ?? '';
  const sessDiscovery = useAsync<SessionRef[]>(async () => {
    if (!selected || selected.cwdPaths.length === 0) return [];
    // Refresh the science export when the selected project has a science
    // cwd so its session update badges reflect the live DB, not a stale
    // export. Covers `r` on the sessions panel (which only re-runs this
    // hook, not allDiscovery) AND selection changes, in both modes.
    // Lock-guarded + incremental; an unchanged pass is cheap (aggregate
    // queries only — message bodies load lazily per re-exported session).
    if (selected.cwdPaths.some(isScienceCwd))
      await refreshScienceExportInteractive(config.scienceDir);
    const refs = discoverSessionsForProject(selected.cwdPaths);
    return isAll ? foldWorktreesToOwner(refs) : refs;
  }, [cwdKey, sessNonce, isAll, config.scienceDir]);

  const listLoading = isAll && allDiscovery.status === 'loading';
  const localStatus = listLoading ? 'loading' : sessDiscovery.status;
  const localError = sessDiscovery.error;
  const localList = sessDiscovery.data ?? [];
  const sessCount = localList.length;
  const sessIdxC = Math.min(sessIdx, Math.max(0, sessCount - 1));
  const totalAll = allDiscovery.data?.length ?? 0;

  // ── layout sizing ─────────────────────────────────────────
  const listH = Math.max(4, rows - 13);
  const projW = 22;
  const sessListW = 32;
  const detailW = Math.max(16, columns - projW - sessListW - 12);

  const closeModal = (): void => {
    setModal(null);
    setCron(schedulerStatus());
    setManifest(loadManifest(tankaEnv));
    setLogTail(readLogTail(LOG_LINES));
    refreshList();
  };

  // ── actions ───────────────────────────────────────────────
  // Single-session upload converges through runSync so the /sync API call
  // and manifest update happen through the same code path as bulk sync.
  const uploadOne = async (ref: SessionRef): Promise<void> => {
    if (!credentials || !selected) return;
    const title = `Upload · ${shortId(ref.id)}`;
    const subtitle = selected.name;
    setBusy({ title, subtitle, detail: 'starting…', done: 0, total: 0 });
    let result: SyncResult | undefined;
    try {
      const limit = isAll ? { cwd: ref.cwd } : { remoteProjectId: selected.ns };
      result = await runSync({
        ...limit,
        sessionId: ref.id,
        onEvent: (e) => {
          if (e.phase === 'upload') {
            setBusy({
              title,
              subtitle,
              detail: e.fileProgress?.label ?? '',
              done: e.fileProgress?.done ?? 0,
              total: e.fileProgress?.total ?? 0,
            });
          }
        },
      });
    } catch (e: unknown) {
      log(
        'error',
        'tui',
        `upload failed ${ref.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      showToast(errorToast(title, e));
    }
    setBusy(null);
    if (result) showToast(syncResultToast(title, result));
    setManifest(loadManifest(tankaEnv));
    setLogTail(readLogTail(LOG_LINES));
    refreshList();
  };

  // "s" syncs the selected project/dir; "S" syncs everything — same meaning in
  // both modes. The scope maps to runSync's per-mode limiter: select uses the
  // project id, all uses the directory cwd; "all" passes neither (full sync).
  const syncNow = async (scope: 'one' | 'all'): Promise<void> => {
    if (scope === 'one' && !selected) return;
    const title =
      scope === 'all' ? 'Sync · all projects' : `Sync · ${selected!.name}`;
    const limit =
      scope === 'all'
        ? {}
        : isAll
          ? { cwd: selected!.cwdPaths[0]! }
          : { remoteProjectId: selected!.ns };
    setBusy({ title, subtitle: '', detail: 'discovering…', done: 0, total: 0 });
    let result: SyncResult | undefined;
    try {
      result = await runSync({
        ...limit,
        onEvent: (e) => {
          const subtitle =
            e.projectTotal && e.projectTotal > 1
              ? `${e.projectName ?? e.project ?? ''} (${e.projectIndex}/${e.projectTotal})`
              : '';
          if (e.phase === 'discover') {
            setBusy({
              title,
              subtitle,
              detail: `discovering${e.project ? ` ${e.project}` : ''}…`,
              done: 0,
              total: 0,
            });
          } else if (e.phase === 'upload') {
            setBusy({
              title,
              subtitle,
              detail:
                `${e.session ? shortId(e.session) : ''} ${e.fileProgress?.label ?? ''}`.trim(),
              done: e.index ?? 0,
              total: e.total ?? 0,
            });
          }
        },
      });
    } catch (e: unknown) {
      log(
        'error',
        'tui',
        `sync failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      showToast(errorToast(title, e));
    }
    setBusy(null);
    if (result) showToast(syncResultToast(title, result));
    setManifest(loadManifest(tankaEnv));
    setLogTail(readLogTail(LOG_LINES));
    refreshList();
  };

  // ── input ─────────────────────────────────────────────────
  useScreenInput(
    (input, key) => {
      if (key.escape) {
        return;
      }
      if (input === 'q') {
        exit();
        return;
      }
      if (input === '?') {
        setModal('help');
        return;
      }
      if (input === 't') {
        setModal('tanka');
        return;
      }
      if (input === 'w') {
        restartWizard();
        return;
      }
      if (input === 'c') {
        setModal('cron');
        return;
      }
      if (input === 'L') {
        setModal('log');
        return;
      }
      if (input === 'r') {
        setManifest(loadManifest(tankaEnv));
        // on the project/dir panel → refresh the whole list; on sessions → just the current list
        if (focus === 'projects') refreshList();
        else refreshSessions();
        return;
      }
      if (key.tab) {
        setFocus((f) => (f === 'projects' ? 'sessions' : 'projects'));
        return;
      }
      if (input === 'm') {
        // select mode: manage projects (migrate lives inside that screen);
        // all mode: migrate the selected directory's data into another project.
        if (!isAll) {
          setModal({ kind: 'projects', action: { kind: 'list' } });
          return;
        }
        const cwd = selected?.cwdPaths[0];
        if (selected && cwd) {
          setModal({
            kind: 'migrate',
            source: {
              kind: 'cwd',
              name: selected.name,
              cwd,
              remoteProjectId: selected.remoteProjectId,
            },
          });
        }
        return;
      }
      if (input === 's' && selected) {
        void syncNow('one');
        return;
      }
      if (input === 'S') {
        void syncNow('all');
        return;
      }

      if (focus === 'projects') {
        if (key.upArrow || input === 'k')
          setProjIdx(moveIndex(projIdxC, -1, displayItems.length));
        else if (key.downArrow || input === 'j')
          setProjIdx(moveIndex(projIdxC, 1, displayItems.length));
        else if (key.return && displayItems.length > 0) {
          setFocus('sessions');
          setSessIdx(0);
        }
        return;
      }
      // focus === 'sessions'
      if (key.upArrow || input === 'k')
        setSessIdx(moveIndex(sessIdxC, -1, sessCount));
      else if (key.downArrow || input === 'j')
        setSessIdx(moveIndex(sessIdxC, 1, sessCount));
      else if (input === 'u' && localList[sessIdxC]) {
        void uploadOne(localList[sessIdxC]!);
      } else if (key.return && sessCount > 0 && selected) {
        nav.openTranscript({
          kind: 'transcript',
          projectId: ns,
          locator: { kind: 'local', ref: localList[sessIdxC]! },
        });
      }
    },
    modal === null && busy === null && toast === null,
  );

  // dismiss toast on any key
  useScreenInput(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, toast !== null);

  // ── modal / busy / toast overlays ─────────────────────────
  if (busy) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color={theme.brand}>
          {busy.title}
        </Text>
        {busy.subtitle ? (
          <Text color={theme.accent}>{`  ${busy.subtitle}`}</Text>
        ) : null}
        <Box marginTop={1}>
          <Spinner label={busy.detail || 'working…'} />
        </Box>
        {busy.total > 0 ? (
          <Text color={theme.dim}>{`  ${busy.done}/${busy.total}`}</Text>
        ) : null}
      </Box>
    );
  }
  if (toast) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color={toast.ok ? theme.ok : theme.err}>
          {toast.ok ? '✓' : '✗'} {toast.title}
        </Text>
        {toast.lines.map((line, i) => (
          <Text key={i} color={toast.ok ? theme.text : theme.err}>
            {'  '}
            {line}
          </Text>
        ))}
        <Text color={theme.dim} dimColor>
          {'  '}press any key to dismiss
        </Text>
      </Box>
    );
  }
  if (modal === 'tanka')
    return <TankaConfigScreen onSaved={closeModal} onCancel={closeModal} />;
  if (modal === 'cron') return <CronModal onClose={closeModal} />;
  if (modal != null && typeof modal === 'object' && modal.kind === 'projects')
    return (
      <ProjectsScreen
        onDone={closeModal}
        onCancel={closeModal}
        initialAction={modal.action}
      />
    );
  if (modal != null && typeof modal === 'object' && modal.kind === 'migrate')
    return (
      <MigrateModal
        source={modal.source}
        onClose={closeModal}
        onDone={(t) => {
          closeModal();
          showToast(t);
        }}
      />
    );
  if (modal === 'log') return <LogModal onClose={closeModal} />;
  if (modal === 'help') return <HelpModal onClose={closeModal} isAll={isAll} />;

  // ── board ─────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        tokenSet={credentials != null}
        tankaEnv={credentials?.env ?? DEFAULT_TANKA_ENV}
        cronLabel={cron.installed ? (cron.expr ?? 'on') : null}
        summary={
          isAll
            ? `${totalAll} sessions · ${displayItems.length} projects`
            : `${displayItems.length} projects`
        }
      />

      <Box marginTop={1}>
        <ProjectsPanel
          title="PROJECTS"
          emptyHint={isAll ? 'no sessions found' : 'press w to set up'}
          projects={displayItems.map((item) => ({ name: item.name }))}
          selected={projIdxC}
          focused={focus === 'projects'}
          height={listH}
          width={projW}
        />
        <Box marginLeft={1} flexGrow={1} flexDirection="column">
          {selected ? (
            <ProjectInfoPanel
              name={selected.name}
              remoteProjectId={selected.remoteProjectId}
              origin={selected.origin}
              cwdPaths={selected.cwdPaths}
              width={sessListW + detailW + 2}
            />
          ) : null}
          <SessionsPanel
            project={selected ? { name: selected.name } : null}
            focused={focus === 'sessions'}
            height={selected ? Math.max(2, listH - PROJECT_INFO_HEIGHT) : listH}
            listWidth={sessListW}
            detailWidth={detailW}
            local={{ status: localStatus, error: localError, list: localList }}
            selected={sessIdxC}
            manifest={manifest}
            ns={ns}
          />
        </Box>
      </Box>

      <LogStrip lines={logTail} width={columns} />

      <Box>
        <Text color={theme.dim}>
          <Text color={theme.accent}>tab</Text> panel{'  '}
          <Text color={theme.accent}>↑↓</Text> move{'  '}
          <Text color={theme.accent}>enter</Text> open{'  '}
          <Text color={theme.accent}>r</Text> refresh{'  '}
          {focus === 'sessions' ? (
            <>
              <Text color={theme.accent}>u</Text> upload{'  '}
            </>
          ) : null}
          <Text color={theme.accent}>s</Text> sync{'  '}
          <Text color={theme.accent}>S</Text> sync all{'  '}
          <Text color={theme.accent}>m</Text>{' '}
          {isAll ? 'migrate' : 'manage projs'}
          {'  '}
          <Text color={theme.accent}>t</Text> tanka{'  '}
          <Text color={theme.accent}>w</Text> wizard{'  '}
          <Text color={theme.accent}>c</Text> cron{'  '}
          <Text color={theme.accent}>L</Text> log{'  '}
          <Text color={theme.accent}>?</Text> help{'  '}
          <Text color={theme.accent}>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}

// ── header ───────────────────────────────────────────────────
function Header({
  tokenSet,
  tankaEnv,
  cronLabel,
  summary,
}: {
  tokenSet: boolean;
  tankaEnv: TankaEnv;
  cronLabel: string | null;
  summary: string;
}): React.ReactElement {
  return (
    <Box>
      <Text backgroundColor={theme.brand} color="black" bold>
        {' tanka-wm '}
      </Text>
      <Text bold>{' work-memory'}</Text>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text>
          <Text color={tokenSet ? theme.ok : theme.dim}>
            {tokenSet ? '● ' : '○ '}
          </Text>
          <Text
            color={theme.dim}
          >{`tanka ${tokenSet ? tankaEnv : 'not set'}`}</Text>
          <Text>{'   '}</Text>
          <Text color={cronLabel ? theme.ok : theme.dim}>
            {cronLabel ? '● ' : '○ '}
          </Text>
          <Text color={theme.dim}>{`cron ${cronLabel ?? 'off'}`}</Text>
          <Text color={theme.dim}>{`   ${summary}`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── projects panel ───────────────────────────────────────────
function ProjectsPanel({
  title,
  emptyHint,
  projects,
  selected,
  focused,
  height,
  width,
}: {
  title: string;
  emptyHint: string;
  projects: Array<{ name: string }>;
  selected: number;
  focused: boolean;
  height: number;
  width: number;
}): React.ReactElement {
  const cap = Math.max(1, height - 2);
  const win = computeWindow(projects, selected, cap);

  const body: React.ReactElement[] = [];
  if (win.hiddenAbove > 0)
    body.push(
      <Text key="up" color={theme.dim}>{`  ↑ ${win.hiddenAbove} more`}</Text>,
    );
  win.items.forEach((p, i) => {
    const idx = win.start + i;
    const sel = idx === selected;
    const label = `${sel ? '❯ ' : '  '}${clip(p.name, Math.max(4, width - 6))}`;
    body.push(
      <Text
        key={idx}
        color={sel ? theme.brand : undefined}
        bold={sel}
        wrap="truncate"
      >
        {label}
      </Text>,
    );
  });
  if (win.hiddenBelow > 0)
    body.push(
      <Text key="down" color={theme.dim}>{`  ↓ ${win.hiddenBelow} more`}</Text>,
    );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.brand : theme.dim}
      width={width}
      paddingX={1}
    >
      <Text bold color={focused ? theme.brand : undefined}>
        {title}
      </Text>
      {projects.length === 0 ? (
        <Text color={theme.dim}>{emptyHint}</Text>
      ) : (
        body
      )}
      {Array.from({
        length: Math.max(
          0,
          height - body.length - (projects.length === 0 ? 1 : 0),
        ),
      }).map((_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
    </Box>
  );
}

// ── sessions panel (master-detail) ───────────────────────────
interface ListState<T> {
  status: 'loading' | 'ok' | 'error';
  error?: string;
  list: T[];
}

function SessionsPanel({
  project,
  focused,
  height,
  listWidth,
  detailWidth,
  local,
  selected,
  manifest,
  ns,
}: {
  project: { name: string } | null;
  focused: boolean;
  height: number;
  listWidth: number;
  detailWidth: number;
  local: ListState<SessionRef>;
  selected: number;
  manifest: UploadManifest;
  ns: string;
}): React.ReactElement {
  const count = local.list.length;

  // Per-status tally shown after the count, reusing the row icons/colors so the
  // header summary can never drift from the list. ✓ current · ⟳ changed · · new.
  const statusSummary = useMemo(() => {
    const tally: Record<UploadStatusKind, number> = {
      current: 0,
      changed: 0,
      new: 0,
    };
    for (const r of local.list) tally[uploadStatus(manifest, ns, r)] += 1;
    return (['current', 'changed', 'new'] as const)
      .map((k) => ({ k, n: tally[k], ...statusIcon(k) }))
      .filter((s) => s.n > 0);
  }, [local.list, manifest, ns]);

  const innerH = height;
  const body = (): React.ReactElement => {
    if (!project) return <Text color={theme.dim}>no project selected</Text>;
    if (local.status === 'loading') return <Spinner label="discovering…" />;
    if (local.status === 'error')
      return <Text color={theme.err}>{`✗ ${local.error}`}</Text>;
    if (count === 0)
      return <Text color={theme.dim}>no sessions discovered</Text>;
    return (
      <Box>
        <Box flexDirection="column" width={listWidth}>
          {renderLocalRows(local.list, selected, innerH, ns, manifest)}
        </Box>
        <Box marginLeft={1} flexGrow={1} flexDirection="column">
          {renderDetail(
            localDetail(local.list[selected], ns, manifest),
            local.list[selected]?.id,
            innerH,
            detailWidth,
          )}
        </Box>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.brand : theme.dim}
      flexGrow={1}
      paddingX={1}
    >
      <Text bold color={focused ? theme.brand : undefined} wrap="truncate">
        {`SESSIONS · ${project ? project.name : '—'}`}
        <Text color={theme.dim}>{`  (${count})`}</Text>
        {statusSummary.length > 0 ? (
          <Text>
            {'  '}
            {statusSummary.map((s, i) => (
              <Text key={s.k} color={s.color}>
                {`${i > 0 ? ' ' : ''}${s.icon}${s.n}`}
              </Text>
            ))}
          </Text>
        ) : null}
      </Text>
      {body()}
    </Box>
  );
}

// ── project info panel (both modes) ──
// select: real backend project (id + origin). all: a per-cwd project that is
// created lazily on first sync — its id shows a placeholder until then.
function ProjectInfoPanel({
  name,
  remoteProjectId,
  origin,
  cwdPaths,
  width,
}: {
  name: string;
  remoteProjectId?: string;
  origin?: 'created' | 'joined';
  cwdPaths: string[];
  width: number;
}): React.ReactElement {
  const idLabel = remoteProjectId ?? 'project will be created on first sync';
  const meta = [
    idLabel,
    `${cwdPaths.length} cwd(s)`,
    ...(origin ? [origin] : []),
  ].join('  · ');
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Text bold color={theme.text} wrap="truncate">
        {`‹${name}›  `}
        <Text color={remoteProjectId ? theme.dim : theme.warn}>{meta}</Text>
      </Text>
      <Text color={theme.dim} wrap="truncate">
        {clip(cwdPaths.join(', '), width - 4)}
      </Text>
    </Box>
  );
}

function renderLocalRows(
  list: SessionRef[],
  selected: number,
  height: number,
  ns: string,
  manifest: UploadManifest,
): React.ReactElement[] {
  const win = computeWindow(list, selected, height);
  return win.items.map((r, i) => {
    const idx = win.start + i;
    const sel = idx === selected;
    const st = statusIcon(uploadStatus(manifest, ns, r));
    return (
      <Text key={r.id} color={sel ? theme.brand : undefined}>
        {sel ? '❯' : ' '}
        <Text
          color={sel ? theme.text : undefined}
        >{` ${clip(shortId(r.id), 8).padEnd(8)}`}</Text>
        <Text
          color={agentColor(r.agent)}
        >{` ${(AGENT_TAG[r.agent] ?? '?').padEnd(3)}`}</Text>
        <Text
          color={theme.dim}
        >{` ${fmtBytes(r.sizeBytes).padStart(7)} ${fmtAge(r.mtimeMs).padStart(4)} `}</Text>
        <Text color={st.color}>{st.icon}</Text>
      </Text>
    );
  });
}

function renderDetail(
  rows: Array<[string, string]>,
  title: string | undefined,
  height: number,
  width: number,
): React.ReactElement {
  const shown = rows.slice(0, Math.max(0, height - 2));
  return (
    <>
      <Text bold color={theme.text}>
        {clip(title ?? '—', width)}
      </Text>
      <Text> </Text>
      {shown.map(([k, v], i) => (
        <Text key={`${k}${i}`}>
          <Text color={theme.dim}>{k.padEnd(13)}</Text>
          <Text>{clip(v, Math.max(4, width - 13))}</Text>
        </Text>
      ))}
    </>
  );
}

function localDetail(
  ref: SessionRef | undefined,
  ns: string,
  manifest: UploadManifest,
): Array<[string, string]> {
  if (!ref) return [];
  const sub = ref.sidecarFiles.filter((f) =>
    f.relPath.startsWith('subagents/'),
  ).length;
  const tr = ref.sidecarFiles.filter((f) =>
    f.relPath.startsWith('tool-results/'),
  ).length;
  const st = uploadStatus(manifest, ns, ref);
  const rows: Array<[string, string]> = [
    ['agent', ref.agent],
    ['cwd', ref.cwd],
    ['size', fmtBytes(ref.sizeBytes)],
    ['modified', fmtRelTime(ref.mtimeMs)],
    ['subagents', String(sub)],
    ['tool-results', String(tr)],
    [
      'status',
      st === 'new'
        ? 'not uploaded'
        : st === 'changed'
          ? 'changed — re-upload'
          : 'uploaded',
    ],
  ];
  for (const [k, v] of Object.entries(ref.meta)) rows.push([k, v]);
  return rows;
}

// ── log strip ────────────────────────────────────────────────
function LogStrip({
  lines,
  width,
}: {
  lines: string[];
  width: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Text bold color={theme.dim}>
        LOG
      </Text>
      {lines.length === 0 ? (
        <Text color={theme.dim}>(no activity yet)</Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} color={theme.dim}>
            {clip(l, Math.max(20, width - 6))}
          </Text>
        ))
      )}
    </Box>
  );
}
