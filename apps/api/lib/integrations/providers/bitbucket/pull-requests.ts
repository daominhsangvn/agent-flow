import type { Result } from "@repo/api/src/types/result";
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
import {
  type BitbucketContext,
  type BitbucketError,
  BitbucketErrorKind,
  bitbucketRequest,
  operationError,
  operationOk,
  repositoryPath,
} from "./client";
import {
  type BitbucketComment,
  type BitbucketConnectionConfig,
  type BitbucketPage,
  type BitbucketSecrets,
  bitbucketCommentSchema,
  bitbucketCreatedCommentSchema,
  bitbucketPageSchema,
  bitbucketPullRequestDetailSchema,
} from "./schemas";

/**
 * Review threads of Bitbucket Cloud pull requests for the agents of a
 * process (docs/workflows.md "Pull request review tools"). Bitbucket has no
 * thread object: a thread is a root comment and the replies below it, and
 * its id is the root's. A resolved thread carries `resolution` on its root.
 */

const COMMENTS_PAGE_SIZE = 100;
/** Bounds the comments read at 10 pages (1000 comments). */
const COMMENTS_PAGES_MAX = 10;

export const bitbucketPullRequests: IntegrationPullRequestsDefinition<
  BitbucketConnectionConfig,
  BitbucketSecrets
> = {
  async get(ctx, repository, number) {
    const result = await bitbucketRequest(
      ctx,
      { method: HttpMethod.Get, path: pullRequestPath(repository, number) },
      bitbucketPullRequestDetailSchema
    );
    if (!result.ok) {
      return operationError(result.error);
    }
    return operationOk({
      state: toState(result.value.state),
      title: result.value.title ?? null,
      url: result.value.links.html.href,
    });
  },

  async listThreads(ctx, repository, number) {
    const comments: BitbucketComment[] = [];
    let path: string | null = `${pullRequestPath(repository, number)}/comments`;
    for (let page = 0; path && page < COMMENTS_PAGES_MAX; page++) {
      const result: Result<BitbucketPage, BitbucketError> =
        await bitbucketRequest(
          ctx,
          {
            method: HttpMethod.Get,
            path,
            query: page === 0 ? { pagelen: COMMENTS_PAGE_SIZE } : undefined,
          },
          bitbucketPageSchema
        );
      if (!result.ok) {
        return operationError(result.error);
      }
      for (const value of result.value.values) {
        const comment = bitbucketCommentSchema.safeParse(value);
        if (comment.success) {
          comments.push(comment.data);
        }
      }
      path = result.value.next ?? null;
    }
    return operationOk(toThreads(comments));
  },

  async reply(ctx, repository, number, threadId, markdown) {
    const parent = toCommentId(threadId);
    if (parent === null) {
      return unknownThread(threadId);
    }
    const result = await bitbucketRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: `${pullRequestPath(repository, number)}/comments`,
        body: { content: { raw: markdown }, parent: { id: parent } },
      },
      bitbucketCreatedCommentSchema
    );
    return result.ok
      ? operationOk({ commentId: String(result.value.id) })
      : operationError(result.error);
  },

  async resolve(ctx, repository, number, threadId) {
    const root = toCommentId(threadId);
    if (root === null) {
      return unknownThread(threadId);
    }
    const result = await resolveComment(ctx, repository, number, root);
    // 409: the thread is resolved already.
    if (result.ok || result.error.status === CONFLICT) {
      return operationOk(null);
    }
    return operationError(result.error);
  },
};

const CONFLICT = 409;
const COMMENT_ID_RE = /^\d+$/;

function resolveComment(
  ctx: BitbucketContext,
  repository: RepositoryInfo,
  number: number,
  commentId: number
) {
  return bitbucketRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: `${pullRequestPath(repository, number)}/comments/${commentId}/resolve`,
    },
    z.unknown()
  );
}

function pullRequestPath(repository: RepositoryInfo, number: number): string {
  return `${repositoryPath(repository)}/pullrequests/${number}`;
}

function toState(state: string): PullRequestState {
  switch (state.toUpperCase()) {
    case "OPEN":
      return PullRequestState.Open;
    case "MERGED":
      return PullRequestState.Merged;
    default:
      return PullRequestState.Declined;
  }
}

/**
 * Root comments with every reply below them (a reply of a reply belongs to
 * the same root), oldest first; deleted comments are left out.
 */
function toThreads(comments: readonly BitbucketComment[]): PullRequestThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: BitbucketComment): BitbucketComment => {
    let current = comment;
    const seen = new Set<number>();
    while (current.parent && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parent.id);
      if (!parent) {
        break;
      }
      current = parent;
    }
    return current;
  };
  const threads = new Map<number, PullRequestThread>();
  for (const comment of [...comments].sort(byCreation)) {
    const root = rootOf(comment);
    if (root.deleted) {
      continue;
    }
    const thread = threads.get(root.id) ?? newThread(root);
    threads.set(root.id, thread);
    if (!comment.deleted) {
      thread.comments.push(toComment(comment));
    }
  }
  return [...threads.values()];
}

function newThread(root: BitbucketComment): PullRequestThread {
  return {
    id: String(root.id),
    status: root.resolution
      ? PullRequestThreadStatus.Resolved
      : PullRequestThreadStatus.Open,
    file: root.inline
      ? {
          path: root.inline.path,
          line: root.inline.to ?? root.inline.from ?? null,
        }
      : null,
    comments: [],
  };
}

function toComment(comment: BitbucketComment): PullRequestComment {
  return {
    id: String(comment.id),
    authorId: comment.user?.uuid ?? null,
    author: comment.user?.display_name ?? null,
    createdAt: comment.created_on ?? null,
    bodyMarkdown: comment.content?.raw ?? "",
  };
}

function byCreation(a: BitbucketComment, b: BitbucketComment): number {
  return (a.created_on ?? "").localeCompare(b.created_on ?? "") || a.id - b.id;
}

function toCommentId(threadId: string): number | null {
  return COMMENT_ID_RE.test(threadId) ? Number(threadId) : null;
}

function unknownThread<T>(threadId: string) {
  return operationError<T>({
    kind: BitbucketErrorKind.Validation,
    status: 400,
    message: `"${threadId}" is not a thread of this pull request`,
    retryable: false,
  });
}
