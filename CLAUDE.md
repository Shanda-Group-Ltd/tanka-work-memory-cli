# tanka-work-memory-cli

`tanka-wm` — a single-package bun CLI + Ink TUI that discovers Claude Code /
Codex / Cowork / claude-science session transcripts per project and syncs them
to Tanka cloud storage via the work-memory backend API. See `README.md` for the
user-facing overview and `AGENT-SETUP.md` for a non-interactive setup procedure.

## Toolchain — bun, not node

Everything runs on **bun**. Do not reach for npm/node/tsx — they were removed
on purpose.

```bash
bun install
bun run dev        # bun src/cli.tsx (TUI from source)
bun run dev:watch  # restart on change
bun run typecheck  # tsc --noEmit (bun does NOT type-check)
bun run lint       # biome check (lint + format, scope = biome.json `files.includes`)
bun run lint:fix   # biome check --write (auto-fix + format in place)
bun test           # bun:test runner — NOT node:test
bun run build      # scripts/build-binaries.mjs → dist/tanka-wm-<platform>
                   # (bun build --compile, cross-compiles all 4 targets)
```

- Tests import from `bun:test` (not `node:test`); `node:test` under bun breaks on
  concurrent async files ("test() inside another test()"). Keep `bun:test`.
- `@types/bun` + `"types": ["bun", ...]` in tsconfig make tsc accept `bun:test`.
- The release artifact is the **self-contained binary** (`bun --compile`); the
  target machine needs neither node nor bun. There is no npm `bin`/dist publish.
- **Lint/format is Biome** (one tool, not ESLint+Prettier — same reason node was
  cut). `biome.json` decisions worth knowing before you touch it:
  - `noNonNullAssertion` is **off** on purpose: tsconfig's
    `noUncheckedIndexedAccess` makes every `arr[i]` `T | undefined`, so `arr[i]!`
    is the sanctioned escape hatch — the rule would only fight the tsconfig.
  - `noArrayIndexKey` is off (the lists are stateless display-only `<Text>`).
  - `src/discovery/{sessions,transcript}.ts` were once Biome-**excluded** to stay
    byte-identical to upstream; they have since **forked** into this project and are
    now linted/formatted like everything else (no `overrides`). `transcript.ts`
    keeps a top-of-file `// biome-ignore-all lint/suspicious/noExplicitAny` because
    its transcript JSON is heterogeneous; `sessions.ts` types its probe results
    instead.
  - Suppress a real-but-intentional finding with `// biome-ignore lint/<rule>:
    <reason>` (Biome does **not** honor `// eslint-disable` comments).

## Architecture

### Concept model (aligned with Tanka backend)

- **ProjectCwd** — a working directory entry (`{ id, name, cwd }`).
- **Project** — the backend project entity (`{ id, remoteProjectId, name,
  cwdIds, origin }`). In select mode one project has N cwds; in all mode
  each cwd is its own project (1:1, lazily created on first sync).
- **Config** — `config.json` holds `cwds: ProjectCwd[]`,
  `projects?: Project[]`, `deviceId`, `deviceName`, `mode`, `wizardStep`,
  `scienceDir?` (claude-science data dir override, stored as a `~`-literal;
  expand with `expandHome` before touching the filesystem),
  `claudeConfigDir?` (CLAUDE_CONFIG_DIR snapshot — see below).
  `loadConfig` rebuilds the object from a **field whitelist**, so a new key is
  silently dropped on read until it is added there (`scienceDir` was lost this
  way — written by the wizard, never read back).
- **Science cwd** — a claude-science project is encoded as the synthetic cwd
  `claude-science://<org_id>/<proj_id>` (one project ≡ one cwd, both modes).
  It is an identifier, NOT a path: `path.resolve` would mangle it (collapsing
  `//`→`/`), so every cwd-as-directory touchpoint branches on `isScienceCwd`
  and `project-map` fail-loud asserts against the mangled single-slash form.

### Key modules

