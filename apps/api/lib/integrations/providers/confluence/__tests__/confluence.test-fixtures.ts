import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createFakeAdo,
  type FakeAdo,
  type FakeRoute,
  runSnapshot,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import type { ConfluenceContext } from "@/lib/integrations/providers/confluence/client";
import type {
  ConfluenceConnectionConfig,
  ConfluenceSecrets,
} from "@/lib/integrations/providers/confluence/schemas";
import { type ActionContext, HttpMethod } from "@/lib/integrations/types";

/**
 * Confluence Cloud REST v2 payloads (shapes from the API reference) and
 * contexts over the shared routed fetch double.
 */

export const SITE = "https://acme.atlassian.net";
export const TOKEN = "ATATT3xFfGF0-confluence-token";
export const BOT_ID = "5b10ac8d82e05b22cc7d4ef5";
export const REVIEWER_ID = "70121:9a8b7c6d-reviewer";
export const ENG_SPACE_ID = "65537";
export const OPS_SPACE_ID = "98305";
/** A page of ENG, and one of OPS (not a space of the project). */
export const PLAN_PAGE_ID = "1638401";
export const OTHER_PAGE_ID = "2228225";

/** The routed fetch double shared with the Azure DevOps tests. */
export function createFakeConfluence(routes: FakeRoute[]): FakeAdo {
  return createFakeAdo(routes);
}

export function createContext(
  fake: FakeAdo,
  options: {
    settings?: JsonObject | null;
    config?: Partial<ConfluenceConnectionConfig>;
  } = {}
): ConfluenceContext {
  return {
    connection: {
      id: "0199a5f0-0000-7000-8000-0000000000f1",
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: IntegrationProviderKey.Confluence,
      name: "Confluence",
      config: {
        siteUrl: SITE,
        email: "agentflow-bot@acme.com",
        cloudId: null,
        ...options.config,
      },
      secrets: { apiToken: TOKEN },
      account: {
        externalAccountId: BOT_ID,
        displayName: "AgentFlow Bot",
        aliases: [],
        details: {},
      },
      ...(options.settings === null
        ? {}
        : {
            projectSettings: options.settings ?? {
              spaceKeys: ["ENG"],
              parentPageId: null,
            },
          }),
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-15T11:00:00.000Z"),
  };
}

export function createActionContext<TConfig>(
  fake: FakeAdo,
  config: TConfig,
  options: { attempt?: number; settings?: JsonObject } = {}
): ActionContext<TConfig, ConfluenceConnectionConfig, ConfluenceSecrets> {
  return {
    ...createContext(fake, { settings: options.settings }),
    config,
    run: runSnapshot(),
    actionRunId: "6c1e0f2a-3b4d-4e5f-8a9b-0c1d2e3f4a5c",
    attempt: options.attempt ?? 1,
    render: (template) => template.replaceAll("{{source.key}}", "PROJ-7"),
  };
}

export const spacesRoute: FakeRoute = {
  method: HttpMethod.Get,
  path: "/wiki/api/v2/spaces",
  json: {
    results: [
      { id: ENG_SPACE_ID, key: "ENG", name: "Engineering", type: "global" },
    ],
    _links: {},
  },
};

export function page(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    status: "current",
    title: "PROJ-7 Implementation plan",
    spaceId: ENG_SPACE_ID,
    parentId: "1605633",
    parentType: "page",
    authorId: BOT_ID,
    version: {
      number: 3,
      authorId: REVIEWER_ID,
      createdAt: "2026-10-15T09:00:00.000Z",
    },
    body: {
      storage: {
        value: "<h2>Tasks</h2><p>Export orders as <strong>CSV</strong>.</p>",
        representation: "storage",
      },
    },
    _links: {
      webui: `/spaces/ENG/pages/${id}/PROJ-7+Implementation+plan`,
    },
    ...overrides,
  };
}

export function pageRoute(
  id: string,
  overrides: Record<string, unknown> = {}
): FakeRoute {
  return {
    method: HttpMethod.Get,
    path: `/wiki/api/v2/pages/${id}`,
    json: page(id, overrides),
  };
}

export function comment(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    status: "current",
    title: "Re: PROJ-7 Implementation plan",
    pageId: PLAN_PAGE_ID,
    version: {
      number: 1,
      authorId: REVIEWER_ID,
      createdAt: "2026-10-15T09:30:00.000Z",
    },
    body: { storage: { value: `<p>comment ${id}</p>` } },
    _links: {
      webui: `/spaces/ENG/pages/${PLAN_PAGE_ID}?focusedCommentId=${id}`,
    },
    ...overrides,
  };
}
