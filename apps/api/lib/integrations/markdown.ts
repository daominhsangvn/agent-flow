import { NodeHtmlMarkdown } from "node-html-markdown";

/**
 * Text conversions shared by providers. Source systems hand us HTML (Jira
 * renderedFields, ADO multi-line fields); the platform stores markdown.
 */

const htmlConverter = new NodeHtmlMarkdown({
  // Keep output compact and predictable for document bodies.
  maxConsecutiveNewlines: 2,
  useLinkReferenceDefinitions: false,
});

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
