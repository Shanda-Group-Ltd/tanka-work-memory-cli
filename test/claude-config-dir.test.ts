/**
 * CLAUDE_CONFIG_DIR support (GitHub issue #1).
 *
 * Claude Code writes its sessions under `$CLAUDE_CONFIG_DIR/projects` when that
 * variable is set. tanka-wm used to hardcode `~/.claude/projects`, so a user
 * with a non-default config dir synced the wrong (usually stale) directory —
 * silently, because the wrong directory still had *some* sessions in it.
 *
 * The fix is deliberately NOT "resolve the one true root". The scheduled/cron
 * path inherits no shell environment and cannot read the variable at all, so
 * any single-root resolution is guaranteed wrong on exactly the path nobody
 * watches. Instead:
 *   - discovery sweeps a SET of roots (env · recorded snapshot · default), and
 *   - every environment-aware run records the variable into the config, so the
 *     cron path has something to go on.
 *
 * These tests pin both halves, plus the config round-trip that carries the
 * snapshot across runs.
 */
import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  type Config,
  ensureClaudeConfigDir,
  loadConfig,
  saveConfig,
} from '../src/config/config';
import {
  claudeEncodedDir,
  claudeRootCandidates,
  discoverSessionsForProject,
  scanSessionCwds,
} from '../src/discovery/sessions';
import { logPath } from '../src/log';
import { logClaudeRoots, warnOnEmptySweep } from '../src/sync';

let home: string;
let prevEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-ccdir-'));
  process.env.TANKA_WM_HOME = join(home, 'state');
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  delete process.env.TANKA_WM_HOME;
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  rmSync(home, { recursive: true, force: true });
});

/**
 * Plant one Claude Code session for `cwd` inside `configDir`, mirroring the
 * real layout: `<configDir>/projects/<encoded-cwd>/<session-id>.jsonl`, whose
 * head line carries the cwd and session id.
 */
function plantSession(configDir: string, cwd: string, id: string): void {
  const dir = join(configDir, 'projects', claudeEncodedDir(cwd));
  mkdirSync(dir, { recursive: true });
  const head = JSON.stringify({
    type: 'user',
    cwd,
    sessionId: id,
    version: '2.0.0',
    timestamp: '2026-06-01T00:00:00.000Z',
  });
  writeFileSync(join(dir, `${id}.jsonl`), `${head}\n`);
}

/** A project cwd that exists on disk (worktree expansion stats it). */
function makeCwd(name: string): string {
  const p = join(home, name);
  mkdirSync(p, { recursive: true });
  return p;
}

// ── discovery: the root SET ──────────────────────────────────────────────

test('discovery honours CLAUDE_CONFIG_DIR (the issue #1 report)', () => {
  const cwd = makeCwd('proj');
  const cfgDir = join(home, 'alt-claude');
  plantSession(cfgDir, cwd, 'sess-env');

  // Without the variable the alt dir is invisible — this is the old behaviour.
  assert.deepEqual(discoverSessionsForProject([cwd]), []);

  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  const found = discoverSessionsForProject([cwd]);
  assert.deepEqual(
    found.map((s) => s.id),
    ['sess-env'],
  );
});

// The cron path's whole reason for existing: no shell environment, so the
// snapshot in config.json is the ONLY thing pointing at the real directory.
test('discovery falls back to the recorded snapshot when the env var is absent', () => {
  const cwd = makeCwd('proj');
  const cfgDir = join(home, 'alt-claude');
  plantSession(cfgDir, cwd, 'sess-snap');

  saveConfig({ version: 1, cwds: [], claudeConfigDir: cfgDir });

  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  const found = discoverSessionsForProject([cwd]);
  assert.deepEqual(
    found.map((s) => s.id),
    ['sess-snap'],
  );
});

// The point of a set rather than a single root: when the user re-points
// CLAUDE_CONFIG_DIR, the snapshot goes stale — but a stale entry must only cost
// an extra directory to scan, never hide the live one.
test('a stale snapshot does not shadow the live env var — both roots are swept', () => {
  const cwd = makeCwd('proj');
  const oldDir = join(home, 'old-claude');
  const newDir = join(home, 'new-claude');
  plantSession(oldDir, cwd, 'sess-old');
  plantSession(newDir, cwd, 'sess-new');

  saveConfig({ version: 1, cwds: [], claudeConfigDir: oldDir });
  process.env.CLAUDE_CONFIG_DIR = newDir;

  const ids = discoverSessionsForProject([cwd])
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ['sess-new', 'sess-old']);
});

