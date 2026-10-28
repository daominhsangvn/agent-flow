import { z } from "zod";
import {
  HttpMethod,
  type IntegrationPullRequestsDefinition,
  type PullRequestComment,
  PullRequestState,
  type PullRequestThread,
  PullRequestThreadStatus,
  type RepositoryInfo,
} from "../../types";
import { ADO_API_VERSION, AdoErrorKind, adoRequest } from "./client";
import {
  operationError,
  operationOk,
  pullRequestsPath,
} from "./repository-operations";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  type AdoThread,
  adoCreatedThreadCommentSchema,
  adoPullRequestDetailSchema,
  adoThreadListSchema,
  adoThreadSchema,
} from "./schemas";

/**
 * Review threads of Azure Repos pull requests for the agents of a process
 * (docs/workflows.md "Pull request review tools"). Threads are Azure
 * DevOps's own; the ones of the system (votes, pushes, status changes) are
 * left out. A thread is open while active or pending; resolving sets it to
 * fixed. Needs the Code (Read & write) scope.
 */

/** The first comment of a thread: replies go below it. */
const THREAD_ROOT_COMMENT_ID = 1;
/** Comment type of a person's comment in a new comment (1 = text). */
const TEXT_COMMENT_TYPE = 1;
const SYSTEM_COMMENT_TYPE = "system";
const FIXED_STATUS = "fixed";
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "pending",
  "unknown",
]);
const THREAD_ID_RE = /^\d+$/;

export const adoPullRequests: IntegrationPullRequestsDefinition<
  AdoConnectionConfig,
  AdoSecrets
> = {
  async get(ctx, repository, number) {
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: pullRequestPath(repository, number),
        query: { "api-version": ADO_API_VERSION },
      },
      adoPullRequestDetailSchema
    );
    if (!result.ok) {
      return operationError(result.error);
    }
    return operationOk({
      state: toState(result.value.status),
      title: result.value.title ?? null,
      url: `${repository.webUrl}/pullrequest/${number}`,
    });
  },

  async listThreads(ctx, repository, number) {
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: `${pullRequestPath(repository, number)}/threads`,
        query: { "api-version": ADO_API_VERSION },
      },
      adoThreadListSchema
    );
    if (!result.ok) {
      return operationError(result.error);
    }
    return operationOk(
      result.value.value.flatMap((value) => {
        const thread = adoThreadSchema.safeParse(value);
        const mapped = thread.success ? toThread(thread.data) : null;
        return mapped ? [mapped] : [];
      })
    );
  },

  async reply(ctx, repository, number, threadId, markdown) {
    if (!THREAD_ID_RE.test(threadId)) {
      return unknownThread(threadId);
    }
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: `${pullRequestPath(repository, number)}/threads/${threadId}/comments`,
        query: { "api-version": ADO_API_VERSION },
        body: {
          content: markdown,
          parentCommentId: THREAD_ROOT_COMMENT_ID,
          commentType: TEXT_COMMENT_TYPE,
        },
      },
      adoCreatedThreadCommentSchema
    );
    return result.ok
      ? operationOk({ commentId: `${threadId}:${result.value.id}` })
      : operationError(result.error);
  },

  async resolve(ctx, repository, number, threadId) {
    if (!THREAD_ID_RE.test(threadId)) {
      return unknownThread(threadId);
    }
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Patch,
        path: `${pullRequestPath(repository, number)}/threads/${threadId}`,
        query: { "api-version": ADO_API_VERSION },
        body: { status: FIXED_STATUS },
      },
      z.unknown()
    );
    return result.ok ? operationOk(null) : operationError(result.error);
  },
};

function pullRequestPath(repository: RepositoryInfo, number: number): string {
  return `${pullRequestsPath(repository)}/${number}`;
}

function toState(status: string | null | undefined): PullRequestState {
  switch (status) {
    case "completed":
      return PullRequestState.Merged;
    case "abandoned":
      return PullRequestState.Declined;
    default:
      return PullRequestState.Open;
  }
}

/** A person's thread with its comments; null for a system or deleted one. */
function toThread(thread: AdoThread): PullRequestThread | null {
  const comments = (thread.comments ?? []).filter(
    (comment) =>
      !comment.isDeleted && comment.commentType !== SYSTEM_COMMENT_TYPE
  );
  if (thread.isDeleted || comments.length === 0) {
    return null;
  }
  const context = thread.threadContext;
  return {
    id: String(thread.id),
    status:
      !thread.status || OPEN_STATUSES.has(thread.status)
        ? PullRequestThreadStatus.Open
        : PullRequestThreadStatus.Resolved,
    file: context?.filePath
      ? {
          path: context.filePath,
          line:
            context.rightFileStart?.line ?? context.leftFileStart?.line ?? null,
        }
      : null,
    comments: comments.map(
      (comment): PullRequestComment => ({
        id: `${thread.id}:${comment.id}`,
        authorId: comment.author?.id ?? null,
        author: comment.author?.displayName ?? null,
        createdAt: comment.publishedDate ?? null,
        bodyMarkdown: comment.content ?? "",
      })
    ),
  };
}

function unknownThread<T>(threadId: string) {
  return operationError<T>({
    kind: AdoErrorKind.InvalidResponse,
    status: 400,
    message: `"${threadId}" is not a thread of this pull request`,
    retryable: false,
  });
}
