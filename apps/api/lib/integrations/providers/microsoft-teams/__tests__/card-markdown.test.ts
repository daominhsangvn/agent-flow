import { describe, expect, it } from "vitest";
import {
  isHttpUrl,
  markdownLink,
  toAdaptiveCardMarkdown,
} from "../card-markdown";

describe("toAdaptiveCardMarkdown", () => {
  it("turns headings into bold lines", () => {
    const markdown = "# Plan ready\n\n## Open **questions** ##\ntext";

    expect(toAdaptiveCardMarkdown(markdown)).toBe(
      "**Plan ready**\n\n**Open questions**\ntext"
    );
  });

  it("keeps lists, links, bold and italic as they are", () => {
    const markdown = [
      "**Bold** and _italic_ and *also italic*",
      "- first [link](https://example.com)",
      "* second",
      "1. numbered",
    ].join("\n");

    expect(toAdaptiveCardMarkdown(markdown)).toBe(markdown);
  });

  it("drops code fences but keeps their content verbatim", () => {
    const markdown = "Before\n```ts\n# not a heading\nconst a = 1;\n```\nAfter";

    expect(toAdaptiveCardMarkdown(markdown)).toBe(
      "Before\n# not a heading\nconst a = 1;\nAfter"
    );
  });

  it("strips blockquote markers and horizontal rules", () => {
    const markdown = "> quoted\n>> nested\n\n---\n\nend";

    expect(toAdaptiveCardMarkdown(markdown)).toBe("quoted\nnested\n\nend");
  });

  it("turns images into links", () => {
    const markdown =
      'See ![diagram](https://example.com/a.png "title") and ![](https://example.com/b.png)';

    expect(toAdaptiveCardMarkdown(markdown)).toBe(
      "See [diagram](https://example.com/a.png) and [image](https://example.com/b.png)"
    );
  });

  it("normalizes CRLF and collapses runs of blank lines", () => {
    expect(toAdaptiveCardMarkdown("a\r\n\r\n\r\n\r\nb\r\n")).toBe("a\n\nb");
  });
});

describe("markdownLink", () => {
  it("builds a link for http(s) URLs", () => {
    expect(
      markdownLink("PROJ-1", "https://acme.atlassian.net/browse/PROJ-1")
    ).toBe("[PROJ-1](https://acme.atlassian.net/browse/PROJ-1)");
  });

  it("neutralizes characters that break the link syntax", () => {
    expect(markdownLink("a [b]", "https://example.com/x (1)")).toBe(
      "[a (b)](https://example.com/x%20%281%29)"
    );
  });

  it("falls back to the label without a usable URL", () => {
    expect(markdownLink("PROJ-1", null)).toBe("PROJ-1");
    expect(markdownLink("PROJ-1", "javascript:alert(1)")).toBe("PROJ-1");
    expect(markdownLink("PROJ-1", "/relative")).toBe("PROJ-1");
  });
});

describe("isHttpUrl", () => {
  it.each([
    ["https://example.com", true],
    ["http://localhost:3000/x", true],
    ["mailto:a@example.com", false],
    ["not a url", false],
  ])("%s -> %s", (value, expected) => {
    expect(isHttpUrl(value)).toBe(expected);
  });
});
