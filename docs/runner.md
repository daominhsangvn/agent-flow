# Headless runner

The headless runner executes AgentFlow agent loops (PLAN, EXECUTE) on a
server, a VM, a WSL2 distribution or a Docker container, without the desktop
app. It is a plain Node.js process that connects to the AgentFlow API exactly
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
(official apt repository, `stable` channel; `--build-arg
CLAUDE_CODE_CHANNEL=latest` for the latest one), the runner and the plugins,
and runs as the unprivileged user `runner`.

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
that need them (Project → Repositories → Runners). Build all of a project's
runners from the same image: a new loop goes to whichever is least busy. A
runner with every toolchain (e.g. .NET, Rust and Node.js) can serve every
project. The runner reports the toolchains it finds on its `PATH` (node, npm,
pnpm, yarn, dotnet, cargo, rustc, java, mvn, gradle), and the project page
shows them on each runner.

**Upgrade:** rebuild the image, then `docker rm -f agentflow-runner-1` and
`docker run` again with the same name, volumes and environment.

## Option B: Ubuntu Server / Debian (systemd)

Supported: Ubuntu 22.04 and 24.04, Debian 12, x86_64 or arm64.

1. **Build the release package** on a machine with the repository (any OS,
   Node.js 22+ and pnpm):

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

Native Windows is not supported (loops run through `bash run-loop.sh`); use
Docker Desktop or WSL2 on Windows machines.

## After installing

1. The runner appears in AgentFlow under Settings → Compute & Integrations →
   Local Compute Targets, online, under the API key owner's account.
2. **Share it with the organization** there if workflows run as other users.
3. Select it as the compute target of a workflow (Workflows → edit → Agent
   team).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENTFLOW_API_URL` | required | Origin of the AgentFlow API: websocket, loop credentials and loop callbacks. |
| `AGENTFLOW_API_KEY` | required | `sk_live_` key with the `write` scope. |
| `AGENTFLOW_RUNNER_NAME` | hostname | Compute target name. Set it: a container's hostname changes on every `docker run`. |
| `AGENTFLOW_WEB_APP_URL` | API URL | Web app origin (links only). |
| `AGENTFLOW_RUNNER_WORKSPACE` | `/workspace` | Repositories are cloned here and loops work in worktrees next to them. Project repositories are cloned by URL with per-loop credentials from the API (docs/workflows.md "How loops use them"); the runner needs no git or `gh` login. |
| `AGENTFLOW_RUNNER_DATA_DIR` | `~/.agentflow-runner` | Identity, job store, sealed loop tokens, status file. Keep it private. |
| `AGENTFLOW_RUNNER_MAX_CONCURRENT` | `2` | Commands executed at the same time. |
| `AGENTFLOW_RUNNER_GATEWAY_PORT` | `47821` | Local gateway port, loopback only (the next 10 ports are tried if taken). |
| `AGENTFLOW_RUNNER_REWRITE_CALLBACK_URL` | `true` | Send loop callbacks to `AGENTFLOW_API_URL` instead of the API's own `API_BASE_URL`, which is often a host-local address. |
| `AGENTFLOW_RUNNER_REPORT_SESSIONS` | `true` | Report every loop as an agent session, and the runner's agents (see "Sessions and Agents"). `false` turns it off. |
| `AGENTFLOW_ALLOW_HTTP_HOSTS` | — | Comma-separated host names allowed over plain http besides localhost. Also honoured by the desktop app. |
| `AGENTFLOW_PLUGINS_DIR` | set by the image / service | The `agent-plugins` directory. |
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
| System Check shows "Claude authentication: No Claude credential found" | Same: set a model provider for the computer in AgentFlow, or a credential on the runner. The row is a warning, not a required check. |
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

AgentFlow ingests them only when the organization allows session sync
(Settings → Organization → **Sync session data to the cloud**) and the
`desktop-agent-session-sync` feature flag is on (PostHog, or
`AGENTFLOW_FEATURE_FLAGS` on a deployment without PostHog: see
self-hosting.md). A refusal pauses the reporting for five minutes. Set
`AGENTFLOW_RUNNER_REPORT_SESSIONS=false` to turn it off on a runner.

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
| Operations | Everything the web app can ask a workstation to do | Only `symphony_loop`, `symphony_loop_kill`, `symphony_status`, `symphony_logs`, `health_check`; everything else is refused |
| Session capture, cost tracking, dashboards | Yes | No |
| Sign-in | Browser login (managed key) | A `sk_live_` API key in the environment |
| Browser-signed commands | Supported | Not supported (the runner does not advertise command signing) |
| Secrets at rest | OS keychain (`safeStorage`) | AES-256-GCM with a key file in the data directory |
