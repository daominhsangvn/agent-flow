import { truncateText } from "@/lib/integrations/markdown";
import type { SourceItem } from "@/lib/integrations/types";
import { renderTemplate } from "../template";

/**
 * Markdown body and title of the Issue (FEATURE) document a run imports from
 * its source item. Ticket text is untrusted: it only ever lands in this
 * document, which the loop context pack wraps as untrusted input.
 */

export const ISSUE_BODY_MAX_LENGTH = 100_000;
export const ISSUE_TITLE_MAX_LENGTH = 255;
const MAX_COMMENTS = 20;

export type IssueDocumentContext = {
  item: SourceItem;
  providerDisplayName: string;
  workflowName: string;
  instructions: string;
};

export function buildIssueTitle(
  titleTemplate: string,
  item: SourceItem,
  workflowName: string
): string {
  const rendered = renderTemplate(titleTemplate, {
    "source.key": item.key,
    "source.title": item.title,
    "source.url": item.url ?? "",
    "source.provider": item.provider,
    "workflow.name": workflowName,
  })
    .replaceAll(LINE_BREAK_RE, " ")
    .trim();
  const title = rendered || `${item.key}: ${item.title}`.trim();
  return title.slice(0, ISSUE_TITLE_MAX_LENGTH);
}

export function buildIssueBody(context: IssueDocumentContext): string {
  const { item } = context;
  const parts = [
    importNotice(context),
    fieldsTable(item),
    section("Description", item.bodyMarkdown.trim() || "_No description._"),
    ...item.sections
      .filter((entry) => entry.markdown.trim() !== "")
      .map((entry) => section(entry.title, entry.markdown.trim())),
    commentsSection(item),
    attachmentsSection(item),
    linksSection(item),
    instructionsSection(context.instructions),
  ].filter((part) => part !== "");
  return truncateText(parts.join("\n\n"), ISSUE_BODY_MAX_LENGTH);
}

const LINE_BREAK_RE = /[\r\n]+/g;
const MARKDOWN_LINK_TEXT_RE = /[[\]]/g;

function importNotice(context: IssueDocumentContext): string {
  const { item } = context;
  const key = item.key.replaceAll(MARKDOWN_LINK_TEXT_RE, "");
  const reference = item.url ? `[${key}](${safeLinkTarget(item.url)})` : key;
  const workflowName = context.workflowName.replaceAll('"', "'");
  return `> Imported from ${context.providerDisplayName} ${reference} by workflow "${workflowName}".`;
}

function fieldsTable(item: SourceItem): string {
  const rows: [string, string | null][] = [
    ["Type", item.itemType],
    ["Status", item.status],
    ["Priority", item.priority],
    ["Labels", item.labels.length > 0 ? item.labels.join(", ") : null],
    ["Reporter", item.reporter],
  ];
  const present = rows.filter(
    (row): row is [string, string] => row[1] !== null && row[1].trim() !== ""
  );
  if (present.length === 0) {
    return "";
  }
  const lines = present.map(
    ([field, value]) => `| ${field} | ${tableCell(value)} |`
  );
  return ["| Field | Value |", "|---|---|", ...lines].join("\n");
}

function commentsSection(item: SourceItem): string {
  if (item.comments.length === 0) {
    return "";
  }
  const ordered = [...item.comments].sort(
    (left, right) => commentTime(left.createdAt) - commentTime(right.createdAt)
  );
  const latest = ordered.slice(-MAX_COMMENTS);
  const lines = latest.map((comment) => {
    const author = comment.author?.trim() || "Unknown";
    const when = comment.createdAt ? ` (${comment.createdAt})` : "";
    return `**${author}**${when}: ${comment.bodyMarkdown.trim()}`;
  });
  return section("Comments", lines.join("\n\n"));
}

function attachmentsSection(item: SourceItem): string {
  if (item.attachments.length === 0) {
    return "";
  }
  const lines = item.attachments.map((attachment) => {
    const name = attachment.name.replaceAll(MARKDOWN_LINK_TEXT_RE, "");
    return attachment.url
      ? `- [${name}](${safeLinkTarget(attachment.url)})`
      : `- ${name}`;
  });
  return section("Attachments", lines.join("\n"));
}

function instructionsSection(instructions: string): string {
  const trimmed = instructions.trim();
  return trimmed ? section("Additional instructions", trimmed) : "";
}

function section(title: string, body: string): string {
  return `## ${title.replaceAll(LINE_BREAK_RE, " ").trim()}\n\n${body}`;
}

function tableCell(value: string): string {
  return value.replaceAll(LINE_BREAK_RE, " ").replaceAll("|", String.raw`\|`);
}

/** Keeps a URL from breaking out of a markdown link destination. */
function safeLinkTarget(url: string): string {
  return url.trim().replaceAll(" ", "%20").replaceAll(")", "%29");
}

/** Comments without a parseable timestamp keep their relative order first. */
function commentTime(createdAt: string | null): number {
  if (!createdAt) {
    return 0;
  }
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Body of a PRD the run imports: the requirement keeps its own headings, so
 * the description is the document itself, below the import notice; extra
 * sections, comments and attachments follow like on an Issue.
 */
export function buildPrdBody(context: IssueDocumentContext): string {
  const { item } = context;
  const parts = [
    importNotice(context),
    item.bodyMarkdown.trim() || "_No description._",
    ...item.sections
      .filter((entry) => entry.markdown.trim() !== "")
      .map((entry) => section(entry.title, entry.markdown.trim())),
    commentsSection(item),
    attachmentsSection(item),
    linksSection(item),
    instructionsSection(context.instructions),
  ].filter((part) => part !== "");
  return truncateText(parts.join("\n\n"), ISSUE_BODY_MAX_LENGTH);
}

/** The item's web links (e.g. the page its plan is reviewed on). */
function linksSection(item: SourceItem): string {
  const links = item.links ?? [];
  if (links.length === 0) {
    return "";
  }
  const lines = links.map((link) => {
    const title = (link.title?.trim() || link.url).replaceAll(
      MARKDOWN_LINK_TEXT_RE,
      ""
    );
    return `- [${title}](${safeLinkTarget(link.url)})`;
  });
  return section("Links", lines.join("\n"));
}
