import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createFakeAdo as createRoutedFetch,
  type FakeAdo as RoutedFetch,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import type { BitbucketContext } from "@/lib/integrations/providers/bitbucket/client";
import { bitbucketPullRequests } from "@/lib/integrations/providers/bitbucket/pull-requests";
import { BITBUCKET_DEFAULT_API_URL } from "@/lib/integrations/providers/bitbucket/schemas";
import {
  HttpMethod,
  PullRequestState,
  PullRequestThreadStatus,
  type RepositoryInfo,
} from "@/lib/integrations/types";

/**
 * Review threads of Bitbucket Cloud pull requests
 * (providers/bitbucket/pull-requests.ts): a thread is a root comment with
 * every reply below it.
 */

const PULL_REQUEST = "/2.0/repositories/acme/shop/pullrequests/12";
const COMMENTS = `${PULL_REQUEST}/comments`;
const BEA = { uuid: "{b0a1}", display_name: "Bea" };
const BOT = { uuid: "{b0b2}", display_name: "AgentFlow Bot" };

const shop: RepositoryInfo = {
  externalId: "{ws}/{repo}",
  fullName: "acme/shop",
  name: "shop",
  namespace: "acme",
  defaultBranch: "main",
  webUrl: "https://bitbucket.org/acme/shop",
  isPrivate: true,
  cloneUrl: "https://bitbucket.org/acme/shop.git",
};

function createContext(fake: RoutedFetch): BitbucketContext {
  return {
    connection: {
      id: "0199a5f0-0000-7000-8000-0000000000e1",
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: IntegrationProviderKey.Bitbucket,
      name: "Bitbucket",
      config: { apiUrl: BITBUCKET_DEFAULT_API_URL, workspace: "" },
      secrets: { token: "ATATT3xFfGF0-bitbucket-api-token-test" },
      account: null,
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-15T11:00:00.000Z"),
  };
}

function comment(
  id: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "pullrequest_comment",
    id,
    content: { raw: `comment ${id}`, markup: "markdown" },
    user: BEA,
    created_on: `2026-10-15T09:00:0${id % 10}.000Z`,
    deleted: false,
    ...overrides,
  };
}

describe("bitbucketPullRequests.get", () => {
  it("reads the state and title", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: PULL_REQUEST,
        json: {
          id: 12,
          title: "Export orders",
          state: "MERGED",
          links: {
            html: { href: "https://bitbucket.org/acme/shop/pull-requests/12" },
          },
        },
      },
    ]);

    expect(
      await bitbucketPullRequests.get(createContext(fake), shop, 12)
    ).toEqual({
      ok: true,
      value: {
        state: PullRequestState.Merged,
        title: "Export orders",
        url: "https://bitbucket.org/acme/shop/pull-requests/12",
      },
    });
  });
});

describe("bitbucketPullRequests.listThreads", () => {
  it("groups replies (also of replies) under their root, across pages", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: COMMENTS,
        query: { page: "2" },
        json: {
          values: [
            comment(4, { parent: { id: 3 }, user: BOT }),
            comment(5, { deleted: true, parent: { id: 1 } }),
            comment(6, { deleted: true }),
          ],
        },
      },
      {
        method: HttpMethod.Get,
        path: COMMENTS,
        json: {
          values: [
            comment(1, {
              inline: { path: "src/export.ts", to: 42, from: null },
            }),
            comment(2, { resolution: { type: "comment_resolution" } }),
            comment(3, { parent: { id: 1 } }),
          ],
          next: `https://api.bitbucket.org${COMMENTS}?page=2`,
        },
      },
    ]);

    const result = await bitbucketPullRequests.listThreads(
      createContext(fake),
      shop,
      12
    );

    expect(fake.requests[0]?.url.searchParams.get("pagelen")).toBe("100");
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "1",
          status: PullRequestThreadStatus.Open,
          file: { path: "src/export.ts", line: 42 },
          comments: [
            expect.objectContaining({ id: "1", author: "Bea" }),
            expect.objectContaining({ id: "3" }),
            {
              id: "4",
              authorId: BOT.uuid,
              author: BOT.display_name,
              createdAt: "2026-10-15T09:00:04.000Z",
              bodyMarkdown: "comment 4",
            },
          ],
        },
        {
          id: "2",
          status: PullRequestThreadStatus.Resolved,
          file: null,
          comments: [expect.objectContaining({ id: "2" })],
        },
      ],
    });
  });

  it("reports a failed read", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: COMMENTS,
        status: 404,
        json: { type: "error", error: { message: "Not found" } },
      },
    ]);

    const result = await bitbucketPullRequests.listThreads(
      createContext(fake),
      shop,
      12
    );

    expect(result.ok).toBe(false);
  });
});

describe("bitbucketPullRequests.reply and resolve", () => {
  it("replies below the thread's root comment", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Post,
        path: COMMENTS,
        status: 201,
        json: comment(9),
      },
    ]);

    const result = await bitbucketPullRequests.reply(
      createContext(fake),
      shop,
      12,
      "1",
      "Done: rows stream now."
    );

    expect(result).toEqual({ ok: true, value: { commentId: "9" } });
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      content: { raw: "Done: rows stream now." },
      parent: { id: 1 },
    });
  });

  it("resolves a thread, a resolved one included, and rejects a malformed id", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Post,
        path: `${COMMENTS}/1/resolve`,
        json: { type: "comment_resolution" },
      },
      {
        method: HttpMethod.Post,
        path: `${COMMENTS}/2/resolve`,
        status: 409,
        json: { type: "error", error: { message: "Already resolved" } },
      },
    ]);
    const ctx = createContext(fake);

    expect(await bitbucketPullRequests.resolve(ctx, shop, 12, "1")).toEqual({
      ok: true,
      value: null,
    });
    expect(await bitbucketPullRequests.resolve(ctx, shop, 12, "2")).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await bitbucketPullRequests.resolve(ctx, shop, 12, "../x")
    ).toMatchObject({ ok: false, retryable: false });
    expect(fake.requests).toHaveLength(2);
  });
});
