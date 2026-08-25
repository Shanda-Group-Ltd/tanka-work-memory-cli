/**
 * Root component. Two startup modes:
 *   - Wizard — the default until setup is finished (resumable across launches).
 *   - Board  — the persistent multi-panel app, once the wizard is done.
 * A transcript drill-in can layer over the Board.
 *
 * Config and credentials live here and flow down through context.
 */
import { useApp } from 'ink';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

import {
  type Config,
  type Credentials,
  DEFAULT_TANKA_ENV,
  ensureClaudeConfigDir,
  ensureDeviceIdentity,
  loadConfig,
  loadCredentials,
  type RunMode,
  saveConfig,
  saveCredentials,
  type WizardStep,
} from './config/config';
import { dropProjectManifest } from './config/uploads';
import { ConfigProvider, type ConfigStore } from './hooks/useConfig';
import { type Nav, NavProvider, type TranscriptRoute } from './navigation';
import { Board } from './screens/Board';
import { TranscriptScreen } from './screens/TranscriptScreen';
import { Wizard } from './screens/Wizard';

export interface AppProps {
  /** --check mode: render one frame then exit 0 (binary smoke-test). */
  checkMode: boolean;
}

function transcriptKey(route: TranscriptRoute): string {
  if (route.kind === 'subagent') return `sub:${route.relPath}`;
  return `txn:${route.locator.ref.path}`;
}

/**
 * After a config is persisted, forget the upload state of any project that no
 * longer exists in it. The manifest is namespaced by `remoteProjectId`, so we
 * diff projects by that key (not by local slug or cwd id).
 */
function cleanupRemovedProjects(prev: Config, next: Config): void {
  const keptRemoteIds = new Set(
    (next.projects ?? []).map((p) => p.remoteProjectId),
  );
  for (const p of prev.projects ?? []) {
    if (!keptRemoteIds.has(p.remoteProjectId)) {
      dropProjectManifest(p.env ?? DEFAULT_TANKA_ENV, p.remoteProjectId);
    }
  }
}

/** Resolve where to start: an explicit wizardStep, else infer from config + token. */
function initialWizardStep(
  config: Config,
  credentials: Credentials | null,
): WizardStep {
  if (config.wizardStep) return config.wizardStep;
  // a pre-existing setup (mode chosen + token + projects when in select mode) skips the wizard
  const configured =
    !!config.mode &&
    !!credentials &&
    (config.mode === 'all' || config.cwds.length > 0);
  return configured ? 'done' : 'mode';
}

export function App({ checkMode }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [config, setConfigState] = useState<Config>(() =>
    ensureClaudeConfigDir(ensureDeviceIdentity(loadConfig())),
  );
  const [credentials, setCredentialsState] = useState<Credentials | null>(() =>
    loadCredentials(),
  );
  const [wizardStep, setWizardStep] = useState<WizardStep>(() =>
    initialWizardStep(config, credentials),
  );
  const [stack, setStack] = useState<TranscriptRoute[]>([]);
  // re-run wizard: an in-memory draft snapshot, committed to disk only on finish.
  const [reWizard, setReWizard] = useState<{
    config: Config;
    credentials: Credentials | null;
  } | null>(null);

  useEffect(() => {
    if (!checkMode) return;
    const t = setTimeout(() => exit(), 250);
    return () => clearTimeout(t);
  }, [checkMode, exit]);

  // record the resolved step the first time, so a fresh install is recognised
  // as "wizard in progress" rather than "pre-existing" on the next launch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only init; the inner `wizardStep === undefined` guard keeps it idempotent.
  useEffect(() => {
    if (config.wizardStep === undefined) {
      const next = { ...config, wizardStep };
      saveConfig(next);
      setConfigState(next);
    }
  }, []);

  const configStore: ConfigStore = useMemo(
    () => ({
      config,
      credentials,
      setConfig: (c) => {
        cleanupRemovedProjects(config, c);
        saveConfig(c);
        setConfigState(c);
      },
      setCredentials: (c) => {
        saveCredentials(c);
        setCredentialsState(c);
      },
      // Enter a draft re-run: snapshot current config/credentials; nothing is
      // persisted until the wizard finishes (cancel discards the draft).
      restartWizard: () => {
        setReWizard({ config: { ...config, wizardStep: 'mode' }, credentials });
      },
    }),
    [config, credentials],
  );

  const advanceWizard = (next: WizardStep): void => {
    setWizardStep(next);
    setConfigState((c) => {
      const nc = { ...c, wizardStep: next };
      saveConfig(nc);
      return nc;
    });
  };

  const setMode = (mode: RunMode): void => {
    setConfigState((c) => {
      const nc = { ...c, mode };
      saveConfig(nc);
      return nc;
    });
  };

  // ── re-run wizard (draft) ─────────────────────────────────
  // Edits live on the `reWizard` snapshot via this store; finishing commits it,
  // cancelling drops it — so a re-run never changes anything unless completed.
  const draftStore: ConfigStore | null = reWizard
    ? {
        config: reWizard.config,
        credentials: reWizard.credentials,
        setConfig: (c) => setReWizard((d) => (d ? { ...d, config: c } : d)),
        setCredentials: (cr) =>
          setReWizard((d) => (d ? { ...d, credentials: cr } : d)),
        restartWizard: () => {},
      }
    : null;

  const commitReWizard = (): void => {
    if (!reWizard) return;
    const nc = { ...reWizard.config, wizardStep: 'done' as WizardStep };
    cleanupRemovedProjects(config, nc);
    saveConfig(nc);
    setConfigState(nc);
    setWizardStep('done');
    if (reWizard.credentials) {
      saveCredentials(reWizard.credentials);
      setCredentialsState(reWizard.credentials);
    }
    setReWizard(null);
  };

  const draftAdvance = (next: WizardStep): void => {
    if (next === 'done') {
      commitReWizard();
      return;
    }
    setReWizard((d) =>
      d ? { ...d, config: { ...d.config, wizardStep: next } } : d,
    );
  };
  const draftSetMode = (m: RunMode): void => {
    setReWizard((d) => (d ? { ...d, config: { ...d.config, mode: m } } : d));
  };

  const nav: Nav = useMemo(
    () => ({
      openTranscript: (route) => setStack((s) => [...s, route]),
      back: () => setStack((s) => s.slice(0, -1)),
    }),
    [],
  );

  const top = stack[stack.length - 1];
  const showWizard = !checkMode && wizardStep !== 'done';

  // Re-run wizard: a draft store layered over the snapshot, isolated from disk.
  if (!checkMode && reWizard && draftStore) {
    return (
      <ConfigProvider value={draftStore}>
        <NavProvider value={nav}>
          <Wizard
            step={reWizard.config.wizardStep ?? 'mode'}
            mode={reWizard.config.mode}
            onAdvance={draftAdvance}
            onSetMode={draftSetMode}
            onExit={() => setReWizard(null)}
            rerun
          />
        </NavProvider>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider value={configStore}>
      <NavProvider value={nav}>
        {showWizard ? (
          <Wizard
            step={wizardStep}
            mode={config.mode}
            onAdvance={advanceWizard}
            onSetMode={setMode}
          />
        ) : top ? (
          <TranscriptScreen key={transcriptKey(top)} route={top} />
        ) : (
          <Board />
        )}
      </NavProvider>
    </ConfigProvider>
  );
}
