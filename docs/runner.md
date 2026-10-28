# Headless runner

The headless runner executes AgentFlow agent loops (PLAN, EXECUTE) on a
server, a VM, a WSL2 distribution, a Docker container or directly on Windows,
without the desktop app. It is a plain Node.js process that connects to the AgentFlow API exactly
like the desktop app does, registers as a compute target, and runs the Claude
Code CLI with the vendored plugins (`agent-plugins/`, loaded with
`--plugin-dir`).

```
AgentFlow API ──websocket──▶ runner ──▶ run-loop.sh ──▶ claude -p … (agent team)
       ▲                                    │
       └──── loop events, artifacts, heartbeats (HTTPS, loop token) ◀──┘
```

Run as many runners as you like, on any number of machines: each one appears
as its own compute target. A workflow is pinned to one compute target
(`agent.computeTargetId`), and EXECUTE always runs on the runner that ran the
PLAN. The runner only connects outwards; it needs no open port.

## Docker or a plain Ubuntu server?

Both run the same runner. **Docker is the recommended default.**

| | Docker container | Ubuntu Server + systemd |
|---|---|---|
| Isolation from the host | Container boundary: agent-written code cannot touch the host's files or other services | Only a Unix user; anything that user can read, agents can read |
| Per-project toolchains | One image per toolchain (`FROM agentflow-runner:base`), reproducible, versioned | Install every project's toolchain on the server, and keep them from conflicting |
| Several runners per machine | `docker run` again with another name and volumes | One service per runner, each with its own user and directories (manual) |
| Upgrade and rollback | Rebuild or pull the image; roll back by tag | Re-run `install.sh`; no rollback beyond reinstalling the old package |
| Tests that need Docker (Testcontainers, `docker compose`) | Needs the host Docker socket, which is root on the host; avoid | Works natively (add the user to the `docker` group) |
| Debugging | `docker exec`, logs via `docker logs` | Ordinary shell, `journalctl` |

Pick **Docker** unless a project's build or tests need Docker themselves,
special hardware, or kernel features. In that case install directly, on a
**dedicated VM**: the VM then is the isolation boundary. Never install a
runner on a server that also holds production data or other services'
secrets, whichever method you use.

## Before you install

You need, for every runner:

1. **A AgentFlow API URL reachable from the runner**, over https. The API key
   travels over this connection, so plain http is refused except for
   localhost or hosts you list in `AGENTFLOW_ALLOW_HTTP_HOSTS` (only for a
   network you trust, e.g. `host.docker.internal` on Docker Desktop).
2. **An API key**: AgentFlow → Settings → API Keys. The runner registers as a
   compute target of the key's owner; a dedicated "bot" user is a good owner.
3. **Claude credentials**, either in AgentFlow or on the runner:
   - **In AgentFlow (recommended for API keys and compatible APIs such as
     DeepSeek):** Settings → Compute & Integrations → Local compute targets →
     the runner → **Model provider**. Choose "Anthropic-compatible API", enter
     the base URL, the token, the default model and any other Claude Code
     variables, or paste a Claude `settings.json` and **Import** it. AgentFlow
     stores the token sealed and sends the settings with every loop that runs
     on this computer; nothing is written to the runner's disk, and changing
     or rotating them needs no restart.
   - **On the runner (for a Claude subscription):** `CLAUDE_CODE_OAUTH_TOKEN`
     from `claude setup-token` (run it on any machine with a browser; valid
     one year), or `ANTHROPIC_API_KEY`. A model provider set in AgentFlow
     takes precedence for that computer's loops.
4. **A GitHub token** (`GH_TOKEN`) for cloning, pushing and opening pull
   requests: ideally a fine-grained token of a bot account, limited to the
   repositories the agents may change.

## Option A: Docker

Build the base image from the repository root:

```bash
docker buildx build -f deploy/runner/Dockerfile -t agentflow-runner:base .
```

