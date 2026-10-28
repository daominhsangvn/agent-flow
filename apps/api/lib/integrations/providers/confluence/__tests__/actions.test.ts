import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  confluenceCommentAction,
  confluenceCreatePageAction,
  confluenceResolveCommentAction,
  confluenceUpdatePageAction,
} from "@/lib/integrations/providers/confluence/actions";
import { ConfluenceBodyFormat } from "@/lib/integrations/providers/confluence/constants";
import { HttpMethod } from "@/lib/integrations/types";
import {
  BOT_ID,
  comment,
  createActionContext,
  createFakeConfluence,
  ENG_SPACE_ID,
  OPS_SPACE_ID,
  OTHER_PAGE_ID,
  PLAN_PAGE_ID,
  page,
  pageRoute,
  SITE,
  spacesRoute,
} from "./confluence.test-fixtures";

/**
 * Confluence writes: pages in the project connection's spaces only, updates
 * that never overwrite a newer version, comments and replies, and resolving
 * inline comments.
 */

const PARENT_PAGE_ID = "1605633";
const PAGES_RE = /\/pages\//;
const PLAN_URL = `${SITE}/wiki/spaces/ENG/pages/${PLAN_PAGE_ID}/PROJ-7+Implementation+plan`;

function body(fake: ReturnType<typeof createFakeConfluence>, index: number) {
  return JSON.parse(fake.requests[index]?.body ?? "{}");
}

describe("confluence.create_page", () => {
  const config = {
    space: "eng",
    title: "{{source.key}} Implementation plan",
    body: "## Tasks\n\n- Export",
    parentId: null,
    format: ConfluenceBodyFormat.Markdown,
  };

  it("creates the page under the project's parent page, as ADF", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PARENT_PAGE_ID, { title: "Plans" }),
      {
        method: HttpMethod.Post,
        path: "/wiki/api/v2/pages",
        json: page(PLAN_PAGE_ID),
      },
    ]);

    const result = await confluenceCreatePageAction.execute(
      createActionContext(fake, config, {
        settings: { spaceKeys: ["ENG"], parentPageId: PARENT_PAGE_ID },
      })
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: PLAN_URL,
      detail: 'Created the page "PROJ-7 Implementation plan"',
    });
    const sent = body(fake, 2);
    expect(sent).toMatchObject({
      spaceId: ENG_SPACE_ID,
      status: "current",
      title: "PROJ-7 Implementation plan",
      parentId: PARENT_PAGE_ID,
      body: { representation: "atlas_doc_format" },
    });
    expect(JSON.parse(sent.body.value)).toMatchObject({
      type: "doc",
      content: [
        expect.objectContaining({ type: "heading" }),
        expect.anything(),
      ],
    });
  });

  it("refuses a space or a parent outside the project's spaces", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(OTHER_PAGE_ID, { spaceId: OPS_SPACE_ID }),
    ]);

    const space = await confluenceCreatePageAction.execute(
      createActionContext(fake, { ...config, space: "OPS" })
    );
    const parent = await confluenceCreatePageAction.execute(
      createActionContext(fake, { ...config, parentId: OTHER_PAGE_ID })
    );

    expect(space).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
    });
    expect(parent).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      error: expect.stringContaining("not in the project connection's spaces"),
    });
    expect(fake.requestsTo(HttpMethod.Post, "/wiki/api/v2/pages")).toHaveLength(
      0
    );
  });

  it("finds the page its first attempt created on a retry", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/pages",
        json: { results: [page(PLAN_PAGE_ID)], _links: {} },
      },
    ]);

    const result = await confluenceCreatePageAction.execute(
      createActionContext(fake, config, { attempt: 2 })
    );

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: PLAN_URL,
    });
    expect(fake.requestsTo(HttpMethod.Post, "/wiki/api/v2/pages")).toHaveLength(
      0
    );
  });
});

