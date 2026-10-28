import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import { TERMINAL_LOOP_STATUSES } from "@/app/loops/validators";
import {
  listDocumentRepositoryCheckouts,
  type ProjectRepositoryCheckout,
} from "@/app/projects/project-repository-checkouts";
import { loadRepositoryConnection } from "@/lib/integrations/repositories";
import type { GitCredential, RepositoryInfo } from "@/lib/integrations/types";

/**
 * Git credentials for a running loop's project repositories.
 *
 * A computer clones and pushes a project repository over HTTPS with a git
 * credential helper that posts git's own credential description (protocol,
 * host and, with `credential.useHttpPath`, path) to
 * `POST /loops/:id/git-credential` with the loop's runner token. The
 * credential comes from the repository's integration connection and is only
 * issued for the repositories of that loop while the loop is running, so no
 * repository token is stored on the computer.
 */

const LOG_PREFIX = "[loop-git-credential]";
const TRAILING_GIT_RE = /\.git$/i;
const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;
const CREDENTIAL_LINE_RE = /^([a-z_]+)=(.*)$/;

export type GitCredentialRequest = {
  protocol: string;
  host: string;
  /** Repository path without a leading slash; null when git did not send it. */
  path: string | null;
};

export type GitCredentialError = { status: StatusCode; message: string };

/** Parses git's credential description (`key=value` lines). */
export function parseGitCredentialRequest(
  text: string
): GitCredentialRequest | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = CREDENTIAL_LINE_RE.exec(line.trim());
    if (match) {
      fields.set(match[1], match[2]);
    }
  }
  const protocol = fields.get("protocol");
  const host = fields.get("host");
  if (!(protocol && host)) {
    return null;
  }
  return { protocol, host, path: fields.get("path") || null };
}

/** The credential in git's format; secrets never reach a log line. */
export function formatGitCredential(credential: GitCredential): string {
  const lines = [
    `username=${credential.username}`,
    `password=${credential.password}`,
  ];
  if (credential.expiresAt) {
    lines.push(
      `password_expiry_utc=${Math.floor(credential.expiresAt.getTime() / 1000)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function issueLoopGitCredential(input: {
  loopId: string;
  organizationId: string;
  request: GitCredentialRequest;
}): Promise<Result<GitCredential, GitCredentialError>> {
  const loop = await loopsService.findById(input.loopId, input.organizationId);
  if (!loop) {
    return failure(Status.NotFound, "Loop not found");
  }
  if (TERMINAL_LOOP_STATUSES.has(loop.status)) {
    return failure(Status.Conflict, "The loop has finished");
  }
  const loopRepositories = new Set(
    [
      loop.repo?.fullName,
      ...(loop.additionalRepos ?? []).map((r) => r.fullName),
    ]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase())
  );
  const checkouts = await listDocumentRepositoryCheckouts(
    input.organizationId,
    loop.documentId
  );
  const repository = checkouts.find(
    (checkout) =>
      loopRepositories.has(checkout.fullName.toLowerCase()) &&
      matchesGitCredentialRequest(checkout.cloneUrl, input.request)
  );
  if (!repository) {
    return failure(
      Status.NotFound,
      "No repository of this loop matches the request"
    );
  }
  return issueRepositoryGitCredential({
    organizationId: input.organizationId,
    repository,
    logContext: { loopId: input.loopId },
  });
}

/** Same scheme and host; same repository path when git sent one. */
export function matchesGitCredentialRequest(
  cloneUrl: string,
  request: GitCredentialRequest
): boolean {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== `${request.protocol.toLowerCase()}:` ||
    url.host.toLowerCase() !== request.host.toLowerCase()
  ) {
    return false;
  }
  return (
    request.path === null ||
    normalizePath(url.pathname) === normalizePath(request.path)
  );
}

function normalizePath(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the raw path; it then only matches an identical one.
  }
  return decoded
    .replace(LEADING_SLASHES_RE, "")
    .replace(TRAILING_SLASHES_RE, "")
    .replace(TRAILING_GIT_RE, "")
    .toLowerCase();
}

function toRepositoryInfo(checkout: ProjectRepositoryCheckout): RepositoryInfo {
  const separator = checkout.fullName.lastIndexOf("/");
  return {
    externalId: checkout.externalId,
    fullName: checkout.fullName,
    name: checkout.name,
    namespace: separator > 0 ? checkout.fullName.slice(0, separator) : "",
    defaultBranch: checkout.defaultBranch,
    webUrl: checkout.webUrl,
    isPrivate: true,
    cloneUrl: checkout.cloneUrl,
  };
}

function failure<T>(
  status: StatusCode,
  message: string
): Result<T, GitCredentialError> {
  return Result.err({ status, message });
}

/** Issues a git credential for one project repository from its connection. */
export async function issueRepositoryGitCredential(input: {
  organizationId: string;
  repository: ProjectRepositoryCheckout;
  logContext: Record<string, string>;
}): Promise<Result<GitCredential, GitCredentialError>> {
  const connection = await loadRepositoryConnection(
    input.organizationId,
    input.repository.connectionId
  );
  if (!connection.ok) {
    return Result.err(connection.error);
  }
  try {
    return Result.ok(
      await connection.value.repositories.gitCredential(
        connection.value.context,
        toRepositoryInfo(input.repository)
      )
    );
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not issue a git credential`, {
      ...input.logContext,
      repository: input.repository.fullName,
      error: parseError(error),
    });
    return failure(Status.BadGateway, "Could not issue a git credential");
  }
}