// Reaching the same directory through two sources must not double-count:
// sessions dedupe by (agent, id).
test('a directory reachable via both env and snapshot yields each session once', () => {
  const cwd = makeCwd('proj');
  const cfgDir = join(home, 'alt-claude');
  plantSession(cfgDir, cwd, 'sess-dup');

  saveConfig({ version: 1, cwds: [], claudeConfigDir: cfgDir });
  process.env.CLAUDE_CONFIG_DIR = cfgDir;

  assert.deepEqual(
    discoverSessionsForProject([cwd]).map((s) => s.id),
    ['sess-dup'],
  );
});

// scanSessionCwds feeds the "auto-scan → generate projects" picker, which shows
// one row per cwd. Two roots holding the same cwd (sessions from before and
// after a re-point) must merge into one row with the counts added, not appear
// twice.
test('scanSessionCwds merges one cwd found under two roots into a single tallied row', () => {
  const cwd = makeCwd('proj');
  const oldDir = join(home, 'old-claude');
  const newDir = join(home, 'new-claude');
  plantSession(oldDir, cwd, 'sess-old');
  plantSession(newDir, cwd, 'sess-new');

  saveConfig({ version: 1, cwds: [], claudeConfigDir: oldDir });
  process.env.CLAUDE_CONFIG_DIR = newDir;

  const rows = scanSessionCwds().filter(
    (r) => r.agent === 'claude-code' && r.cwd === cwd,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sessionCount, 2);
});

// Same session id reachable through two roots (a copied ~/.claude, say) must
// count once. Counting files instead of ids would double every session in a
// duplicated directory.
test('scanSessionCwds counts a session reachable through two roots only once', () => {
  const cwd = makeCwd('proj');
  const a = join(home, 'claude-a');
  const b = join(home, 'claude-b');
  plantSession(a, cwd, 'same-id');
  plantSession(b, cwd, 'same-id');

  saveConfig({ version: 1, cwds: [], claudeConfigDir: a });
  process.env.CLAUDE_CONFIG_DIR = b;

  const rows = scanSessionCwds().filter(
    (r) => r.agent === 'claude-code' && r.cwd === cwd,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sessionCount, 1);
});

// A relative CLAUDE_CONFIG_DIR would otherwise be resolved against the process
// cwd — which under cron is whatever the scheduler happened to pick.
test('claudeRootCandidates resolves a relative CLAUDE_CONFIG_DIR to an absolute path', () => {
  process.env.CLAUDE_CONFIG_DIR = 'some-relative-dir';
  const envRoot = claudeRootCandidates().find((c) => c.source === 'env');
  assert.ok(envRoot);
  assert.ok(
    isAbsolute(envRoot.dir),
    `expected an absolute path, got ${envRoot.dir}`,
  );
});

// ── ensureClaudeConfigDir: snapshot maintenance ──────────────────────────

test('ensureClaudeConfigDir records the env var and persists it', () => {
  const cfgDir = join(home, 'alt-claude');
  process.env.CLAUDE_CONFIG_DIR = cfgDir;

  const next = ensureClaudeConfigDir({ version: 1, cwds: [] });
  assert.equal(next.claudeConfigDir, cfgDir);
  assert.equal(loadConfig().claudeConfigDir, cfgDir);
});

// The rule that makes the whole scheme work. Every cron run sees no variable;
// if absence were treated as "the dir is default now", the first cron run would
// wipe the only clue the cron path has.
test('ensureClaudeConfigDir leaves the snapshot alone when the env var is unset', () => {
  const cfgDir = join(home, 'alt-claude');
  const cfg: Config = { version: 1, cwds: [], claudeConfigDir: cfgDir };
  saveConfig(cfg);

  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(ensureClaudeConfigDir(cfg).claudeConfigDir, cfgDir);
  assert.equal(loadConfig().claudeConfigDir, cfgDir);
});

