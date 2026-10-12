import { getApiBaseUrl, getAppBaseUrl, isLocalUrl } from "./helpers/api-url";
import { AUTH_BASE_PATH } from "./helpers/better-auth";

const PROBE_TIMEOUT_MS = 10_000;
const START_INSTRUCTIONS =
  "Start the stack first: `docker compose up -d`, " +
  "`cd packages/database && pnpm prisma migrate deploy`, then " +
  "`pnpm turbo dev --filter=app --filter=api` (see docs/e2e.md).";

export default async function globalSetup(): Promise<void> {
  const baseUrl = getAppBaseUrl();

  // In CI, allow non-localhost targets. Locally, restrict to localhost to
  // prevent accidental runs against a shared deployment.
  if (!(process.env.CI || isLocalUrl(baseUrl))) {
    throw new Error(
      "E2E tests must not run against non-localhost targets outside CI. " +
        `Received BASE_URL=${baseUrl}. ` +
        "Set BASE_URL to a localhost address or set CI=true for remote targets."
    );
  }

  // Fail fast with one clear message instead of a timeout per test.
  // /api/auth/ok proves the web app, its /api/auth rewrite and Better Auth.
  await probe(
    `${baseUrl}${AUTH_BASE_PATH}/ok`,
    "web app (Better Auth via the /api/auth rewrite)"
  );
  await probe(`${getApiBaseUrl()}/health`, "API");
}

async function probe(url: string, label: string): Promise<void> {
  let failure: string;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      return;
    }
    failure = `answered ${response.status} ${response.statusText}`;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `E2E readiness check failed: ${label} at ${url} ${failure}. ${START_INSTRUCTIONS}`
  );
}
