# Self-hosting

This edition runs without AWS, Vercel, or any hosted AgentFlow service. Every
backing service starts from `docker-compose.yml`, and Claude Code runs through
the locally installed `claude` CLI (your subscription login, or any
Anthropic-compatible endpoint configured in `~/.claude/settings.json`).

## Quick start

```bash
pnpm install
cp .env.docker.example .env        # optional: change host ports / credentials
docker compose up -d               # Postgres, RustFS (S3), Mailpit, Local Git
pnpm storage:init                  # create the buckets + browser CORS (idempotent)
pnpm local-git:init                # optional: Local Git account + token, written to apps/api/.env.local
cd packages/database && pnpm prisma migrate deploy && cd ../..
pnpm dev
```

| Service  | Image                  | Default host ports            | Purpose |
|----------|------------------------|-------------------------------|---------|
| postgres | `postgres:16`          | 5432                          | Application database |
| rustfs   | `rustfs/rustfs:1.0.1`  | 9000 (S3 API), 9001 (console) | Attachments, transcripts, loop state, catalog assets |
| mailpit  | `axllent/mailpit:v1.27`| 1025 (SMTP), 8025 (web UI)    | Captures outgoing mail in development |
| local-git | `gitea/gitea:1.24.7`  | 3300 (web UI + git over HTTP) | Local Git: repositories on this machine for projects without a remote ([local-git.md](local-git.md)) |

`apps/api/.env.example` lists every variable. The ones specific to
self-hosting:

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Plain PostgreSQL URL. Add `?sslmode=disable` when the host is not `localhost` and the server has no TLS (e.g. inside the compose network). |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | Endpoint used by the API, and the one baked into presigned URLs (must be reachable from browsers, the desktop app and runners; a runner container reaches a local RustFS at `http://host.docker.internal:9000`, which a Windows/macOS browser resolves too). |
| `S3_CORS_ALLOWED_ORIGINS` | Comma-separated web app origins `pnpm storage:init` allows on the attachments (GET/HEAD/PUT) and transcripts (GET/HEAD) buckets; defaults to the origin of `NEXT_PUBLIC_APP_URL`. Without these rules the browser cannot upload attachments or show a session's transcript (Trace). Re-run `storage:init` after changing the app's origin. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Same pair as the RustFS root credentials in `.env`. |
| `S3_MULTIPART_CHECKSUM` | `computed` (default) works on any S3-compatible server; `native` only for AWS S3. |
| `S3_COLD_STORAGE_CLASS` | Leave unset unless the backend supports the class. |
| `ENCRYPTION_KEY` | 32-byte base64 master key for secrets at rest. Rotating it makes stored Claude API keys and integration tokens unreadable. |

## Authentication

