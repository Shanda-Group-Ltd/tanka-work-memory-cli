import { Database } from 'bun:sqlite';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config, Credentials } from '../src/config/config';
import { expandHome } from '../src/config/config';
import {
  lookupRemoteProjectId,
  recordProjectMapping,
} from '../src/config/project-map';
import { runScienceExport } from '../src/discovery/science-export';
import type { SessionRef } from '../src/discovery/sessions';
import {
  discoverScienceSessions,
  isScienceCwd,
  parseScienceCwd,
  scienceCwd,
  scienceExportCwds,
  syntheticCwdFor,
} from '../src/discovery/sessions';
import { runMigrateForCwd } from '../src/migrate';
import { allModeItems, sessionCountsForItems } from '../src/project-items';
import { classifySidecar } from '../src/sync';

// ── predicates ───────────────────────────────────────────────────────

test('scienceCwd / isScienceCwd / parseScienceCwd round-trip', () => {
  const cwd = scienceCwd('org-uuid-123', 'proj_abc');
  assert.equal(cwd, 'claude-science://org-uuid-123/proj_abc');
  assert.equal(isScienceCwd(cwd), true);
  assert.equal(isScienceCwd('/Users/x/proj'), false);
  assert.deepEqual(parseScienceCwd(cwd), {
    orgId: 'org-uuid-123',
    projId: 'proj_abc',
  });
});

test('parseScienceCwd rejects malformed values', () => {
  assert.equal(parseScienceCwd('/real/path'), null);
  assert.equal(parseScienceCwd('claude-science://'), null); // no org/proj
  assert.equal(parseScienceCwd('claude-science://orgonly'), null); // no slash
  assert.equal(parseScienceCwd('claude-science:///proj'), null); // empty org
  assert.equal(parseScienceCwd('claude-science://org/'), null); // empty proj
  // '/' inside projId: a shell-completion trailing slash (or extra segment)
  // must not bind a project-map key discovery can never match.
  assert.equal(parseScienceCwd('claude-science://org/proj/'), null);
  assert.equal(parseScienceCwd('claude-science://org/a/b'), null);
});

// ── expandHome ───────────────────────────────────────────────────────

test('expandHome expands leading tilde only', () => {
  assert.equal(expandHome('~'), process.env.HOME);
  assert.equal(
    expandHome('~/.claude-science'),
    `${process.env.HOME}/.claude-science`,
  );
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('rel/~/mid'), 'rel/~/mid'); // tilde not at start → untouched
});

// ── project-map mangled-key assertion ────────────────────────────────

