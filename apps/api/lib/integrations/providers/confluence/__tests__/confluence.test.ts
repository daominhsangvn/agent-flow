import { describe, expect, it } from "vitest";
import { validateConfluenceConnection } from "@/lib/integrations/providers/confluence/connection";
import {
  ConfluenceBodyFormat,
  ConfluenceCommentFilter,
} from "@/lib/integrations/providers/confluence/constants";
import { parsePageReference } from "@/lib/integrations/providers/confluence/pages";
import { confluenceProvider } from "@/lib/integrations/providers/confluence/provider";
import {
  confluenceFindPagesRead,
  confluenceGetPageRead,
  confluenceListCommentsRead,
} from "@/lib/integrations/providers/confluence/reads";
import { confluenceConnectionConfigSchema } from "@/lib/integrations/providers/confluence/schemas";
import { HttpMethod, ValidateConnectionReason } from "@/lib/integrations/types";
import {
  BOT_ID,
  comment,
  createContext,
  createFakeConfluence,
  OPS_SPACE_ID,
  OTHER_PAGE_ID,
  PLAN_PAGE_ID,
  pageRoute,
  REVIEWER_ID,
  SITE,
  spacesRoute,
  TOKEN,
} from "./confluence.test-fixtures";

/**
 * Confluence Cloud: the connection (site or Atlassian API gateway), page
 * references, and the reads agents make, always inside the project
 * connection's spaces.
 */

const CLOUD_ID = "1324a887-45db-1bf4-1e99-ef0ff456d421";
const PAGE_URL = `${SITE}/wiki/spaces/ENG/pages/${PLAN_PAGE_ID}/PROJ-7+Implementation+plan`;

describe("confluenceProvider", () => {
  it("offers reads and writes, no triggers and no claims", () => {
    expect(confluenceProvider.triggers).toEqual([]);
    expect(confluenceProvider.reads?.map((read) => read.key)).toEqual([
      "confluence.get_page",
      "confluence.find_pages",
      "confluence.list_comments",
    ]);
    expect(confluenceProvider.actions.map((action) => action.key)).toEqual([
      "confluence.create_page",
      "confluence.update_page",
      "confluence.comment",
      "confluence.resolve_comment",
    ]);
    expect(
      confluenceProvider.project?.containers({ spaceKeys: ["ENG"] })
    ).toEqual([]);
  });

  it("keeps the site's origin", () => {
    expect(
      confluenceConnectionConfigSchema.parse({
        siteUrl: " https://acme.atlassian.net/wiki/home ",
        email: "agentflow-bot@acme.com",
      }).siteUrl
    ).toBe(SITE);
  });
});

