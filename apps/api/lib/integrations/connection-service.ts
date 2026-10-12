import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  type CreateIntegrationConnectionInput,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  type IntegrationConnectionTestResult,
  type IntegrationDelivery,
  IntegrationDeliveryMode,
  type IntegrationInboundDetails,
  type IntegrationSecretFieldState,
  type UpdateIntegrationConnectionInput,
} from "@repo/api/src/types/integration";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type IntegrationConnection as IntegrationConnectionRecord,
  type IntegrationDelivery as IntegrationDeliveryRecord,
  Prisma,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { checkCredentialOrigin } from "./connection/credential-origin";
import {
  checkDeliveryMode,
  parseConnectionConfig,
  parseConnectionSecrets,
  renderSetupInstructions,
  runProviderValidation,
} from "./connection/provider-checks";
import {
  buildCredentialHints,
  collectSecretValues,
  generateInboundKey,
  getSecretFieldKeys,
  hasSecretChanges,
  mergeSecrets,
  openCredentials,
  openInboundSecret,
  scrubLogMeta,
  scrubSecretValues,
  sealCredentials,
  sealInboundSecret,
} from "./connection/secrets";
import {
  parseConnectionStatus,
  parseCredentialHints,
  parseDeliveryMode,
  parseDeliveryOutcome,
  parseDeliverySource,
  parseStoredAccount,
  toAccountSummary,
  toJsonObject,
} from "./connection/stored-json";
import {
  ADMIN_VIEWER,
  type ConfigViewer,
  redactUrlFields,
} from "./connection/url-redaction";
import { createProviderHttp } from "./http";
import { generateInboundSecret } from "./inbound-auth";
import { type AnyProvider, getIntegrationProvider } from "./registry";
import {
  type ConnectionRuntime,
  type IntegrationAccount,
  type ProviderContext,
  type ProviderLogger,
  ValidateConnectionReason,
} from "./types";

/**
 * Integration connections: CRUD for the admin UI, secret sealing, provider
 * validation, inbound endpoint details, and the decrypted runtime view the
 * workflow engine hands to provider code.
 *
 * Secrets never leave this module family except as `{ isSet, lastFour }`
 * hints and the inbound secret on the admin-only inbound endpoint.
 */

export type LoadedConnection = {
  record: IntegrationConnectionRecord;
  provider: AnyProvider;
  runtime: ConnectionRuntime;
};

export type ConnectionServiceError = { status: StatusCode; message: string };

