import type { JsonObject } from "@repo/api/src/types/common";
import { PullRequestOperation } from "@repo/api/src/types/connection-grants";
import {
  IntegrationToolCallStatus,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { withDb } from "@repo/database";
import {
  type PlannedToolCall,
  PullRequestThreadFilter,
  type RunPullRequestRef,
} from "@/lib/integrations/agent-tools/catalog";
import {
  createProviderContext,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import { getIntegrationProvider } from "@/lib/integrations/registry";
import {
  type IntegrationPullRequestsDefinition,
  type ProviderContext,
  type PullRequestThread,
  PullRequestThreadStatus,
  type RepositoryInfo,
} from "@/lib/integrations/types";
import { scrubProviderError } from "@/lib/workflows/engine/errors";
import type { ExecutionOutcome } from "./execute";
import type { ToolSessionContext } from "./session-context";

/**
 * Carries out the pull_request_* tools (docs/workflows.md "Pull request
 * review tools") on the run's own pull requests, through the connection of
 * each one's repository, whatever its provider. A comment is the agent's own
 * (`mine`) when the connection's account wrote it, or when this run's
 * pull_request_reply recorded it (an access token has no account).
 */

const LOG_PREFIX = "[integration-tools/pull-requests]";
const COMMENT_BODY_MAX = 10_000;

export async function listRunPullRequests(
  context: ToolSessionContext
): Promise<ExecutionOutcome> {
  const pullRequests: JsonObject[] = [];
  for (const pullRequest of context.input.pullRequests) {
    const opened = await openPullRequest(context, pullRequest);
    const read = opened.ok
      ? await opened.value.pullRequests.get(
          opened.value.ctx,
          opened.value.repository,
          pullRequest.number
        )
      : null;
    pullRequests.push({
      url: pullRequest.url,
      number: pullRequest.number,
      repository: pullRequest.repository,
      state: read?.ok ? read.value.state : null,
      title: read?.ok ? read.value.title : null,
      ...(read && !read.ok ? { error: read.error } : {}),
      ...(opened.ok ? {} : { error: opened.error.error }),
    });
  }
  return { ok: true, output: { pullRequests }, externalRef: null };
}

export async function readPullRequestThreads(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "pull_request_threads" }>
): Promise<ExecutionOutcome> {
  const opened = await openPullRequest(context, plan.pullRequest);
  if (!opened.ok) {
    return opened.error;
  }
  const { pullRequests, ctx, repository, accountId, secrets } = opened.value;
  const [state, threads] = await Promise.all([
    pullRequests.get(ctx, repository, plan.pullRequest.number),
    pullRequests.listThreads(ctx, repository, plan.pullRequest.number),
  ]);
  if (!threads.ok) {
    return {
      ok: false,
      error: scrubProviderError(threads.error, secrets),
      retryable: threads.retryable,
    };
  }
  const mine = await recordedReplies(context.session.runId);
  const shown = threads.value.filter(
    (thread) =>
      plan.status === PullRequestThreadFilter.All ||
      thread.status === PullRequestThreadStatus.Open
  );
  return {
    ok: true,
    output: {
      pullRequest: plan.pullRequest.url,
      state: state.ok ? state.value.state : null,
      threads: shown.map((thread) => toThreadOutput(thread, accountId, mine)),
    },
    externalRef: null,
  };
}

export async function executePullRequestWrite(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "pull_request_write" }>
): Promise<ExecutionOutcome> {
  const opened = await openPullRequest(context, plan.pullRequest);
  if (!opened.ok) {
    return opened.error;
  }
  const { pullRequests, ctx, repository, secrets } = opened.value;
  const { number } = plan.pullRequest;
  if (plan.operation === PullRequestOperation.Reply) {
    const replied = await pullRequests.reply(
      ctx,
      repository,
      number,
      plan.threadId,
      plan.body ?? ""
    );
    return replied.ok
      ? {
          ok: true,
          output: { done: true, reference: replied.value.commentId },
          externalRef: replied.value.commentId,
        }
      : {
          ok: false,
          error: scrubProviderError(replied.error, secrets),
          retryable: replied.retryable,
        };
  }
  const resolved = await pullRequests.resolve(
    ctx,
    repository,
    number,
    plan.threadId
  );
  const reference = `${plan.pullRequest.url}#thread-${plan.threadId}`;
  return resolved.ok
    ? { ok: true, output: { done: true, reference }, externalRef: reference }
    : {
        ok: false,
        error: scrubProviderError(resolved.error, secrets),
        retryable: resolved.retryable,
      };
}

type OpenedPullRequest = {
  pullRequests: IntegrationPullRequestsDefinition<unknown, unknown>;
  ctx: ProviderContext<unknown, unknown>;
  repository: RepositoryInfo;
  /** The connection's account id at the provider, to tell its comments. */
  accountId: string | null;
  secrets: JsonObject;
};

/** The pull request's repository through its connection, or why it cannot be used. */
async function openPullRequest(
  context: ToolSessionContext,
  pullRequest: RunPullRequestRef
): Promise<
  | { ok: true; value: OpenedPullRequest }
  | { ok: false; error: Extract<ExecutionOutcome, { ok: false }> }
> {
  const fail = (error: string, retryable = false) => ({
    ok: false as const,
    error: { ok: false as const, error, retryable },
  });
  const repository = context.snapshot.repositories.find(
    (candidate) => candidate.pullRequest?.url === pullRequest.url
  );
  if (!repository) {
    return fail(`${pullRequest.url} is not a pull request of this run.`);
  }
  const definition = getIntegrationProvider(repository.provider)?.repositories;
  if (!definition?.pullRequests) {
    return fail(
      `Pull request review threads are not supported for ${repository.provider} yet.`
    );
  }
  const loaded = await loadConnectionRuntime(
    context.session.organizationId,
    repository.connectionId
  );
  if (!loaded) {
    return fail(
      `The connection of ${repository.fullName} cannot be used right now (it was removed or its credentials no longer work).`
    );
  }
  const ctx = createProviderContext(loaded.runtime, LOG_PREFIX);
  let info: RepositoryInfo | null;
  try {
    info = await definition.get(ctx, repository.externalId);
  } catch (error) {
    return fail(scrubProviderError(error, loaded.runtime.secrets), true);
  }
  if (!info) {
    return fail(
      `${repository.fullName} no longer exists or its connection cannot access it.`
    );
  }
  return {
    ok: true,
    value: {
      pullRequests: definition.pullRequests,
      ctx,
      repository: info,
      accountId: loaded.runtime.account?.externalAccountId ?? null,
      secrets: loaded.runtime.secrets,
    },
  };
}

/** The comment ids this run's replies created. */
async function recordedReplies(runId: string): Promise<ReadonlySet<string>> {
  const calls = await withDb((db) =>
    db.integrationToolCall.findMany({
      where: {
        runId,
        tool: IntegrationToolName.PullRequestReply,
        status: IntegrationToolCallStatus.Succeeded,
      },
      select: { externalRef: true },
    })
  );
  return new Set(
    calls.flatMap((call) => (call.externalRef ? [call.externalRef] : []))
  );
}

function toThreadOutput(
  thread: PullRequestThread,
  accountId: string | null,
  mine: ReadonlySet<string>
): JsonObject {
  return {
    id: thread.id,
    status: thread.status,
    file: thread.file
      ? { path: thread.file.path, line: thread.file.line }
      : null,
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      mine:
        mine.has(comment.id) ||
        (accountId !== null && comment.authorId === accountId),
      createdAt: comment.createdAt,
      body: comment.bodyMarkdown.slice(0, COMMENT_BODY_MAX),
    })),
  };
}
