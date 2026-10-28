import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { HttpMethod, type SourceItemFile } from "../../../types";
import { markdownToAdf } from "../../atlassian/adf";
import { jiraAddCommentAction, jiraAddCommentConfigSchema } from "../actions";
import { attachJiraFile } from "../attachments";
import {
  CLOUD_SITE_URL,
  DC_SITE_URL,
  dataCenterConfig,
  jsonResponse,
  makeActionContext,
  makeJiraContext,
  makeRunSnapshot,
  requestBody,
  routedHttp,
} from "./jira.test-helpers";

/**
 * Evidence files an agent attaches for a comment: uploaded to the run's issue
 * as a multipart request, then shown below the comment's text (inline images
 * and links on Cloud, wiki markup on Data Center).
 */

const SCREENSHOT: SourceItemFile = {
  id: "10500",
  name: "login-error.png",
  contentType: "image/png",
};
const LOG: SourceItemFile = {
  id: "10501",
  name: "test-run.log",
  contentType: "text/plain",
};

describe("attachJiraFile", () => {
  it("uploads the file to the run's issue as multipart with the XSRF opt-out", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/rest/api/3/issue/10042/attachments",
        respond: jsonResponse(200, [
          {
            id: "10500",
            filename: "login-error.png",
            mimeType: "image/png",
            size: 4,
          },
        ]),
      },
    ]);
    const ctx = makeJiraContext({ http: fake.http });

    const result = await attachJiraFile(ctx, makeRunSnapshot().source, {
      name: "login-error.png",
      contentType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    });

    expect(result).toEqual({ ok: true, value: SCREENSHOT });
    const request = fake.requests[0];
    expect(request?.headers?.["x-atlassian-token"]).toBe("no-check");
    const body = request?.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("login-error.png");
    expect((file as File).type).toBe("image/png");
    expect((file as File).size).toBe(4);
  });

  it("reports Jira's refusal without retrying a permission error", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/rest/api/3/issue/10042/attachments",
        respond: jsonResponse(403, {
          errorMessages: ["You do not have permission to create attachments."],
        }),
      },
    ]);

    const result = await attachJiraFile(
      makeJiraContext({ http: fake.http }),
      makeRunSnapshot().source,
      { name: "a.png", contentType: "image/png", bytes: new Uint8Array([1]) }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        message: expect.stringContaining("Jira could not attach a.png"),
        retryable: false,
      },
    });
  });
});

describe("jira.add_comment with attachments", () => {
  it("shows images inline and links every file below the Cloud comment", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/rest/api/3/issue/10042/comment",
        respond: jsonResponse(201, { id: "30010" }),
      },
    ]);
    const ctx = {
      ...makeActionContext({
        http: fake.http,
        config: jiraAddCommentConfigSchema.parse({ message: "QC failed." }),
      }),
      render: (template: string) => template,
      attachments: [SCREENSHOT, LOG],
    };

    const result = await jiraAddCommentAction.execute(ctx);

    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    const imageUrl = `${CLOUD_SITE_URL}/rest/api/3/attachment/content/10500`;
    const logUrl = `${CLOUD_SITE_URL}/rest/api/3/attachment/content/10501`;
    expect(requestBody(fake.requests[0])).toEqual({
      body: {
        ...markdownToAdf("QC failed."),
        content: [
          ...markdownToAdf("QC failed.").content,
          {
            type: "mediaSingle",
            attrs: { layout: "center" },
            content: [
              { type: "media", attrs: { type: "external", url: imageUrl } },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Attachments",
                marks: [{ type: "strong" }],
              },
            ],
          },
          {
            type: "bulletList",
            content: [
              link("login-error.png", imageUrl),
              link("test-run.log", logUrl),
            ],
          },
        ],
      },
    });
  });

  it("shows the files with wiki markup on Data Center", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/jira/rest/api/2/issue/10042/comment",
        respond: jsonResponse(201, { id: 40_010 }),
      },
    ]);
    const ctx = {
      ...makeActionContext({
        http: fake.http,
        config: jiraAddCommentConfigSchema.parse({ message: "QC failed." }),
        connectionConfig: dataCenterConfig(),
        run: makeRunSnapshot({
          source: {
            ...makeRunSnapshot().source,
            url: `${DC_SITE_URL}/browse/PROJ-123`,
          },
        }),
      }),
      render: (template: string) => template,
      attachments: [SCREENSHOT, LOG],
    };

    await jiraAddCommentAction.execute(ctx);

    expect(requestBody(fake.requests[0])).toEqual({
      body: "QC failed.\n\n!login-error.png|thumbnail!\n*Attachments*\n* [^login-error.png]\n* [^test-run.log]",
    });
  });
});

function link(text: string, href: string) {
  return {
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text, marks: [{ type: "link", attrs: { href } }] },
        ],
      },
    ],
  };
}