// Moving back to the default is a real change and must clear the snapshot —
// otherwise the old dir keeps being swept forever. The default root is scanned
// unconditionally, so nothing is lost by not recording it.
test('ensureClaudeConfigDir drops the snapshot when the env var points back at the default', () => {
  const cfg: Config = {
    version: 1,
    cwds: [],
    claudeConfigDir: join(home, 'alt-claude'),
  };
  saveConfig(cfg);

  process.env.CLAUDE_CONFIG_DIR = '~/.claude';
  assert.equal(ensureClaudeConfigDir(cfg).claudeConfigDir, undefined);
  assert.equal(loadConfig().claudeConfigDir, undefined);
});

// ── config round-trip ────────────────────────────────────────────────────

// loadConfig builds its result field-by-field from a whitelist, so a new field
// is silently dropped unless it's added there. scienceDir WAS being dropped
// that way — the wizard wrote it and the next run never read it back.
test('loadConfig round-trips claudeConfigDir and scienceDir', () => {
  saveConfig({
    version: 1,
    cwds: [],
    claudeConfigDir: '~/alt-claude',
    scienceDir: '~/my-science',
  });
  const back = loadConfig();
  assert.equal(back.claudeConfigDir, '~/alt-claude');
  assert.equal(back.scienceDir, '~/my-science');
});

// ── fail loud ────────────────────────────────────────────────────────────

/** Whatever has accumulated in ~/.tanka-wm/wm.log for this test's home. */
function readLog(): string {
  try {
    return readFileSync(logPath(), 'utf8');
  } catch {
    return '';
  }
}

// A cron run cannot tell on its own that its snapshot went stale — it just
// sweeps a dead directory and reports success. Naming the directories on every
// run is what turns that into something a user can actually see in wm.log.
test('logClaudeRoots names the dirs it will sweep', () => {
  const cfgDir = join(home, 'alt-claude');
  mkdirSync(join(cfgDir, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfgDir;

  logClaudeRoots();
  const text = readLog();
  assert.match(text, /Claude Code dirs:/);
  assert.ok(text.includes(join(cfgDir, 'projects')));
  assert.match(text, /\(CLAUDE_CONFIG_DIR\)/);
});

test('logClaudeRoots warns about a snapshot pointing at a directory that is gone', () => {
  const gone = join(home, 'deleted-claude');
  saveConfig({ version: 1, cwds: [], claudeConfigDir: gone });

  logClaudeRoots();
  const text = readLog();
  assert.match(text, /WARN/);
  assert.match(text, /config\.claudeConfigDir does not exist/);
  assert.ok(text.includes(join(gone, 'projects')));
});

// A missing default root is the normal state on a machine that only runs Codex
// or Cowork — warning about it every sync would be noise, so it only counts
// toward the "nothing at all" case.
test('logClaudeRoots does not warn about a missing default root on its own', () => {
  const cfgDir = join(home, 'alt-claude');
  mkdirSync(join(cfgDir, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfgDir;

  // Precondition: the default root is among the candidates, absent or not.
  assert.ok(claudeRootCandidates().some((c) => c.source === 'default'));

  logClaudeRoots();
  assert.doesNotMatch(readLog(), /default.*does not exist/);
});

test('warnOnEmptySweep fires when a configured run found nothing', () => {
  warnOnEmptySweep(
    { version: 1, cwds: [], mode: 'all' },
    { uploaded: 0, failed: 0, skipped: 0, cleaned: 0, errors: [] },
  );
  assert.match(readLog(), /found 0 sessions/);
});

// Two ways this must stay quiet: a run that actually did something, and a
// fresh install with nothing configured yet (whose emptiness is expected).
test('warnOnEmptySweep stays quiet on a productive run and on an unconfigured one', () => {
  warnOnEmptySweep(
    { version: 1, cwds: [], mode: 'all' },
    { uploaded: 0, failed: 0, skipped: 7, cleaned: 0, errors: [] },
  );
  warnOnEmptySweep(
    { version: 1, cwds: [] },
    { uploaded: 0, failed: 0, skipped: 0, cleaned: 0, errors: [] },
  );
  assert.doesNotMatch(readLog(), /found 0 sessions/);
});
