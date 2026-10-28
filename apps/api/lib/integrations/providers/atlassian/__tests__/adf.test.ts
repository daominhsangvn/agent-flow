import { describe, expect, it } from "vitest";
import { adfToPlainText, markdownToAdf } from "../adf";

const text = (value: string, marks?: unknown[]) =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });

describe("markdownToAdf", () => {
  it("always returns a doc; empty input gives one empty paragraph", () => {
    expect(markdownToAdf("")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    });
    expect(markdownToAdf("   \n\n  ").content).toEqual([
      { type: "paragraph", content: [] },
    ]);
  });

  it("converts paragraphs, soft breaks and hard breaks", () => {
    expect(
      markdownToAdf("Hello world\nsecond line  \nthird\n\nNext").content
    ).toEqual([
      paragraph(
        text("Hello world"),
        { type: "hardBreak" },
        text("second line"),
        { type: "hardBreak" },
        text("third")
      ),
      paragraph(text("Next")),
    ]);
  });

  it("converts headings 1-6 and keeps deeper markers as text", () => {
    const doc = markdownToAdf("# One\n## Two\n###### Six\n####### Seven");
    expect(doc.content).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [text("One")] },
      { type: "heading", attrs: { level: 2 }, content: [text("Two")] },
      { type: "heading", attrs: { level: 6 }, content: [text("Six")] },
      paragraph(text("####### Seven")),
    ]);
  });

  it("applies inline marks (strong, em, code, strike, link)", () => {
    const doc = markdownToAdf(
      "**bold** *it* `code()` ~~old~~ [PR #42](https://github.com/acme/repo/pull/42)"
    );
    expect(doc.content).toEqual([
      paragraph(
        text("bold", [{ type: "strong" }]),
        text(" "),
        text("it", [{ type: "em" }]),
        text(" "),
        text("code()", [{ type: "code" }]),
        text(" "),
        text("old", [{ type: "strike" }]),
        text(" "),
        text("PR #42", [
          {
            type: "link",
            attrs: { href: "https://github.com/acme/repo/pull/42" },
          },
        ])
      ),
    ]);
  });

  it("nests marks and keeps code combined only with link", () => {
    const doc = markdownToAdf("***both*** **[`x`](https://e.com)**");
    expect(doc.content).toEqual([
      paragraph(
        text("both", [{ type: "em" }, { type: "strong" }]),
        text(" "),
        text("x", [
          { type: "link", attrs: { href: "https://e.com" } },
          { type: "code" },
        ])
      ),
    ]);
  });

  it("turns autolinks and bare URLs into links", () => {
    const doc = markdownToAdf(
      "See https://acme.atlassian.net/browse/PROJ-1 now"
    );
    expect(doc.content).toEqual([
      paragraph(
        text("See "),
        text("https://acme.atlassian.net/browse/PROJ-1", [
          {
            type: "link",
            attrs: { href: "https://acme.atlassian.net/browse/PROJ-1" },
          },
        ]),
        text(" now")
      ),
    ]);
  });

  it("converts bullet and ordered lists, nested, with a start number and task items", () => {
    const doc = markdownToAdf(
      "- one\n- two\n  - nested **b**\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo"
    );
    expect(doc.content).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("one"))] },
          {
            type: "listItem",
            content: [
              paragraph(text("two")),
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      paragraph(
                        text("nested "),
                        text("b", [{ type: "strong" }])
                      ),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [
          { type: "listItem", content: [paragraph(text("three"))] },
          { type: "listItem", content: [paragraph(text("four"))] },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [paragraph(text("[x] "), text("done"))],
          },
          {
            type: "listItem",
            content: [paragraph(text("[ ] "), text("todo"))],
          },
        ],
      },
    ]);
  });

  it("omits attrs for ordered lists starting at 1", () => {
    expect(markdownToAdf("1. a\n2. b").content[0]).toEqual({
      type: "orderedList",
      content: [
        { type: "listItem", content: [paragraph(text("a"))] },
        { type: "listItem", content: [paragraph(text("b"))] },
      ],
    });
  });

  it("converts fenced and indented code blocks", () => {
    const doc = markdownToAdf(
      "```ts title=x\nconst a = 1 < 2;\n```\n\n    indented\n\n```\n```"
    );
    expect(doc.content).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const a = 1 < 2;" }],
      },
      { type: "codeBlock", content: [{ type: "text", text: "indented" }] },
      { type: "codeBlock" },
    ]);
  });

  it("converts blockquotes and flattens what ADF does not allow inside them", () => {
    const doc = markdownToAdf("> quoted\n> # Title\n> > deeper\n> - item");
    expect(doc.content).toEqual([
      {
        type: "blockquote",
        content: [
          paragraph(text("quoted")),
          paragraph(text("Title", [{ type: "strong" }])),
          paragraph(text("deeper")),
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [paragraph(text("item"))] }],
          },
        ],
      },
    ]);
  });

  it("converts horizontal rules", () => {
    expect(markdownToAdf("above\n\n---\n\nbelow").content).toEqual([
      paragraph(text("above")),
      { type: "rule" },
      paragraph(text("below")),
    ]);
  });

  it("converts tables with header cells and inline marks", () => {
    const doc = markdownToAdf(
      "| Field | Value |\n|---|:-:|\n| PR | **#42** |\n| Empty | |"
    );
    expect(doc.content).toEqual([
      {
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph(text("Field"))] },
              { type: "tableHeader", content: [paragraph(text("Value"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("PR"))] },
              {
                type: "tableCell",
                content: [paragraph(text("#42", [{ type: "strong" }]))],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("Empty"))] },
              { type: "tableCell", content: [paragraph()] },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps raw HTML as plain text and decodes entities", () => {
    const doc = markdownToAdf(
      "<div>html block</div>\n\nA &amp; B &#169; &unknown; <b>x</b>"
    );
    expect(doc.content).toEqual([
      paragraph(text("<div>html block</div>")),
      paragraph(
        text("A & B © &unknown; "),
        text("<b>"),
        text("x"),
        text("</b>")
      ),
    ]);
  });

  it("keeps escaped markdown characters literally", () => {
    expect(markdownToAdf(String.raw`not \*em\* \# heading`).content).toEqual([
      paragraph(
        text("not "),
        text("*"),
        text("em"),
        text("*"),
        text(" "),
        text("#"),
        text(" heading")
      ),
    ]);
  });

  it("links only absolute http(s) and mailto URLs", () => {
    const doc = markdownToAdf(
      "[rel](docs/readme.md) [js](javascript:alert(1)) [mail](mailto:ba@acme.com)"
    );
    expect(doc.content).toEqual([
      paragraph(
        text("rel"),
        text(" "),
        text("js"),
        text(" "),
        text("mail", [{ type: "link", attrs: { href: "mailto:ba@acme.com" } }])
      ),
    ]);
  });

  it("turns images into links", () => {
    expect(
      markdownToAdf("![screenshot](https://img.example.com/a.png)").content
    ).toEqual([
      paragraph(
        text("screenshot", [
          { type: "link", attrs: { href: "https://img.example.com/a.png" } },
        ])
      ),
    ]);
  });

  it("never emits empty text nodes", () => {
    const doc = markdownToAdf("**  **\n\n[](https://e.com)\n\n- \n");
    expect(JSON.stringify(doc)).not.toContain('"text":""');
    expect(doc.type).toBe("doc");
  });

  it("converts the run summaries the engine produces", () => {
    const doc = markdownToAdf(
      "❓ The plan for **PROJ-1** has open questions:\n\n- Which format?\n- Which columns?\n\nPlan: https://app.example.com/acme/implementation-plans/p-1"
    );
    expect(doc.content.map((node) => node.type)).toEqual([
      "paragraph",
      "bulletList",
      "paragraph",
    ]);
  });
});

describe("adfToPlainText", () => {
  it("extracts text with blank lines between blocks", () => {
    expect(
      adfToPlainText({
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First" }] },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "item " },
                      {
                        type: "text",
                        text: "bold",
                        marks: [{ type: "strong" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "a" },
              { type: "hardBreak" },
              { type: "text", text: "b" },
            ],
          },
        ],
      })
    ).toBe("First\n\nitem bold\n\na\nb");
  });

  it("returns an empty string for anything that is not ADF", () => {
    expect(adfToPlainText(null)).toBe("");
    expect(adfToPlainText("text")).toBe("");
    expect(adfToPlainText({ content: [] })).toBe("");
  });

  it("round-trips the text of markdownToAdf output", () => {
    expect(adfToPlainText(markdownToAdf("# Title\n\nBody **text**"))).toBe(
      "Title\n\nBody text"
    );
  });
});