describe("confluence.update_page", () => {
  const config = {
    page: PLAN_URL,
    baseVersion: 3,
    title: null,
    body: "<p>Revised</p>",
    format: ConfluenceBodyFormat.Storage,
    message: "Addressed the review",
  };

  it("writes the next version of the version read", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID),
      {
        method: HttpMethod.Put,
        path: `/wiki/api/v2/pages/${PLAN_PAGE_ID}`,
        json: page(PLAN_PAGE_ID, {
          version: { number: 4, authorId: BOT_ID },
        }),
      },
    ]);

    const result = await confluenceUpdatePageAction.execute(
      createActionContext(fake, config)
    );

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: 'Updated "PROJ-7 Implementation plan" to version 4',
    });
    expect(body(fake, 2)).toEqual({
      id: PLAN_PAGE_ID,
      status: "current",
      title: "PROJ-7 Implementation plan",
      body: { representation: "storage", value: "<p>Revised</p>" },
      version: { number: 4, message: "Addressed the review" },
    });
  });

  it("refuses when the page changed since the version read", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID, { version: { number: 5, authorId: "someone" } }),
    ]);

    const result = await confluenceUpdatePageAction.execute(
      createActionContext(fake, config)
    );

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      error: expect.stringContaining("changed since version 3"),
      retryable: false,
    });
    expect(fake.requestsTo(HttpMethod.Put, PAGES_RE)).toHaveLength(0);
  });
});

describe("confluence.comment and resolve_comment", () => {
  it("adds a comment below the page", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID),
      {
        method: HttpMethod.Post,
        path: "/wiki/api/v2/footer-comments",
        json: comment("31"),
      },
    ]);

    const result = await confluenceCommentAction.execute(
      createActionContext(fake, {
        page: PLAN_PAGE_ID,
        body: "Plan updated.",
        replyTo: null,
      })
    );

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "31",
    });
    expect(body(fake, 2)).toMatchObject({
      pageId: PLAN_PAGE_ID,
      body: { representation: "atlas_doc_format" },
    });
  });

  it("replies to an inline comment of the page, not of another page", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID),
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/footer-comments/21",
        status: 404,
        json: { errors: [{ title: "Not Found" }] },
      },
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/inline-comments/21",
        json: comment("21", { resolutionStatus: "open" }),
      },
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/footer-comments/41",
        json: comment("41", { pageId: OTHER_PAGE_ID }),
      },
      {
        method: HttpMethod.Post,
        path: "/wiki/api/v2/inline-comments",
        json: comment("32"),
      },
    ]);

    const reply = await confluenceCommentAction.execute(
      createActionContext(fake, {
        page: PLAN_PAGE_ID,
        body: "Done.",
        replyTo: "21",
      })
    );
    const elsewhere = await confluenceCommentAction.execute(
      createActionContext(fake, {
        page: PLAN_PAGE_ID,
        body: "Done.",
        replyTo: "41",
      })
    );

    expect(reply).toMatchObject({ status: WorkflowActionRunStatus.Succeeded });
    expect(
      JSON.parse(
        fake.requestsTo(HttpMethod.Post, "/wiki/api/v2/inline-comments")[0]
          ?.body ?? "{}"
      )
    ).toMatchObject({ parentCommentId: "21" });
    expect(elsewhere).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      error: 'There is no comment 41 on "PROJ-7 Implementation plan".',
    });
  });

  it("resolves an inline comment, keeping its body; a resolved one is done", async () => {
    const fake = createFakeConfluence([
      spacesRoute,
      pageRoute(PLAN_PAGE_ID),
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/inline-comments/21",
        json: comment("21", { resolutionStatus: "open" }),
      },
      {
        method: HttpMethod.Get,
        path: "/wiki/api/v2/inline-comments/22",
        json: comment("22", { resolutionStatus: "resolved" }),
      },
      {
        method: HttpMethod.Put,
        path: "/wiki/api/v2/inline-comments/21",
        json: comment("21", { resolutionStatus: "resolved" }),
      },
    ]);

    const resolved = await confluenceResolveCommentAction.execute(
      createActionContext(fake, { page: PLAN_PAGE_ID, comment: "21" })
    );
    const again = await confluenceResolveCommentAction.execute(
      createActionContext(fake, { page: PLAN_PAGE_ID, comment: "22" })
    );

    expect(resolved).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: "Resolved the comment",
    });
    expect(
      JSON.parse(
        fake.requestsTo(HttpMethod.Put, "/wiki/api/v2/inline-comments/21")[0]
          ?.body ?? "{}"
      )
    ).toEqual({
      version: { number: 2 },
      body: { representation: "storage", value: "<p>comment 21</p>" },
      resolved: true,
    });
    expect(again).toMatchObject({ detail: "Already resolved" });
  });
});
