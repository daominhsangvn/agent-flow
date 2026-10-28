import { describe, expect, it } from "vitest";
import {
  BOT,
  createAdoContext,
  createFakeAdo,
  HUMAN,
  identityRef,
  TEST_PROJECT,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import { adoPullRequests } from "@/lib/integrations/providers/azure-devops/pull-requests";
import {
  HttpMethod,
  PullRequestState,
  PullRequestThreadStatus,
  type RepositoryInfo,
} from "@/lib/integrations/types";

/**
 * Review threads of Azure Repos pull requests
 * (providers/azure-devops/pull-requests.ts): the threads of people, not of
 * the system; resolving sets a thread to fixed.
 */

const REPO_ID = "5febef5a-833d-4e14-b9c0-14cb638f91e6";
const PULL_REQUEST = `/contoso/Fabrikam%20Web/_apis/git/repositories/${REPO_ID}/pullrequests/31`;
const THREADS = `${PULL_REQUEST}/threads`;

const shop: RepositoryInfo = {
  externalId: REPO_ID,
  fullName: `contoso/${TEST_PROJECT}/shop`,
  name: "shop",
  namespace: `contoso/${TEST_PROJECT}`,
  defaultBranch: "main",
  webUrl: "https://dev.azure.com/contoso/Fabrikam%20Web/_git/shop",
  isPrivate: true,
  cloneUrl: "https://dev.azure.com/contoso/Fabrikam%20Web/_git/shop",
};

function threadComment(
  id: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentCommentId: id === 1 ? 0 : 1,
    author: identityRef(HUMAN),
    content: `comment ${id}`,
    publishedDate: `2026-10-15T09:00:0${id}.000Z`,
    commentType: "text",
    ...overrides,
  };
}

describe("adoPullRequests.get", () => {
  it("maps completed to merged and builds the web URL", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: PULL_REQUEST,
        json: { pullRequestId: 31, status: "completed", title: "Export" },
      },
    ]);

    expect(await adoPullRequests.get(createAdoContext(fake), shop, 31)).toEqual(
      {
        ok: true,
        value: {
          state: PullRequestState.Merged,
          title: "Export",
          url: `${shop.webUrl}/pullrequest/31`,
        },
      }
    );
  });
});

describe("adoPullRequests.listThreads", () => {
  it("keeps the threads of people with their file and line", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: THREADS,
        json: {
          value: [
            {
              id: 7,
              status: "active",
              threadContext: {
                filePath: "/src/export.ts",
                rightFileStart: { line: 42, offset: 1 },
              },
              comments: [
                threadComment(1),
                threadComment(2, { author: identityRef(BOT) }),
                threadComment(3, { isDeleted: true }),
              ],
            },
            { id: 8, status: "fixed", comments: [threadComment(1)] },
            {
              id: 9,
              comments: [threadComment(1, { commentType: "system" })],
            },
            { id: 10, isDeleted: true, comments: [threadComment(1)] },
            { id: "not-a-thread" },
          ],
          count: 5,
        },
      },
    ]);

    const result = await adoPullRequests.listThreads(
      createAdoContext(fake),
      shop,
      31
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "7",
          status: PullRequestThreadStatus.Open,
          file: { path: "/src/export.ts", line: 42 },
          comments: [
            expect.objectContaining({ id: "7:1", authorId: HUMAN.id }),
            {
              id: "7:2",
              authorId: BOT.id,
              author: BOT.displayName,
              createdAt: "2026-10-15T09:00:02.000Z",
              bodyMarkdown: "comment 2",
            },
          ],
        },
        {
          id: "8",
          status: PullRequestThreadStatus.Resolved,
          file: null,
          comments: [expect.objectContaining({ id: "8:1" })],
        },
      ],
    });
  });
});

describe("adoPullRequests.reply and resolve", () => {
  it("replies below the thread's first comment", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Post,
        path: `${THREADS}/7/comments`,
        json: { id: 4, parentCommentId: 1, content: "Done" },
      },
    ]);

    const result = await adoPullRequests.reply(
      createAdoContext(fake),
      shop,
      31,
      "7",
      "Done"
    );

    expect(result).toEqual({ ok: true, value: { commentId: "7:4" } });
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      content: "Done",
      parentCommentId: 1,
      commentType: 1,
    });
  });

  it("sets a thread to fixed and rejects a malformed id", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Patch,
        path: `${THREADS}/7`,
        json: { id: 7, status: "fixed" },
      },
    ]);
    const ctx = createAdoContext(fake);

    expect(await adoPullRequests.resolve(ctx, shop, 31, "7")).toEqual({
      ok: true,
      value: null,
    });
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      status: "fixed",
    });
    expect(await adoPullRequests.resolve(ctx, shop, 31, "7/x")).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(fake.requests).toHaveLength(1);
  });
});