test('project-map rejects a path.resolve-mangled science key', () => {
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-'));
  const prev = process.env.TANKA_WM_HOME;
  process.env.TANKA_WM_HOME = home;
  try {
    // The mangled form: `//` collapsed to `/` by path.resolve.
    const mangled = '/some/dir/claude-science:/org/proj';
    assert.throws(
      () => recordProjectMapping('prod', mangled, 'remote1'),
      /mangled science cwd key/,
    );
    assert.throws(
      () => lookupRemoteProjectId('prod', mangled),
      /mangled science cwd key/,
    );
    // The verbatim form round-trips fine.
    const good = scienceCwd('org', 'proj');
    recordProjectMapping('prod', good, 'remote1');
    assert.equal(lookupRemoteProjectId('prod', good), 'remote1');
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── discovery from a fixture export tree ─────────────────────────────

/** Write a minimal exported session tree and return the export dir. */
function fixtureExport(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tanka-sci-exp-'));
  const org = '2509ecdd';
  const proj = 'proj_dc82';
  const sess = 'root-frame-uuid';
  const base = join(dir, org, proj);
  mkdirSync(join(base, 'sessions', sess, 'details'), { recursive: true });
  mkdirSync(join(base, 'sessions', sess, 'artifacts', 'art1'), {
    recursive: true,
  });
  writeFileSync(
    join(base, 'project.json'),
    JSON.stringify({ name: '研究项目' }),
  );
  const sd = join(base, 'sessions', sess);
  writeFileSync(join(sd, 'session.jsonl'), '{"frame_id":"x","idx":0}\n');
  writeFileSync(
    join(sd, 'meta.json'),
    JSON.stringify({
      model: 'claude-opus-4-8',
      status: 'completed',
      name: '研究项目会话',
      agent_name: 'OPERON',
      created_at: 1784169271633,
    }),
  );
  writeFileSync(join(sd, 'details', 'chat-frames.jsonl'), '{"id":"x"}\n');
  writeFileSync(
    join(sd, 'artifacts', '_artifacts.jsonl'),
    '{"artifact_id":"art1"}\n',
  );
  writeFileSync(join(sd, 'artifacts', 'art1', 'v1_data.csv'), 'a,b\n1,2\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('discoverScienceSessions builds a SessionRef from the export tree', () => {
  const { dir, cleanup } = fixtureExport();
  try {
    const cwd = scienceCwd('2509ecdd', 'proj_dc82');
    const refs = discoverScienceSessions(cwd, dir);
    assert.equal(refs.length, 1);
    const r = refs[0]!;
    assert.equal(r.agent, 'claude-science');
    assert.equal(r.id, 'root-frame-uuid');
    assert.equal(r.cwd, cwd);
    assert.ok(r.path.endsWith('session.jsonl'));
    // index meta lifted from meta.json (CJK preserved), created_at → ISO
    assert.equal(r.meta.name, '研究项目会话');
    assert.equal(r.meta.model, 'claude-opus-4-8');
    assert.equal(r.meta.startedAt, new Date(1784169271633).toISOString());
    // sidecars: meta.json + details/* + artifacts/*, but NOT session.jsonl
    const rels = r.sidecarFiles.map((f) => f.relPath).sort();
    assert.deepEqual(rels, [
      'artifacts/_artifacts.jsonl',
      'artifacts/art1/v1_data.csv',
      'details/chat-frames.jsonl',
      'meta.json',
    ]);
    assert.equal(
      rels.includes('session.jsonl'),
      false,
      'the transcript must not also appear as a sidecar',
    );
  } finally {
    cleanup();
  }
});

test('discoverScienceSessions skips a half-written session (no session.jsonl)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tanka-sci-half-'));
  try {
    const sd = join(dir, 'org', 'proj', 'sessions', 'half');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, 'meta.json'), '{}'); // meta but no transcript
    const refs = discoverScienceSessions(scienceCwd('org', 'proj'), dir);
    assert.deepEqual(refs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scienceExportCwds enumerates projects that have a sessions dir', () => {
  const { dir, cleanup } = fixtureExport();
  try {
    // add a project with no sessions/ dir — must be excluded
    mkdirSync(join(dir, '2509ecdd', 'proj_empty'), { recursive: true });
    const cwds = scienceExportCwds(dir).sort();
    assert.deepEqual(cwds, [scienceCwd('2509ecdd', 'proj_dc82')]);
  } finally {
    cleanup();
  }
});

// ── all-mode ordering: science first ─────────────────────────────────

