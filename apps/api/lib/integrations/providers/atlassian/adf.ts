import { type MarkedToken, marked, type Token, type Tokens } from "marked";
import { z } from "zod";

/**
 * Markdown -> Atlassian Document Format (ADF), the rich text format of Jira
 * Cloud REST v3 (comments, descriptions) and of Confluence Cloud pages and
 * comments (`atlas_doc_format`), built on marked's lexer.
 *
 * Supported: paragraphs, headings 1-6, bullet/ordered lists (nested, task
 * items as "[x]"/"[ ]"), fenced/indented code blocks with language,
 * blockquotes, horizontal rules, tables, and inline strong / em / code /
 * links / strike / hard breaks. Soft line breaks become hard breaks (chat
 * semantics, like GitHub comments). Images become links (ADF media needs an
 * upload). Raw HTML and anything unknown is kept as plain text.
 *
 * ADF nesting rules are respected: blockquotes and list items hold no
 * headings, tables or nested blockquotes (those are flattened to
 * paragraphs), list items start with a paragraph, text nodes are never
 * empty, and the code mark is only combined with the link mark. The result
 * is always a valid `doc`; empty input gives a single empty paragraph.
 */

export type AdfMark =
  | { type: "strong" }
  | { type: "em" }
  | { type: "code" }
  | { type: "strike" }
  | { type: "link"; attrs: { href: string } };

export type AdfInlineNode =
  | { type: "text"; text: string; marks?: AdfMark[] }
  | { type: "hardBreak" };

export type AdfBlockNode =
  | { type: "paragraph"; content: AdfInlineNode[] }
  | {
      type: "heading";
      attrs: { level: number };
      content: AdfInlineNode[];
    }
  | { type: "bulletList"; content: AdfListItem[] }
  | {
      type: "orderedList";
      attrs?: { order: number };
      content: AdfListItem[];
    }
  | {
      type: "codeBlock";
      attrs?: { language: string };
      content?: Array<{ type: "text"; text: string }>;
    }
  | { type: "blockquote"; content: AdfBlockNode[] }
  | { type: "rule" }
  | {
      type: "table";
      attrs: { isNumberColumnEnabled: boolean; layout: "default" };
      content: AdfTableRow[];
    }
  | {
      type: "mediaSingle";
      attrs: { layout: "center" };
      content: [{ type: "media"; attrs: { type: "external"; url: string } }];
    };

export type AdfListItem = { type: "listItem"; content: AdfBlockNode[] };

export type AdfTableRow = {
  type: "tableRow";
  content: Array<{
    type: "tableHeader" | "tableCell";
    content: AdfBlockNode[];
  }>;
};

export type AdfDocument = {
  type: "doc";
  version: 1;
  content: AdfBlockNode[];
};

export function markdownToAdf(markdown: string): AdfDocument {
  const tokens = lexMarkdown(markdown);
  const content = tokens
    ? convertBlocks(tokens, TOP_LEVEL)
    : markdown.split(BLANK_LINE_RE).flatMap(plainParagraph);
  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [emptyParagraph()],
  };
}

/** Plain text of an ADF node tree (blocks separated by blank lines). Used as a fallback reader. */
export function adfToPlainText(value: unknown): string {
  const parsed = adfNodeSchema.safeParse(value);
  if (!parsed.success) {
    return "";
  }
  return collectText(parsed.data).replaceAll(EXCESS_NEWLINES_RE, "\n\n").trim();
}

type BlockContext = {
  /** Inside a blockquote or list item: no headings, tables or blockquotes. */
  nested: boolean;
};

const TOP_LEVEL: BlockContext = { nested: false };
const NESTED: BlockContext = { nested: true };
const MAX_HEADING_LEVEL = 6;
const NEWLINE_RE = /\r?\n/;
const BLANK_LINE_RE = /\r?\n\s*\r?\n/;
const WHITESPACE_RE = /\s+/;
const EXCESS_NEWLINES_RE = /\n{3,}/g;
const STRONG_MARK: AdfMark = { type: "strong" };
const EM_MARK: AdfMark = { type: "em" };
const CODE_MARK: AdfMark = { type: "code" };
const STRIKE_MARK: AdfMark = { type: "strike" };
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const BLOCK_NODE_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "blockquote",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "panel",
  "mediaSingle",
]);

const HTML_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", String.fromCodePoint(0xa0)],
]);
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

type AdfNode = {
  type: string;
  text?: string;
  content?: AdfNode[];
};

const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    content: z.array(adfNodeSchema).optional(),
  })
);

/** marked's lexer does not throw on any string in practice; plain paragraphs are the safety net. */
function lexMarkdown(markdown: string): Token[] | null {
  try {
    return marked.lexer(markdown);
  } catch {
    return null;
  }
}

function convertBlocks(
  tokens: readonly Token[],
  context: BlockContext
): AdfBlockNode[] {
  return tokens.flatMap((token) => convertBlock(token, context));
}

