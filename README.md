# tanka-work-memory-cli

`tanka-wm` — a bun CLI (with an Ink TUI) that **discovers coding-agent session
transcripts** (Claude Code, Codex, Claude Cowork, claude-science) per project
and **syncs them to the Tanka work-memory backend**.

Single package, zero runtime dependency beyond bun and `ink`/`react` for the
terminal UI. The session-discovery core is agent-agnostic; the upload layer
speaks Tanka's two-step file-upload + `/sync` protocol.

## Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.ps1 | iex
```

The installer auto-detects your platform, downloads the matching binary from
GitHub Releases, verifies SHA-256 checksum, and places it in `~/.local/bin`.

To pin a version: `TANKA_WM_VERSION=v1.3.1 curl ... | bash`
To change install dir: `TANKA_WM_INSTALL_DIR=/usr/local/bin curl ... | bash`

## What it does / doesn't

**Run modes** (chosen in the wizard's first step, stored as `config.mode`):

- **All** — sync *every* coding-agent session on the machine, re-discovered on
  each run so new directories are picked up automatically. Each cwd is its own
  project (1:1), lazily created on the backend at first sync.
- **Select** — sync only the sessions of the projects you manage. Each project
  is created on (or joined from) the backend and has one or more cwds.

**Does**

- Manage projects (select mode) — create/join/edit/delete/leave via the
  backend API. CWDs are discovered by scanning the machine for coding-agent
  sessions.
- Discover sessions: Claude Code (`~/.claude/projects/`), Codex
  (`~/.codex/sessions/`), Cowork (`~/Library/Application Support/Claude/
  local-agent-mode-sessions/`), claude-science (`~/.claude-science`, exported
  to a local cache before each sync; macOS/Linux only — each science project
  shows up as `claude-science://<org>/<proj>`).
- Incremental sync — upload files to S3, then POST `/sync` to register with
  the backend. A local manifest records each session's transcript mtime+size;
  only new/changed sessions sync. Stale records are pruned automatically.
- TUI Board: projects panel, sessions master-detail with per-session upload
  status, local transcript viewer, and config/cron modals.
- Headless `tanka-wm sync` (the cron target) + cron install/remove.
- Self-update from GitHub Releases (`tanka-wm update`).

**Doesn't** (this tool is raw-session sync only)

- No Claude Code plugin / slash commands / subagents
- No work-log synthesis or daily reports

## Toolchain & build

Everything runs on **bun** — dev runtime, test runner, and binary compiler.

```bash
bun install        # install deps
bun run dev        # run the TUI from source (bun src/cli.tsx)
bun run dev:watch  # same, restart on file change
bun run typecheck  # tsc --noEmit (strict)
bun run lint       # biome check (lint + format); lint:fix to auto-fix
bun test           # tests (config / discovery / render / upload / scheduler / format)
bun run build      # compile self-contained binaries → dist/tanka-wm-<platform>
```

`bun run build` cross-compiles standalone executables (6 platforms:
`darwin-arm64/x64`, `linux-x64/arm64`, `windows-x64/arm64`) and generates
`checksums-sha256.txt` alongside them.

API base URLs are injected at compile time via `TANKA_API_URL_*` environment
variables and bun's `--define` flag. `TANKA_API_URL_PROD` is required for
building; `DEV`/`TEST`/`UAT` are optional — omitted environments are excluded
from the binary.

## Configuration

State lives under `~/.tanka-wm/` (override with `TANKA_WM_HOME`):

| File | Mode | Contents |
|---|---|---|
| `config.json` | 0644 | `mode`, `cwds[]`, `projects[]`, `deviceId`, `deviceName`, `wizardStep` |
| `credentials.json` | 0600 | `{ "token": "mcp_sk_…", "env": "prod" }` |
| `uploads/<env>/<ns>.json` | 0644 | upload manifest shards, namespaced by env then project |
| `project-map/<env>.json` | 0644 | all-mode cwd→remoteProjectId mapping, one per env |

**Token** — the raw apiKey from `/open/auth/mcp/api-key/work-memory`. Configure
in the TUI (`t` → Tanka settings) or write `credentials.json` directly.

**Environment** — only environments with a configured API URL are available.
The built binary includes whichever `TANKA_API_URL_*` variables were set at
compile time.

## Usage

```bash
tanka-wm                      # launch the TUI board
tanka-wm sync [project]       # upload new / changed sessions and exit (cron target)
tanka-wm projects             # list the current mode's projects (all mode: every discovered dir)
tanka-wm migrate <src> <dst>  # move all of one project's synced data into another project
tanka-wm migrate --cwd <dir> <dst>  # same, by directory — a dir with no project yet joins <dst>
tanka-wm cron install [expr]  # install the scheduled-upload job (default: 0 */4 * * *)
tanka-wm cron status          # show the scheduled-upload job
tanka-wm cron remove          # remove it
tanka-wm update               # check for updates and install the latest version
tanka-wm update --check       # check for updates without installing
tanka-wm --version | --help
```

