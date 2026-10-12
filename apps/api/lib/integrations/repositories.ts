import type { JsonObject } from "@repo/api/src/types/common";
import {
  type createIntegrationRepositoryInputSchema,
  IntegrationConnectionStatus,
  type IntegrationRepository,
} from "@repo/api/src/types/integration";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import type { z } from "zod";
import {
  createProviderContext,
  type LoadedConnection,
  loadConnectionRuntime,
} from "./connection-service";
import type {
  IntegrationRepositoriesDefinition,
  ProviderContext,
  RepositoryInfo,
} from "./types";

/**
 * Repository access through integration connections. Projects add
 * repositories from any connection whose provider declares `repositories`;
 * the connection's credentials are used here and never leave the API.
 */

const LOG_PREFIX = "[integration-repositories]";

export type RepositoryAccessError = { status: StatusCode; message: string };

/** Validated body of POST /integrations/connections/{id}/repositories. */
export type CreateIntegrationRepositoryParsed = z.output<
  typeof createIntegrationRepositoryInputSchema
>;

/** A loaded connection whose provider offers repositories. */
export type RepositoryConnection = {
  loaded: LoadedConnection;
  repositories: IntegrationRepositoriesDefinition<JsonObject, JsonObject>;
  context: ProviderContext;
};

/**
 * Loads a connection for repository operations: it must exist in the
 * organization, not be disabled, and its provider must offer repositories.
 */
export async function loadRepositoryConnection(
  organizationId: string,
  connectionId: string
): Promise<Result<RepositoryConnection, RepositoryAccessError>> {
  const loaded = await loadConnectionRuntime(organizationId, connectionId);
  if (!loaded) {
    return accessError(Status.NotFound, "Integration connection not found");
  }
  if (loaded.record.status === IntegrationConnectionStatus.Disabled) {
    return accessError(
      Status.Conflict,
      `The connection "${loaded.record.name}" is disabled. Enable it first.`
    );
  }
  const repositories = loaded.provider.repositories;
  if (!repositories) {
    return accessError(
      Status.BadRequest,
      `${loaded.provider.displayName} connections do not offer repositories`
    );
  }
  return Result.ok({
    loaded,
    repositories,
    context: createProviderContext(loaded.runtime, LOG_PREFIX),
  });
}

/** Repositories the connection can access, for the "add repository" picker. */
export async function listConnectionRepositories(
  organizationId: string,
  connectionId: string,
  options: { query: string | null; limit: number }
): Promise<Result<IntegrationRepository[], RepositoryAccessError>> {
  const connection = await loadRepositoryConnection(
    organizationId,
    connectionId
  );
  if (!connection.ok) {
    return connection;
  }
  try {
    const found = await connection.value.repositories.list(
      connection.value.context,
      options
    );
    return Result.ok(found.slice(0, options.limit).map(toPublicRepository));
  } catch (error) {
    return providerFailure(connection.value, "list repositories", error);
  }
}

/**
 * Creates a repository through a connection whose provider hosts
 * repositories itself (Local Git). The answer is the new repository, ready to
 * be added to a project.
 */
export async function createConnectionRepository(
  organizationId: string,
  connectionId: string,
  input: CreateIntegrationRepositoryParsed
): Promise<Result<IntegrationRepository, RepositoryAccessError>> {
  const connection = await loadRepositoryConnection(
    organizationId,
    connectionId
  );
  if (!connection.ok) {
    return connection;
  }
  const { create } = connection.value.repositories;
  if (!create) {
    return accessError(
      Status.BadRequest,
      `${connection.value.loaded.provider.displayName} connections cannot create repositories. Create it there and add it here.`
    );
  }
  try {
    const created = await create(connection.value.context, {
      name: input.name,
      description: input.description,
      isPrivate: input.private,
    });
    if (!created.ok) {
      return accessError(
        created.retryable ? Status.BadGateway : Status.Conflict,
        created.error
      );
    }
    log.info(`${LOG_PREFIX} Created a repository`, {
      connectionId,
      provider: connection.value.loaded.record.provider,
      repository: created.value.fullName,
    });
    return Result.ok(toPublicRepository(created.value));
  } catch (error) {
    return providerFailure(connection.value, "create the repository", error);
  }
}

/** One repository by its provider id, as the connection currently sees it. */
export async function getConnectionRepository(
  connection: RepositoryConnection,
  externalId: string
): Promise<Result<RepositoryInfo, RepositoryAccessError>> {
  try {
    const repository = await connection.repositories.get(
      connection.context,
      externalId
    );
    if (!repository) {
      return accessError(
        Status.NotFound,
        `Repository not found, or "${connection.loaded.record.name}" cannot access it`
      );
    }
    return Result.ok(repository);
  } catch (error) {
    return providerFailure(connection, "read the repository", error);
  }
}

function toPublicRepository(repository: RepositoryInfo): IntegrationRepository {
  return {
    externalId: repository.externalId,
    fullName: repository.fullName,
    name: repository.name,
    namespace: repository.namespace,
    defaultBranch: repository.defaultBranch,
    webUrl: repository.webUrl,
    isPrivate: repository.isPrivate,
  };
}

function providerFailure<T>(
  connection: RepositoryConnection,
  operation: string,
  error: unknown
): Result<T, RepositoryAccessError> {
  const detail = error instanceof Error ? error.message : String(error);
  log.warn(`${LOG_PREFIX} Could not ${operation}`, {
    connectionId: connection.loaded.record.id,
    provider: connection.loaded.record.provider,
    error: detail,
  });
  return accessError(
    Status.BadGateway,
    `${connection.loaded.provider.displayName} could not ${operation}: ${detail}`
  );
}

function accessError<T>(
  status: StatusCode,
  message: string
): Result<T, RepositoryAccessError> {
  return Result.err({ status, message });
}
