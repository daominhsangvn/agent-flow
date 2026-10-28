import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { HttpMethod } from "../../../types";
import { markdownToAdf } from "../../atlassian/adf";
import { jiraEditOnItem, jiraReplyOnItem } from "../item-reply";
import {
  dataCenterConfig,
  jsonResponse,
  makeJiraContext,
  requestBody,
  routedHttp,
} from "./jira.test-helpers";

/**
 * The project orchestrator's messages on a Jira issue (docs/orchestrator.md):
 * in the thread of the comment it answers, on the issue when the site
 * refuses threads, and edited in place.
 */

const COMMENT_PATH = "/rest/api/3/issue/10042/comment";
const ITEM = {
  provider: IntegrationProviderKey.Jira,
  externalId: "10042",
  key: "LD-7",
  url: null,
  title: "Half-day leave",
  container: "LD",
};

describe("jiraReplyOnItem", () => {
  it("answers in the thread of the comment it replies to", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(201, { id: "900" }),
      },
    ]);

    const result = await jiraReplyOnItem(makeJiraContext({ http: fake.http }), {
      item: ITEM,
      parentId: "500",
      text: "Half days are **allowed**.",
      extras: null,
    });

    expect(result).toEqual({ ok: true, externalRef: "900" });
    expect(requestBody(fake.requests[0])).toEqual({
      body: markdownToAdf("Half days are **allowed**."),
      parentId: "500",
    });
  });

  it("comments on the issue when the site refuses the thread", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: (request) =>
          (requestBody(request) as { parentId?: string }).parentId
            ? jsonResponse(400, { errorMessages: ["parentId: unknown field"] })
            : jsonResponse(201, { id: "901" }),
      },
    ]);

    const result = await jiraReplyOnItem(makeJiraContext({ http: fake.http }), {
      item: ITEM,
      parentId: "500",
      text: "Half days are allowed.",
      extras: null,
    });

    expect(result).toEqual({ ok: true, externalRef: "901" });
    expect(fake.requests).toHaveLength(2);
  });

  it("sends wiki text to Data Center", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/jira/rest/api/2/issue/10042/comment",
        respond: jsonResponse(201, { id: "902" }),
      },
    ]);

    await jiraReplyOnItem(
      makeJiraContext({ http: fake.http, config: dataCenterConfig() }),
      { item: ITEM, parentId: null, text: "Plain text.", extras: null }
    );

    expect(requestBody(fake.requests[0])).toEqual({ body: "Plain text." });
  });

  it("shows the files attached to the item below a Cloud comment", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(201, { id: "903" }),
      },
    ]);

    await jiraReplyOnItem(makeJiraContext({ http: fake.http }), {
      item: ITEM,
      parentId: null,
      text: "The PRD is attached.",
      extras: null,
      files: [{ id: "10", name: "PRD-LD-5.md", contentType: "text/markdown" }],
    });

    const body = JSON.stringify(requestBody(fake.requests[0]));
    expect(body).toContain("Attachments");
    expect(body).toContain("/rest/api/3/attachment/content/10");
  });

  it("ends a Data Center comment with the files it shows", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/jira/rest/api/2/issue/10042/comment",
        respond: jsonResponse(201, { id: "904" }),
      },
    ]);

    await jiraReplyOnItem(
      makeJiraContext({ http: fake.http, config: dataCenterConfig() }),
      {
        item: ITEM,
        parentId: null,
        text: "The PRD is attached.",
        extras: null,
        files: [
          { id: "10", name: "PRD-LD-5.md", contentType: "text/markdown" },
        ],
      }
    );

    const body = requestBody(fake.requests[0]) as { body: string };
    expect(body.body.endsWith("* [^PRD-LD-5.md]")).toBe(true);
  });

  it("refuses an item that is not a Jira issue", async () => {
    const fake = routedHttp([]);
    const result = await jiraReplyOnItem(makeJiraContext({ http: fake.http }), {
      item: { ...ITEM, provider: IntegrationProviderKey.MicrosoftTeams },
      parentId: null,
      text: "Hi",
      extras: null,
    });
    expect(result.ok).toBe(false);
    expect(fake.requests).toEqual([]);
  });
});

describe("jiraEditOnItem", () => {
  it("replaces the text of the orchestrator's comment", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Put,
        path: `${COMMENT_PATH}/900`,
        respond: jsonResponse(200, { id: "900" }),
      },
    ]);

    const result = await jiraEditOnItem(makeJiraContext({ http: fake.http }), {
      item: ITEM,
      externalRef: "900",
      text: "Plan v2 is out.",
      extras: null,
    });

    expect(result).toEqual({ ok: true, externalRef: "900" });
    expect(requestBody(fake.requests[0])).toEqual({
      body: markdownToAdf("Plan v2 is out."),
    });
  });
});
