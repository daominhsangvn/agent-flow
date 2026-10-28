# Local Development Setup Guide

This guide walks you through running AgentFlow locally for development. For the
self-hosted infrastructure in depth (services, variables, authentication,
scheduler, runners), see [self-hosting.md](self-hosting.md).

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 24+ | Required by the root `package.json` engines |
| pnpm | 11.7.0 | Pinned in `packageManager`; managed via corepack |
| Docker | Latest | Runs Postgres, RustFS (S3), Mailpit and Local Git |
| `claude` CLI | Latest | Loops run on compute targets through the local Claude Code CLI |

```bash
corepack enable
```

---

## Setup Steps

### 1. Install Dependencies

```bash
git clone <repository-url>
cd agentflow
pnpm install        # postinstall generates the Prisma client
```

### 2. Start the Backing Services (Docker Compose)

```bash
cp .env.docker.example .env   # optional: change host ports / credentials
docker compose up -d          # Postgres, RustFS (S3), Mailpit, Local Git
docker compose ps
pnpm storage:init             # create the S3 buckets + browser CORS (idempotent)
pnpm local-git:init           # optional: Local Git admin + token, written to apps/api/.env.local
```

| Service | Host ports | Purpose |
|---------|------------|---------|
| postgres | 5432 | Application database (`postgres` / `password`, database `agentflow_ai`) |
| rustfs | 9000 (S3 API), 9001 (console) | Attachments, transcripts, loop state, catalog assets |
| mailpit | 1025 (SMTP), 8025 (web UI) | Captures invitations and password resets |
| local-git | 3300 | Git hosting for projects without a remote ([local-git.md](local-git.md)) |

### 3. Configure Environment Variables

`pnpm dev` runs `scripts/predev.mjs`, which copies each missing env file from
its `.env.example` template. You can also create them manually:

```bash
cp apps/app/.env.example apps/app/.env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local
cp apps/mcp/.env.example apps/mcp/.env.local
cp apps/relay/.env.example apps/relay/.env.local
cp packages/database/.env.example packages/database/.env
```

The templates already point `DATABASE_URL`, the `S3_*` variables and
`SMTP_URL` at the Docker Compose services. Fill in, in `apps/api/.env.local`:

- **`BETTER_AUTH_SECRET`** (required): signs sessions; any long random string.
- **`ENCRYPTION_KEY`** (required): 32-byte base64 key for secrets at rest
  (`openssl rand -base64 32`).
- **GitHub App** (optional): only for GitHub repositories, see
  [github-app-setup.md](github-app-setup.md). Local Git, Bitbucket and other
  connections are added in the app under Settings.
- **PostHog** (optional): analytics and feature flags. Without it, use
  `AGENTFLOW_FEATURE_FLAGS` ([self-hosting.md](self-hosting.md#feature-flags-without-posthog)).
- **Liveblocks** (optional): live co-editing in the document editors.

The first account you sign up with creates the organization and becomes its
owner ([self-hosting.md](self-hosting.md#authentication)).

### 4. Initialize the Database

```bash
pnpm migrate        # prisma migrate dev in packages/database
```

`pnpm migrate:status` shows pending migrations. See
`packages/database/CLAUDE.md` for the other database commands.

### 5. Start the Application

**Option A: Core apps only (recommended for most development)**

```bash
pnpm turbo dev --filter=app --filter=api --filter=mcp
```

**Option B: All apps**

```bash
pnpm dev            # same as pnpm start-apps
```

#### Available Apps

| App | Port | URL | Description |
|-----|------|-----|-------------|
| **app** | 3000 | http://localhost:3000 | Main authenticated application |
| **web** | 3001 | http://localhost:3001 | Marketing/public website |
| **api** | 3002 | http://localhost:3002 | REST API, webhooks, desktop gateway socket, in-process cron |
| **studio** | 3005 | http://localhost:3005 | Prisma Studio (database browser) |
| **mcp** | 3010 | http://localhost:3010 | MCP server |
| **relay** | 3020 | http://localhost:3020 | WebSocket relay |
| **prototypes** | 3030 | http://localhost:3030 | Mock-data UI prototype sandbox |
| **storybook** | 6006 | http://localhost:6006 | Component library |

> **Tip:** To start a specific app individually, use `pnpm turbo dev --filter=<app-name>` (e.g., `pnpm turbo dev --filter=studio`).

### 6. Add a Compute Target

Loops run only on compute targets: the desktop app or a headless runner
(Docker image or systemd service). See [runner.md](runner.md).

---

## Troubleshooting

### Database connection errors

```
Error: P1001: Can't reach database server at `undefined:5432`
```

**Cause**: `DATABASE_URL` not set or Docker not running.

**Solution**:
1. Verify Docker is running: `docker compose ps`
2. Check that `packages/database/.env` contains the correct `DATABASE_URL`
3. Check that your app `.env.local` files have `DATABASE_URL` set

### "Cannot find module '@repo/database'"

**Cause**: Prisma client not generated.

**Solution**:
```bash
pnpm --filter @repo/database db:generate
```

### Attachments fail to upload or transcripts do not load

**Cause**: Buckets or CORS rules missing on RustFS.

**Solution**: run `pnpm storage:init` (again after changing the app's origin).

### Environment variable validation failed

**Cause**: Missing or invalid environment variable.

**Solution**:
- Ensure credentials were added to `.env.local`
- **Important**: Empty strings `""` fail validation — comment out unused variables instead

```bash
# Wrong - empty string fails validation
RESEND_TOKEN=""

# Right - comment out if not used
# RESEND_TOKEN=""
```

---

## Quick Reference

### Docker commands

```bash
docker compose up -d     # Start the backing services
docker compose down      # Stop them
docker compose logs -f   # View logs
```

### Local mail

Open http://localhost:8025 (Mailpit) to read invitations and password resets.
