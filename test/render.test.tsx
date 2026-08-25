import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { render } from 'ink-testing-library';
import type React from 'react';

import { App } from '../src/app';
import { emptyConfig, loadConfig, saveConfig } from '../src/config/config';
import { ConfigProvider, type ConfigStore } from '../src/hooks/useConfig';
import { CronModal } from '../src/modals/CronModal';
import { HelpModal } from '../src/modals/HelpModal';
import { LogModal } from '../src/modals/LogModal';
import { MigrateModal } from '../src/modals/MigrateModal';
import { type Nav, NavProvider } from '../src/navigation';
import { ModeScreen } from '../src/screens/ModeScreen';
import { TankaConfigScreen } from '../src/screens/TankaConfigScreen';

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const noop = (): void => {};

let home: string;
const API_ENV_VARS: Record<string, string> = {
  TANKA_API_URL_DEV: 'https://dev.test',
  TANKA_API_URL_TEST: 'https://test.test',
  TANKA_API_URL_UAT: 'https://uat.test',
  TANKA_API_URL_PROD: 'https://prod.test',
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-tui-render-'));
  process.env.TANKA_WM_HOME = home;
  for (const [k, v] of Object.entries(API_ENV_VARS)) process.env[k] = v;
});
afterEach(() => {
  delete process.env.TANKA_WM_HOME;
  for (const k of Object.keys(API_ENV_VARS)) delete process.env[k];
  rmSync(home, { recursive: true, force: true });
});

function harness(children: React.ReactNode): React.ReactElement {
  const store: ConfigStore = {
    config: emptyConfig(),
    credentials: null,
    setConfig: noop,
    setCredentials: noop,
    restartWizard: noop,
  };
  const nav: Nav = { openTranscript: noop, back: noop };
  return (
    <ConfigProvider value={store}>
      <NavProvider value={nav}>{children}</NavProvider>
    </ConfigProvider>
  );
}

test('App boots to the Board once the wizard is done', async () => {
  saveConfig({ ...emptyConfig(), wizardStep: 'done' });
  const { lastFrame, unmount } = render(<App checkMode={false} />);
  await delay(80);
  const frame = lastFrame() ?? '';
  assert.match(frame, /work-memory/);
  assert.match(frame, /PROJECTS/);
  assert.match(frame, /SESSIONS/);
  unmount();
});

test('App resumes the wizard at the recorded step', async () => {
  // mode 'all' + wizardStep 'tanka' → resumes on the Tanka step, which is 2/3 in all mode
  saveConfig({ ...emptyConfig(), mode: 'all', wizardStep: 'tanka' });
  const { lastFrame, unmount } = render(<App checkMode={false} />);
  await delay(80);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Setup 2\/3/);
  assert.match(frame, /Tanka settings/);
  unmount();
});

test('TankaConfigScreen mounts and renders the form fields', async () => {
  const { lastFrame, unmount } = render(
    harness(<TankaConfigScreen onSaved={noop} onCancel={noop} />),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Tanka settings/);
  assert.match(frame, /token/);
  assert.match(frame, /target/);
  // claude-science data dir field with its default value
  assert.match(frame, /claude science/);
  assert.match(frame, /~\/\.claude-science/);
  unmount();
});