test('allModeItems floats science projects to the top', () => {
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-order-'));
  try {
    process.env.TANKA_WM_HOME = home; // no project-map → all remoteProjectId undefined
    const ref = (cwd: string, id: string): SessionRef => ({
      id,
      agent: 'claude-code',
      path: '',
      cwd,
      sizeBytes: 1,
      mtimeMs: 1,
      meta: {},
      sidecarFiles: [],
    });
    const items = allModeItems(
      [
        ref('/Users/x/zzz', 's1'),
        ref('/Users/x/aaa', 's2'),
        ref(scienceCwd('org', 'proj_z'), 's3'),
        ref(scienceCwd('org', 'proj_a'), 's4'),
      ],
      'test',
    );
    const science = items.map((it) => isScienceCwd(it.cwdPaths[0] ?? ''));
    // the first two entries are the science ones (sorted by name within group)
    assert.deepEqual(science, [true, true, false, false]);
    assert.equal(items[2]!.name, 'aaa'); // regular group still name-sorted
    assert.equal(items[3]!.name, 'zzz');
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── sidecarType classification ───────────────────────────────────────

test('classifySidecar tags science sidecars by top-level dir', () => {
  assert.equal(classifySidecar('claude-science', 'meta.json'), 'meta');
  assert.equal(
    classifySidecar('claude-science', 'details/chat-frames.jsonl'),
    'details',
  );
  assert.equal(
    classifySidecar('claude-science', 'artifacts/_artifacts.jsonl'),
    'artifacts',
  );
  assert.equal(
    classifySidecar('claude-science', 'artifacts/art1/v1_data.csv'),
    'artifacts',
  );
  // non-science agents keep the prefix-based scheme
  assert.equal(
    classifySidecar('claude-code', 'subagents/agent-a1.jsonl'),
    'subagent',
  );
  assert.equal(classifySidecar('claude-code', 'tool-results/x'), 'tool-result');
});

// ── migrate --cwd for a science cwd ──────────────────────────────────

const EMPTY_CONFIG: Config = { version: 1, cwds: [] };
const CREDS: Credentials = { token: 't', env: 'test' };

test('runMigrateForCwd looks up a science cwd verbatim (no mangling)', async () => {
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-mig-'));
  try {
    process.env.TANKA_WM_HOME = home;
    const scwd = scienceCwd('org', 'proj');
    recordProjectMapping('test', scwd, 'R1');
    // target resolves to R1 too → source===target → moveProjectData throws
    // BEFORE any network call. Reaching that throw proves the science cwd was
    // looked up verbatim (a mangled key would miss the mapping and fall to the
    // join path instead).
    await assert.rejects(
      runMigrateForCwd(scwd, 'R1', {
        config: EMPTY_CONFIG,
        credentials: CREDS,
      }),
      /source and target are the same/,
    );
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('runMigrateForCwd still rejects an unmapped non-directory (regression)', async () => {
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-mig2-'));
  try {
    process.env.TANKA_WM_HOME = home;
    await assert.rejects(
      runMigrateForCwd('/no/such/dir/xyz', 'R1', {
        config: EMPTY_CONFIG,
        credentials: CREDS,
      }),
      /is not a directory/,
    );
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sessionCountsForItems counts science sessions (no path.resolve mangling)', () => {
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-count-'));
  try {
    process.env.TANKA_WM_HOME = home;
    // lay a fixture export with one session under the export dir
    const base = join(
      home,
      'claude_science_export',
      '2509ecdd',
      'proj_dc82',
      'sessions',
      'sess1',
    );
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'session.jsonl'), '{"idx":0}\n');
    const cwd = scienceCwd('2509ecdd', 'proj_dc82');
    const counts = sessionCountsForItems([
      { name: 'p', cwdPaths: [cwd], ns: 'x' },
    ]);
    assert.deepEqual(counts, [1]);
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── export-tree prune (deleted project / org) ────────────────────────

/**
 * Lay a minimal per-org `operon-cli.db` with one completed root frame per
 * project id — just enough schema for `runScienceExport` to export each project
 * as one session. Empty message/artifact/detail tables exercise the real query
 * paths without any content.
 */
function makeOrgDb(scienceDir: string, orgId: string, projIds: string[]): void {
  const orgDir = join(scienceDir, 'orgs', orgId);
  mkdirSync(orgDir, { recursive: true });
  const db = new Database(join(orgDir, 'operon-cli.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT, name TEXT, created_at INTEGER);
    CREATE TABLE frames (id TEXT, project_id TEXT, parent_frame_id TEXT, root_frame_id TEXT, conversation_type TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE frame_messages (frame_id TEXT, idx INTEGER);
    CREATE TABLE execution_log (frame_id TEXT, cell_index INTEGER);
    CREATE TABLE artifacts (id TEXT, project_id TEXT, root_frame_id TEXT, filename TEXT, is_user_upload INTEGER, is_ephemeral INTEGER, sort_order INTEGER);
    CREATE TABLE artifact_versions (id TEXT, artifact_id TEXT, version_number INTEGER, frame_id TEXT, content_type TEXT, size_bytes INTEGER, checksum TEXT, storage_path TEXT, language TEXT, code_description TEXT, created_at INTEGER);
    CREATE TABLE verification_checks (root_frame_id TEXT);
    CREATE TABLE frame_system_prompts (frame_id TEXT);
    CREATE TABLE compaction_archives (frame_id TEXT);
    CREATE TABLE frame_branch_archives (frame_id TEXT);
  `);
  let t = 1000;
  for (const pid of projIds) {
    db.query('INSERT INTO projects (id,name,created_at) VALUES (?,?,?)').run(
      pid,
      `name-${pid}`,
      t,
    );
    const fid = `frame-${pid}`;
    db.query(
      'INSERT INTO frames (id,project_id,parent_frame_id,root_frame_id,conversation_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(fid, pid, null, fid, 'agent', 'completed', t, t);
    t += 1;
  }
  db.close();
}

test('runScienceExport prunes deleted projects and orgs', async () => {
  const scienceDir = mkdtempSync(join(tmpdir(), 'tanka-sci-src-'));
  const outDir = mkdtempSync(join(tmpdir(), 'tanka-sci-out-'));
  try {
    makeOrgDb(scienceDir, 'orgA', ['p1', 'p2']);
    makeOrgDb(scienceDir, 'orgB', ['p3']);
    await runScienceExport({ scienceDir, outDir });
    assert.equal(existsSync(join(outDir, 'orgA', 'p1')), true);
    assert.equal(existsSync(join(outDir, 'orgA', 'p2')), true);
    assert.equal(existsSync(join(outDir, 'orgB', 'p3')), true);

    // delete p2 from orgA's DB, and drop orgB from the source entirely
    const db = new Database(join(scienceDir, 'orgs', 'orgA', 'operon-cli.db'));
    db.query('DELETE FROM projects WHERE id=?').run('p2');
    db.query('DELETE FROM frames WHERE project_id=?').run('p2');
    db.close();
    rmSync(join(scienceDir, 'orgs', 'orgB'), { recursive: true, force: true });

    const s = await runScienceExport({ scienceDir, outDir });
    assert.equal(existsSync(join(outDir, 'orgA', 'p1')), true); // kept
    assert.equal(existsSync(join(outDir, 'orgA', 'p2')), false); // deleted project pruned
    assert.equal(existsSync(join(outDir, 'orgB')), false); // deleted org pruned
    assert.ok(s.counts.pruned >= 2);
  } finally {
    rmSync(scienceDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("runScienceExport prunes the export dir of an org's LAST deleted project", async () => {
  const scienceDir = mkdtempSync(join(tmpdir(), 'tanka-sci-last-'));
  const outDir = mkdtempSync(join(tmpdir(), 'tanka-sci-lastout-'));
  try {
    makeOrgDb(scienceDir, 'orgA', ['p1']);
    await runScienceExport({ scienceDir, outDir });
    assert.equal(existsSync(join(outDir, 'orgA', 'p1')), true);

    // delete the ONLY project — the org dir + DB stay (projects table empty)
    const db = new Database(join(scienceDir, 'orgs', 'orgA', 'operon-cli.db'));
    db.query('DELETE FROM projects WHERE id=?').run('p1');
    db.query('DELETE FROM frames WHERE project_id=?').run('p1');
    db.close();

    const s = await runScienceExport({ scienceDir, outDir });
    // the empty-projects run must still reach the project-level prune
    assert.equal(existsSync(join(outDir, 'orgA', 'p1')), false);
    assert.ok(s.counts.pruned >= 1);
  } finally {
    rmSync(scienceDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runScienceExport clears the export tree when the source is removed', async () => {
  const scienceDir = mkdtempSync(join(tmpdir(), 'tanka-sci-gone-'));
  const outDir = mkdtempSync(join(tmpdir(), 'tanka-sci-goneout-'));
  try {
    makeOrgDb(scienceDir, 'orgA', ['p1']);
    await runScienceExport({ scienceDir, outDir });
    assert.equal(existsSync(join(outDir, 'orgA')), true);

    // uninstall: the whole orgs/ root disappears
    rmSync(join(scienceDir, 'orgs'), { recursive: true, force: true });
    const s = await runScienceExport({ scienceDir, outDir });
    // the derived cache is cleared instead of lingering as phantom projects
    assert.equal(existsSync(join(outDir, 'orgA')), false);
    assert.ok(s.counts.pruned >= 1);
  } finally {
    rmSync(scienceDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runMigrateForCwd rejects malformed science cwds with a clear error', async () => {
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-badcwd-'));
  try {
    process.env.TANKA_WM_HOME = home;
    // missing project segment
    await assert.rejects(
      runMigrateForCwd('claude-science://orgonly', 'R1', {
        config: EMPTY_CONFIG,
        credentials: CREDS,
      }),
      /invalid claude-science cwd/,
    );
    // single-slash typo — must NOT surface the internal mangled-key assertion
    await assert.rejects(
      runMigrateForCwd('claude-science:/org/proj', 'R1', {
        config: EMPTY_CONFIG,
        credentials: CREDS,
      }),
      /invalid claude-science cwd/,
    );
    // shell-completion trailing slash — would bind a dead project-map key
    await assert.rejects(
      runMigrateForCwd('claude-science://org/proj/', 'R1', {
        config: EMPTY_CONFIG,
        credentials: CREDS,
      }),
      /invalid claude-science cwd/,
    );
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('runScienceExport with onlyProject leaves sibling export dirs untouched', async () => {
  const scienceDir = mkdtempSync(join(tmpdir(), 'tanka-sci-flt-'));
  const outDir = mkdtempSync(join(tmpdir(), 'tanka-sci-fltout-'));
  try {
    makeOrgDb(scienceDir, 'orgA', ['p1', 'p2']);
    await runScienceExport({ scienceDir, outDir }); // full: p1 + p2 exist
    // a filtered run must not read p2's absence-from-this-pass as a deletion
    await runScienceExport({ scienceDir, outDir, onlyProject: 'p1' });
    assert.equal(existsSync(join(outDir, 'orgA', 'p2')), true);
  } finally {
    rmSync(scienceDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('syntheticCwdFor uses the exported project name for a science cwd', () => {
  // syntheticCwdFor reads scienceExportDir() = TANKA_WM_HOME/claude_science_export,
  // so point TANKA_WM_HOME at a home and lay the project.json under its export dir.
  const prev = process.env.TANKA_WM_HOME;
  const home = mkdtempSync(join(tmpdir(), 'tanka-sci-home-'));
  try {
    process.env.TANKA_WM_HOME = home;
    const base = join(home, 'claude_science_export', '2509ecdd', 'proj_dc82');
    mkdirSync(join(base, 'sessions'), { recursive: true });
    writeFileSync(
      join(base, 'project.json'),
      JSON.stringify({ name: '研究项目' }),
    );
    const scwd = scienceCwd('2509ecdd', 'proj_dc82');
    const pc = syntheticCwdFor(scwd);
    assert.equal(pc.name, '研究项目');
    assert.equal(pc.cwd, scwd);
    assert.equal(pc.id, 'proj_dc82');
  } finally {
    if (prev === undefined) delete process.env.TANKA_WM_HOME;
    else process.env.TANKA_WM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