function convertBlock(token: Token, context: BlockContext): AdfBlockNode[] {
  const typed = token as MarkedToken;
  switch (typed.type) {
    case "space":
    case "def":
      return [];
    case "paragraph":
    case "text":
      return paragraphOf(inlineOf(typed));
    case "heading":
      return convertHeading(typed, context);
    case "list":
      return [convertList(typed)];
    case "code":
      return [convertCode(typed)];
    case "blockquote":
      return convertBlockquote(typed, context);
    case "hr":
      return context.nested ? [] : [{ type: "rule" }];
    case "table":
      return convertTable(typed, context);
    default:
      return plainParagraph(rawText(token));
  }
}

function convertHeading(
  token: Tokens.Heading,
  context: BlockContext
): AdfBlockNode[] {
  const content = convertInline(token.tokens, []);
  if (context.nested) {
    return paragraphOf(withMark(content, STRONG_MARK));
  }
  if (content.length === 0) {
    return [];
  }
  return [
    {
      type: "heading",
      attrs: { level: clampHeadingLevel(token.depth) },
      content,
    },
  ];
}

function convertList(token: Tokens.List): AdfBlockNode {
  const items = token.items.map(convertListItem);
  if (!token.ordered) {
    return { type: "bulletList", content: items };
  }
  const start = typeof token.start === "number" ? token.start : 1;
  return start === 1
    ? { type: "orderedList", content: items }
    : { type: "orderedList", attrs: { order: start }, content: items };
}

function convertListItem(item: Tokens.ListItem): AdfListItem {
  const prefix = taskPrefix(item);
  const blocks = convertBlocks(
    item.tokens.filter((token) => token.type !== "checkbox"),
    NESTED
  );
  const content = startWithParagraph(blocks);
  if (prefix) {
    prependText(content, prefix);
  }
  return { type: "listItem", content };
}

function convertCode(token: Tokens.Code): AdfBlockNode {
  const language = token.lang?.trim().split(WHITESPACE_RE)[0] ?? "";
  const text = token.text;
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    ...(text ? { content: [{ type: "text" as const, text }] } : {}),
  };
}

function convertBlockquote(
  token: Tokens.Blockquote,
  context: BlockContext
): AdfBlockNode[] {
  const content = convertBlocks(token.tokens, NESTED);
  if (context.nested) {
    return content;
  }
  return content.length > 0 ? [{ type: "blockquote", content }] : [];
}

function convertTable(
  token: Tokens.Table,
  context: BlockContext
): AdfBlockNode[] {
  if (context.nested) {
    return plainParagraph(token.raw);
  }
  const header: AdfTableRow = {
    type: "tableRow",
    content: token.header.map((cell) => ({
      type: "tableHeader",
      content: cellContent(cell),
    })),
  };
  const rows: AdfTableRow[] = token.rows.map((row) => ({
    type: "tableRow",
    content: row.map((cell) => ({
      type: "tableCell",
      content: cellContent(cell),
    })),
  }));
  return [
    {
      type: "table",
      attrs: { isNumberColumnEnabled: false, layout: "default" },
      content: [header, ...rows],
    },
  ];
}

function cellContent(cell: Tokens.TableCell): AdfBlockNode[] {
  return [{ type: "paragraph", content: convertInline(cell.tokens, []) }];
}

/** Inline content of a paragraph-like token; a token without inline children keeps its text. */
function inlineOf(token: Tokens.Paragraph | Tokens.Text): AdfInlineNode[] {
  if (token.tokens && token.tokens.length > 0) {
    return convertInline(token.tokens, []);
  }
  return textNodes(decodeEntities(token.text), []);
}

function convertInline(
  tokens: readonly Token[] | undefined,
  marks: AdfMark[]
): AdfInlineNode[] {
  return (tokens ?? []).flatMap((token) => convertInlineToken(token, marks));
}

function convertInlineToken(token: Token, marks: AdfMark[]): AdfInlineNode[] {
  const typed = token as MarkedToken;
  switch (typed.type) {
    case "strong":
      return convertInline(typed.tokens, addMark(marks, STRONG_MARK));
    case "em":
      return convertInline(typed.tokens, addMark(marks, EM_MARK));
    case "del":
      return convertInline(typed.tokens, addMark(marks, STRIKE_MARK));
    case "codespan":
      return textNodes(typed.text, addMark(marks, CODE_MARK));
    case "link":
      return convertLink(typed, marks);
    case "image":
      return convertImage(typed, marks);
    case "br":
      return [{ type: "hardBreak" }];
    case "escape":
      return textNodes(decodeEntities(typed.text), marks);
    case "text":
      return convertInlineText(typed, marks);
    default:
      return textNodes(rawText(token), marks);
  }
}