// Discovery sweeps EVERY resolved Claude Code root at once. Someone who keeps
// work and personal sessions in separate CLAUDE_CONFIG_DIRs must be able to see
// that both are in scope before a sync ships both — so the screen lists them,
// stale ones included, rather than widening the sweep silently.
test('TankaConfigScreen lists the resolved Claude Code session dirs', async () => {
  const alt = join(home, 'alt-claude');
  mkdirSync(join(alt, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = alt;
  try {
    const { lastFrame, unmount } = render(
      harness(<TankaConfigScreen onSaved={noop} onCancel={noop} />),
    );
    await delay(40);
    const frame = lastFrame() ?? '';
    assert.match(frame, /claude code/);
    // Both roots are in scope and both are named — the env one and the default.
    // (Paths themselves aren't asserted: a tmpdir path is long enough that Ink
    // wraps it mid-word, which says nothing about the screen being wrong.)
    assert.match(frame, /2 dir\(s\) scanned/);
    assert.match(frame, /from CLAUDE_CONFIG_DIR/);
    assert.match(frame, /default/);
    unmount();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('CronModal shows a Continue row in wizard mode', async () => {
  const { lastFrame, unmount } = render(
    harness(<CronModal onClose={noop} onContinue={noop} />),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Scheduled upload/);
  assert.match(frame, /Continue/);
  unmount();
});

test('LogModal mounts', async () => {
  const { lastFrame, unmount } = render(harness(<LogModal onClose={noop} />));
  await delay(40);
  assert.match(lastFrame() ?? '', /Activity log/);
  unmount();
});

test('HelpModal lists keybindings with the mode in the subtitle (select)', async () => {
  const { lastFrame, unmount } = render(
    harness(<HelpModal onClose={noop} isAll={false} />),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /switch panel/);
  assert.match(frame, /select-projects mode/);
  unmount();
});

test('HelpModal shows all-sessions mode in the subtitle', async () => {
  const { lastFrame, unmount } = render(
    harness(<HelpModal onClose={noop} isAll={true} />),
  );
  await delay(40);
  assert.match(lastFrame() ?? '', /all-sessions mode/);
  unmount();
});

test('MigrateModal shows the migrate branch for a synced directory', async () => {
  const { lastFrame, unmount } = render(
    harness(
      <MigrateModal
        source={{
          kind: 'cwd',
          name: 'demo',
          cwd: '/tmp/demo',
          remoteProjectId: 'abc123def456',
        }}
        onDone={noop}
        onClose={noop}
      />,
    ),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Migrate/);
  assert.match(frame, /source project ID {2}abc123def456/);
  assert.match(frame, /target project ID/);
  unmount();
});

test('MigrateModal shows the join branch for a never-synced directory', async () => {
  const { lastFrame, unmount } = render(
    harness(
      <MigrateModal
        source={{ kind: 'cwd', name: 'demo', cwd: '/tmp/demo' }}
        onDone={noop}
        onClose={noop}
      />,
    ),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /never synced/);
  assert.match(frame, /target project ID/);
  unmount();
});

test('MigrateModal shows the project form for a select-mode project', async () => {
  const { lastFrame, unmount } = render(
    harness(
      <MigrateModal
        source={{ kind: 'project', name: 'My Proj', remoteProjectId: 'p123' }}
        onDone={noop}
        onClose={noop}
      />,
    ),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /source project ID {2}p123/);
  assert.match(frame, /target project ID/);
  unmount();
});

test('ModeScreen offers both run modes', async () => {
  const { lastFrame, unmount } = render(
    harness(<ModeScreen onPick={noop} onCancel={noop} />),
  );
  await delay(40);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Run mode/);
  assert.match(frame, /All sessions/);
  assert.match(frame, /Select projects/);
  unmount();
});

test('App starts the wizard at the mode step on a fresh install', async () => {
  // no config at all → wizard begins at the run-mode step
  const { lastFrame, unmount } = render(<App checkMode={false} />);
  await delay(80);
  assert.match(lastFrame() ?? '', /Run mode/);
  unmount();
});

test('w re-runs the wizard as a draft; cancelling leaves config unchanged', async () => {
  saveConfig({ ...emptyConfig(), mode: 'select', wizardStep: 'done' });
  const { stdin, lastFrame, unmount } = render(<App checkMode={false} />);
  await delay(80);
  const before = JSON.stringify(loadConfig());
  stdin.write('w'); // enter the re-run wizard (draft)
  await delay(60);
  assert.match(lastFrame() ?? '', /Run mode/);
  stdin.write(String.fromCharCode(27)); // Esc on the mode step → cancel back to the Board
  await delay(60);
  assert.equal(JSON.stringify(loadConfig()), before); // nothing was persisted
  unmount();
});
