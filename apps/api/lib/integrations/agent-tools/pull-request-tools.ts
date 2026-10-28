import type { JsonObject } from "@repo/api/src/types/common";
import {
  type NormalizedConnectionGrant,
  PULL_REQUESTS_CONNECTION_KEY,
  PullRequestOperation,
} from "@repo/api/src/types/connection-grants";
import {
  IntegrationToolAccess,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import {
  type AgentTool,
  type AgentToolSessionInput,
  APPROVAL_NOTE,
  cap,
  PullRequestThreadFilter,
  READ_ANNOTATIONS,
  type RunPullRequestRef,
  WRITE_ANNOTATIONS,
} from "./catalog";
import {
  describeProperties,
  objectSchema,
  type ToolProperty,
} from "./field-schema";

/**
 * The pull_request_* tools (docs/workflows.md "Pull request review tools"):
 * an agent granted `pull_requests` reads the review threads of the run's own
 * pull requests and, when granted, replies to and resolves them. Like the
 * source item tools, they take no connection: a pull request is named by its
 * URL from an enum of exactly the run's pull requests, so a link in a review
 * comment can never point them at another one. The repository's connection
 * carries them out, whatever its provider (Bitbucket, Azure DevOps).
 */

export const PULL_REQUEST_REPLY_MAX = 30_000;
const THREAD_ID_MAX = 64;

export function pullRequestTools(input: AgentToolSessionInput): AgentTool[] {
  const grant = input.grants.find(
    (candidate) => candidate.key === PULL_REQUESTS_CONNECTION_KEY
  );
  if (!grant) {
    return [];
  }
  const tools = [listTool(input)];
  if (input.pullRequests.length === 0) {
    return tools;
  }
  tools.push(threadsTool(input));
  if (grant.allow.includes(PullRequestOperation.Reply)) {
    tools.push(replyTool(input, grant));
  }
  if (grant.allow.includes(PullRequestOperation.Resolve)) {
    tools.push(resolveTool(input, grant));
  }
  return tools;
}

function listTool(input: AgentToolSessionInput): AgentTool {
  return {
    name: IntegrationToolName.PullRequestsList,
    title: "List the run's pull requests",
    description: cap([
      "List the pull requests this run opened, with their repository and state (open, merged or declined).",
      "Use when: you need the pull requests to read their review threads, e.g. to address a code review.",
      `Do not use for: any other pull request; the tools here only act on these. Read a pull request's threads with ${IntegrationToolName.PullRequestThreads}.`,
      input.pullRequests.length === 0
        ? "This run has opened no pull request yet, so the other pull request tools are not available."
        : `This run: ${input.pullRequests.map(describePullRequest).join("; ")}.`,
      "Input: none.",
      "Returns: the pull requests as JSON (url, number, repository, state, title).",
    ]),
    inputSchema: objectSchema([]),
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: () => Result.ok({ kind: "pull_requests" }),
  };
}

function threadsTool(input: AgentToolSessionInput): AgentTool {
  const properties: ToolProperty[] = [
    pullRequestProperty(input),
    {
      key: "status",
      schema: {
        enum: Object.values(PullRequestThreadFilter),
        description:
          'open (default): the threads that still wait for an answer; all: every thread, resolved ones included. Example: "open".',
      },
      required: false,
    },
  ];
  return {
    name: IntegrationToolName.PullRequestThreads,
    title: "Read the review threads of a pull request",
    description: cap([
      "Read the review threads of one of the run's pull requests: general comments and comments on lines of files, each with its replies.",
      "Use when: you address a code review, or need what reviewers asked before you change the code.",
      "Do not use for: any other pull request, or the item this run started from (use source_item_get).",
      "Each comment says whether it is yours (`mine`): a thread whose last comment is yours was answered already.",
      `Input:\n${describeProperties(properties)}`,
      "Returns: the pull request's state and its threads as JSON (id, status, file and line, comments with author, mine, createdAt, body).",
    ]),
    inputSchema: objectSchema(properties),
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: (args) => {
      const pullRequest = findPullRequest(input, args);
      if (!pullRequest.ok) {
        return pullRequest;
      }
      const status =
        args.status === PullRequestThreadFilter.All
          ? PullRequestThreadFilter.All
          : PullRequestThreadFilter.Open;
      return Result.ok({
        kind: "pull_request_threads",
        pullRequest: pullRequest.value,
        status,
      });
    },
  };
}

function replyTool(
  input: AgentToolSessionInput,
  grant: NormalizedConnectionGrant
): AgentTool {
  const properties: ToolProperty[] = [
    pullRequestProperty(input),
    threadProperty(),
    {
      key: "body",
      schema: {
        type: "string",
        minLength: 1,
        maxLength: PULL_REQUEST_REPLY_MAX,
        description:
          'The reply, in Markdown: what you changed for the comment, or why you did not. Example: "Done: the export now streams rows."',
      },
      required: true,
    },
  ];
  return {
    name: IntegrationToolName.PullRequestReply,
    title: "Reply to a review thread",
    description: cap([
      "Reply to a review thread of one of the run's pull requests.",
      "Use when: you addressed (or decided not to address) a reviewer's comment and say so in its thread.",
      `Do not use for: a new review comment, any other pull request, or the ticket (use source_item_comment). To mark a thread done use ${IntegrationToolName.PullRequestResolve}.`,
      grant.approvalRequired ? APPROVAL_NOTE : "",
      `Input:\n${describeProperties(properties)}`,
      "Returns: the new comment's reference.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: WRITE_ANNOTATIONS,
    access: IntegrationToolAccess.Write,
    operationType: PullRequestOperation.Reply,
    plan: (args) => {
      const pullRequest = findPullRequest(input, args);
      if (!pullRequest.ok) {
        return pullRequest;
      }
      const threadId = readThreadId(args);
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!(threadId && body) || body.length > PULL_REQUEST_REPLY_MAX) {
        return Result.err(
          `threadId and body (1-${PULL_REQUEST_REPLY_MAX} characters) are required.`
        );
      }
      return Result.ok({
        kind: "pull_request_write",
        pullRequest: pullRequest.value,
        operation: PullRequestOperation.Reply,
        threadId,
        body,
        requiresApproval: grant.approvalRequired,
      });
    },
  };
}

function resolveTool(
  input: AgentToolSessionInput,
  grant: NormalizedConnectionGrant
): AgentTool {
  const properties: ToolProperty[] = [
    pullRequestProperty(input),
    threadProperty(),
  ];
  return {
    name: IntegrationToolName.PullRequestResolve,
    title: "Resolve a review thread",
    description: cap([
      "Mark a review thread of one of the run's pull requests resolved.",
      "Use when: the thread's request is done (reply first with what you changed).",
      `Do not use for: a thread you did not address, or any other pull request. To answer a thread use ${IntegrationToolName.PullRequestReply}.`,
      grant.approvalRequired ? APPROVAL_NOTE : "",
      "Resolving a thread that is resolved already is not an error.",
      `Input:\n${describeProperties(properties)}`,
      "Returns: a reference to the resolved thread.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: WRITE_ANNOTATIONS,
    access: IntegrationToolAccess.Write,
    operationType: PullRequestOperation.Resolve,
    plan: (args) => {
      const pullRequest = findPullRequest(input, args);
      if (!pullRequest.ok) {
        return pullRequest;
      }
      const threadId = readThreadId(args);
      if (!threadId) {
        return Result.err("threadId is required.");
      }
      return Result.ok({
        kind: "pull_request_write",
        pullRequest: pullRequest.value,
        operation: PullRequestOperation.Resolve,
        threadId,
        body: null,
        requiresApproval: grant.approvalRequired,
      });
    },
  };
}

function pullRequestProperty(input: AgentToolSessionInput): ToolProperty {
  const urls = input.pullRequests.map((pullRequest) => pullRequest.url);
  return {
    key: "pullRequest",
    schema: {
      enum: urls,
      description: `The pull request's URL. One of: ${urls.join(", ")}. Example: "${urls[0] ?? ""}".`,
    },
    required: true,
  };
}

function threadProperty(): ToolProperty {
  return {
    key: "threadId",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: THREAD_ID_MAX,
      description: `A thread id from ${IntegrationToolName.PullRequestThreads}. Example: "4211".`,
    },
    required: true,
  };
}

function findPullRequest(
  input: AgentToolSessionInput,
  args: JsonObject
): Result<RunPullRequestRef, string> {
  const pullRequest = input.pullRequests.find(
    (candidate) => candidate.url === args.pullRequest
  );
  return pullRequest
    ? Result.ok(pullRequest)
    : Result.err(
        `pullRequest must be one of the run's pull requests: ${input.pullRequests.map((candidate) => candidate.url).join(", ")}.`
      );
}

function readThreadId(args: JsonObject): string | null {
  const value =
    typeof args.threadId === "number" ? String(args.threadId) : args.threadId;
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= THREAD_ID_MAX
    ? value.trim()
    : null;
}

function describePullRequest(pullRequest: RunPullRequestRef): string {
  return `${pullRequest.repository} #${pullRequest.number} (${pullRequest.url})`;
}