export const integrationConnectionService = {
  /** Members who are not org admins see url-kind config fields as their origin only. */
  async list(
    organizationId: string,
    viewer: ConfigViewer
  ): Promise<IntegrationConnection[]> {
    const records = await withDb((db) =>
      db.integrationConnection.findMany({
        where: { organizationId },
        include: USAGE_COUNT_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    );
    return records.map((record) => toConnectionDto(record, viewer));
  },

  async get(
    organizationId: string,
    id: string,
    viewer: ConfigViewer
  ): Promise<IntegrationConnection | null> {
    const record = await findConnectionWithUsage(organizationId, id);
    return record ? toConnectionDto(record, viewer) : null;
  },

  async create(
    organizationId: string,
    userId: string,
    input: CreateIntegrationConnectionInput
  ): Promise<Result<IntegrationConnection, ConnectionServiceError>> {
    const provider = getIntegrationProvider(input.provider);
    if (!provider) {
      return badRequest(`Unknown integration provider "${input.provider}"`);
    }
    const mode = checkDeliveryMode(provider, input.deliveryMode);
    if (!mode.ok) {
      return badRequest(mode.error);
    }

    const id = uuidv7();
    const secretKeys = getSecretFieldKeys(provider.connection.fields);
    const settings = await validateSettings(
      provider,
      { id, organizationId, name: input.name },
      input.config,
      mergeSecrets({}, input.secrets, secretKeys)
    );
    if (!settings.ok) {
      return badRequest(settings.error);
    }

    const now = new Date();
    const inboundSecret =
      provider.inbound?.generateSecret?.() ?? generateInboundSecret();
    const record = await withDb((db) =>
      db.integrationConnection.create({
        data: {
          id,
          organizationId,
          provider: provider.key,
          name: input.name,
          status: IntegrationConnectionStatus.Active,
          deliveryMode: mode.value,
          pollIntervalSeconds: input.pollIntervalSeconds,
          nextPollAt: mode.value === IntegrationDeliveryMode.Poll ? now : null,
          inboundKey: generateInboundKey(),
          inboundSecretEncrypted: sealInboundSecret(inboundSecret),
          createdById: userId,
          ...toValidatedSettingsData(settings.value, secretKeys, now),
        },
        include: USAGE_COUNT_INCLUDE,
      })
    );
    return Result.ok(toConnectionDto(record, ADMIN_VIEWER));
  },

  async update(
    organizationId: string,
    id: string,
    input: UpdateIntegrationConnectionInput
  ): Promise<Result<IntegrationConnection, ConnectionServiceError>> {
    const record = await findConnectionRecord(organizationId, id);
    if (!record) {
      return notFound();
    }
    const provider = getIntegrationProvider(record.provider);
    if (!provider) {
      return badRequest(`Unknown integration provider "${record.provider}"`);
    }
    if (input.deliveryMode !== undefined) {
      const mode = checkDeliveryMode(provider, input.deliveryMode);
      if (!mode.ok) {
        return badRequest(mode.error);
      }
    }

    const settings = await resolveSettingsUpdate(record, provider, input);
    if (!settings.ok) {
      return badRequest(settings.error);
    }

    const data = buildUpdateData(record, provider, input, settings.value);
    const updated = await withDb((db) =>
      db.integrationConnection.update({
        where: { id: record.id, organizationId },
        data,
        include: USAGE_COUNT_INCLUDE,
      })
    );
    return Result.ok(toConnectionDto(updated, ADMIN_VIEWER));
  },

  async remove(
    organizationId: string,
    id: string
  ): Promise<Result<{ deleted: true }, ConnectionServiceError>> {
    const record = await findConnectionWithUsage(organizationId, id);
    if (!record) {
      return notFound();
    }
    const usageCount = countUsage(record);
    if (usageCount > 0) {
      return inUse(usageCount);
    }
    // The relation filters make the delete atomic with the usage check: a
    // trigger, action or project repository added since the read keeps the row.
    const deleted = await withDb((db) =>
      db.integrationConnection.deleteMany({
        where: {
          id: record.id,
          organizationId,
          triggers: { none: {} },
          actions: { none: {} },
          projectRepositories: { none: {} },
        },
      })
    );
    if (deleted.count === 0) {
      return inUse(null);
    }
    return Result.ok({ deleted: true });
  },

  async test(
    organizationId: string,
    id: string
  ): Promise<IntegrationConnectionTestResult | null> {
    const record = await findConnectionRecord(organizationId, id);
    if (!record) {
      return null;
    }
    const loaded = buildLoadedConnection(record);
    if (!loaded.ok) {
      await recordValidationFailure(record, loaded.error);
      return {
        ok: false,
        account: toAccountSummary(parseStoredAccount(record.account)),
        error: loaded.error,
      };
    }

    const { provider, runtime } = loaded.value;
    const result = await runProviderValidation(
      provider,
      createProviderContext(runtime, LOG_PREFIX),
      ValidateConnectionReason.Test
    );
    if (!result.ok) {
      await recordValidationFailure(record, result.error);
      return {
        ok: false,
        account: toAccountSummary(runtime.account),
        error: result.error,
      };
    }
    await recordValidationSuccess(record, result.account);
    return { ok: true, account: toAccountSummary(result.account), error: null };
  },

  async getInboundDetails(
    organizationId: string,
    id: string
  ): Promise<IntegrationInboundDetails | null> {
    const record = await findConnectionRecord(organizationId, id);
    if (!record) {
      return null;
    }
    const inboundSecret = openInboundSecret(record.inboundSecretEncrypted);
    if (!inboundSecret.ok) {
      // Unexpected (rotated ENCRYPTION_KEY or a corrupt row): surface as a 500.
      // Rotating the inbound endpoint replaces the secret and recovers.
      throw new Error(inboundSecret.error);
    }
    return toInboundDetails(record, inboundSecret.value);
  },

  async rotateInbound(
    organizationId: string,
    id: string
  ): Promise<IntegrationInboundDetails | null> {
    const record = await findConnectionRecord(organizationId, id);
    if (!record) {
      return null;
    }
    const provider = getIntegrationProvider(record.provider);
    const inboundSecret =
      provider?.inbound?.generateSecret?.() ?? generateInboundSecret();
    const updated = await withDb((db) =>
      db.integrationConnection.update({
        where: { id: record.id, organizationId },
        data: {
          inboundKey: generateInboundKey(),
          inboundSecretEncrypted: sealInboundSecret(inboundSecret),
        },
      })
    );
    log.info(`${LOG_PREFIX} Rotated inbound endpoint`, {
      organizationId,
      connectionId: record.id,
      provider: record.provider,
    });
    return toInboundDetails(updated, inboundSecret);
  },

  async listDeliveries(
    organizationId: string,
    id: string,
    limit = DELIVERIES_DEFAULT_LIMIT
  ): Promise<IntegrationDelivery[]> {
    if (!isConnectionId(id)) {
      return [];
    }
    const deliveries = await withDb((db) =>
      db.integrationDelivery.findMany({
        where: { organizationId, connectionId: id },
        orderBy: { receivedAt: "desc" },
        take: clampDeliveriesLimit(limit),
      })
    );
    return deliveries.map(toDeliveryDto);
  },
};

/**
 * Decrypted, validated runtime for engine and action code. Returns null (and
 * logs a warning) when the connection is missing, its provider is no longer
 * registered, or its stored config/credentials no longer parse.
 */
export async function loadConnectionRuntime(
  organizationId: string,
  connectionId: string
): Promise<LoadedConnection | null> {
  const record = await findConnectionRecord(organizationId, connectionId);
  if (!record) {
    return null;
  }
  const loaded = buildLoadedConnection(record);
  if (!loaded.ok) {
    warnUnloadable(record, loaded.error);
    return null;
  }
  return loaded.value;
}

/**
 * Public ingress lookup: resolves the connection (and with it the
 * organization) from the opaque inbound key, never from the payload.
 */
export async function loadConnectionByInboundKey(
  inboundKey: string
): Promise<(LoadedConnection & { inboundSecret: string }) | null> {
  if (!INBOUND_KEY_RE.test(inboundKey)) {
    return null;
  }
  const record = await withDb((db) =>
    db.integrationConnection.findUnique({ where: { inboundKey } })
  );
  if (!record) {
    return null;
  }
  const loaded = buildLoadedConnection(record);
  if (!loaded.ok) {
    warnUnloadable(record, loaded.error);
    return null;
  }
  const inboundSecret = openInboundSecret(record.inboundSecretEncrypted);
  if (!inboundSecret.ok) {
    warnUnloadable(record, inboundSecret.error);
    return null;
  }
  return { ...loaded.value, inboundSecret: inboundSecret.value };
}

/**
 * Context handed to provider code. The logger prefixes every line, tags it
 * with the connection, and scrubs the connection's secret values from the
 * message and metadata.
 */
export function createProviderContext(
  runtime: ConnectionRuntime,
  logPrefix: string
): ProviderContext {
  return {
    connection: runtime,
    http: createProviderHttp(),
    log: createProviderLogger(runtime, logPrefix),
    now: () => new Date(),
  };
}

/** Absolute URL a source system POSTs to for this connection. */
export function buildInboundUrl(inboundKey: string): string {
  const base =
    firstNonEmpty(
      process.env.PUBLIC_WEBHOOK_BASE_URL,
      process.env.NEXT_PUBLIC_API_URL
    ) ?? DEFAULT_PUBLIC_API_URL;
  return `${base.replace(TRAILING_SLASHES_RE, "")}${INBOUND_WEBHOOK_PATH}${inboundKey}`;
}

/**
 * Saves the outcome of one poll. `cursor` is replaced only when given (null
 * clears it); `error` is replaced only when given (null clears lastError).
 * The status is left alone so a transient failure never stops polling.
 */
export async function recordConnectionPollResult(
  connectionId: string,
  data: { cursor?: JsonValue; error?: string | null; nextPollAt: Date }
): Promise<void> {
  const update: Prisma.IntegrationConnectionUpdateManyMutationInput = {
    lastPolledAt: new Date(),
    nextPollAt: data.nextPollAt,
  };
  if (data.cursor !== undefined) {
    update.pollCursor = toNullableJson(data.cursor);
  }
  if (data.error !== undefined) {
    update.lastError = data.error === null ? null : trimError(data.error);
  }
  await withDb((db) =>
    db.integrationConnection.updateMany({
      where: { id: connectionId },
      data: update,
    })
  );
}

const LOG_PREFIX = "[integrations/connections]";
const DEFAULT_PUBLIC_API_URL = "http://localhost:3002";
const INBOUND_WEBHOOK_PATH = "/webhooks/integrations/";
const TRAILING_SLASHES_RE = /\/+$/;
const INBOUND_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DELIVERIES_DEFAULT_LIMIT = 50;
const DELIVERIES_MAX_LIMIT = 200;
const LAST_ERROR_MAX_LENGTH = 1000;

const connectionIdSchema = z.uuid();

const USAGE_COUNT_INCLUDE = {
  _count: {
    select: { triggers: true, actions: true, projectRepositories: true },
  },
} as const satisfies Prisma.IntegrationConnectionInclude;

type ConnectionRecordWithUsage = Prisma.IntegrationConnectionGetPayload<{
  include: typeof USAGE_COUNT_INCLUDE;
}>;

type ValidatedSettings = {
  config: JsonObject;
  secrets: JsonObject;
  account: IntegrationAccount | null;
};

type ConnectionIdentity = Pick<
  ConnectionRuntime,
  "id" | "organizationId" | "name"
>;

type PollScheduleInput = {
  deliveryMode: IntegrationDeliveryMode;
  status: IntegrationConnectionStatus;
  /** Submitted interval; undefined keeps the stored one. */
  pollIntervalSeconds: number | undefined;
  now: Date;
};

function isConnectionId(id: string): boolean {
  return connectionIdSchema.safeParse(id).success;
}

async function findConnectionRecord(
  organizationId: string,
  id: string
): Promise<IntegrationConnectionRecord | null> {
  if (!isConnectionId(id)) {
    return null;
  }
  return await withDb((db) =>
    db.integrationConnection.findFirst({ where: { id, organizationId } })
  );
}

async function findConnectionWithUsage(
  organizationId: string,
  id: string
): Promise<ConnectionRecordWithUsage | null> {
  if (!isConnectionId(id)) {
    return null;
  }
  return await withDb((db) =>
    db.integrationConnection.findFirst({
      where: { id, organizationId },
      include: USAGE_COUNT_INCLUDE,
    })
  );
}

/**
 * Parses config and secrets with the provider's schemas, then asks the
 * provider to check them against the source system (reason "save", no side
 * effects). The provider may return a normalized config to persist.
 */
async function validateSettings(
  provider: AnyProvider,
  identity: ConnectionIdentity,
  rawConfig: Record<string, unknown>,
  rawSecrets: Record<string, unknown>
): Promise<Result<ValidatedSettings, string>> {
  const config = parseConnectionConfig(provider, rawConfig);
  if (!config.ok) {
    return Result.err(config.error);
  }
  const secrets = parseConnectionSecrets(provider, rawSecrets);
  if (!secrets.ok) {
    return Result.err(secrets.error);
  }
  const runtime: ConnectionRuntime = {
    ...identity,
    provider: provider.key,
    config: config.value,
    secrets: secrets.value,
    account: null,
  };
  const validation = await runProviderValidation(
    provider,
    createProviderContext(runtime, LOG_PREFIX),
    ValidateConnectionReason.Save
  );
  if (!validation.ok) {
    return Result.err(validation.error);
  }
  return Result.ok({
    config: validation.config ?? config.value,
    secrets: secrets.value,
    account: validation.account,
  });
}

/**
 * Re-validates only when config or secrets change (Ok(null) otherwise), so
 * a form that re-sends unchanged config with a rename does not call the
 * source system. Submitted secrets are merged over the stored ones; stored
 * credentials that no longer decrypt are treated as unset so the admin can
 * re-enter them. Stored secrets are never reused once a credential origin
 * field (e.g. the Jira site URL) changes: the update is refused before the
 * provider is called unless every secret that is set is entered again.
 */
async function resolveSettingsUpdate(
  record: IntegrationConnectionRecord,
  provider: AnyProvider,
  input: UpdateIntegrationConnectionInput
): Promise<Result<ValidatedSettings | null, string>> {
  const secretKeys = getSecretFieldKeys(provider.connection.fields);
  if (
    !(
      hasConfigChanges(provider, record, input.config) ||
      hasSecretChanges(input.secrets, secretKeys)
    )
  ) {
    return Result.ok(null);
  }
  const originError = checkCredentialOrigin({
    provider,
    storedConfig: toJsonObject(record.config),
    storedHints: parseCredentialHints(record.credentialHints),
    submittedConfig: input.config,
    submittedSecrets: input.secrets,
  });
  if (originError) {
    return Result.err(originError);
  }
  const stored = openCredentials(record.credentialsEncrypted);
  if (!stored.ok) {
    warnUnloadable(record, stored.error);
  }
  return await validateSettings(
    provider,
    {
      id: record.id,
      organizationId: record.organizationId,
      name: input.name ?? record.name,
    },
    input.config ?? toJsonObject(record.config),
    mergeSecrets(stored.ok ? stored.value : {}, input.secrets, secretKeys)
  );
}

/**
 * Compares submitted and stored config as parsed by the provider schema, so
 * re-sending the displayed (normalized) values is not a change. A config that
 * does not parse counts as a change and fails in validation.
 */
function hasConfigChanges(
  provider: AnyProvider,
  record: IntegrationConnectionRecord,
  submitted: Record<string, unknown> | undefined
): boolean {
  if (submitted === undefined) {
    return false;
  }
  const next = parseConnectionConfig(provider, submitted);
  const current = parseConnectionConfig(provider, toJsonObject(record.config));
  return !(
    next.ok &&
    current.ok &&
    isDeepStrictEqual(next.value, current.value)
  );
}

function buildUpdateData(
  record: IntegrationConnectionRecord,
  provider: AnyProvider,
  input: UpdateIntegrationConnectionInput,
  settings: ValidatedSettings | null
): Prisma.IntegrationConnectionUpdateInput {
  const now = new Date();
  const status = resolveNextStatus(record, input.status, settings !== null);
  const deliveryMode =
    input.deliveryMode ?? parseDeliveryMode(record.deliveryMode);
  const data: Prisma.IntegrationConnectionUpdateInput = {
    status,
    deliveryMode,
    name: input.name,
    pollIntervalSeconds: input.pollIntervalSeconds,
    ...pollScheduleChanges(record, {
      deliveryMode,
      status,
      pollIntervalSeconds: input.pollIntervalSeconds,
      now,
    }),
  };
  if (settings) {
    const secretKeys = getSecretFieldKeys(provider.connection.fields);
    Object.assign(data, toValidatedSettingsData(settings, secretKeys, now));
  }
  return data;
}

/**
 * An explicit status wins. A successful re-validation clears an error status
 * but never re-enables a disabled connection.
 */
function resolveNextStatus(
  record: IntegrationConnectionRecord,
  requested: UpdateIntegrationConnectionInput["status"],
  revalidated: boolean
): IntegrationConnectionStatus {
  const current = parseConnectionStatus(record.status);
  if (requested !== undefined) {
    return requested;
  }
  if (revalidated && current !== IntegrationConnectionStatus.Disabled) {
    return IntegrationConnectionStatus.Active;
  }
  return current;
}

/**
 * Entering poll mode polls right away from a fresh cursor (a stale cursor
 * would replay a backlog); re-enabling a polling connection polls right away;
 * a changed poll interval takes effect now; leaving poll mode unschedules it.
 */
function pollScheduleChanges(
  record: IntegrationConnectionRecord,
  next: PollScheduleInput
): Prisma.IntegrationConnectionUpdateInput {
  const wasPolling = record.deliveryMode === IntegrationDeliveryMode.Poll;
  if (next.deliveryMode !== IntegrationDeliveryMode.Poll) {
    return wasPolling ? { nextPollAt: null } : {};
  }
  if (!wasPolling) {
    return { nextPollAt: next.now, pollCursor: Prisma.DbNull };
  }
  const reEnabled =
    record.status === IntegrationConnectionStatus.Disabled &&
    next.status !== IntegrationConnectionStatus.Disabled;
  if (reEnabled) {
    return { nextPollAt: next.now };
  }
  return rescheduleForInterval(record, next);
}

/**
 * A new poll interval moves the next poll to at most one new interval from
 * now; a poll that is already due sooner keeps its time.
 */
function rescheduleForInterval(
  record: IntegrationConnectionRecord,
  next: PollScheduleInput
): Prisma.IntegrationConnectionUpdateInput {
  const interval = next.pollIntervalSeconds;
  if (interval === undefined || interval === record.pollIntervalSeconds) {
    return {};
  }
  const latest = new Date(next.now.getTime() + interval * 1000);
  const current = record.nextPollAt;
  return { nextPollAt: current && current < latest ? current : latest };
}

function toValidatedSettingsData(
  settings: ValidatedSettings,
  secretKeys: readonly string[],
  now: Date
) {
  return {
    config: settings.config,
    credentialsEncrypted: sealCredentials(settings.secrets),
    credentialHints: buildCredentialHints(settings.secrets, secretKeys),
    account: toAccountJson(settings.account),
    lastValidatedAt: now,
    lastError: null,
  };
}

function buildLoadedConnection(
  record: IntegrationConnectionRecord
): Result<LoadedConnection, string> {
  const provider = getIntegrationProvider(record.provider);
  if (!provider) {
    return Result.err(`Unknown integration provider "${record.provider}"`);
  }
  const config = parseConnectionConfig(provider, toJsonObject(record.config));
  if (!config.ok) {
    return Result.err(`Stored configuration is invalid. ${config.error}`);
  }
  const stored = openCredentials(record.credentialsEncrypted);
  if (!stored.ok) {
    return Result.err(`${stored.error}. Re-enter the connection secrets.`);
  }
  const secrets = parseConnectionSecrets(provider, stored.value);
  if (!secrets.ok) {
    return Result.err(`Stored credentials are incomplete. ${secrets.error}`);
  }
  return Result.ok({
    record,
    provider,
    runtime: {
      id: record.id,
      organizationId: record.organizationId,
      provider: record.provider,
      name: record.name,
      config: config.value,
      secrets: secrets.value,
      account: parseStoredAccount(record.account),
    },
  });
}

async function recordValidationFailure(
  record: IntegrationConnectionRecord,
  message: string
): Promise<void> {
  await withDb((db) =>
    db.integrationConnection.updateMany({
      where: { id: record.id, organizationId: record.organizationId },
      data: {
        status: keepDisabled(record, IntegrationConnectionStatus.Error),
        lastError: trimError(message),
      },
    })
  );
}

async function recordValidationSuccess(
  record: IntegrationConnectionRecord,
  account: IntegrationAccount | null
): Promise<void> {
  await withDb((db) =>
    db.integrationConnection.updateMany({
      where: { id: record.id, organizationId: record.organizationId },
      data: {
        status: keepDisabled(record, IntegrationConnectionStatus.Active),
        account: toAccountJson(account),
        lastValidatedAt: new Date(),
        lastError: null,
      },
    })
  );
}

function keepDisabled(
  record: IntegrationConnectionRecord,
  next: IntegrationConnectionStatus
): IntegrationConnectionStatus {
  return record.status === IntegrationConnectionStatus.Disabled
    ? IntegrationConnectionStatus.Disabled
    : next;
}

function toInboundDetails(
  record: IntegrationConnectionRecord,
  inboundSecret: string
): IntegrationInboundDetails {
  const provider = getIntegrationProvider(record.provider);
  const inboundUrl = buildInboundUrl(record.inboundKey);
  const config = provider
    ? parseConnectionConfig(provider, toJsonObject(record.config))
    : null;
  const setupInstructions = renderSetupInstructions(provider, {
    connection: {
      id: record.id,
      provider: record.provider,
      name: record.name,
      config: config?.ok ? config.value : toJsonObject(record.config),
      account: parseStoredAccount(record.account),
    },
    inboundSecret,
    inboundUrl,
    deliveryMode: parseDeliveryMode(record.deliveryMode),
  });
  return { inboundUrl, inboundSecret, setupInstructions };
}

function toConnectionDto(
  record: ConnectionRecordWithUsage,
  viewer: ConfigViewer
): IntegrationConnection {
  const deliveryMode = parseDeliveryMode(record.deliveryMode);
  return {
    managedByWorkflowId: record.managedByWorkflowId,
    id: record.id,
    provider: record.provider,
    name: record.name,
    status: parseConnectionStatus(record.status),
    config: toPublicConfig(record, viewer),
    secretFields: toSecretFieldStates(record),
    account: toAccountSummary(parseStoredAccount(record.account)),
    deliveryMode,
    pollIntervalSeconds: record.pollIntervalSeconds,
    inboundUrl:
      deliveryMode === IntegrationDeliveryMode.Webhook
        ? buildInboundUrl(record.inboundKey)
        : null,
    lastPolledAt: record.lastPolledAt,
    lastDeliveryAt: record.lastDeliveryAt,
    lastValidatedAt: record.lastValidatedAt,
    lastError: record.lastError,
    usageCount: countUsage(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Stored config never holds secrets; dropping secret keys is defense in
 * depth. Members who are not admins see url-kind fields as their origin.
 */
function toPublicConfig(
  record: IntegrationConnectionRecord,
  viewer: ConfigViewer
): JsonObject {
  const config = toJsonObject(record.config);
  const provider = getIntegrationProvider(record.provider);
  if (!provider) {
    return redactUrlFields(config, null, viewer);
  }
  const secretKeys = new Set(getSecretFieldKeys(provider.connection.fields));
  const publicConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => !secretKeys.has(key))
  );
  return redactUrlFields(publicConfig, provider.connection.fields, viewer);
}

function toSecretFieldStates(
  record: IntegrationConnectionRecord
): Record<string, IntegrationSecretFieldState> {
  const hints = parseCredentialHints(record.credentialHints);
  const provider = getIntegrationProvider(record.provider);
  const keys = provider
    ? getSecretFieldKeys(provider.connection.fields)
    : Object.keys(hints);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        isSet: Object.hasOwn(hints, key),
        lastFour: hints[key] ?? null,
      },
    ])
  );
}

