/**
 * tanka-work-memory-cli — entry point.
 *
 *   tanka-wm              launch the Ink board
 *   tanka-wm sync [proj]  headless incremental upload (cron target), then exit
 *   tanka-wm --version    print version
 *   tanka-wm --check      render one frame and exit 0 (binary smoke-test)
 */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { App } from './app';
import {
  DEFAULT_TANKA_ENV,
  loadConfig,
  loadCredentials,
  resolveProjectId,
} from './config/config';
import { installSchedule, removeSchedule, schedulerStatus } from './scheduler';
import { runSync } from './sync';
import { WM_TUI_VERSION } from './version';

const argv = process.argv.slice(2);
const cmd = argv[0];

// ── Auto-update: check + replace + re-exec (skip for --version/--help/update) ──
if (
  cmd !== '--version' &&
  cmd !== '-v' &&
  cmd !== '--help' &&
  cmd !== '-h' &&
  cmd !== 'update'
) {
  const { autoUpdate } = await import('./update');
  const updated = await autoUpdate();
  if (updated) {
    // Binary has been replaced — re-exec with the user's original arguments.
    // Use `argv` (process.argv.slice(2)) which is already parsed above and
    // works consistently across bun compile's argv conventions.
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, argv, {
      stdio: 'inherit',
      env: { ...process.env, TANKA_WM_NO_AUTO_UPDATE: '1' },
    });
    process.exit(result.status ?? 0);
  }
}

if (cmd === '--version' || cmd === '-v') {
  console.log(`tanka-wm ${WM_TUI_VERSION}`);
  process.exit(0);
}

if (cmd === '--help' || cmd === '-h') {
  console.log(
    [
      `tanka-wm ${WM_TUI_VERSION} — work-memory session manager`,
      '',
      'Usage:',
      '  tanka-wm                     launch the TUI board',
      '  tanka-wm sync [project]      upload new / changed sessions and exit (cron target)',
      '  tanka-wm projects            list the current mode’s projects (all mode: every discovered dir)',
      '  tanka-wm migrate <src> <dst> move all of one project’s synced data into another project',
      '  tanka-wm migrate --cwd <dir> <dst>  same, by directory — a dir with no project yet joins <dst>',
      '  tanka-wm cron install [expr] install the scheduled-upload job (default: 0 */4 * * *)',
      '  tanka-wm cron status         show the scheduled-upload job',
      '  tanka-wm cron remove         remove the scheduled-upload job',
      '  tanka-wm update              check for updates and install the latest version',
      '  tanka-wm update --check      check for updates without installing',
      '  tanka-wm --version           print version',
      '  tanka-wm --help              show this help',
    ].join('\n'),
  );
  process.exit(0);
}