- `src/discovery/sessions.ts` + `transcript.ts` — session discovery (Claude
  Code / Codex / Cowork / claude-science, cross-platform). `syntheticCwdFor(cwd)`
  creates virtual ProjectCwd entries for all mode. Both git calls pass
  `windowsHide: true`. Science discovery reads the exported tree (below):
  `session.jsonl` is the transcript; sidecars are the CLOSED allowlist
  `isScienceSidecar` (meta.json, details/*, artifacts/*) — a new exporter
  output shape must be added there too (a lockstep test in science.test.ts
  fails otherwise). `walkSidecar` additionally skips OS junk (.DS_Store etc.
  and `._*` AppleDouble) for every agent's sidecar tree.
  Claude Code's store is resolved by `claudeProjectsRoots()` as a **set**, not a
  single path: `CLAUDE_CONFIG_DIR` env var (live truth, absent under cron) ·
  `config.claudeConfigDir` snapshot · `~/.claude`, deduped and existence-filtered.
  A set is what makes a stale snapshot survivable — it costs one dead directory
  in the sweep instead of hiding the live one. Do NOT "simplify" this back to
  one root (that is GitHub issue #1: cron inherits no shell env, so a single
  root is wrong on exactly the path nobody watches). `scanSessionCwds` tallies
  Claude Code counts through a map for the same reason — one cwd can live under
  two roots and must not produce two picker rows.
- `src/discovery/science-export.ts` — TS port of the claude-science exporter:
  reads per-org SQLite DBs (`<scienceDir>/orgs/<org>/operon-cli.db`, bun:sqlite,
  WAL read transaction) and writes `~/.tanka-wm/claude_science_export/<org>/
  <proj>/sessions/<root_frame>/…` incrementally (per-session
  `_export_signature`; sessions build in a `.staging/` dir then rename-swap so
  readers never see a torn dir; deleted sessions/projects/orgs are pruned at
  every level, including source-removed). macOS/Linux only — `refreshScienceExport`
  in sync.ts hard-no-ops on win32. Runs before discovery on sync, Board refresh,
  and picker rescan, guarded by `science-export.lock` (NOT the sync lock, so a
  display refresh can never make `runSync` report "already running").
- `src/api/` — axios client for the work-memory business endpoints. Uses the
  **same** base URL as file upload (via `resolveBaseUrl()`, no separate gateway)
  and only a `token` header (no signing). `client.ts` creates an instance with
  token header + response envelope unwrapping + 401 → `TokenExpiredError`.
  `work-memory.ts` wraps 8 endpoints under `/link/workmemory/auth/*` (no
  `/open` prefix — only the file-upload application uses `/open`).
- `src/upload/tanka-client.ts` — the two-step file upload protocol (native
  `fetch` against the `-api` service). Step 1: POST apply → pre-signed URLs.
  Step 2: PUT files to S3. Returns `transcriptFileId` + `transcriptUrl`.
- `src/sync.ts` — incremental sync: discover → upload files → POST `/sync`
  (registers session with the backend). The manifest is updated only after
  `/sync` succeeds (and only if the response carries no item-level `errors`).
  Held under an advisory lock (`src/sync-lock.ts`, `~/.tanka-wm/sync.lock`) so
  a cron run and an interactive sync can't race. All mode lazily creates remote
  projects via `ensureRemoteProject` and self-heals dropped mappings when a
  remote project is deleted server-side; select mode pre-validates *created*
  projects against `listProjects` (paginated). Drives both `tanka-wm sync`
  (headless cron) and Board's sync actions.
  Two fail-loud guards write to `wm.log` (exported for tests — `runSync` itself
  needs credentials + network): `logClaudeRoots` states every Claude Code dir
  the run will sweep and warns per non-existent env/snapshot root (a missing
  *default* root alone is not warned — plenty of machines never run Claude
  Code); `warnOnEmptySweep` fires when a run that HAD scope found 0 sessions.
  Both exist because a stale root otherwise reports "done — 0 uploaded" as
  success, which is issue #1's silence in a new costume.
- `src/migrate.ts` — `runMigrate`: client side of `POST /project/change` (move
  one project's data into another). Order is server-call-first; only on success
  is local state re-pointed at the target — manifest shard (sync progress),
  all-mode project-map, select-mode config entry (merge cwds if the target
  already exists locally, else rewrite the source's ids). Runs under the sync
  lock. `MigrateOptions` lets the TUI inject context config/credentials +
  `setConfig` so React state doesn't diverge from disk. Two entry points:
  `runMigrate(srcId, dstId)` (CLI `migrate <src> <dst>`) and
  `runMigrateForCwd(dir, dstId)` (CLI `migrate --cwd <dir> <dst>`) — the cwd
  form folds the dir to its owning worktree, then migrates if project-mapped,
  else JOINS the target + records the project-map binding (nothing to move
  yet; first sync uploads there). A science cwd is used verbatim (no resolve /
  worktree fold / dir guard) but must parse as a full
  `claude-science://<org>/<proj>` URI or the command errors up front. Both TUI entries (ProjectsScreen `m` and
  all-mode Board `m`) share one `MigrateModal`, parameterized by a
  `MigrateSource` union (`project` → runMigrate · `cwd` → runMigrateForCwd).
  Known limit (accepted): the server call and the local re-points are not
  transactional — a local failure after the server move leaves state split
  until the user re-runs.
- `src/project-items.ts` — shared "one row per project" derivation for the
  Board's PROJECTS panel and `tanka-wm projects` (single source of truth).
  `sessionCountsForItems` counts select-mode sessions with ONE discovery
  sweep over all projects' cwds (attribution via worktree-expanded roots),
  not one full scan per project.
- `src/config/config.ts` — Config + Credentials persistence.
  `ensureDeviceIdentity` auto-generates `deviceId` (UUID) and `deviceName`
  (macOS: `scutil --get ComputerName`; others: `os.hostname()`).
- `src/config/project-map.ts` — all-mode `cwd → remoteProjectId` mapping
  (`~/.tanka-wm/project-map/<env>.json`, one file per Tanka env). Keys are
  case-folded (`foldPath`).
- `src/config/uploads.ts` — upload manifest sharded per project namespace.
- `src/scheduler/` — cross-platform scheduled-upload backends behind one
  `Scheduler` interface: `crontab.ts` (linux), `launchd.ts` (darwin),
  `schtasks.ts` (win32).
- TUI: `app.tsx` (wizard ⇄ board), `screens/`, `modals/`, `components/`,
  `hooks/`.

### Upload protocol

Two stages per session:
1. **PUT files** — POST `/open/file/upload/application` for pre-signed URLs,
   then PUT transcript + sidecar files to S3. `groupId` format:
   `wm-session-${remoteProjectId}-${randomId}`. The pre-signed URL signs
   `content-disposition;content-length;content-md5;content-type;host` — the
   PUT must echo every signed header byte-for-byte.
2. **POST /sync** — `POST /link/workmemory/auth/sync` with the transcript's
   `fileId` + `objectStorageUri` + session metadata (including `deviceId`,
   `deviceName`). This establishes the project↔session association on the
   backend. The manifest records upload only after `/sync` succeeds.

## Run modes (`config.mode`)

- **all** — `discoverAllSessions()` scans the whole machine each run. Each
  cwd is a project (1:1); remote projects are lazily created on first sync
  and mapped in `project-map/<env>.json`. Board shows PROJECTS.
- **select** — user-managed projects via `ProjectsScreen`. Each project has
  a `remoteProjectId` (from backend `createProject` / user-provided for
  `joinProject`) and one or more cwds. Board shows PROJECTS + project info.

## Environment & config

- Upload environment is **dev/test/uat/prod** (default prod), chosen in Tanka
  settings and stored in `credentials.json` alongside the token. **One** set of
  base URLs (resolved from `TANKA_API_URL_<ENV>` env vars, inlined at compile
  time via `--define`) serves both file upload and the business API — there is
  no separate `-gw` gateway and no request signing.
- State lives under `~/.tanka-wm/` (override `TANKA_WM_HOME`, used by tests):
  - `config.json` — cwds, projects (each carries `env`), mode, wizardStep,
    deviceId, deviceName, scienceDir?, claudeConfigDir?
  - `credentials.json` 0600 — token + env
  - `uploads/<env>/<ns>.json` — manifest shards per env per project namespace
    (`ns` = remoteProjectId); env-isolated so switching env can't cross-contaminate
  - `project-map/<env>.json` — all-mode cwd→remoteProjectId mapping, one per env
  - `schedule.json` — installed cron expr echo
  - `sync.lock` — advisory lock held for the duration of a `runSync`
  - `science-export.lock` — advisory lock held while the science export writes
    (separate from sync.lock on purpose; see science-export module notes)
  - `claude_science_export/` — the exported claude-science session tree
    (derived cache; not env-namespaced — it mirrors the local DB verbatim)
  - `wm.log` — append-only activity log (TUI + cron sync)
  - `update-state.json` — self-update bookkeeping

## Wizard

- 4 steps (select): mode → tanka → projects → cron
- 3 steps (all): mode → tanka → cron
- Tanka step: env + token + deviceName (editable) + deviceId (read-only) +
  claude-science data dir (editable, default `~/.claude-science`; clearing the
  field resets to the default) + the resolved Claude Code session dirs
  (read-only list from `claudeRootCandidates`, non-existent ones shown too).
  That list is not decoration: discovery sweeps every resolved root at once, so
  someone deliberately keeping separate CLAUDE_CONFIG_DIRs (work vs personal)
  must be able to SEE that both are in scope before a sync ships both.
- Projects step (select only): `ProjectsScreen` —
  create/join/edit/migrate/delete/leave

## Board keys

| Key | Action |
|-----|--------|
| `m` | select mode: manage projects (opens `ProjectsScreen`) · all mode: migrate the selected directory's data into another project (`MigrateModal`) |
| `s` / `S` | sync the selected project / all projects |
| `L` | activity log |

ProjectsScreen list keys (select mode): `c` create · `j` join · `e` edit ·
`m` migrate · `d` delete (origin=created) · `l` leave (origin=joined) ·
`r` rescan.

## Unfinished

- scheduled upload backends: macOS launchd verified e2e; Windows schtasks and
  Linux crontab have unit coverage but NOT exercised on real platforms yet.
- `joinProject` always records `origin: 'joined'`; joining a project you
  created elsewhere is mislabelled (Board offers leave, not delete). Needs a
  `creatorUserId` check to self-correct (accepted as-is for now).
- select-mode pre-validation skips *joined* projects' existence check (the
  backend `/project/list` may not return joined projects); their deletion only
  surfaces as a per-session `/sync` failure. Confirm `/project/list` semantics.
- `bun:test` can't `mkdtemp` under a read-only sandbox — full suite needs write
  access to the temp dir.
