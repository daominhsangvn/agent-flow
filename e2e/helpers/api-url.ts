import { readEnv, stripTrailingSlashes } from "./env";

/**
 * Origins of the web app and the API under test.
 *
 * The web app origin is BASE_URL, else NEXT_PUBLIC_APP_URL (loaded from
 * apps/app/.env.local by playwright.config.ts). It must equal the origin in
 * BETTER_AUTH_URL: Better Auth rejects cookie-carrying POSTs from any other
 * Origin, and the session JWT's issuer/audience are that origin.
 *
 * The API origin is E2E_API_URL, else NEXT_PUBLIC_API_URL, else the web app
 * host on port 3002. `API_BASE_URL` is deliberately NOT read: in
 * apps/api/.env.local it is the loop callback URL, which e2e/helpers/loops.ts
 * loads into this process and which may differ from the API origin.
 */

const DEFAULT_APP_ORIGIN = "http://localhost:3000";
const DEFAULT_API_PORT = "3002";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function getAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return stripTrailingSlashes(
    readEnv("BASE_URL", env) ??
      readEnv("NEXT_PUBLIC_APP_URL", env) ??
      DEFAULT_APP_ORIGIN
  );
}

export function getAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(getAppBaseUrl(env)).origin;
}

export function getApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    readEnv("E2E_API_URL", env) ?? readEnv("NEXT_PUBLIC_API_URL", env);
  if (explicit) {
    return stripTrailingSlashes(explicit);
  }

  const appUrl = new URL(getAppBaseUrl(env));
  if (LOCAL_HOSTNAMES.has(appUrl.hostname)) {
    return `${appUrl.protocol}//${appUrl.hostname}:${DEFAULT_API_PORT}`;
  }

  throw new Error(
    `Could not resolve the API origin for BASE_URL=${appUrl.origin}. ` +
      "Set E2E_API_URL to the API origin (e.g. https://api.example.com)."
  );
}

export function isLocalUrl(url: string): boolean {
  return LOCAL_HOSTNAMES.has(new URL(url).hostname);
}