It contains Node.js 24, git, gh, jq, python3 (+ PyYAML), ripgrep, Claude Code
(official apt repository, `latest` channel, so every build ships the newest
release; `--build-arg CLAUDE_CODE_CHANNEL=stable` for the one about a week
behind), the runner and the plugins, and runs as the unprivileged user
`runner`. Loops run the Claude Code version set for the runner in AgentFlow
(see [Claude Code version](#claude-code-version)).

Run it:

```bash
docker run -d --name agentflow-runner-1 --restart unless-stopped \
  -e AGENTFLOW_API_URL=https://agentflow.example.com \
  -e AGENTFLOW_API_KEY=sk_live_... \
  -e AGENTFLOW_RUNNER_NAME=runner-1 \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e GH_TOKEN=github_pat_... \
  -v agentflow-runner-1-workspace:/workspace \
  -v agentflow-runner-1-data:/home/runner/.agentflow-runner \
  -v agentflow-runner-1-claude:/home/runner/.claude \
  -v agentflow-runner-1-learnings:/home/runner/.agentflow-ai \
  -v agentflow-runner-1-claude-versions:/home/runner/.local/share/claude \
  agentflow-runner:base
```

On Docker Desktop with the API on the same machine, use
`-e AGENTFLOW_API_URL=http://host.docker.internal:3002 -e
AGENTFLOW_ALLOW_HTTP_HOSTS=host.docker.internal`.

Volumes:

- `/workspace`: cloned repositories and loop worktrees. Persist it so
  repositories are not re-cloned on every restart.
- `/home/runner/.agentflow-runner`: the runner's identity
  (`gateway-identity.json`), job store and sealed loop tokens. Keep it so the
  runner stays the same compute target across restarts and upgrades.
- `/home/runner/.claude`: Claude Code's sessions and state. Mount a logged-in
  `~/.claude` here to use that Claude configuration instead of an environment
  credential. An Anthropic-compatible provider (e.g. DeepSeek) is better set
  per computer in AgentFlow (Settings → computers → Model provider): it is
  sent with each loop and never stored on the runner.
- `/home/runner/.agentflow-ai`: AgentFlow learnings (self-learning).
- `/home/runner/.local/share/claude`: the Claude Code versions installed for
  the version set in AgentFlow, so a recreated container does not download
  them again.

Several loops run at once (`AGENTFLOW_RUNNER_MAX_CONCURRENT`, default 2),
for one project or several. Each has its own workspace folder, worktrees,
branch, git credentials and model environment; loops sharing a repository
share its checkout under a lock. They do share the machine: CPU, memory,
ports and the toolchains' caches, and they run as the same user. Keep the
concurrency to what the machine can build and test at once, and run a
separate runner (container) where loops must not see each other's files.

`docker logs -f agentflow-runner-1` shows the startup checks (tools found,
plugins, Claude credentials) and the connection state; `docker ps` shows the
container as healthy once it is connected.

### Project images

Agents build and test what they change, so a runner needs the project's
toolchain. Extend the base image (see
`deploy/runner/examples/node-project.Dockerfile`):

```dockerfile
FROM agentflow-runner:base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
USER runner
```

`deploy/runner/examples/tauri-project.Dockerfile` does the same for Rust and
Tauri 2 apps (rustup in `/usr/local`, WebKitGTK and the other libraries Tauri
compiles against).

**Toolchains outside `/usr/bin` need a profile script.** The runner and the
agents it starts take `PATH` from a login shell, and Debian's `/etc/profile`
resets `PATH` there, so a directory added only with `ENV PATH=...` (Rust's
`~/.cargo/bin`, a .NET install in `/opt`, ...) is not found: the runner
reports the tool as missing and agents cannot run it. Add the directory in
`/etc/profile.d/<tool>.sh` as the Tauri example does, and check with
`su runner -s /bin/bash -lc '<tool> --version'` in the Dockerfile.

Run one image per set of toolchains and assign its runners to the projects
that need them (Project → Integrations → Runners). Build all of a project's
runners from the same image: a new loop goes to whichever is least busy. A
runner with every toolchain (e.g. .NET, Rust and Node.js) can serve every
project. The runner reports the toolchains it finds on its `PATH` (node, npm,
pnpm, yarn, dotnet, cargo, rustc, java, mvn, gradle), and the project page
shows them on each runner.

**Upgrade:** rebuild the image, then `docker rm -f agentflow-runner-1` and
`docker run` again with the same name, volumes and environment.

## Option B: Ubuntu Server / Debian (systemd)

Supported: Ubuntu 22.04 and 24.04, Debian 12, x86_64 or arm64.

1. **Get the release package:** download
   `agentflow-runner-<version>-linux.tar.gz` from the repository's GitHub
   Releases (tags `runner-v*`, see [Releases](#releases)), or build it on a
   machine with the repository (any OS,
   Node.js 24+ as the repository's engines require, and pnpm; the built
   runner itself needs only Node.js 22+):

   ```bash
   pnpm install
   pnpm -C apps/desktop package:headless
   # → apps/desktop/dist-headless/agentflow-runner-<version>-linux.tar.gz
   ```

2. **Install on the server:**

   ```bash
   scp apps/desktop/dist-headless/agentflow-runner-*-linux.tar.gz server:
   ssh server
   tar -xzf agentflow-runner-*-linux.tar.gz
   sudo bash agentflow-runner/install.sh
   ```

   The installer adds Node.js 24 (NodeSource) unless Node.js 22+ is present,
   git, gh, jq, python3 + PyYAML and Claude Code (official apt repositories,
   signing key verified), creates the system user `agentflow-runner`
   (home `/var/lib/agentflow-runner`), copies the runner to
   `/opt/agentflow-runner`, and installs and enables
   `agentflow-runner.service`. It never overwrites an existing configuration.

3. **Configure** `/etc/agentflow-runner/runner.env` (template:
   `deploy/runner/linux/runner.env.example`): `AGENTFLOW_API_URL`,
   `AGENTFLOW_API_KEY`, `AGENTFLOW_RUNNER_NAME`, one Claude credential and
   `GH_TOKEN`. Values are not quoted.

4. **Start and watch it:**

   ```bash
   sudo systemctl start agentflow-runner
   journalctl -u agentflow-runner -f
   ```

5. **Add the project toolchains** to the server (as root), for example
   `apt-get install build-essential`, a .NET SDK or a JDK. If tests need
   Docker: install Docker and `usermod -aG docker agentflow-runner`.

| Path | Content |
|---|---|
| `/opt/agentflow-runner` | runner bundle, plugins, `entrypoint.sh` (replaced on upgrade) |
| `/etc/agentflow-runner/runner.env` | configuration (root:agentflow-runner, 0640) |
| `/var/lib/agentflow-runner/workspace` | cloned repositories and loop worktrees |
| `/var/lib/agentflow-runner/data` | runner identity, job store, sealed loop tokens |

**Upgrade:** build a new package and run `sudo bash agentflow-runner/install.sh`
again; it replaces `/opt/agentflow-runner` and restarts the running service.
**Uninstall:** `sudo systemctl disable --now agentflow-runner`, then remove
`/etc/systemd/system/agentflow-runner.service`, `/opt/agentflow-runner`,
`/etc/agentflow-runner` and, to drop its data, the `agentflow-runner` user
and `/var/lib/agentflow-runner`.

## Option C: run the bundle directly (development, macOS, WSL2)

Any Linux, macOS or WSL2 machine with Node.js 22+, `bash`, `git`, `gh`, `jq`,
`python3` (+ PyYAML) and the Claude Code CLI:

```bash
pnpm install
pnpm -C apps/desktop build:headless
export AGENTFLOW_PLUGINS_DIR="$PWD/agent-plugins"
export AGENTFLOW_API_URL=… AGENTFLOW_API_KEY=… AGENTFLOW_RUNNER_WORKSPACE=~/agentflow-work
node apps/desktop/dist-headless/runner.mjs
```

On Windows, use Docker Desktop, WSL2, or Option D.

## Option D: Windows

Runs the runner and its agents directly on Windows, with the machine's own
toolchains, databases and network (VPN). It is meant for putting agents on a
developer's Windows machine that already builds and runs the project. The
agents can do anything the Windows account can, so run the runner under a
dedicated, non-administrator account where possible, and give that account
only the databases and shares the agents should use. Prefer Docker or a VM
when the project builds on Linux.

**Requirements** (PowerShell; open a new terminal afterwards):

```powershell
winget install OpenJS.NodeJS.LTS          # Node.js 22+
winget install Git.Git                    # git, and the bash the loops run in
winget install jqlang.jq
winget install Python.Python.3.12
winget install GitHub.cli                 # pull requests on GitHub
python -m pip install --user pyyaml
irm https://claude.ai/install.ps1 | iex   # Claude Code, native installer
```

Plus each project's own toolchain (.NET SDK or Visual Studio Build Tools,
Node.js, ...). Install Claude Code with the native installer: an npm install
is a `claude.cmd`, which the runner cannot start without a shell.

**Install.** Download `agentflow-runner-<version>-windows.zip` from the
repository's GitHub Releases (see [Releases](#releases)), or build it on any
machine with the repository:

```bash
pnpm -C apps/desktop package:headless --windows
# dist-headless/agentflow-runner-<version>-windows.zip
```

Unzip it on the Windows machine and run `start-runner.cmd`. The first start
asks four questions, then connects:

| Question | Default |
|---|---|
| AgentFlow API URL | — |
| API key (`sk_live_...`) | — |
| Runner name | The Windows user name, accents removed and every other character run turned into `-` (`Nguyễn Văn An` → `Nguyen-Van-An`) |
| Workspace | `%USERPROFILE%\.agentflow\_works` |

The answers are saved to `%USERPROFILE%\.agentflow-runner\runner.env`;
`setup-runner.cmd` (`node runner.mjs setup`) asks again. The runner reads
that file on every platform (see "Configuration"), and any other variable in
it reaches the loops, e.g. `CLAUDE_CODE_OAUTH_TOKEN`, or a connection string
that points the agents at their own database:

```
ConnectionStrings__DefaultConnection=Server=localhost;Database=App_Agent;Trusted_Connection=True;TrustServerCertificate=True
```

**What is different on Windows:**

- Loop scripts run in Git for Windows' `bin\bash.exe`, found next to the
  `git.exe` on PATH or in the default install locations; set
  `AGENTFLOW_GIT_BASH_PATH` to use another. WSL's `System32\bash.exe` is never
  used. Claude Code gets the same bash (`CLAUDE_CODE_GIT_BASH_PATH`), and the
  paths passed to scripts use forward slashes (`C:/Users/...`).
- Windows builds of Python and jq print `\r\n`, which bash keeps in every
  `$(...)`. The runner writes shims to `<data dir>\shims` and puts them first
  on the loops' PATH: `python3` (the first of `python3`, `python`, `py -3`
  that runs Python 3), `jq` (with `--binary`), and a `sitecustomize.py` on
  `PYTHONPATH` that makes Python print `\n`. Loops also get `PYTHONUTF8=1`.
- Stopping a loop ends its whole process tree with `taskkill /T /F`; Windows
  has no graceful equivalent, so the scripts get no chance to clean up.
- The Claude Code version set in AgentFlow is not installed: loops run the
  `claude` on PATH. Keep it current with `claude update`.
- To start the runner with Windows, add `start-runner.cmd` to a Task
  Scheduler task that runs at logon of the runner's account.

## After installing

1. The runner appears in AgentFlow under Settings → Compute & Integrations →
   Local Compute Targets, online, under the API key owner's account.
2. **Share it with the organization** there if workflows run as other users.
3. Select it as the compute target of a workflow (Workflows → edit → Agent
   team).

## Claude Code version

Settings → Compute & Integrations → Local Compute Targets → the runner →
**Model provider** → **Claude Code version**: `latest` (the default) or an
exact release such as `2.1.296`, for instance when a proxy accepts only one
version. It is sent with every loop, like the model provider
(`src/headless/claude-code-versions.ts`):

- When a loop starts, the runner resolves `latest` to a release number (the
  official installer's `https://downloads.claude.ai/claude-code-releases/latest`).
  If the version is neither installed nor the image's own, it runs
  `claude install <version>`, Claude Code's native installer, which verifies
  the release checksum, and checks the result with `--version`. A version that
  cannot be installed fails the loop with the reason; the runner never falls
  back to another version. If `latest` cannot be looked up (one retry), the
  newest version on the runner runs, installed or the image's own.
- The loop runs that binary by absolute path, and `~/.local/bin/claude`
  (first on `PATH`) points at it, so `docker exec agentflow-runner-1 claude
  --version` reports the version the last loop used. A change takes effect
  with the next loop; running loops keep their version.
- Installed versions are kept in `~/.local/share/claude/versions` (the
  `/home/runner/.local/share/claude` volume): switching back to one is
  immediate, a new one downloads about 100 MB.
- `DISABLE_AUTOUPDATER=1` (set by the image) keeps Claude Code from updating
  itself away from the version set. Set it in `runner.env` on a systemd
  runner.
- The desktop app ignores the setting and keeps its own `claude`.

## Configuration

Settings come from the environment and from `<data dir>/runner.env`, written
by `node runner.mjs setup` (one `NAME=value` per line; a variable set in the
environment wins). A start from a terminal with no API URL or key asks the
setup questions first.

| Variable | Default | Purpose |
|---|---|---|
| `AGENTFLOW_API_URL` | required | Origin of the AgentFlow API: websocket, loop credentials and loop callbacks. |
| `AGENTFLOW_API_KEY` | required | `sk_live_` key with the `write` scope. |
| `AGENTFLOW_RUNNER_NAME` | hostname | Compute target name. Set it: a container's hostname changes on every `docker run`. |
| `AGENTFLOW_WEB_APP_URL` | API URL | Web app origin (links only). |
| `AGENTFLOW_MCP_URL` | the API's | MCP endpoint instruction agents use for integration tools (docs/workflows.md "Integration tools"). The API names it (its own `AGENTFLOW_MCP_URL`, default `http://localhost:3010/mcp`); set it when the runner reaches the MCP server under another address, e.g. `http://host.docker.internal:3010/mcp` from a container. |
| `AGENTFLOW_RUNNER_WORKSPACE` | `/workspace` | Repositories are cloned here and loops work in worktrees next to them. Project repositories are cloned by URL with per-loop credentials from the API (docs/workflows.md "How loops use them"); the runner needs no git or `gh` login. |
| `AGENTFLOW_RUNNER_DATA_DIR` | `~/.agentflow-runner` | Identity, job store, sealed loop tokens, status file. Keep it private. |
| `AGENTFLOW_RUNNER_MODE` | `auto` | `personal`: one project, in a folder of this computer, with its credentials (see "Personal runner"). |
| `AGENTFLOW_RUNNER_PROJECT_KEY` | — | Personal: the AgentFlow project key (slug) whose steps the runner runs. |
| `AGENTFLOW_RUNNER_PROJECT_DIR` | — | Personal: the project folder loops run in; replaces the workspace. |
| `AGENTFLOW_RUNNER_PARALLEL` | `false` | Personal: `true` lets several loops run in the folder at once (the project's commands make their own worktrees); `false` runs them in turn. |
| `AGENTFLOW_RUNNER_SKIP_PERMISSIONS` | `false` | Personal: `true` lets the agent use any tool without a permission prompt (`--permission-mode bypassPermissions`). |
| `AGENTFLOW_RUNNER_MAX_CONCURRENT` | `2` | Commands executed at the same time. |
| `AGENTFLOW_RUNNER_GATEWAY_PORT` | any free port | Local gateway port, loopback only. Setup asks for it (Enter: any free port). A configured port that is taken stops the runner. The port in use is logged at start and written to `<data dir>/gateway-port`. |
| `AGENTFLOW_RUNNER_REWRITE_CALLBACK_URL` | `true` | Send loop callbacks to `AGENTFLOW_API_URL` instead of the API's own `API_BASE_URL`, which is often a host-local address. |
| `AGENTFLOW_RUNNER_REPORT_SESSIONS` | `true` | Report every loop as an agent session, and the runner's agents (see "Sessions and Agents"). `false` turns it off. |
| `AGENTFLOW_ALLOW_HTTP_HOSTS` | — | Comma-separated host names allowed over plain http besides localhost. Also honoured by the desktop app. |
| `AGENTFLOW_PLUGINS_DIR` | set by the image / service; else `agent-plugins` next to `runner.mjs` | The `agent-plugins` directory. |
| `AGENTFLOW_GIT_BASH_PATH` | found next to `git.exe` | Windows only: Git for Windows' `bin\bash.exe`, which runs the loop scripts. |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | gh and git (HTTPS) authentication. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `AgentFlow Runner` | Fallback git identity; loops commit as the loop's user. |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` | — | Claude credentials, passed through to `claude`. |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Exits with code 2, `Invalid configuration: …` | A variable is missing or invalid; the message names it. |
| `AGENTFLOW_API_URL: Origin must use https …` | Plain http to a non-local host; use https or list the host in `AGENTFLOW_ALLOW_HTTP_HOSTS`. |
| Exits with code 3, `Cannot start: missing required tools …` | `bash`, `git`, `claude`, `jq` or `python3` is not on the PATH, the plugins are not found, or the workspace is not writable. |
| `No Claude credentials found` warning | Expected when the runner's model provider is set in AgentFlow; otherwise loops fail at the first `claude` call. |
| System Check shows "Claude authentication: No Claude credential found" | Neither a model provider in AgentFlow nor a credential on the runner. Set the model provider (Settings → Local Compute Targets → the runner → **Model provider**) and run the check again: the row then reads "AgentFlow model provider (<host>)". The runner asks the API for it with its own key; an older runner image always showed this warning, so rebuild it. The row is a warning, not a required check. |
| System Check on a runner has no "Claude MCP" / "Codex MCP" rows | Expected: runners only run loops and health checks, never the AgentFlow MCP server or Codex, so those rows do not apply. The "Gateway Version" row shows the runner's version as a local build; it is never compared with desktop releases. |
| `Connection degraded: …` in a loop | The API is unreachable or rejects the key (revoked, missing `write` scope); the runner keeps retrying. |
| A command fails with `operation not supported by the headless runner` | Expected for desktop-only features (file browsing, chats, deploys); runners only run loops and health checks. |

## Operations

- **Stopping** a runner abandons the loops it is running: the API times them
  out and the workflow run fails. Upgrade a runner when it is idle.
- **Finalization replay:** a loop whose agent finished but whose result
  could not reach AgentFlow (API down, a push that failed) is finalized again
  from what it left on disk: when the runner starts (boot recovery, as in the
  desktop app) and each time it reconnects. EXECUTE on project repositories
  is pushed again with the loop's git credentials, so a commit left by a
  failed push is not lost. Each loop is replayed at most 3 times.
- **Leftover processes:** a process the agent starts in the background (a dev
  server, a watcher) leaves the loop's process group, so it used to outlive
  the loop and pile up on the runner (ports, memory). Every loop's agent runs
  with `AGENTFLOW_LOOP_ID` set; when the agent exits, the runner stops the
  processes still carrying the loop's id (SIGTERM, then SIGKILL after 1.5 s;
  Linux only, it reads `/proc`).
- **Scaling:** add runners and share them; each workflow selects its runner.
  All runners connect to the API process that hosts the desktop gateway
  socket (`apps/api/server.ts`), unless a relay is configured with
  `RELAY_API_URL`.
- **Security:** a runner executes code that agents write from ticket content.
  Keep it in a container or a dedicated VM, give it a bot GitHub account
  limited to the repositories it may change, and do not share its data or
  workspace with other workloads.

## Sessions and Agents

The runner reports what its agents do to the **Sessions** and **Agents**
pages, the way the desktop app reports its local sessions
(`src/headless/headless-session-reporter.ts`):

- **Every loop is an agent session**, named after its command and artifact
  (e.g. `PLAN PLN-3 · acme/web`) and linked to the loop, the run's
  documents and the runner. It is `active` while the loop runs, refreshed
  every 20 seconds from the loop's Claude Code stream (tool calls,
  subagents, input tokens), and `inactive` (or `error`) once it ends, with
  the stream's final totals per model (input, output and cache tokens).
  A cost is reported only when Claude Code knows the model's price: for an
  Anthropic-compatible provider (DeepSeek, ...) it guesses a rate
  (`costBasis: "unknown"`), which is left out.
  The session's id is the loop id: a loop that retries an iteration in a
  fresh Claude session, or a STEP loop that resumes the session of the loop
  before it, stays one session, with the Claude session ids in its
  `metadata.harnessSessionIds` and the totals of all of them. It carries the
  loop's work branch (read from its worktree) and autonomy 100 (a loop runs
  unattended). The branch is also sent as a session→branch link, which
  AgentFlow keeps only for repositories of a GitHub App installation.
- **The transcripts** of a loop's Claude sessions are archived for the
  session's **Trace** (`headless-transcript-uploader.ts`, the desktop's
  redacted `/desktop/transcripts` protocol): every 5 minutes while the loop
  runs and in full when it ends. The first Claude session is the `main`
  file; a retry's session is `subagent:iteration-<n>-<id>`, and each
  session's subagent transcripts follow. The runner uploads to the presigned
  URLs the API signs with `S3_PUBLIC_ENDPOINT`, so that endpoint must be
  reachable from the runner (for a runner container next to a local RustFS,
  `http://host.docker.internal:9100`). The transcript routes allow 120
  requests a minute per user; a rate-limited pass resumes a minute later.
- **The agent components** the runner offers — the bundled plugins and their
  subagents, commands and skills, and the `.claude` definitions of a loop
  workspace (a process toolkit) — make up the runner's inventory on the
  Agents page; the subagents, skills and commands a loop invokes count as
  their usage.

AgentFlow always ingests them: no organization setting or feature flag
switches it off, and the data stays in the deployment's own database. A
refused or failed report (the API down, say) pauses the reporting for five
minutes. Set `AGENTFLOW_RUNNER_REPORT_SESSIONS=false` to turn it off on a
runner.

## Secret guard

Every agent session loads the bundled `code` plugin, whose PreToolUse hook
`agent-plugins/code/hooks/secret-guard.py` (Python 3, stdlib) keeps secrets
out of the transcript: a repository can hold real keys, and the agent's process
inherits the runner's environment (its API key, the model token). It denies,
by default:

| Category | What is denied |
|---|---|
| `secret-files` | Reading a file whose name marks it as secret, directly or through a content search over a directory that holds one (the Grep tool in content mode, `grep -r`, `rg`, unless a type or include filter keeps it out; listing names or counts is fine): `.env` and `.env.*` (not `.env.example` / `.sample` / `.template`), `.envrc`, key and keystore files (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, ...), ssh keys, `.npmrc` / `.pypirc` / `.netrc` / `.git-credentials`, docker config, kubeconfig, `*credentials.json` / `service-account*.json`, `secrets.yml`, `*.tfvars`, `terraform.tfstate`, the runner's own data (`~/.agentflow-runner`, `/etc/agentflow-runner`, `/var/lib/agentflow-runner/data`) and host credential directories (`~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gh`, `~/.config/gcloud`, `~/.claude/.credentials.json`) |
| `secret-content` | Reading a file (Read, Grep on a file, `cat` / `grep` / `head` / `sed` ... of a file) that holds a credential: a private key block, an AWS / GitHub / GitLab / Slack / Stripe / Google / Anthropic / `sk-` / npm / PyPI / SendGrid / Azure storage key, or, in a config file (`.json`, `.yml`, `.ini`, `.toml`, `.xml`, ...), a password / secret / token / API key with a real-looking value |
| `environment-dump` | `env`, `printenv`, `set`, `export -p`, `/proc/*/environ`, `Get-ChildItem Env:`, printing `process.env` / `os.environ`, `echo $..._KEY` / `_TOKEN` / `_SECRET`, `docker inspect` (its `Config.Env`) unless `--format` picks other fields, `docker exec ... env`, `docker compose config`, `git credential fill`, `gh auth token` |

Still allowed: `.env.example` files, checking that a file exists (`ls`,
`test -f`, `Test-Path`), writing env files (`cp .env.example .env`,
`echo X=1 >> .env`), `docker run --env-file`, and programs or tests that use
secrets without printing them. The agent gets the reason and is told not to
look for another way. It is a guard, not a sandbox: a program the agent runs
can still open these files. A directory-wide Grep is not pre-scanned; it
skips gitignored files such as `.env`, but not a key committed to a tracked
file.

To allow a category on one runner, set it in the overrides file the `code`
plugin's hooks read, `~/.claude/security-overrides.json` of the runner user
(or the path in `CLAUDE_SECURITY_OVERRIDES`):

```json
{ "overrides": { "secret-content": true } }
```

Tests: `python3 agent-plugins/code/hooks/tests/test_secret_guard.py`.

## Plan state

A plan's progress, next step and context do not live on the computer that
ran its last loop: every PLAN, EXECUTE and REQUEST_CHANGES loop saves the
plan's state when it ends, and the plan's next loop restores it, on whatever
runner or desktop it starts (`plan-state-bundle.ts`, `plan-state-sync.ts` in
`apps/desktop/src/server/operations/`).

- **What is saved:** the loop's `.agentflow-ai/work` — plan.json, plan.md,
  state.json, the PRD, the exploration (requirements extract, code maps,
  investigation log), reviews — plus `plan-state.json`: the plan's `phase`
  (`started`, `awaiting-answers`, `planned`, `implementing`, `implemented`),
  `nextStep`, task and question counts, and the `history` of its loops.
  Runtime output (logs, Claude streams, pid and session files, the per-loop
  config and prompts, learnings), files that look like secrets and symlinks
  are never saved; a file over 8 MB, or past 64 MB in total, is listed under
  `skipped` instead.
- **Where:** gzipped JSON in the loop-state bucket under the plan,
  `{org}/plans/{planDocumentId}/state.json.gz` (the latest) and
  `.../loops/{loopId}.json.gz` (each loop's copy), written through presigned
  URLs from `POST /api/loops/:id/plan-state` before the loop's terminal
  event. A loop that fails saves only its own copy: its plan may be
  half-made, and an EXECUTE's commits are pushed only when it succeeds, so
  its progress must not reach another computer. A retry on the same computer
  still continues it (see Restore). Nothing about it is stored in the
  database, and
  the loop-state retention sweep (which removes `{org}/loops/{loopId}/`)
  leaves it alone.
- **Restore:** an EXECUTE or REQUEST_CHANGES gets the latest state into its
  work directory (`GET /api/loops/:id/plan-state`), a workflow re-plan into
  `previous-work`. A work directory that already holds that state, or a
  newer one that grew from it (its `history` has the saved loop), is left as
  it is. The runner log says `Plan state: ...` either way. The orchestrator
  reads `plan-state.json` once and continues from it.
- A loop that continues another resumes the parent's Claude session
  (`--resume`) only when that session is on this computer; elsewhere it
  continues from the restored state alone. A workflow EXECUTE runs on the
  PLAN's runner while it is online, else on another online project runner.
- Only loops the cloud keeps state for (the request carries `s3StateKey`, as
  every dispatched loop does) take part. Without a saved state a loop works
  from its local work directory and the plan document, as before.

## Process steps (STEP loops)

A project process step (docs/workflows.md "Project process") runs as a
`STEP` loop (`apps/desktop/src/server/operations/loop-step.ts`):

- It uses the loop workspace like PLAN / EXECUTE. The run's first loop starts
  fresh; later steps reuse its worktrees and `.agentflow-ai/work`, whose
  previous step outputs (`questions.json`, `execution-result.json`, the agent
  output and session id) are cleared first.
- `step-request.json` (the step's settings) and `issue.md` are written to the
  work directory. The toolkit's directories (`.claude/skills`,
  `.claude/commands`, `.specify`, ...) are symlinked from the toolkit
  repository's worktree into the workspace root.
- The agent runs from the workspace root with the shared flags. A slash
  command is the prompt argument; any other instruction goes through stdin.
  Answers resume the asking loop's session with `--resume`; the session id
  comes from the agent's stream output (`session-id.txt`).
- On exit the step's questions and artifact files are uploaded as
  `uploadedArtifacts.step`; a `finish: push` step is committed and pushed by
  the EXECUTE finalization. Boot recovery reads the same files.

The tools a toolkit's scripts call (`bash`, `git`, `jq`, project
toolchains, ...) must be installed on the runner like any other loop tool.

## Personal runner

A runner in **personal** mode works for one AgentFlow project on a person's
own computer, in the project folder they already use, so the commands they
type by hand today run unchanged when a workflow starts them. It is a
migration aid, not a replacement for the auto runner.

| | Auto (default) | Personal |
|---|---|---|
| Projects | any | one, by its AgentFlow project key (the project's slug, e.g. `PRO-1`) |
| Where loops work | clones in the workspace, one worktree per loop | the project folder itself: no clone, no worktree |
| Credentials | per-loop git credentials from AgentFlow; AgentFlow's integration tools | everything on the computer: git config and credential helpers, ssh, `gh`, the person's `~/.claude` (plugins, commands, MCP servers). Only the Claude model provider set for the computer comes from AgentFlow with each loop |
| Commits | AgentFlow commits as the loop's user (`finish: push`) | the step's own commands commit, push and open pull requests; `finish: push` steps are refused |
| Loops | PLAN, EXECUTE, STEP, ... | process steps (STEP loops) only |
| At once | `AGENTFLOW_RUNNER_MAX_CONCURRENT` | one, the other runs waiting their turn, or several when the project's commands make their own worktrees (`AGENTFLOW_RUNNER_PARALLEL=true`) |
| Permission prompts | the loop's allowed tools | the loop's allowed tools and the person's `permissions.allow`, or none at all (`AGENTFLOW_RUNNER_SKIP_PERMISSIONS=true`) |
| Per computer | any number, each with its own `AGENTFLOW_RUNNER_DATA_DIR` | any number, one per project key |
| Claude Code | the version set in AgentFlow | the `claude` on PATH (no pinning: `~/.local/bin/claude` is shared by the account) |

**Set up.** `node runner.mjs setup` (Windows: `setup-runner.cmd`) asks for the
mode first; Enter keeps `auto`. Personal asks for the API URL and key, the
project key, the project folder (it must exist), whether the project's
commands can run several tasks at once in that folder (default no), whether
the agent may use any tool without a permission prompt (default no), the
runner name (default `<user name>-<project key>`) and the local gateway port
(Enter: any free port). The answers go to
`<data dir>/personal/<project key>/runner.env`; start it with

```bash
node runner.mjs --project PRO-1          # Windows: start-runner.cmd --project PRO-1
node runner.mjs setup --project PRO-1    # asks that runner's questions again
```

Each personal runner has its own data directory (identity, job store, loop
tokens, status, Windows shims), so any number of them, for different
projects, run side by side with auto runners. Runners are not limited; a
lock file (`runner.lock`) only keeps a second process off a data directory
already in use, since both would be the same computer in AgentFlow.

**How a step runs** (`apps/desktop/src/server/operations/personal-runner.ts`):

- The loop must carry the runner's project key (AgentFlow sends the
  project's slug with every loop); another project's loop, a loop that is
  not a STEP and a `finish: push` step are refused with that reason, which
  fails the loop.
- **One at a time** (the default): AgentFlow does not start a step on the
  runner while another loop holds it. The step waits (`runner_busy`, tried
  again every minute) and the runs take the runner in turn
  (`apps/api/lib/workflows/engine/personal-runner-queue.ts`); two runs that
  start at the same moment are ordered by their loops' creation. A loop that
  still reaches a busy runner is refused.
- **Several at once** (`AGENTFLOW_RUNNER_PARALLEL=true`): every run has its own
  work directory, `.agentflow-ai/runs/<run id>` (the `AGENTFLOW_WORKDIR` of
  its agent), holding its `issue.md`, `questions.json`, agent output and
  session, so parallel runs never read each other's questions or answers.
  The project's commands must keep their own work apart (a worktree or a
  branch per ticket); the runner does not.
- The agent runs from the project folder. A run's first step creates its
  work directory empty and removes work directories unused for 30 days; in a
  git repository `.agentflow-ai/` is added to `.git/info/exclude`. Nothing
  else is written into the folder: no `CLAUDE.md`, no `.claude/agents`, no
  toolkit links. The step's instructions (where the run's files are, how to
  ask questions, the toolkit's notes) go to `--append-system-prompt`.
- The agent gets no AgentFlow integration tools (they act with the
  connection's credentials); the workflow's own actions still run in
  AgentFlow as usual. Tools beyond the loop's `--allowedTools` (e.g. the
  person's Jira MCP server) need the command's `allowed-tools` front matter,
  the person's Claude Code `permissions.allow`, or
  `AGENTFLOW_RUNNER_SKIP_PERMISSIONS=true` (`--permission-mode
  bypassPermissions`: the agent may then do anything the account can):
  nobody is at the terminal to approve a prompt.
- Questions work like any step with `questions: ask`: the command writes
  `$AGENTFLOW_WORKDIR/questions.json` and stops; the run shows them in
  AgentFlow, and the answers resume the same session.
- The folder is never removed or reset; worktree clean-up skips it.
- A workflow chooses a person's runner per item with runner rules
  (docs/workflows.md "Runner rules"), e.g. the assignee's. A personal runner
  a workflow or a rule names is used even when the project lists other
  runners.

### Writing commands for a personal runner

A command written for a person at a terminal runs on a personal runner with
small changes. The runner tells the agent all of this in its system prompt
too; writing it into the command keeps the command correct when someone
runs it by hand.

1. **Never ask in the terminal.** Nobody answers, so the step ends without
   doing anything. Where the command would ask (`AskUserQuestion`, "Proceed?
   yes/no", "Overwrite?"), it writes the questions and stops:

   ```markdown
   When you need a decision you cannot make from the ticket or the code:
   - If `$AGENTFLOW_WORKDIR` is set (an AgentFlow run), write the questions to
     `$AGENTFLOW_WORKDIR/questions.json` as a JSON array, e.g.
     `[{"id": "q1", "question": "Export CSV or XLSX?", "options": ["CSV", "XLSX"]}]`,
     then stop. Do not ask in the terminal.
   - Otherwise ask the user as usual.
   ```

   At most 30 questions, 2,000 characters each, 10 options of 500
   characters. The answers come back as the next prompt of the same session:
   pick up where the command stopped (write the answers where the command
   keeps them, e.g. `clarifications.md`, then go on).
2. **Never wait for a confirmation.** Decide with a stated default, or ask
   through the file. An `--auto` flag, as `/brep.ship` has, is the simplest
   switch: the step's instruction passes it (`/speckit.clarify-all
   {{issue.key}} --auto`).
3. **Keep the run's own files in `$AGENTFLOW_WORKDIR`.** It holds the ticket
   (`issue.md`). Another run may work in the same folder at the same time
   when the runner runs in parallel: anything specific to one ticket goes
   there or under a path named after the ticket (`BREP-12/...`), never in a
   shared file such as `./clarifications.md`.
4. **Allow the tools it needs** in its front matter (`allowed-tools:
   Bash(git:*), mcp__jira__*, ...`), or set
   `AGENTFLOW_RUNNER_SKIP_PERMISSIONS=true` on the runner.
5. **Report through files the step collects.** A step's `artifacts` globs and
   its `reply` file are read after the agent stops (paths under
   `.agentflow-ai/work/` mean the run's work directory); post actions can then
   comment them on the ticket, or the command does it itself with the
   person's Jira tools.

## Capabilities (AGENTFLOW.md)

A runner tells AgentFlow what it can do in an `AGENTFLOW.md`, so the project's
orchestrator knows which command of which runner to send a request to. A
personal runner reads it from its project folder; an auto runner reads it from
the root of the default branch of the project's toolkit repository (see
"Reading it from a toolkit" below). The front matter lists the
commands and skills (the part AgentFlow reads and later checks); the body
describes them in detail for the orchestrator.

```markdown
---
runner: Dev (LeaveDesk)          # a display name for the runner's role
commands:
  - name: /plan-ticket           # the slash command as typed in Claude Code
    args: <ticket-key>
    description: Plan a ticket from its PRD
    mode: write                  # read | write (required)
    produces: plan               # prd | plan | testcases | code | answer | ...
    needs: [prd]                 # what must exist before it runs
    asks: true                   # may stop with questions
    push: false                  # commits and pushes
    attach: ["PLAN-*.md"]        # files it writes for the ticket (in its work dir)
  - name: /explain-code
    mode: read
    produces: answer
skills: [tdd, systematic-debugging]
---

# Dev runner (LeaveDesk)

## /plan-ticket
Reads the PRD attached to the ticket (PRD-<KEY>.md), explores leavedesk-app
and writes the plan to $AGENTFLOW_WORKDIR/plan.md. Use it once the ticket has
an approved PRD; to answer questions about a plan, resume its session.
```

- The runner uploads the file when it connects and whenever it changes
  (`src/headless/headless-capabilities-reporter.ts`, `PUT
  /compute-targets/{id}/capabilities` with the owner's API key). No file: the
  runner logs it once and uploads nothing.
- Before uploading, the runner checks that each declared command is in
  `.claude/commands` (`/ns:cmd` is `ns/cmd.md`) or `.claude/skills` of the
  project folder or `~/.claude`, and each skill in `.claude/skills`; what it
  cannot find is uploaded as a warning (a plugin's command cannot be checked
  this way).
- `attach` lists globs of files the command writes for the ticket, relative to
  the task's work directory: `<workspace root>/.agentflow-ai/work/` on an auto
  runner, `$AGENTFLOW_WORKDIR` on a personal runner. When the loop ends the
  runner collects the matches as bytes (at most 20 files, 4 MB each, 5 MB in
  total), and the orchestrator can attach them to the ticket. Only
  orchestrator tasks use it (process steps use `artifacts` and
  `$AGENTFLOW_ATTACH`). Name the files in the command's body text.
- The API parses the front matter itself (`parseRunnerCapabilitiesMarkdown`,
  `packages/api/src/types/runner-capabilities.ts`) and keeps one file per
  runner and project (`compute_target_capabilities`); a file whose front matter
  does not parse is kept with its problems.
### Reading it from a toolkit (auto runners)

The `capabilities_refresh` operation makes an auto runner clone or fetch the
toolkit repository, read `AGENTFLOW.md` from `refs/remotes/origin/<default
branch>`, and upload it with `source: toolkit` through the same `PUT
/compute-targets/{id}/capabilities`. It always uploads after a successful read,
so `uploadedAt` shows the last check.

- **Triggers.** (1) **Refresh** on a toolkit row, or **Read from a runner's
  toolkit** in Project → Runners → Commands (org admins). (2) A daily cron,
  `/cron/refresh-runner-capabilities`, which refreshes toolkit files older than
  20 h (at most 100 per run, online runners only). (3) Saving the project
  process with a changed `toolkit` (repository or mounts) refreshes the
  runners that already have a toolkit file for the project and the project's
  assigned runners.
- **Which repository.** The one named in the form; else the `toolkit.repository`
  of the runner's previously uploaded file for the project; else the project
  process's `toolkit.repository`. With none, the request is refused. The
  repository must be one of the project's repositories.
- **Credential.** The runner's git credential helper calls
  `POST /compute-targets/{id}/capabilities/refresh/{refreshId}/git-credential`
  with the runner's own API key. The API issues a credential only while that
  refresh is queued, accepted or running, only to the runner's owner, and only
  for the repository the command names. Nothing is written to disk.
- **Status.** `GET /compute-targets/{id}/capabilities/refresh/{refreshId}`
  answers pending, succeeded or failed (with the reason).
- **Older and personal runners.** The runner advertises the capability flag
  `toolkitCapabilitiesRefresh`. A runner without it, a personal runner, or an
  offline runner is refused with a message naming the machine; upload the file
  by hand with `PUT /compute-targets/{id}/capabilities` instead.
- **Warnings.** Declared commands and skills are checked against the
  repository's `.claude/` tree; the runner also warns when the front matter
  names no toolkit or a different repository than the one it was read from.

- Project → Integrations → **Commands** shows
  each runner's commands, problems, warnings and the file;
  `GET /projects/{id}/runner-capabilities` returns them.
- The file is sent to AgentFlow: never put a secret in it.

## How it relates to the desktop app

The runner is built from the desktop source (`apps/desktop/src/headless/`) and
reuses its gateway and loop code unchanged: `CloudSocketService`,
`CloudCommandExecutor`, `DesktopGatewayServer` and
`src/server/operations/symphony-loop.ts`. Only Electron is replaced:
`electron`, `electron-store` and `electron-log` are swapped for small Node
shims at bundle time (`apps/desktop/src/headless/shims/`), and the build fails
if anything else pulls Electron in.

| | Desktop app | Headless runner |
|---|---|---|
| Operations | Everything the web app can ask a workstation to do | Only `symphony_loop`, `symphony_loop_kill`, `symphony_status`, `symphony_logs`, `health_check`, `capabilities_refresh`, the orchestrator ops (`orchestrator_turn`, `orchestrator_turn_cancel`); everything else is refused |
| Session capture, cost tracking, dashboards | Yes | No |
| Sign-in | Browser login (managed key) | A `sk_live_` API key in the environment |
| Browser-signed commands | Supported | Not supported (the runner does not advertise command signing) |
| Secrets at rest | OS keychain (`safeStorage`) | AES-256-GCM with a key file in the data directory |

## Releases

`.github/workflows/runner-release.yml` builds both packages and attaches them
to a GitHub Release. To publish one, bump `version` in
`apps/desktop/package.json`, commit, and push the matching tag:

```bash
git tag runner-v<version>
git push origin runner-v<version>
```

The workflow fails if the tag does not match the version. It also checks on a
Windows machine that the zip unpacks and `runner.mjs` parses before
publishing. Running the workflow by hand (Actions → Runner release → Run
workflow) builds the packages as a workflow artifact without a release.
