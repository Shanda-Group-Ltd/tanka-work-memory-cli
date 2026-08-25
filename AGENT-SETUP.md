# tanka-wm — agent-driven setup guide

**Audience: an AI coding agent.** A user asked you to set up `tanka-wm` — the
work-memory session sync tool — for them. This is the complete, deterministic,
non-interactive procedure.

`tanka-wm` discovers raw coding-agent session transcripts (Claude Code, Codex,
Cowork, claude-science) on this machine and syncs them to the Tanka
work-memory backend. claude-science sessions are read from the local
claude-science data dir (default `~/.claude-science`), exported to a local
cache before each sync, and discovered automatically — each science project
appears as a synthetic `claude-science://<org_id>/<proj_id>` entry instead of
a directory path. **macOS/Linux only**: on Windows the science export is a
hard no-op, so science sessions are simply absent there.
"Fully configured" means: a CLI on `PATH`, config + credentials written,
and a scheduled job running the upload.

---

## Step 1 — Install the CLI

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.ps1 | iex
```

The script auto-detects the platform, downloads the binary from GitHub Releases,
verifies SHA-256 checksum, and installs to `~/.local/bin`.

After installation, verify the binary works:

```bash
tanka-wm --version
```

If the command is not found, ensure `~/.local/bin` is in your `PATH` (the
installer will have prompted or auto-added it — you may need to restart your
shell).

## Step 2 — Configure credentials and device name

Ask the user for two things:

1. **API Token** — tell the user: open the **Tanka** app → go to **Link** →
   find the **AI Work Memory** section → click the **API Key** tab → generate
   a new key and paste it here.

2. **Device name** — ask the user what they'd like to call this machine
   (e.g. "Brian's MacBook", "work-laptop"). This label appears in the backend
   to identify which device uploaded a session. If they don't care, use the
   machine hostname.

Then write the credentials and seed the config with the device name:

```bash
mkdir -p ~/.tanka-wm
umask 177
cat > ~/.tanka-wm/credentials.json <<'EOF'
{ "token": "<PASTE_TOKEN_HERE>", "env": "prod" }
EOF
chmod 600 ~/.tanka-wm/credentials.json
```
### 2.5 [Interlude] Environment Pre-check: Task Scheduling Service (Linux / WSL Only)

The background scheduling mechanism of the Agent relies on the native `cron` daemon for task execution on **Linux-based systems**. 

*(Note: Windows and macOS environments utilize their own native scheduling systems and do not require this `cron` configuration.)*

If you are deploying on Linux or WSL, please verify that your `cron` service is active before proceeding to Step 3:

#### For Native Linux Environments
Check the status of the `cron` service:

```bash
# Ubuntu / Debian
sudo systemctl status cron

# CentOS / RHEL
sudo systemctl status crond
```

If the service is `inactive (dead)`, start and enable it to run on boot:

```bash
sudo systemctl enable --now cron  # Use 'crond' for CentOS/RHEL
```

#### For WSL (Windows Subsystem for Linux) Environments
WSL handles background daemons differently than native servers. Please ensure the following configurations are set:

1. **Verify `systemd` is enabled**
   Some older or minimal WSL distributions do not have `systemd` enabled by default. Check if your `/etc/wsl.conf` file contains the following block:
   ```ini
   [boot]
   systemd=true
   ```
   *Note: If you just added this configuration, you must completely restart the WSL instance by executing `wsl --shutdown` in your Windows host terminal before it takes effect.*

2. **Enable `cron` auto-start**
   Once `systemd` is active, manually start the scheduling service and enable it to run on boot:
   ```bash
   sudo systemctl enable --now cron
   ```
   You only need to execute this once. The `cron` service will now automatically initialize in the background whenever WSL starts.

## Step 3 — Pick a mode

Ask the user which mode they prefer. **Recommend "all" mode** — it syncs every
coding-agent session on the machine automatically with zero configuration.

### If the user chooses "all" mode (recommended)

Write the config and proceed to Step 4. Replace `<DEVICE_NAME>` with the name
from Step 2:

```bash
cat > ~/.tanka-wm/config.json <<EOF
{
  "version": 1,
  "mode": "all",
  "wizardStep": "done",
  "cwds": [],
  "deviceId": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "deviceName": "<DEVICE_NAME>"
}
EOF
```

If the user's claude-science data lives somewhere other than
`~/.claude-science`, add a `"scienceDir"` key to the config JSON above (keep
the `~` literal — the CLI expands it itself):

```json
  "scienceDir": "~/custom/claude-science-dir"
```

Omit the key entirely for the default location; an empty value is not valid.

If Claude Code runs with a non-default `CLAUDE_CONFIG_DIR`, add a
`"claudeConfigDir"` key pointing at that directory (sessions live under
`<dir>/projects/`):

```json
  "claudeConfigDir": "/path/to/claude-config-dir"
