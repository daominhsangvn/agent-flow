import { PullRequestOperation } from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestThreadFilter } from "@/lib/integrations/agent-tools/catalog";
import {
  PullRequestState,
  PullRequestThreadStatus,
} from "@/lib/integrations/types";
import {
  executePullRequestWrite,
  listRunPullRequests,
  readPullRequestThreads,
} from "./pull-requests";
import type { ToolSessionContext } from "./session-context";

/**
 * The pull_request_* tools act on the run's own pull requests through each
 * one's repository connection; a comment is `mine` when the connection's
 * account wrote it or this run's reply recorded it, and provider errors
 * never carry the connection's secrets.
 */

const mocks = vi.hoisted(() => ({
  loadRuntime: vi.fn(),
  findCalls: vi.fn(),
  getRepository: vi.fn(),
  get: vi.fn(),
  listThreads: vi.fn(),
  reply: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ integrationToolCall: { findMany: mocks.findCalls } }),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadRuntime,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/integrations/registry", () => ({
  getIntegrationProvider: (key: string) =>
    key === IntegrationProviderKey.Bitbucket
      ? {
          repositories: {
            get: mocks.getRepository,
            pullRequests: {
              get: mocks.get,
              listThreads: mocks.listThreads,
              reply: mocks.reply,
              resolve: mocks.resolve,
            },
          },
        }
      : { repositories: { get: mocks.getRepository } },
}));

const SECRET = "ATATT3xFfGF0-secret";
const PR_URL = "https://bitbucket.org/acme/shop/pull-requests/12";
const PULL_REQUEST = {
  url: PR_URL,
  number: 12,
  repository: "acme/shop",
  provider: IntegrationProviderKey.Bitbucket,
};
const REPOSITORY = {
  connectionId: "conn-1",
  provider: IntegrationProviderKey.Bitbucket,
  externalId: "{ws}/{repo}",
  fullName: "acme/shop",
  pullRequest: { url: PR_URL, number: 12 },
};
const REPOSITORY_INFO = { fullName: "acme/shop" };

function context(repositories: unknown[] = [REPOSITORY]): ToolSessionContext {
  return {
    session: { organizationId: "org-1", runId: "run-1" },
    snapshot: { repositories },
    input: { pullRequests: [PULL_REQUEST] },
  } as unknown as ToolSessionContext;
}

function threadComment(id: string, authorId: string | null) {
  return {
    id,
    authorId,
    author: authorId ? "Someone" : null,
    createdAt: "2026-10-15T09:00:00.000Z",
    bodyMarkdown: `comment ${id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadRuntime.mockResolvedValue({
    runtime: {
      secrets: { token: SECRET },
      account: { externalAccountId: "{bot}" },
    },
  });
  mocks.getRepository.mockResolvedValue(REPOSITORY_INFO);
  mocks.findCalls.mockResolvedValue([{ externalRef: "13" }]);
  mocks.get.mockResolvedValue({
    ok: true,
    value: { state: PullRequestState.Open, title: "Export", url: PR_URL },
  });
});

describe("readPullRequestThreads", () => {
  it("returns the open threads and tells the agent's own comments", async () => {
    mocks.listThreads.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "1",
          status: PullRequestThreadStatus.Open,
          file: { path: "src/export.ts", line: 42 },
          comments: [
            threadComment("1", "{bea}"),
            threadComment("2", "{bot}"),
            threadComment("13", null),
          ],
        },
        {
          id: "5",
          status: PullRequestThreadStatus.Resolved,
          file: null,
          comments: [threadComment("5", "{bea}")],
        },
      ],
    });

    const result = await readPullRequestThreads(context(), {
      kind: "pull_request_threads",
      pullRequest: PULL_REQUEST,
      status: PullRequestThreadFilter.Open,
    });

    expect(mocks.loadRuntime).toHaveBeenCalledWith("org-1", "conn-1");
    expect(mocks.findCalls.mock.calls[0]?.[0]?.where).toMatchObject({
      runId: "run-1",
    });
    expect(result).toEqual({
      ok: true,
      output: {
        pullRequest: PR_URL,
        state: PullRequestState.Open,
        threads: [
          {
            id: "1",
            status: PullRequestThreadStatus.Open,
            file: { path: "src/export.ts", line: 42 },
            comments: [
              expect.objectContaining({ id: "1", mine: false }),
              expect.objectContaining({ id: "2", mine: true }),
              expect.objectContaining({ id: "13", mine: true }),
            ],
          },
        ],
      },
      externalRef: null,
    });
  });

  it("scrubs the connection's secrets from a provider error", async () => {
    mocks.listThreads.mockResolvedValue({
      ok: false,
      error: `401 for token ${SECRET}`,
      retryable: false,
    });

    const result = await readPullRequestThreads(context(), {
      kind: "pull_request_threads",
      pullRequest: PULL_REQUEST,
      status: PullRequestThreadFilter.All,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("listRunPullRequests", () => {
  it("lists each pull request with its state, or why it cannot be read", async () => {
    const result = await listRunPullRequests(context());

    expect(result).toEqual({
      ok: true,
      output: {
        pullRequests: [
          {
            url: PR_URL,
            number: 12,
            repository: "acme/shop",
            state: PullRequestState.Open,
            title: "Export",
          },
        ],
      },
      externalRef: null,
    });

    mocks.loadRuntime.mockResolvedValue(null);
    expect(await listRunPullRequests(context())).toMatchObject({
      ok: true,
      output: {
        pullRequests: [{ state: null, error: expect.any(String) }],
      },
    });
  });
});

describe("executePullRequestWrite", () => {
  it("replies and records the new comment as the reference", async () => {
    mocks.reply.mockResolvedValue({ ok: true, value: { commentId: "14" } });

    const result = await executePullRequestWrite(context(), {
      kind: "pull_request_write",
      pullRequest: PULL_REQUEST,
      operation: PullRequestOperation.Reply,
      threadId: "1",
      body: "Done",
      requiresApproval: false,
    });

    expect(mocks.reply).toHaveBeenCalledWith(
      expect.anything(),
      REPOSITORY_INFO,
      12,
      "1",
      "Done"
    );
    expect(result).toEqual({
      ok: true,
      output: { done: true, reference: "14" },
      externalRef: "14",
    });
  });

  it("resolves a thread", async () => {
    mocks.resolve.mockResolvedValue({ ok: true, value: null });

    const result = await executePullRequestWrite(context(), {
      kind: "pull_request_write",
      pullRequest: PULL_REQUEST,
      operation: PullRequestOperation.Resolve,
      threadId: "1",
      body: null,
      requiresApproval: false,
    });

    expect(result).toMatchObject({
      ok: true,
      externalRef: `${PR_URL}#thread-1`,
    });
  });

  it("refuses a pull request that is not the run's, or a provider without threads", async () => {
    const plan = {
      kind: "pull_request_write" as const,
      pullRequest: PULL_REQUEST,
      operation: PullRequestOperation.Resolve,
      threadId: "1",
      body: null,
      requiresApproval: false,
    };

    expect(await executePullRequestWrite(context([]), plan)).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(
      await executePullRequestWrite(
        context([{ ...REPOSITORY, provider: IntegrationProviderKey.GitHub }]),
        plan
      )
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("not supported"),
    });
    expect(mocks.loadRuntime).not.toHaveBeenCalled();
  });
});