describe("validateConfluenceConnection", () => {
  const userRoute = (path: string) => ({
    method: HttpMethod.Get,
    path,
    json: {
      type: "known",
      accountId: BOT_ID,
      displayName: "AgentFlow Bot",
    },
  });

  it("identifies the bot with Basic auth on the site", async () => {
    const fake = createFakeConfluence([
      userRoute("/wiki/rest/api/user/current"),
    ]);

    const result = await validateConfluenceConnection(
      createContext(fake),
      ValidateConnectionReason.Save
    );

    expect(result).toMatchObject({
      ok: true,
      account: { externalAccountId: BOT_ID, displayName: "AgentFlow Bot" },
      config: { siteUrl: SITE, cloudId: null },
    });
    const auth = fake.requests[0]?.headers.get("authorization") ?? "";
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      `agentflow-bot@acme.com:${TOKEN}`
    );
  });

  it("goes through the API gateway for a token with scopes", async () => {
    const fake = createFakeConfluence([
      {
        method: HttpMethod.Get,
        path: "/wiki/rest/api/user/current",
        status: 401,
        json: { message: "Unauthorized" },
      },
      {
        method: HttpMethod.Get,
        path: "/_edge/tenant_info",
        json: { cloudId: CLOUD_ID },
      },
      userRoute(`/ex/confluence/${CLOUD_ID}/wiki/rest/api/user/current`),
    ]);

    const result = await validateConfluenceConnection(
      createContext(fake),
      ValidateConnectionReason.Save
    );

    expect(result).toMatchObject({ ok: true, config: { cloudId: CLOUD_ID } });
    expect(fake.requests.at(-1)?.url.host).toBe("api.atlassian.com");
  });

  it("refuses an anonymous answer", async () => {
    const fake = createFakeConfluence([
      {
        method: HttpMethod.Get,
        path: "/wiki/rest/api/user/current",
        json: { type: "anonymous", displayName: "Anonymous" },
      },
    ]);

    const result = await validateConfluenceConnection(
      createContext(fake),
      ValidateConnectionReason.Save
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("parsePageReference", () => {
  const config = { siteUrl: SITE, email: "bot@acme.com", cloudId: null };

  it.each([
    [PLAN_PAGE_ID, PLAN_PAGE_ID],
    [PAGE_URL, PLAN_PAGE_ID],
    [`${SITE}/wiki/spaces/ENG/pages/edit-v2/${PLAN_PAGE_ID}`, PLAN_PAGE_ID],
    [`${SITE}/wiki/pages/viewpage.action?pageId=${PLAN_PAGE_ID}`, PLAN_PAGE_ID],
    [`${SITE}/wiki/x/AQAZ`, PLAN_PAGE_ID],
  ])("reads %s", (reference, id) => {
    expect(parsePageReference(config, reference)).toEqual({
      ok: true,
      value: id,
    });
  });

  it("refuses another site and text that names no page", () => {
    expect(
      parsePageReference(
        config,
        `https://evil.atlassian.net/wiki/spaces/ENG/pages/${PLAN_PAGE_ID}`
      ).ok
    ).toBe(false);
    expect(parsePageReference(config, "the plan page").ok).toBe(false);
  });
});

describe("confluence reads", () => {
  it("reads a page of an allowed space as Markdown", async () => {
    const fake = createFakeConfluence([spacesRoute, pageRoute(PLAN_PAGE_ID)]);

    const result = await confluenceGetPageRead.execute(createContext(fake), {
      page: PAGE_URL,
      format: ConfluenceBodyFormat.Markdown,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: PLAN_PAGE_ID,
        title: "PROJ-7 Implementation plan",
        space: "ENG",
        version: 3,
        parentId: "1605633",
        url: `${SITE}/wiki/spaces/ENG/pages/${PLAN_PAGE_ID}/PROJ-7+Implementation+plan`,
        format: ConfluenceBodyFormat.Markdown,
        body: "## Tasks\n\nExport orders as **CSV**.",
        truncated: false,
      },
    });
    expect(fake.requests[0]?.url.searchParams.get("keys")).toBe("ENG");
    expect(fake.requests[1]?.url.searchParams.get("body-format")).toBe(
      "storage"
    );
  });

  it("refuses a page of another space, and works only through a project connection", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(OTHER_PAGE_ID, { spaceId: OPS_SPACE_ID }),
    ]);

    expect(
      await confluenceGetPageRead.execute(createContext(fake), {
        page: OTHER_PAGE_ID,
        format: ConfluenceBodyFormat.Markdown,
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("not in the project connection's spaces"),
      retryable: false,
    });
    expect(
      await confluenceGetPageRead.execute(
        createContext(fake, { settings: null }),
        { page: OTHER_PAGE_ID, format: ConfluenceBodyFormat.Markdown }
      )
    ).toMatchObject({ ok: false, retryable: false });
  });

  it("finds pages by title within the allowed spaces", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      {
        method: HttpMethod.Get,
        path: "/wiki/rest/api/content/search",
        json: {
          results: [
            {
              id: PLAN_PAGE_ID,
              type: "page",
              title: "PROJ-7 Implementation plan",
              space: { key: "ENG" },
              version: { number: 3 },
              _links: { webui: `/spaces/ENG/pages/${PLAN_PAGE_ID}` },
            },
            {
              id: OTHER_PAGE_ID,
              type: "page",
              title: "PROJ-7 notes",
              space: { key: "OPS" },
            },
          ],
        },
      },
    ]);

    const result = await confluenceFindPagesRead.execute(createContext(fake), {
      title: 'PROJ-7 "plan"',
    });

    expect(fake.requests[1]?.url.searchParams.get("cql")).toBe(
      String.raw`type = page AND space in ("ENG") AND title ~ "PROJ-7 \"plan\""`
    );
    expect(result).toEqual({
      ok: true,
      value: {
        pages: [
          {
            id: PLAN_PAGE_ID,
            title: "PROJ-7 Implementation plan",
            space: "ENG",
            version: 3,
            url: `${SITE}/wiki/spaces/ENG/pages/${PLAN_PAGE_ID}`,
          },
        ],
      },
    });
    expect(
      await confluenceFindPagesRead.execute(createContext(fake), {
        title: "plan",
        space: "OPS",
      })
    ).toMatchObject({ ok: false, retryable: false });
  });

  it("lists open threads with replies and tells the bot's comments", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID),
      {
        method: HttpMethod.Get,
        path: `/wiki/api/v2/pages/${PLAN_PAGE_ID}/footer-comments`,
        json: { results: [comment("11")], _links: {} },
      },
      {
        method: HttpMethod.Get,
        path: `/wiki/api/v2/pages/${PLAN_PAGE_ID}/inline-comments`,
        json: {
          results: [
            comment("21", {
              resolutionStatus: "open",
              properties: { inlineOriginalSelection: "Export orders" },
            }),
            comment("22", { resolutionStatus: "resolved" }),
          ],
          _links: {},
        },
      },
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/footer-comments/11/children",
        json: {
          results: [
            comment("12", {
              version: {
                number: 1,
                authorId: BOT_ID,
                createdAt: "2026-10-15T10:00:00.000Z",
              },
            }),
          ],
          _links: {},
        },
      },
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/inline-comments/21/children",
        json: { results: [], _links: {} },
      },
    ]);

    const result = await confluenceListCommentsRead.execute(
      createContext(fake),
      { page: PLAN_PAGE_ID, status: ConfluenceCommentFilter.Open }
    );

    expect(result).toEqual({
      ok: true,
      value: {
        page: {
          id: PLAN_PAGE_ID,
          title: "PROJ-7 Implementation plan",
          version: 3,
        },
        threads: [
          {
            id: "11",
            kind: "footer",
            status: "open",
            highlighted: null,
            comments: [
              {
                id: "11",
                authorId: REVIEWER_ID,
                mine: false,
                createdAt: "2026-10-15T09:30:00.000Z",
                body: "comment 11",
              },
              expect.objectContaining({ id: "12", mine: true }),
            ],
          },
          {
            id: "21",
            kind: "inline",
            status: "open",
            highlighted: "Export orders",
            comments: [expect.objectContaining({ id: "21" })],
          },
        ],
      },
    });
    expect(
      fake.requestsTo(
        HttpMethod.Get,
        "/wiki/api/v2/inline-comments/22/children"
      )
    ).toHaveLength(0);
  });
});
