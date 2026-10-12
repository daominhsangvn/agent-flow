/**
 * Teams renders only a markdown subset in Adaptive Card TextBlocks: bold,
 * italic, links, bulleted and numbered lists. Headings, code fences,
 * blockquotes, rules and images show up literally, so they are rewritten to
 * that subset. Everything else is passed through unchanged.
 */

const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BLOCKQUOTE_RE = /^\s{0,3}(?:>\s?)+/;
const HORIZONTAL_RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
const BOLD_MARKER_RE = /\*\*|__/g;
const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

export function toAdaptiveCardMarkdown(markdown: string): string {
  const output: string[] = [];
  let inFence = false;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    output.push(inFence ? line : convertLine(line));
  }
  return output.join("\n").replaceAll(EXCESS_BLANK_LINES_RE, "\n\n").trim();
}

/** `[label](url)` with characters that break the link syntax neutralized; the bare label when the URL is not http(s). */
export function markdownLink(label: string, url: string | null): string {
  const text = label.replaceAll("[", "(").replaceAll("]", ")");
  if (!(url && isHttpUrl(url))) {
    return text;
  }
  const target = url
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
  return `[${text}](${target})`;
}

export function isHttpUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null && (url.protocol === "https:" || url.protocol === "http:")
  );
}

function convertLine(line: string): string {
  if (HORIZONTAL_RULE_RE.test(line)) {
    return "";
  }
  const heading = HEADING_RE.exec(line);
  if (heading) {
    const text = (heading[1] ?? "").replaceAll(BOLD_MARKER_RE, "").trim();
    return text ? `**${text}**` : "";
  }
  return line
    .replace(BLOCKQUOTE_RE, "")
    .replaceAll(IMAGE_RE, (_image, alt: string, url: string) =>
      markdownLink(alt.trim() || "image", url)
    );
}