function toDeliveryDto(record: IntegrationDeliveryRecord): IntegrationDelivery {
  return {
    id: record.id,
    deliveryId: record.deliveryId,
    source: parseDeliverySource(record.source),
    eventType: record.eventType,
    outcome: parseDeliveryOutcome(record.outcome),
    detail: record.detail,
    runCount: record.runCount,
    receivedAt: record.receivedAt,
  };
}

function countUsage(record: ConnectionRecordWithUsage): number {
  return (
    record._count.triggers +
    record._count.actions +
    record._count.projectRepositories
  );
}

function createProviderLogger(
  runtime: ConnectionRuntime,
  logPrefix: string
): ProviderLogger {
  const secretValues = collectSecretValues(runtime.secrets);
  const emit =
    (write: (message: string, meta?: Record<string, unknown>) => void) =>
    (message: string, meta?: Record<string, unknown>) => {
      write(`${logPrefix} ${scrubSecretValues(message, secretValues)}`, {
        connectionId: runtime.id,
        organizationId: runtime.organizationId,
        provider: runtime.provider,
        ...scrubLogMeta(meta ?? {}, secretValues),
      });
    };
  return {
    info: emit(log.info),
    warn: emit(log.warn),
    error: emit(log.error),
  };
}

function warnUnloadable(record: IntegrationConnectionRecord, reason: string) {
  log.warn(`${LOG_PREFIX} Connection runtime unavailable`, {
    organizationId: record.organizationId,
    connectionId: record.id,
    provider: record.provider,
    reason,
  });
}

function toAccountJson(
  account: IntegrationAccount | null
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return account ?? Prisma.DbNull;
}

function toNullableJson(
  value: JsonValue
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

function trimError(message: string): string {
  return message.length > LAST_ERROR_MAX_LENGTH
    ? `${message.slice(0, LAST_ERROR_MAX_LENGTH - 1)}…`
    : message;
}

function clampDeliveriesLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DELIVERIES_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(limit)), DELIVERIES_MAX_LIMIT);
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  return (
    values.find((value) => value !== undefined && value.trim() !== "") ?? null
  );
}

function badRequest<T>(message: string): Result<T, ConnectionServiceError> {
  return Result.err({ status: Status.BadRequest, message });
}

function notFound<T>(): Result<T, ConnectionServiceError> {
  return Result.err({
    status: Status.NotFound,
    message: "Integration connection not found",
  });
}

function inUse<T>(
  usageCount: number | null
): Result<T, ConnectionServiceError> {
  const usage =
    usageCount === null
      ? "workflow triggers, actions or project repositories"
      : `${usageCount} workflow trigger(s), action(s) or project repositories`;
  return Result.err({
    status: Status.Conflict,
    message: `The connection is used by ${usage}. Remove them from their workflows and projects first.`,
  });
}
