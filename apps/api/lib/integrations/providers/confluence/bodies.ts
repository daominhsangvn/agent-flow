import type { JsonObject } from "@repo/api/src/types/common";
import { htmlToMarkdown, truncateText } from "../../markdown";
import { markdownToAdf } from "../atlassian/adf";
import { ConfluenceBodyFormat } from "./constants";

/**
 * Page and comment bodies: Markdown is written as Atlassian Document Format
 * and read back from storage format (XHTML); `storage` passes through as is,
 * so a page can be edited keeping its macros and inline comment markers.
 */

export const BODY_MAX = 60_000;
export const COMMENT_BODY_MAX = 10_000;

/** The `body` of a create or update request. */
export function writeBody(
  format: ConfluenceBodyFormat,
  text: string
): JsonObject {
  return format === ConfluenceBodyFormat.Storage
    ? { representation: "storage", value: text }
    : {
        representation: "atlas_doc_format",
        value: JSON.stringify(markdownToAdf(text)),
      };
}

/** A storage body for the agent, cut at `max` characters. */
export function readBody(
  storage: string | null | undefined,
  format: ConfluenceBodyFormat,
  max: number
): { body: string; truncated: boolean } {
  if (format === ConfluenceBodyFormat.Storage) {
    const text = storage ?? "";
    return { body: text.slice(0, max), truncated: text.length > max };
  }
  const text = htmlToMarkdown(storage);
  return { body: truncateText(text, max), truncated: text.length > max };
}
