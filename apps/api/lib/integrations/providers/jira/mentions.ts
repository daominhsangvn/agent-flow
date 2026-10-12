import { z } from "zod";
import type { IntegrationAccount } from "../../types";
import { isJiraBotIdentity } from "./identity";
import type { JiraChangeItem } from "./schemas";

/**
 * Detects mentions of the bot account in Jira text. Mentions arrive as wiki
 * markup on REST v2 and in webhooks (`[~accountid:5b10…]` on Cloud,
 * `[~username]` on Data Center) or as ADF mention nodes
 * (`{type: "mention", attrs: {id}}`) on REST v3.
 */

const WIKI_MENTION_RE = /\[~(?:accountid:)?([^\]\s]+)\]/gi;
const DESCRIPTION_FIELD = "description";

const adfNodeSchema = z.looseObject({
  type: z.string().optional(),
  attrs: z.looseObject({ id: z.string().optional() }).nullish(),
  content: z.array(z.unknown()).nullish(),
});

/** True when wiki markup, plain text or an ADF document mentions the bot. */
export function mentionsJiraBot(
  content: unknown,
  account: IntegrationAccount
): boolean {
  const ids =
    typeof content === "string" ? wikiMentions(content) : adfMentions(content);
  return ids.some((id) => isJiraBotIdentity(account, [id]));
}

/** A changelog entry that edits the description so it newly mentions the bot. */
export function descriptionMentionsBot(
  items: readonly JiraChangeItem[],
  account: IntegrationAccount
): boolean {
  return items.some((item) => {
    const field = (item.fieldId ?? item.field ?? "").trim().toLowerCase();
    if (field !== DESCRIPTION_FIELD) {
      return false;
    }
    return (
      mentionsJiraBot(item.toText ?? item.to ?? "", account) &&
      !mentionsJiraBot(item.fromText ?? item.from ?? "", account)
    );
  });
}

function wikiMentions(text: string): string[] {
  return [...text.matchAll(WIKI_MENTION_RE)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
}

/** Mention node ids of an ADF document (iterative depth-first walk). */
function adfMentions(value: unknown): string[] {
  const ids: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const parsed = adfNodeSchema.safeParse(stack.pop());
    if (!parsed.success) {
      continue;
    }
    const node = parsed.data;
    if (node.type === "mention" && node.attrs?.id) {
      ids.push(node.attrs.id);
    }
    stack.push(...(node.content ?? []));
  }
  return ids;
}