if (cmd === 'cron') {
  const sub = argv[1];
  try {
    if (sub === 'status') {
      const st = schedulerStatus();
      console.log(
        st.installed ? `installed: ${st.expr ?? 'on'}` : 'not installed',
      );
      process.exit(0);
    }
    if (sub === 'remove') {
      removeSchedule();
      console.log('scheduled upload removed');
      process.exit(0);
    }
    if (sub === 'install') {
      const expr = argv[2] || '0 */4 * * *';
      installSchedule(process.execPath, expr);
      console.log(
        `scheduled upload installed: ${expr}  →  ${process.execPath} sync`,
      );
      process.exit(0);
    }
    console.error('usage: wm cron <status|install [cron-expr]|remove>');
    process.exit(1);
  } catch (e: unknown) {
    console.error(`cron: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (cmd === 'update') {
  const { checkForUpdate, performUpdate, isCompiledBinary, formatBytes } =
    await import('./update');

  const checkOnly = argv.includes('--check');

  try {
    process.stdout.write('checking for updates… ');
    const result = await checkForUpdate();

    if (!result.hasUpdate) {
      console.log(`already up to date (${result.current})`);
      process.exit(0);
    }

    console.log(`update available: ${result.current} → ${result.latest}`);

    if (checkOnly) {
      if (result.release.htmlUrl) console.log(`  ${result.release.htmlUrl}`);
      process.exit(0);
    }

    if (!isCompiledBinary()) {
      console.error(
        'self-update is only supported for compiled binaries.\n' +
          'running from source — please pull the latest code instead.',
      );
      process.exit(1);
    }

    if (!result.matchedAsset) {
      console.error(
        `no binary available for ${process.platform}-${process.arch}`,
      );
      process.exit(1);
    }

    process.stdout.write(
      `downloading ${result.matchedAsset.name} (${formatBytes(result.matchedAsset.size)})… `,
    );

    const binPath = await performUpdate(result, (p) => {
      if (p.bytesTotal) {
        const pct = Math.round((p.bytesDownloaded / p.bytesTotal) * 100);
        process.stdout.write(`\rdownloading… ${pct}%  `);
      }
    });

    console.log(`\nupdated to ${result.latest} → ${binPath}`);
    process.exit(0);
  } catch (e: unknown) {
    console.error(
      `\nupdate failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

if (cmd === 'projects') {
  // Mode-aware, purely local (mirrors the Board's PROJECTS panel — no token
  // needed): all mode lists every discovered directory, INCLUDING ones whose
  // remote project hasn't been lazily created yet; select mode lists the
  // configured projects of the current env.
  try {
    const cfg = loadConfig();
    const env = loadCredentials()?.env ?? DEFAULT_TANKA_ENV;
    const mode = cfg.mode ?? 'select';
    const { allModeItems, selectModeItems, sessionCountsForItems } =
      await import('./project-items');
    const { clip, padEndWidth } = await import('./format');

    if (mode === 'all') {
      const { discoverAllSessions } = await import('./discovery/sessions');
      const items = allModeItems(discoverAllSessions(), env);
      console.log(`mode: all · env: ${env} · ${items.length} project(s)`);
      console.log(`${'NAME'.padEnd(26)}${'PROJECT ID'.padEnd(16)}SESSIONS`);
      for (const it of items) {
        console.log(
          `${padEndWidth(clip(it.name, 25), 26)}${(it.remoteProjectId ?? '(not created)').padEnd(16)}${it.sessions ?? 0}`,
        );
        for (const cwd of it.cwdPaths) console.log(`    cwd: ${cwd}`);
      }
    } else {
      const items = selectModeItems(cfg, env);
      // One discovery sweep for ALL projects (not one per project).
      const counts = sessionCountsForItems(items);
      console.log(`mode: select · env: ${env} · ${items.length} project(s)`);
      console.log(
        `${'NAME'.padEnd(26)}${'PROJECT ID'.padEnd(16)}${'ORIGIN'.padEnd(9)}SESSIONS`,
      );
      items.forEach((it, i) => {
        console.log(
          `${padEndWidth(clip(it.name, 25), 26)}${it.ns.padEnd(16)}${(it.origin ?? '—').padEnd(9)}${counts[i] ?? 0}`,
        );
        for (const cwd of it.cwdPaths) console.log(`    cwd: ${cwd}`);
      });
    }
    process.exit(0);
  } catch (e: unknown) {
    console.error(
      `projects failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

if (cmd === 'migrate') {
  const useCwd = argv[1] === '--cwd';
  const sourceArg = argv[useCwd ? 2 : 1];
  const targetArg = argv[useCwd ? 3 : 2];
  if (!sourceArg || !targetArg) {
    console.error('usage: tanka-wm migrate <source-project> <target-project>');
    console.error('       tanka-wm migrate --cwd <directory> <target-project>');
    console.error(
      '  project args accept a local project id or a remote project ID;',
    );
    console.error(
      '  --cwd takes a directory — a dir with no project yet joins the target instead',
    );
    process.exit(1);
  }
  try {
    const { runMigrate, runMigrateForCwd } = await import('./migrate');
    const r = useCwd
      ? await runMigrateForCwd(sourceArg, targetArg)
      : await runMigrate(sourceArg, targetArg);
    if (r.action === 'joined') {
      console.log(
        `joined project ${r.targetRemoteId} and bound the directory to it`,
      );
      console.log('  nothing to migrate yet — the first sync uploads there');
    } else {
      console.log(
        `migrated project data: ${r.sourceRemoteId} → ${r.targetRemoteId}`,
      );
      console.log(`  manifest: ${r.manifestMoved} session record(s) moved`);
      console.log(`  project-map: ${r.cwdsRemapped} cwd(s) re-pointed`);
      console.log(
        `  config: project entry ${r.configUpdated ? 'updated' : 'unchanged'}`,
      );
    }
    process.exit(0);
  } catch (e: unknown) {
    console.error(
      `migrate failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

if (cmd === 'sync') {
  try {
    // `sync [proj]` accepts a local project id or a remoteProjectId; resolve to
    // the remoteProjectId that runSync's select-mode limiter expects.
    let remoteProjectId = argv[1];
    if (remoteProjectId) {
      remoteProjectId = resolveProjectId(
        loadConfig(),
        loadCredentials()?.env ?? DEFAULT_TANKA_ENV,
        remoteProjectId,
      );
    }
    const result = await runSync(remoteProjectId ? { remoteProjectId } : {});
    console.log(
      `sync: ${result.uploaded} uploaded, ${result.failed} failed, ${result.skipped} up-to-date, ${result.cleaned} cleaned`,
    );
    for (const err of result.errors.slice(0, 10)) console.error(`  ${err}`);
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (e: unknown) {
    console.error(`sync failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const checkMode = argv.includes('--check');

/**
 * Ink 7 throws if handed the real `process.stdin` when it's not a TTY — exactly
 * the --check / CI case. An inert stub sidesteps that while still rendering.
 */
function inertStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, {
    isTTY: false,
    setRawMode: () => s,
    ref: () => s,
    unref: () => s,
    read: () => null,
    setEncoding: () => s,
    resume: () => s,
    pause: () => s,
  });
  return s;
}

const { waitUntilExit } = render(<App checkMode={checkMode} />, {
  stdin: checkMode ? inertStdin() : process.stdin,
});
await waitUntilExit();