```

The CLI records this key automatically on any run that can read the
`CLAUDE_CONFIG_DIR` environment variable, so setting it by hand is only needed
when the very first run is a scheduled one. A scheduled (cron / launchd / task
scheduler) run inherits no shell environment and therefore cannot read the
variable — this key is how it finds the sessions. `~/.claude` is always scanned
in addition, so a wrong or outdated value costs an extra directory scan rather
than losing sessions.

### If the user chooses "select" mode

**Stop the agent-driven setup here.** Select mode requires interactive project
management (create/join projects, assign working directories) which is best
done through the TUI. Write a minimal config to start the wizard:

```bash
cat > ~/.tanka-wm/config.json <<EOF
{
  "version": 1,
  "mode": "select",
  "wizardStep": "tanka",
  "cwds": [],
  "deviceId": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "deviceName": "<DEVICE_NAME>"
}
EOF
```

Then tell the user:

> Run `tanka-wm` to launch the TUI. The setup wizard will walk you through
> verifying the token, creating or joining projects, assigning directories,
> and setting up a scheduled sync — all in one flow.

The wizard covers all remaining steps (token verification, project setup,
and cron scheduling), so the agent setup is complete here.

## Step 4 — Verify and schedule (all mode only)

```bash
tanka-wm --check   # smoke-test: render one TUI frame and exit 0
tanka-wm sync      # upload new/changed sessions; lazily creates remote projects for each discovered cwd
```

Then set up the scheduled sync:

```bash
tanka-wm cron install "0 */4 * * *"   # every 4 hours (default)
tanka-wm cron status                  # verify
```

The `tanka-wm cron` subcommand maps to the OS scheduler automatically: **cron**
on Linux, a per-user **LaunchAgent** on macOS, **Task Scheduler** on Windows.

**Supported cron expressions are a fixed subset**, not full cron grammar — the
expression must translate cleanly to launchd's interval / Task Scheduler's
trigger, so the day-of-month, month, and day-of-week fields **must all be `*`**.
Recognised shapes:

| Expression | Meaning |
|------------|---------|
| `*/N * * * *` | every N minutes (`*/1 * * * *` = every minute) |
| `M */N * * *` | every N hours (minute offset dropped) |
| `M * * * *`   | every hour at minute M |
| `M H * * *`   | daily at H:M |

---

## Merging projects (agent task)

A user may ask you to merge or consolidate work-memory projects — typically
after a directory was renamed/moved and its history ended up split across two
projects. **For the full step-by-step agent playbook (confirmation wording,
constraints, error handling), see [docs/AGENT-MIGRATE.md](docs/AGENT-MIGRATE.md).**
The short version:

```bash
tanka-wm projects                     # 1. list the current mode's projects + project IDs + cwd paths
tanka-wm migrate <src> <dst>          # 2a. move ALL of <src>'s data into <dst> (by project id)
tanka-wm migrate --cwd <dir> <dst>    # 2b. same, by directory — PREFER THIS in all mode
```

- `tanka-wm projects` is mode-aware and purely local (no token round-trip):
  all mode lists every discovered directory — including ones marked
  `(not created)` whose remote project doesn't exist yet; select mode lists
  the configured projects.
- `tanka-wm migrate <src> <dst>` accepts a local project id or a remote
  project ID for either argument. It calls the backend first and only
  re-points the local sync state (manifest, project-map, config) after the
  server move succeeds — subsequent syncs report to the target.
- `--cwd <dir>` takes a directory (copy the `cwd:` line from
  `tanka-wm projects`) and handles both cases, which is why it's the safer
  default in all mode: a mapped directory migrates its project's data; a
  `(not created)` directory has nothing to move yet, so it **joins** the
  target project and binds the directory to it — the first sync then uploads
  there directly. The target must be an existing project ID; to merge two
  not-yet-created directories, `tanka-wm sync` one of them first.

## Updating

```bash
tanka-wm update          # check and install the latest version
tanka-wm update --check  # check only, don't install
```

The CLI also auto-updates on every run (throttled to once every 4 hours). If an
update is found, the binary is replaced and the command re-executes seamlessly.
Disable with `TANKA_WM_NO_AUTO_UPDATE=1`.

## State files

| File | Description |
|------|-------------|
| `~/.tanka-wm/config.json` | mode, cwds, projects (each carries `env`), deviceId, deviceName, wizardStep, optional scienceDir, optional claudeConfigDir |
| `~/.tanka-wm/credentials.json` | token + env (0600) |
| `~/.tanka-wm/uploads/<env>/<ns>.json` | upload manifest shards, namespaced by env then project |
| `~/.tanka-wm/project-map/<env>.json` | all-mode cwd→remoteProjectId mapping, one per env |
| `~/.tanka-wm/schedule.json` | installed cron expr echo |
| `~/.tanka-wm/claude_science_export/` | claude-science export cache (derived from the local science DB; safe to delete, rebuilt on next sync) |
| `~/.tanka-wm/science-export.lock` | advisory lock held while the science export writes |
| `~/.tanka-wm/update-state.json` | auto-update throttle state |

## Notes

- **Incremental**: manifest tracks transcript mtime+size; only new/changed
  sessions re-upload. The upload is complete only after `/sync` API succeeds.
- **401 handling**: token can expire. On 401, re-fetch the apiKey and overwrite
  `credentials.json`.
- **deviceId/deviceName**: set in Step 3. `deviceName` is editable later in
  the TUI via Tanka settings (`t`).
