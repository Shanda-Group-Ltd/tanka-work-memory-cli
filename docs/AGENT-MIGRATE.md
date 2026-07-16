# tanka-wm — project migration assistant

**Audience: an AI coding agent.** A user asked you to merge or consolidate
their Tanka work-memory projects (typical trigger: a directory was renamed or
moved, so its session history is split across two projects; or several
scattered directories should report into one shared project).

`tanka-wm migrate` moves ALL of one project's data into another on the server,
then re-points the local sync state so future syncs report to the target.
Requires tanka-wm ≥ 1.6.0 (`tanka-wm --version`; run `tanka-wm update` if older).

## Procedure

### 1. Survey

```bash
tanka-wm projects
```

Read the header first: it tells you the run mode (`mode: all` or `mode: select`)
and env. Each row is one project: NAME, PROJECT ID, SESSIONS, with its
`cwd:` path(s) indented below. In all mode, a PROJECT ID of `(not created)`
means that directory has never been synced — no remote project exists yet.

A claude-science project's `cwd:` is not a directory but a synthetic URI of
the form `claude-science://<org_id>/<proj_id>`. Treat it exactly like any
other cwd in the steps below — just copy the whole URI verbatim.

### 2. Confirm the plan with the user

Identify the SOURCE (whose data moves away) and the TARGET (where it lands),
then restate the plan and get explicit confirmation before running anything —
the server-side move is not reversible by this CLI:

> "I'll move everything from ‹source name› (ID …) into ‹target name› (ID …).
> Future syncs of ‹cwd› will upload to the target. Proceed?"

Constraints to check while planning:

- The TARGET must be an existing project ID (12-char nanoid — copy it from
  step 1, or the user provides one created elsewhere, e.g. on another device).
  Never guess or fabricate IDs.
- To merge two `(not created)` directories, first `tanka-wm sync` one of them
  (this lazily creates its remote project), then migrate the other into it.
- Migrating a project into itself is rejected by the CLI.

### 3. Execute

Pick the form that matches the source:

```bash
tanka-wm migrate <src-project-id> <target-project-id>   # source is a project id
tanka-wm migrate --cwd <directory> <target-project-id>  # source is a directory
```

In **all mode, prefer `--cwd`** with the `cwd:` path copied from step 1 — it
handles both cases automatically: a directory that already has a project
migrates its data; a `(not created)` directory has nothing to move, so it
**joins** the target project and binds the directory to it instead (the first
sync then uploads there directly).

`--cwd` also accepts a claude-science URI. It is used verbatim (no path
resolution, no worktree folding, no is-a-directory check), but it must parse
as a complete `claude-science://<org_id>/<proj_id>` — copy the entire `cwd:`
line from step 1; a truncated or single-slash form is rejected up front.

### 4. Verify and finish

- Read the command output: `migrated …` lines report manifest records moved,
  cwd mappings re-pointed, and whether the local config entry was updated;
  `joined …` means the bind-only branch ran.
- Re-run `tanka-wm projects` to confirm the source row is gone / re-pointed
  and the target now owns the cwd.
- Offer to run `tanka-wm sync` so any not-yet-uploaded sessions land in the
  target immediately.

## Error handling

- `token not configured` → credentials are missing; follow
  [AGENT-SETUP.md](../AGENT-SETUP.md) (Tanka app → Link → AI Work Memory →
  API Key).
- `another sync is running — try again later` → a scheduled sync holds the
  lock; wait a minute and retry.
- `<path> is not a directory (and has no project mapping)` → the `--cwd`
  argument is wrong or you meant a project id; re-check against step 1.
- `invalid claude-science cwd "…" — expected claude-science://<org_id>/<proj_id>`
  → the science URI was truncated or malformed (e.g. `claude-science:/…` with
  a single slash, or a trailing `/`); re-copy the full `cwd:` line from step 1.
- Backend errors are printed verbatim. If the command failed AFTER the server
  move (rare local-disk failure), tell the user: the server data has already
  moved; re-running the same command is the recovery path, and the backend's
  idempotency determines the outcome — do not improvise local file edits.
- Any other unexpected state: stop and show the user the exact output instead
  of retrying blindly.