### Merging projects (for AI agents)

When a user asks to merge or consolidate work-memory projects (e.g. a renamed
directory left its history under an old project) — full agent playbook in
[docs/AGENT-MIGRATE.md](docs/AGENT-MIGRATE.md):

1. **List** — `tanka-wm projects` shows the current mode's projects with
   their project IDs and `cwd:` paths. In all mode that's every discovered
   directory; `(not created)` marks one whose remote project doesn't exist yet.
2. **Migrate** — pick the form that matches the source:
   - `tanka-wm migrate <src> <dst>` — by project id (both args accept a local
     project id or a remote project ID);
   - `tanka-wm migrate --cwd <dir> <dst>` — by directory; in all mode prefer
     this form (copy the `cwd:` line from step 1) — it handles created and
     not-yet-created directories alike.

Semantics: the server-side move runs first; local sync state (manifest,
project-map, config) follows on success, so subsequent syncs report to the
target. With `--cwd`, a directory that has no project yet has nothing to move —
it joins the target project and binds the directory to it, so the first sync
uploads there directly. The target must be an existing project; to merge two
not-yet-created directories, `tanka-wm sync` one of them first.

### Cron prerequisite (Linux / WSL only)

The `tanka-wm cron` subcommand relies on the native `cron` daemon on
Linux-based systems. macOS uses a per-user LaunchAgent and Windows uses Task
Scheduler — neither requires extra setup.

**Native Linux:**

```bash
# Ubuntu / Debian
sudo systemctl status cron

# CentOS / RHEL
sudo systemctl status crond
```

If `inactive (dead)`, start and enable it:

```bash
sudo systemctl enable --now cron   # 'crond' for CentOS/RHEL
```

**WSL (Windows Subsystem for Linux):**

1. Ensure `systemd` is enabled — check `/etc/wsl.conf` contains:
   ```ini
   [boot]
   systemd=true
   ```
   If you just added this, restart WSL with `wsl --shutdown` from the Windows
   host terminal.

2. Start and enable `cron`:
   ```bash
   sudo systemctl enable --now cron
   ```

### TUI keys

| Key | Action |
|-----|--------|
| `tab` | switch panel (Projects ⇄ Sessions) |
| `↑↓` / `j k` | move within focused panel |
| `enter` | open transcript / focus sessions |
| `r` | refresh |
| `u` | upload selected session |
| `s` / `S` | sync project / sync all |
| `m` | select mode: manage projects (create/join/edit/migrate/delete/leave) · all mode: migrate the selected directory's data into another project |
| `t` | Tanka settings |
| `w` | re-run wizard |
| `c` | scheduled upload (cron) |
| `L` | activity log |
| `?` | help |
| `q` | quit |

## Upload + sync protocol

Per session, in two stages:

1. **Upload files** (`src/upload/tanka-client.ts`) — POST
   `/open/file/upload/application` for pre-signed S3 URLs, then PUT
   transcript + sidecar files. `groupId`: `wm-session-${remoteProjectId}-${randomId}`.
2. **Register with backend** (`src/sync.ts`) — POST
   `/link/workmemory/auth/sync` with `projectId`, transcript `fileId` +
   `objectStorageUri`, and session metadata (including `deviceId`,
   `deviceName`). The manifest records upload only after this succeeds.

## Repo layout

```
src/
├── cli.tsx              # entry: TUI / sync / cron / update / --check / --version
├── app.tsx              # root component (wizard ⇄ board)
├── api/                 # axios client + work-memory API endpoints
├── discovery/           # agent-agnostic session discovery
│   ├── sessions.ts      #   discoverSessionsForProject / scan / SessionRef
│   └── transcript.ts    #   transcript parsing & rendering
├── upload/tanka-client.ts   # two-step file upload (native fetch → S3)
├── sync.ts              # incremental sync (upload + /sync API)
├── update.ts            # self-update via GitHub Releases
├── config/              # config.json / credentials / manifest / project-map / paths
├── screens/             # Board, Wizard, ProjectsScreen, TankaConfigScreen, …
├── modals/  components/  hooks/   # Ink UI
├── scheduler/           # cross-platform scheduled-upload
├── format.ts  log.ts  theme.ts  text.ts  version.ts
test/                    # bun:test
e2e/                     # Docker-based Linux e2e tests (real backend)
install.sh               # macOS/Linux installer
install.ps1              # Windows installer (PowerShell)
```
