# End-to-end tests (Playwright)

The web e2e suite lives in `e2e/` and runs with Playwright from the repo root
(`playwright.config.ts`). It drives a running local stack; it never starts
servers itself.

## Run locally

```bash
docker compose up -d                                   # Postgres (RustFS/Mailpit optional)
cd packages/database && pnpm prisma migrate deploy && cd ../..
pnpm turbo dev --filter=app --filter=api               # keep running in another terminal
pnpm exec playwright install chromium                  # once
pnpm test:e2e:smoke                                    # or: pnpm test:e2e
```

- The API must run through `apps/api/server.ts` (the default `dev` script).
  It hosts the in-process scheduler that advances workflow runs and drains
  post actions, which `e2e/workflows.spec.ts` depends on.
- `pnpm test:e2e:ui` opens the Playwright UI. Reports go to
  `playwright-report/`, traces and screenshots to `test-results/` (both may
  contain authenticated page content; do not publish them).

## URLs and the test account

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `NEXT_PUBLIC_APP_URL` from `apps/app/.env.local`, else `http://localhost:3000` | Web app origin. Must equal the origin of `BETTER_AUTH_URL` in `apps/api/.env.local`: Better Auth rejects sign-in from any other `Origin`, and the session JWT's issuer is that origin. |
| `E2E_API_URL` | `NEXT_PUBLIC_API_URL`, else port 3002 on the app host | API origin. (`API_BASE_URL` is not read: in the API env it is the loop callback URL.) |
| `E2E_USER_EMAIL` | `e2e@example.com` | Test account. |
| `E2E_USER_PASSWORD` | `DEVOPS_AGENTFLOW_APP_PWD`, else a fixed local default | Required when `BASE_URL` is not localhost. |
| `E2E_USER_NAME` | `E2E Bot` | Display name used when the account is created. |
| `E2E_INCLUDE_EXTERNAL` | unset | `1` also runs the `@external` specs (see below). |

`.env.local` values never override variables already set in the shell. The
app's `dev` script listens on 3000; if your `NEXT_PUBLIC_APP_URL` and
`BETTER_AUTH_URL` say another port (for example 3100), serve the app there
(`pnpm --filter app exec next dev -p 3100`) or point all three at the same
origin.

The `setup` project signs the account in through the Better Auth API (and
signs it up on first use), marks onboarding complete, and saves the session
cookie to `.auth/user.json`. Every other test starts from that storage state
and mints a fresh 15-minute JWT from it (`getSessionBearerToken(page)`, or the
`apiToken` fixture in `e2e/test.ts`) for API calls.

The first account created on an empty database owns the `agentflow`
organization; later sign-ups join it as members. Settings and the workflow
spec need an org admin or owner, so prefer a dedicated database, or set
`E2E_USER_EMAIL`/`E2E_USER_PASSWORD` to an admin. Sign-up must be open
(`AUTH_ALLOW_SIGN_UP` not `false`) unless the account already exists, and
`AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION` must not be `false`.

## Tags

| Tag | Specs | Needs |
|---|---|---|
| `@smoke` | `auth.setup`, `auth`, `session-token`, `navigation`, `teams`, `projects`, `workflows` | Postgres plus the app and API dev servers. |
| `@external` | `feature-evaluation`, `plan-evaluation`, `pre-loop-system-check` | Liveblocks for document pages, and for loop completion a desktop compute target plus `AGENTFLOW_RUNNER_JWT_SECRET` shared with the API. Skipped unless `E2E_INCLUDE_EXTERNAL=1`. |

`pnpm test:e2e:smoke` runs `playwright test --grep @smoke`. A single spec:
`pnpm exec playwright test e2e/workflows.spec.ts`.

## The workflows smoke spec

`e2e/workflows.spec.ts` creates a generic HTTPS ("webhook") integration
connection and a workflow whose `webhook.post` action targets a throwaway
HTTP server the test starts on `127.0.0.1`. It then:

1. checks that an unsigned request to the inbound URL is rejected (401);
2. sends a Standard Webhooks-signed delivery (200) and waits for the run to
   fail, which it must, because the registered compute target has no desktop
   app behind it;
3. replays the same delivery and checks that there is still exactly one run;
4. waits for the `run.failed` event at the local HTTP server;
5. opens `/{org}/workflows` and expects the workflow to be listed.

Everything it creates is deleted in `finally`.

## Unit tests for the helpers

The helpers in `e2e/helpers/` have vitest tests in `e2e/helpers/__tests__/`
(Playwright only collects `*.spec.ts` and `*.setup.ts`). They need no running
stack:

```bash
npx vitest run --config e2e/vitest.config.ts
npx tsc --noEmit -p tsconfig.playwright.json
```
