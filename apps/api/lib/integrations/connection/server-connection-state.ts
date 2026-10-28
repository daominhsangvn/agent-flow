import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import {
  type IntegrationConnection as IntegrationConnectionRecord,
  withDb,
} from "@repo/database";
import type { AnyProvider } from "../registry";
import {
  isProvidedByServer,
  isServerConnection,
  type ServerConnectionSpec,
} from "../server-connections";
import {
  parseConnectionConfig,
  parseConnectionSecrets,
} from "./provider-checks";
import { openCredentials } from "./secrets";
import { toJsonObject } from "./stored-json";

/**
 * The state of an organization's server-provided connection
 * (server-connections.ts): which row it is (or which admin-added connection
 * it adopts), whether the environment still provides it (then it is
 * read-only), and whether it must be written again because the environment
 * changed it or its last check failed a while ago.
 */

/**
 * The stored connection matches the environment (config and secrets as the
 * provider parses them) and is not a failure worth checking again.
 */
export function isServerConnectionCurrent(
  record: IntegrationConnectionRecord,
  provider: AnyProvider,
  spec: ServerConnectionSpec
): boolean {
  const failedAt =
    record.status === IntegrationConnectionStatus.Error
      ? record.updatedAt.getTime()
      : null;
  if (failedAt !== null && Date.now() - failedAt > SERVER_CONNECTION_RETRY_MS) {
    return false;
  }
  const storedConfig = parseConnectionConfig(
    provider,
    toJsonObject(record.config)
  );
  const wantedConfig = parseConnectionConfig(provider, spec.config);
  if (
    !(
      storedConfig.ok &&
      wantedConfig.ok &&
      isDeepStrictEqual(storedConfig.value, wantedConfig.value)
    )
  ) {
    return false;
  }
  const opened = openCredentials(record.credentialsEncrypted);
  const storedSecrets = opened.ok
    ? parseConnectionSecrets(provider, opened.value)
    : null;
  const wantedSecrets = parseConnectionSecrets(provider, spec.secrets);
  return Boolean(
    storedSecrets?.ok &&
      wantedSecrets.ok &&
      isDeepStrictEqual(storedSecrets.value, wantedSecrets.value)
  );
}

/** A server connection whose check failed is checked again after this long. */
const SERVER_CONNECTION_RETRY_MS = 60_000;

/** A server-provided connection the environment still provides: read-only. */
export function isProvidedServerConnection(
  record: IntegrationConnectionRecord
): boolean {
  return isServerConnection(record) && isProvidedByServer(record.provider);
}

/** The organization's server connection of the provider (no creator), oldest first. */
export async function findServerConnection(
  organizationId: string,
  providerKey: string
): Promise<IntegrationConnectionRecord | null> {
  return await withDb((db) =>
    db.integrationConnection.findFirst({
      where: { organizationId, provider: providerKey, createdById: null },
      orderBy: { createdAt: "asc" },
    })
  );
}

/**
 * The oldest connection an admin added for the same destination (the same
 * credential origin settings, e.g. Local Git's server and runner URLs as
 * `config` sets them): adopting it keeps its id, so the project repositories,
 * triggers and actions using it keep working.
 */
export async function findAdoptableConnection(
  organizationId: string,
  provider: AnyProvider,
  config: JsonObject
): Promise<IntegrationConnectionRecord | null> {
  const wanted = parseConnectionConfig(provider, config);
  if (!wanted.ok) {
    return null;
  }
  const candidates = await withDb((db) =>
    db.integrationConnection.findMany({
      where: { organizationId, provider: provider.key },
      orderBy: { createdAt: "asc" },
    })
  );
  const originKeys = provider.connection.credentialOriginFields ?? [];
  return (
    candidates.find((record) => {
      const stored = parseConnectionConfig(
        provider,
        toJsonObject(record.config)
      );
      return (
        stored.ok &&
        originKeys.every((key) =>
          isDeepStrictEqual(stored.value[key], wanted.value[key])
        )
      );
    }) ?? null
  );
}
