import { describe, expect, it } from "vitest";
import {
  parseWebhookRequestBody,
  summarizeZodIssues,
  webhookRequestBodySchema,
} from "../request-payload";

const TITLE_ISSUE_RE = /^title: /;
const BODY_ISSUE_RE = /^body: /;
const TWO_MORE_RE = /; 2 more$/;

describe("parseWebhookRequestBody", () => {
  it("parses a complete body and trims strings", () => {
    const result = parseWebhookRequestBody(
      JSON.stringify({
        id: " evt-1 ",
        key: "REQ-7",
        title: "  Add CSV export ",
        description: "## Goal\nExport as CSV",
        url: "https://tracker.example.com/REQ-7",
        type: "feature",
        labels: [" reports ", "csv"],
        callbackUrl: "http://10.0.0.5:8080/hooks",
        metadata: { priority: 2, tags: ["a"] },
        unknownField: "ignored",
      })
    );

    expect(result).toEqual({
      ok: true,
      value: {
        id: "evt-1",
        key: "REQ-7",
        title: "Add CSV export",
        description: "## Goal\nExport as CSV",
        url: "https://tracker.example.com/REQ-7",
        type: "feature",
        labels: ["reports", "csv"],
        callbackUrl: "http://10.0.0.5:8080/hooks",
        metadata: { priority: 2, tags: ["a"] },
      },
    });
  });

  it("accepts null for optional fields", () => {
    const result = parseWebhookRequestBody(
      JSON.stringify({
        title: "T",
        id: null,
        url: null,
        labels: null,
        metadata: null,
      })
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a body without a title", () => {
    const result = parseWebhookRequestBody(
      JSON.stringify({ description: "x" })
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(TITLE_ISSUE_RE);
  });

  it("rejects non-JSON bodies", () => {
    expect(parseWebhookRequestBody("title=hello")).toEqual({
      ok: false,
      error: "body is not valid JSON",
    });
  });

  it("rejects a JSON value that is not an object", () => {
    const result = parseWebhookRequestBody("[1,2]");

    expect(result.ok ? "" : result.error).toMatch(BODY_ISSUE_RE);
  });

  it.each([
    ["url", "javascript:alert(1)"],
    ["callbackUrl", "ftp://example.com/x"],
    ["callbackUrl", "not a url"],
  ])("rejects %s=%s", (field, value) => {
    const result = parseWebhookRequestBody(
      JSON.stringify({ title: "T", [field]: value })
    );

    expect(result.ok ? "" : result.error).toContain(`${field}: `);
  });

  it("caps labels at 50", () => {
    const labels = Array.from({ length: 51 }, (_, index) => `l${index}`);

    const result = parseWebhookRequestBody(
      JSON.stringify({ title: "T", labels })
    );

    expect(result.ok ? "" : result.error).toContain("labels: ");
  });
});

describe("summarizeZodIssues", () => {
  it("lists the first three issues and counts the rest", () => {
    const parsed = webhookRequestBodySchema.safeParse({
      title: "",
      key: "",
      type: "",
      url: "x",
      labels: [""],
    });
    if (parsed.success) {
      throw new Error("expected a validation failure");
    }

    const summary = summarizeZodIssues(parsed.error);

    expect(summary.split("; ")).toHaveLength(4);
    expect(summary).toMatch(TWO_MORE_RE);
  });
});
