import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { WORKFLOW_DEFAULT_TITLE_TEMPLATE } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import type { SourceItem } from "@/lib/integrations/types";
import {
  buildIssueBody,
  buildIssueTitle,
  ISSUE_BODY_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
} from "@/lib/workflows/engine/issue-document";

const baseItem: SourceItem = {
  provider: IntegrationProviderKey.Jira,
  externalId: "10001",
  key: "PROJ-7",
  url: "https://acme.atlassian.net/browse/PROJ-7",
  title: "Add CSV export",
  container: "PROJ",
  bodyMarkdown: "Users need a **CSV** export.",
  itemType: "Story",
  status: "To Do",
  priority: "High",
  labels: ["export", "reports"],
  reporter: "Ada BA",
  assignee: "AgentFlow Bot",
  sections: [
    { title: "Acceptance Criteria", markdown: "- Exports all rows" },
    { title: "Empty", markdown: "   " },
  ],
  comments: [],
  attachments: [],
};

function body(overrides: Partial<SourceItem> = {}, instructions = "") {
  return buildIssueBody({
    item: { ...baseItem, ...overrides },
    providerDisplayName: "Jira",
    workflowName: "Jira to PR",
    instructions,
  });
}

describe("buildIssueTitle", () => {
  it("renders the default title template", () => {
    expect(
      buildIssueTitle(WORKFLOW_DEFAULT_TITLE_TEMPLATE, baseItem, "Jira to PR")
    ).toBe("PROJ-7: Add CSV export");
  });

  it("falls back to key: title when the template renders empty", () => {
    expect(buildIssueTitle("{{unknown}}", baseItem, "Jira to PR")).toBe(
      "PROJ-7: Add CSV export"
    );
  });

  it("flattens line breaks and caps the length", () => {
    const title = buildIssueTitle(
      "{{source.title}}",
      { ...baseItem, title: `a\nb${"x".repeat(400)}` },
      "w"
    );
    expect(title.startsWith("a b")).toBe(true);
    expect(title).toHaveLength(ISSUE_TITLE_MAX_LENGTH);
  });
});

describe("buildIssueBody", () => {
  it("starts with the import notice and a field table", () => {
    const markdown = body();
    expect(markdown).toContain(
      '> Imported from Jira [PROJ-7](https://acme.atlassian.net/browse/PROJ-7) by workflow "Jira to PR".'
    );
    expect(markdown).toContain("| Type | Story |");
    expect(markdown).toContain("| Labels | export, reports |");
    expect(markdown).toContain(
      "## Description\n\nUsers need a **CSV** export."
    );
    expect(markdown).toContain("## Acceptance Criteria\n\n- Exports all rows");
    expect(markdown).not.toContain("## Empty");
  });

  it("escapes table cells and link targets", () => {
    const markdown = body({
      status: "In | Review",
      url: "https://example.test/a b)c",
    });
    expect(markdown).toContain(String.raw`| Status | In \| Review |`);
    expect(markdown).toContain("(https://example.test/a%20b%29c)");
  });

  it("keeps the latest 20 comments oldest first", () => {
    const comments = Array.from({ length: 25 }, (_, index) => ({
      author: `user-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      bodyMarkdown: `comment ${index}`,
    })).reverse();
    const markdown = body({ comments });
    expect(markdown).not.toContain("comment 4");
    expect(markdown.indexOf("comment 5")).toBeLessThan(
      markdown.indexOf("comment 24")
    );
  });

  it("lists attachments and additional instructions", () => {
    const markdown = body(
      {
        attachments: [
          {
            name: "spec.pdf",
            url: "https://x.test/spec.pdf",
            mimeType: null,
            size: 1,
          },
          { name: "local.txt", url: null, mimeType: null, size: null },
        ],
      },
      "Follow the style guide."
    );
    expect(markdown).toContain("- [spec.pdf](https://x.test/spec.pdf)");
    expect(markdown).toContain("- local.txt");
    expect(markdown).toContain(
      "## Additional instructions\n\nFollow the style guide."
    );
  });

  it("lists the item's web links after its attachments", () => {
    const markdown = body({
      links: [
        {
          url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          title: "Implementation [plan]",
        },
        { url: "https://x.test/a b", title: null },
      ],
    });

    expect(markdown).toContain(
      "## Links\n\n- [Implementation plan](https://acme.atlassian.net/wiki/spaces/ENG/pages/123)\n- [https://x.test/a b](https://x.test/a%20b)"
    );
    expect(body()).not.toContain("## Links");
  });

  it("uses a placeholder for an empty description and caps the size", () => {
    expect(body({ bodyMarkdown: "  " })).toContain("_No description._");
    const huge = body({ bodyMarkdown: "y".repeat(ISSUE_BODY_MAX_LENGTH * 2) });
    expect(huge.length).toBeLessThanOrEqual(ISSUE_BODY_MAX_LENGTH);
    expect(huge.endsWith("…(truncated)")).toBe(true);
  });
});