function convertInlineText(
  token: Tokens.Text,
  marks: AdfMark[]
): AdfInlineNode[] {
  if (token.tokens && token.tokens.length > 0) {
    return convertInline(token.tokens, marks);
  }
  return textNodes(decodeEntities(token.text), marks);
}

/** Only absolute http(s)/mailto links become link marks; anything else stays text. */
function convertLink(token: Tokens.Link, marks: AdfMark[]): AdfInlineNode[] {
  const href = linkableHref(token.href);
  if (!href) {
    return convertInline(token.tokens, marks);
  }
  const linkMarks = addMark(marks, { type: "link", attrs: { href } });
  const content = convertInline(token.tokens, linkMarks);
  return content.length > 0 ? content : textNodes(href, linkMarks);
}

function convertImage(token: Tokens.Image, marks: AdfMark[]): AdfInlineNode[] {
  const href = linkableHref(token.href);
  const label = token.text.trim() || token.href.trim();
  if (!href) {
    return textNodes(label, marks);
  }
  return textNodes(label, addMark(marks, { type: "link", attrs: { href } }));
}

function linkableHref(value: string): string | null {
  const href = value.trim();
  if (!URL.canParse(href)) {
    return null;
  }
  return LINK_PROTOCOLS.has(new URL(href).protocol) ? href : null;
}

/** Text nodes for a string, with soft line breaks as hard breaks. Empty strings produce nothing. */
function textNodes(text: string, marks: AdfMark[]): AdfInlineNode[] {
  const nodes: AdfInlineNode[] = [];
  for (const [index, line] of text.split(NEWLINE_RE).entries()) {
    if (index > 0) {
      nodes.push({ type: "hardBreak" });
    }
    if (line.length > 0) {
      nodes.push(textNode(line, marks));
    }
  }
  return nodes;
}

/**
 * Adds a mark unless one of the same type is present. ADF allows the code
 * mark only together with link: adding code drops the others, and nothing
 * but a link is added on top of code.
 */
function addMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  if (marks.some((existing) => existing.type === mark.type)) {
    return marks;
  }
  const hasCode = marks.some((existing) => existing.type === CODE_MARK.type);
  if (hasCode && mark.type !== "link") {
    return marks;
  }
  if (mark.type === CODE_MARK.type) {
    return [...marks.filter((existing) => existing.type === "link"), mark];
  }
  return [...marks, mark];
}

function textNode(text: string, marks: AdfMark[]): AdfInlineNode {
  return marks.length > 0
    ? { type: "text", text, marks: [...marks] }
    : { type: "text", text };
}

function withMark(nodes: AdfInlineNode[], mark: AdfMark): AdfInlineNode[] {
  return nodes.map((node) =>
    node.type === "text"
      ? { ...node, marks: addMark(node.marks ?? [], mark) }
      : node
  );
}

function paragraphOf(content: AdfInlineNode[]): AdfBlockNode[] {
  return content.length > 0 ? [{ type: "paragraph", content }] : [];
}

function plainParagraph(text: string): AdfBlockNode[] {
  return paragraphOf(textNodes(text.trim(), []));
}

function emptyParagraph(): AdfBlockNode {
  return { type: "paragraph", content: [] };
}

function startWithParagraph(blocks: AdfBlockNode[]): AdfBlockNode[] {
  if (blocks[0]?.type === "paragraph") {
    return blocks;
  }
  return [emptyParagraph(), ...blocks];
}

function prependText(blocks: AdfBlockNode[], text: string): void {
  const first = blocks[0];
  if (first?.type === "paragraph") {
    first.content = [{ type: "text", text }, ...first.content];
  }
}

function taskPrefix(item: Tokens.ListItem): string | null {
  if (!item.task) {
    return null;
  }
  return item.checked ? "[x] " : "[ ] ";
}

function clampHeadingLevel(depth: number): number {
  return Math.min(Math.max(Math.trunc(depth), 1), MAX_HEADING_LEVEL);
}

function rawText(token: Token): string {
  const typed = token as Tokens.Generic;
  if (typeof typed.text === "string") {
    return typed.text;
  }
  return typed.raw ?? "";
}

function decodeEntities(text: string): string {
  return text.replaceAll(ENTITY_RE, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) {
      return codePointOrEntity(Number.parseInt(lower.slice(2), 16), entity);
    }
    if (lower.startsWith("#")) {
      return codePointOrEntity(Number.parseInt(lower.slice(1), 10), entity);
    }
    return HTML_ENTITIES.get(lower) ?? entity;
  });
}

function codePointOrEntity(codePoint: number, entity: string): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10_ff_ff
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function collectText(node: AdfNode): string {
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  const inner = (node.content ?? []).map(collectText);
  if (!BLOCK_NODE_TYPES.has(node.type)) {
    return inner.join("");
  }
  const separator = node.content?.some((child) =>
    BLOCK_NODE_TYPES.has(child.type)
  )
    ? "\n\n"
    : "";
  return `${inner.join(separator)}\n\n`;
}
