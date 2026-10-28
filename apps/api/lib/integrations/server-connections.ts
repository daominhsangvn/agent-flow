import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LOCAL_GIT_DEFAULT_URL } from "./providers/local-git/schemas";

/**
 * Connections the server provides to every organization, so nobody adds
 * them in Settings → Connections: today Local Git, the `local-git` service
 * of docker-compose.yml, once the API knows its access token
 * (`LOCAL_GIT_TOKEN`, written by `pnpm local-git:init`).
 *
 * The environment is the only place they are configured: the connection
 * service creates each organization's connection on first use (or adopts a
 * Local Git connection an admin added for the same server, keeping its id
 * and the repositories that use it) and refreshes it when the environment
 * changes. Such a connection has no creator (`createdById` null), which is
 * how it is recognised, and is refused edits and deletes through the API
 * while the environment provides it.
 */

/** Environment variables as the server reads them (process.env by default). */
export type ServerEnv = Readonly<Record<string, string | undefined>>;

export type ServerConnectionSpec = {
  provider: string;
  name: string;
  /** Raw config, parsed with the provider's schema like a submitted one. */
  config: JsonObject;
  secrets: Record<string, string>;
};

/** The connections the environment provides, one per provider. */
export function getServerConnectionSpecs(
  env: ServerEnv = process.env
): ServerConnectionSpec[] {
  const token = readEnv(env, "LOCAL_GIT_TOKEN");
  if (!token) {
    return [];
  }
  return [
    {
      provider: IntegrationProviderKey.LocalGit,
      name: LOCAL_GIT_CONNECTION_NAME,
      config: {
        serverUrl:
          readEnv(env, "LOCAL_GIT_SERVER_URL") ?? LOCAL_GIT_DEFAULT_URL,
        runnerUrl: readEnv(env, "LOCAL_GIT_RUNNER_URL") ?? "",
        owner: readEnv(env, "LOCAL_GIT_OWNER") ?? "",
      },
      secrets: { token },
    },
  ];
}

/** True when the server provides the connection of this provider. */
export function isProvidedByServer(
  providerKey: string,
  env: ServerEnv = process.env
): boolean {
  return getServerConnectionSpecs(env).some(
    (spec) => spec.provider === providerKey
  );
}

/**
 * True when the record is a server connection: one of a provider the server
 * can provide, with no creator.
 */
export function isServerConnection(record: {
  provider: string;
  createdById: string | null;
}): boolean {
  return (
    record.createdById === null &&
    SERVER_PROVIDER_KEYS.includes(record.provider)
  );
}

/** Advisory lock key that serializes writing an organization's server connection. */
export function serverConnectionLockKey(
  organizationId: string,
  provider: string
): string {
  return `server-connection:${organizationId}:${provider}`;
}

export const LOCAL_GIT_CONNECTION_NAME = "Local Git";

export const SERVER_CONNECTION_READ_ONLY_MESSAGE =
  "This connection is provided by the server: change it in the API's environment (LOCAL_GIT_SERVER_URL, LOCAL_GIT_RUNNER_URL, LOCAL_GIT_TOKEN, LOCAL_GIT_OWNER; `pnpm local-git:init` writes them) and restart the API.";

/** Providers whose connection the server can provide. */
const SERVER_PROVIDER_KEYS: readonly string[] = [
  IntegrationProviderKey.LocalGit,
];

function readEnv(env: ServerEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}
