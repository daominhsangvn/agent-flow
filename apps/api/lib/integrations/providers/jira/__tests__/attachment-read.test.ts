import { describe, expect, it } from "vitest";
import { HttpMethod, type SourceItemRef } from "../../../types";
import { readJiraAttachment } from "../attachment-read";
import {
  CLOUD_SITE_URL,
  DC_SITE_URL,
  dataCenterConfig,
  jsonResponse,
  makeJiraContext,
  routedHttp,
} from "./jira.test-helpers";

/** source_item_attachment_read on Jira (providers/jira/attachment-read.ts). */

const PRD = "# PRD\n\nThe whole document.";
const ISSUE_PATH = "/rest/api/3/issue/10042";
const CONTENT_PATH = "/rest/api/3/attachment/content/20001";

const REF: SourceItemRef = {
  provider: "jira",
  externalId: "10042",
  key: "PROJ-1",
  url: `${CLOUD_SITE_URL}/browse/PROJ-1`,
  title: "Leave balances",
  container: "PROJ",
};

const PRD_ATTACHMENT = {
  id: "20001",
  filename: "PRD-PROJ-1.md",
  content: `${CLOUD_SITE_URL}/rest/api/3/attachment/content/20001`,
  mimeType: "text/markdown",
  size: PRD.length,
};

function textResponse(text: string) {
  return { ...jsonResponse(200, null), text, json: undefined };
}

function issueWith(
  attachments: object[],
  path = ISSUE_PATH
): {
  method: HttpMethod;
  path: string;
  respond: ReturnType<typeof jsonResponse>;
} {
  return {
    method: HttpMethod.Get,
    path,
    respond: jsonResponse(200, {
      id: "10042",
      key: "PROJ-1",
      fields: { attachment: attachments },
    }),
  };
}

describe("readJiraAttachment", () => {
  it("reads a text attachment by its name, case-insensitive, through the content endpoint", async () => {
    const fake = routedHttp([
      issueWith([
        { ...PRD_ATTACHMENT, id: "1", filename: "shot.png" },
        PRD_ATTACHMENT,
      ]),
      {
        method: HttpMethod.Get,
        path: CONTENT_PATH,
        respond: textResponse(PRD),
      },
    ]);
    const ctx = makeJiraContext({ http: fake.http });

    const result = await readJiraAttachment(ctx, REF, "prd-proj-1.MD");

    expect(result).toEqual({
      ok: true,
      value: {
        name: "PRD-PROJ-1.md",
        contentType: "text/markdown",
        size: PRD.length,
        text: PRD,
      },
    });
    expect(
      new URL(fake.requests[0]?.url ?? "").searchParams.get("fields")
    ).toBe("attachment");
    expect(fake.requests[1]?.headers?.authorization).toBeDefined();
  });

  it("names the attachments the issue has when the file is not one of them", async () => {
    const fake = routedHttp([issueWith([PRD_ATTACHMENT])]);
    const ctx = makeJiraContext({ http: fake.http });

    const result = await readJiraAttachment(ctx, REF, "spec.md");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("PRD-PROJ-1.md");
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses a file too large and a binary file", async () => {
    const fake = routedHttp([
      issueWith([
        { ...PRD_ATTACHMENT, filename: "big.md", size: 2_000_000 },
        { ...PRD_ATTACHMENT, filename: "shot.png", mimeType: "image/png" },
      ]),
      {
        method: HttpMethod.Get,
        path: CONTENT_PATH,
        respond: textResponse("PNG\u0000\u0001"),
      },
    ]);
    const ctx = makeJiraContext({ http: fake.http });

    const big = await readJiraAttachment(ctx, REF, "big.md");
    const binary = await readJiraAttachment(ctx, REF, "shot.png");

    expect(!big.ok && big.error.message).toContain("only files up to");
    expect(!binary.ok && binary.error.message).toContain("not a text file");
  });

  it("downloads a Data Center attachment only from the connection's site", async () => {
    const fake = routedHttp([
      issueWith(
        [
          {
            ...PRD_ATTACHMENT,
            content: `${DC_SITE_URL}/secure/attachment/20001/PRD-PROJ-1.md`,
          },
          {
            ...PRD_ATTACHMENT,
            filename: "elsewhere.md",
            content: "https://elsewhere.example.com/elsewhere.md",
          },
        ],
        "/jira/rest/api/2/issue/10042"
      ),
      {
        method: HttpMethod.Get,
        path: "/jira/secure/attachment/20001/PRD-PROJ-1.md",
        respond: textResponse(PRD),
      },
    ]);
    const ctx = makeJiraContext({
      http: fake.http,
      config: dataCenterConfig(),
    });

    const own = await readJiraAttachment(ctx, REF, "PRD-PROJ-1.md");
    const elsewhere = await readJiraAttachment(ctx, REF, "elsewhere.md");

    expect(own.ok && own.value.text).toBe(PRD);
    expect(elsewhere.ok).toBe(false);
  });
});
