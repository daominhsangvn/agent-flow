import type { RepositoryInfo, RepositoryOperationResult } from "../../types";
import { type AdoError, AdoErrorKind, projectSegment } from "./client";

/**
 * What the repository operations of Azure Repos share (repositories.ts,
 * pull-requests.ts): the pull request path of a repository and the result
 * of an operation, whose permission failures name the scope to add.
 */

const CODE_SCOPE_HINT =
  "Grant the personal access token the Code (Read & write) scope.";

/** The project from the namespace "organization/project". */
export function pullRequestsPath(repository: RepositoryInfo): string {
  const project = repository.namespace.slice(
    repository.namespace.indexOf("/") + 1
  );
  return `${projectSegment(project)}/_apis/git/repositories/${repository.externalId}/pullrequests`;
}

export function repositoryErrorMessage(error: AdoError): string {
  if (
    error.kind === AdoErrorKind.Unauthorized ||
    error.kind === AdoErrorKind.Forbidden
  ) {
    return `${error.message}. ${CODE_SCOPE_HINT}`;
  }
  return error.message;
}

export function operationError<T>(
  error: AdoError
): RepositoryOperationResult<T> {
  return {
    ok: false,
    error: repositoryErrorMessage(error),
    retryable: error.retryable,
  };
}

export function operationOk<T>(value: T): RepositoryOperationResult<T> {
  return { ok: true, value };
}
