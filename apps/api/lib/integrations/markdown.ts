import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigFactory,
} from "node-html-markdown";
import { z } from "zod";

/**
 * Text conversions shared by providers. Source systems hand us HTML (Jira
 * renderedFields, ADO multi-line fields); the platform stores markdown.
 */

const htmlConverter = new NodeHtmlMarkdown(
  {
    // Keep output compact and predictable for document bodies.
    maxConsecutiveNewlines: 2,
    useLinkReferenceDefinitions: false,
  },
  { pre: preformattedText }
);
// Inline code stays code: Jira renders monospace ({{text}}) as <tt>, and the
// converter's table cells drop <code> unless told otherwise. Code spans also
// keep placeholders such as `<result>` safe from the document sanitizer.
const inlineCode = htmlConverter.translators.get("code");
htmlConverter.translators.set("tt", inlineCode);
htmlConverter.tableCellTranslators.set("code,tt", inlineCode);
// Jira renders an issue key as a macro (type icon, link, status lozenge) and a
// mention as a profile link: keep the key as a plain link and the mention as
// @name, without the icon or the status the issue had at that moment.
const defaultLink = htmlConverter.translators.get("a");
for (const translators of [
  htmlConverter.translators,
  htmlConverter.tableCellTranslators,
]) {
  translators.set("a", jiraAwareLink);
  translators.set("span", jiraStatusLozenge);
}

const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) {
    return "";
  }
  return htmlConverter
    .translate(html.replaceAll(SCRIPT_OR_STYLE_RE, ""))
    .trim();
}

/** Truncates on a character boundary and appends a marker when cut. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}\n\n…(truncated)`;
}

type TranslatorContext = Parameters<TranslatorConfigFactory>[0];

const MIN_FENCE_LENGTH = 3;
const JIRA_ISSUE_KEY_CLASS = "jira-issue-macro-key";
const JIRA_MENTION_CLASS = "user-hover";
const JIRA_LOZENGE_CLASS = "aui-lozenge";
const CLASS_SEPARATOR_RE = /\s+/;
const BACKTICK_RUN_RE = /`+/g;
const EDGE_NEWLINES_RE = /^\n+|\n+$/g;
const elementSchema = z.object({ tagName: z.string() });

/**
 * A <pre> holding a single <code> element is fenced by the code translator.
 * Any other <pre> (Jira renders {code} and {noformat} as a plain <pre>) is
 * fenced here, so it stays a code block instead of loose lines.
 */
function preformattedText({
  node,
  visitor,
}: TranslatorContext): TranslatorConfig {
  if (holdsOnlyCode(node)) {
    return { noEscape: true, preserveWhitespace: true };
  }
  return {
    noEscape: true,
    preserveWhitespace: true,
    childTranslators: visitor.instance.codeBlockTranslators,
    postprocess: ({ content }) => fencedCodeBlock(content),
  };
}

function holdsOnlyCode(node: TranslatorContext["node"]): boolean {
  const children = node.childNodes;
  if (children.length !== 1) {
    return false;
  }
  const element = elementSchema.safeParse(children[0]);
  return element.success && element.data.tagName.toUpperCase() === "CODE";
}

/** The fence is longer than any backtick run inside, so content cannot close it. */
function fencedCodeBlock(content: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(BACKTICK_RUN_RE), (run) => run[0].length)
  );
  const fence = "`".repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
  return `${fence}\n${content.replaceAll(EDGE_NEWLINES_RE, "")}\n${fence}`;
}

function jiraAwareLink(context: TranslatorContext): TranslatorConfig {
  const { node } = context;
  const text = node.textContent?.trim() ?? "";
  if (hasClass(node, JIRA_ISSUE_KEY_CLASS)) {
    const href = node.getAttribute("href");
    const target = href?.replaceAll("(", "%28").replaceAll(")", "%29");
    return { content: target ? `[${text}](${target})` : text, recurse: false };
  }
  if (hasClass(node, JIRA_MENTION_CLASS)) {
    return { content: `@${text}`, recurse: false };
  }
  return typeof defaultLink === "function" ? defaultLink(context) : defaultLink;
}

function jiraStatusLozenge({ node }: TranslatorContext): TranslatorConfig {
  return hasClass(node, JIRA_LOZENGE_CLASS) ? { ignore: true } : {};
}

function hasClass(node: TranslatorContext["node"], name: string): boolean {
  const classes = node.getAttribute("class") ?? "";
  return classes.split(CLASS_SEPARATOR_RE).includes(name);
}
