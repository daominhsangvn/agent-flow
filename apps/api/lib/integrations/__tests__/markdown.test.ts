// Rich text from Jira arrives as renderedFields HTML from its wiki renderer:
// monospace ({{text}}) is <tt>, {noformat} and {code} are a plain <pre> in a
// panel. The markdown must keep both as code, or a PRD loses its key names,
// `<placeholder>` values (the document sanitizer strips them as tags) and the
// alignment of its diagrams.

import { describe, expect, it } from "vitest";
import { sanitizeDocumentContent } from "@/app/documents/sanitize-content";
import { htmlToMarkdown } from "@/lib/integrations/markdown";

const KEYPAD = "┌───┬───┐\n│ C │ ⌫ │\n├───┼───┤\n│ 0 │ = │\n└───┴───┘";

function noformatPanel(text: string): string {
  return `<div class="preformatted panel" style="border-width: 1px;"><div class="preformattedContent panelContent">\n<pre>${text}</pre>\n</div></div>`;
}

describe("htmlToMarkdown", () => {
  it("keeps Jira monospace as inline code", () => {
    expect(
      htmlToMarkdown(
        "<p>The display starts at <tt>0</tt>; <tt>=</tt> shows the result.</p>"
      )
    ).toBe("The display starts at `0`; `=` shows the result.");
  });

  it("keeps a monospace placeholder through document sanitizing", () => {
    const markdown = htmlToMarkdown(
      "<p>Every key is a <tt>&lt;button&gt;</tt>; entries read <tt>&lt;expression&gt; = &lt;result&gt;</tt>.</p>"
    );

    expect(markdown).toBe(
      "Every key is a `<button>`; entries read `<expression> = <result>`."
    );
    expect(sanitizeDocumentContent(markdown).content).toBe(markdown);
  });

  it("keeps monospace inside table cells", () => {
    expect(
      htmlToMarkdown(
        '<div class="table-wrap"><table class="confluenceTable"><tbody><tr><th class="confluenceTh">#</th><th class="confluenceTh">Keys pressed</th></tr><tr><td class="confluenceTd">AC-1</td><td class="confluenceTd"><tt>7</tt> <tt>+</tt> <tt>8</tt> <tt>=</tt></td></tr></tbody></table></div>'
      )
    ).toBe(
      "| #    | Keys pressed    |\n| ---- | --------------- |\n| AC-1 | `7` `+` `8` `=` |"
    );
  });

  it("fences a noformat panel so a diagram keeps its lines", () => {
    expect(
      htmlToMarkdown(
        `<p>The keypad:</p>${noformatPanel(KEYPAD)}<p>Usable from 360 px.</p>`
      )
    ).toBe(`The keypad:\n\n\`\`\`\n${KEYPAD}\n\`\`\`\n\nUsable from 360 px.`);
  });

  it("fences a code panel as plain code", () => {
    expect(
      htmlToMarkdown(
        '<div class="code panel" style="border-width: 1px;"><div class="codeContent panelContent">\n<pre class="code-java"><span class="code-keyword">const</span> total = 1;\nnpm test</pre>\n</div></div>'
      )
    ).toBe("```\nconst total = 1;\nnpm test\n```");
  });

  it("makes the fence longer than any backtick run in the block", () => {
    expect(htmlToMarkdown(noformatPanel("```\nnested\n```"))).toBe(
      "````\n```\nnested\n```\n````"
    );
  });

  it("keeps a Jira issue key as a plain link, without its icon or status", () => {
    expect(
      htmlToMarkdown(
        `<h1><a name="ImplementationPlan"></a>Implementation Plan: \n    <span class="jira-issue-macro" data-jira-key="CALC-4" >\n                <a href="https://example.atlassian.net/browse/CALC-4" class="jira-issue-macro-key issue-link"  title="Basic calculator" >\n            <img class="icon" src="https://example.atlassian.net/rest/api/2/universal_avatar/view/type/issuetype/avatar/10315?size=medium" />\n            CALC-4\n        </a>\n                                                    <span class="aui-lozenge aui-lozenge-subtle aui-lozenge-current jira-macro-single-issue-export-pdf">In Review</span>\n            </span>\n Basic Calculator</h1>`
      )
    ).toBe(
      "# Implementation Plan: [CALC-4](https://example.atlassian.net/browse/CALC-4) Basic Calculator"
    );
  });

  it("writes a Jira mention as @name and keeps other links", () => {
    expect(
      htmlToMarkdown(
        '<p><a href="https://example.atlassian.net/secure/ViewProfile.jspa?accountId=557058%3A5097" class="user-hover" rel="557058:5097" data-account-id="557058:5097">Nobody</a> 1: as suggested, see <a href="https://example.com/docs" class="external-link" rel="nofollow noreferrer">the docs</a>.</p>'
      )
    ).toBe(
      "@Nobody 1: as suggested, see [the docs](https://example.com/docs)."
    );
  });

  it("leaves a pre holding a single code element to the code translator", () => {
    expect(
      htmlToMarkdown(
        '<pre><code class="language-ts">const total = 1;</code></pre>'
      )
    ).toBe("```ts\nconst total = 1;\n```");
  });
});