Accounts are local email/password accounts managed by
[Better Auth](https://better-auth.com) inside `apps/api`
(`lib/auth/better-auth.ts`), stored in the `auth_*` tables. The web app serves
the endpoints on its own origin by rewriting `/api/auth/*` to the API, so the
session cookie is first-party. Server code and the browser exchange that cookie
for a 15-minute EdDSA JWT (`/api/auth/token`) carrying the user and the active
organization (`org_id`, `org_slug`, `org_role`); the API verifies it against
`/api/auth/jwks`. `@repo/auth` exposes the same `auth()`, middleware and client
hooks the app used with Clerk.

Single-tenant by default:

- The first account creates the organization (`AUTH_DEFAULT_ORGANIZATION_NAME`
  / `_SLUG`, default `AgentFlow` / `agentflow`) and becomes its owner.
- Later accounts join it as members (`AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION=false`
  to stop that), unless an invitation for their email assigns another role.
- Owners and admins invite people from Settings → Organization; the email links
  to sign-up with the address pre-filled. With `AUTH_ALLOW_SIGN_UP=false` the
  deployment is invite-only: only emails with a pending invitation can sign up.
- More organizations: `AUTH_ALLOW_CREATE_ORGANIZATION=true`.

Password resets and invitations are sent over `SMTP_URL` (Mailpit at
http://localhost:8025 in development). Microsoft Entra ID sign-in is not
configured yet.

## Claude Code plugins

The AgentFlow plugins (`code`, `code-review`, `judges`, `platform`,
`self-learning`, `bootstrap`) are vendored in `agent-plugins/` (Apache-2.0, see
`agent-plugins/NOTICE`). The desktop runner passes them to every `claude`
invocation with `--plugin-dir`, and exports `AGENTFLOW_PLUGIN_DIRS` so
`run-loop.sh` does the same. Nothing is installed into `~/.claude/plugins`.
Set `AGENTFLOW_PLUGINS_DIR` to point the desktop at a different copy.

## Workflows and integrations

Jira, Azure DevOps, Microsoft Teams and generic HTTPS webhooks are connected
under Settings → Compute & Integrations → Connections, and **Workflows**
(sidebar) turn their events into agent-team runs with optional post actions
(comment back on the ticket, transition it, post to Teams, call a URL). See
[workflows.md](workflows.md) for the architecture and per-provider setup.

The API process runs a small in-process scheduler (`apps/api/lib/self-hosted-cron.ts`)
that calls `/cron/workflows` every `WORKFLOW_TICK_SECONDS` (default 10),
`/cron/timeout-loops` every 5 minutes, and `/cron/reconcile-stale-sessions`
hourly (ends agent sessions still marked active after their machine stopped
reporting for `STALE_SESSION_AGE_HOURS`, default 24), because self-hosted has
no Vercel cron. Set `SELF_HOSTED_CRON_DISABLED=true` if an external scheduler calls the
cron routes instead (then `CRON_SECRET` must be set).

Jira Cloud and Azure DevOps webhooks must reach the API over public HTTPS
(`PUBLIC_WEBHOOK_BASE_URL`). On a machine without a public URL, set the
connection to **poll** mode instead.

## Document collaboration (optional)

Live co-editing, presence and inline comment threads in the document editors
(PRDs, issues, plans) use Liveblocks, which is a hosted service. Leave
`LIVEBLOCKS_SECRET` unset to run without it: `GET /collaboration/status`
answers `{ enabled: false }`, the editors then show the saved version and
**Publish** saves each edit as a new version through the API, and the app
never asks for a room token. Set the secret in `apps/api/.env.local` to turn
the live features on.

## Compute targets: desktop app or headless runner

Loops run on compute targets. Developers can use the desktop app; for
unattended workflow runs, deploy one or more **headless runners** (Docker
image or a systemd service on Ubuntu/Debian): see [runner.md](runner.md).
Workflows and the desktop app talk to compute targets through the desktop
gateway socket hosted by `apps/api/server.ts`.

## Feature flags without PostHog

Features still being rolled out sit behind PostHog flags, which are all off
on a deployment without PostHog. Turn them on (or off) for the whole
deployment with comma- or space-separated flag keys; `-key` forces one off,
and an override wins over PostHog:

```bash
# apps/api/.env.local — server-side checks (API routes, ingest)
AGENTFLOW_FEATURE_FLAGS=desktop-agent-session-sync,emergent
# apps/app/.env.local — the web app's UI
NEXT_PUBLIC_AGENTFLOW_FEATURE_FLAGS=desktop-agent-session-sync,emergent
```

The Sessions and Agents pages need no flag or setting: desktops and headless
runners always report their agent sessions and components, and the data stays
in this deployment's database. `desktop-agent-session-sync` now only opens the
Dashboard's insight metrics and golden candidates; `emergent` turns on the
live Active Runs view of Sessions.

## What changed from the hosted product

| Hosted | Self-hosted |
|--------|-------------|
| AWS S3 | RustFS through `@repo/storage` |
| AWS KMS | AES-256-GCM (`apps/api/lib/secret-encryption.ts`) |
| AWS ECS cloud runner | Removed — loops run on desktop compute targets only |
| RDS IAM auth / Neon | `DATABASE_URL` |
| `@vercel/functions` `waitUntil` | `apps/api/lib/wait-until.ts` |
| Vercel preview schemas (`/preview-schemas/ensure`) | Removed |
| `/plugin install` of claude-plugins | `agent-plugins/` + `--plugin-dir` |
| Clerk (auth, organizations, webhooks) | Better Auth in `apps/api` + `@repo/auth` facade |

Still to port: Microsoft Entra ID sign-in, Liveblocks → Hocuspocus, Linear →
disabled, and a full-stack compose profile for the apps themselves.

## Known limitations

- The desktop app is still built for macOS; Linux works in dev mode. Several
  desktop and database tests assume POSIX paths and fail on Windows.
- `apps/desktop` build info needs a git commit (`scripts/write-build-info.mjs`
  runs `git rev-parse HEAD`).
