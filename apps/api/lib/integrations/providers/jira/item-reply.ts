import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { truncateText } from "../../markdown";
import type {
  ItemEditInput,
  ItemReplyInput,
  ItemReplyResult,
} from "../../types";
import { HttpMethod } from "../../types";
import { markdownToAdf } from "../atlassian/adf";
import { jiraCommentBody } from "./attachments";
import {
  type JiraContext,
  JiraErrorKind,
  jiraIssuePath,
  jiraRequest,
} from "./client";
import { JiraDeployment } from "./constants";
import { jiraCreatedCommentSchema } from "./schemas";

/**
 * The project orchestrator's message on a Jira issue (docs/orchestrator.md):
 * a comment, in the thread of the comment it answers where the site has
 * comment threads. A site that refuses the thread (no threads on Data
 * Center, an older Cloud API) gets the comment on the issue instead.
 */

const COMMENT_MAX_LENGTH = 30_000;

export async function jiraReplyOnItem(
  ctx: JiraContext,
  input: ItemReplyInput
): Promise<ItemReplyResult> {
  if (input.item.provider !== IntegrationProviderKey.Jira) {
    return {
      ok: false,
      error: "The item is not a Jira issue.",
      retryable: false,
    };
  }
  const text = truncateText(input.text.trim(), COMMENT_MAX_LENGTH);
  if (!text) {
    return { ok: false, error: "The message is empty.", retryable: false };
  }
  const body = jiraCommentBody(ctx.connection.config, text, input.files ?? []);
  const issue = input.item.externalId || input.item.key;
  const post = (parentId: string | null) =>
    jiraRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: jiraIssuePath(issue, "comment"),
        body: parentId ? { body, parentId } : { body },
      },
      jiraCreatedCommentSchema
    );
  let created = await post(input.parentId);
  if (
    !created.ok &&
    input.parentId &&
    created.error.kind === JiraErrorKind.BadRequest
  ) {
    created = await post(null);
  }
  return created.ok
    ? { ok: true, externalRef: created.value.id }
    : {
        ok: false,
        error: created.error.message,
        retryable: created.error.retryable,
      };
}

/** Replaces the text of a comment the orchestrator posted on a Jira issue. */
export async function jiraEditOnItem(
  ctx: JiraContext,
  input: ItemEditInput
): Promise<ItemReplyResult> {
  if (input.item.provider !== IntegrationProviderKey.Jira) {
    return {
      ok: false,
      error: "The item is not a Jira issue.",
      retryable: false,
    };
  }
  const text = truncateText(input.text.trim(), COMMENT_MAX_LENGTH);
  if (!text) {
    return { ok: false, error: "The message is empty.", retryable: false };
  }
  const updated = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Put,
      path: jiraIssuePath(
        input.item.externalId || input.item.key,
        `comment/${encodeURIComponent(input.externalRef)}`
      ),
      body: {
        body:
          ctx.connection.config.deployment === JiraDeployment.Cloud
            ? markdownToAdf(text)
            : text,
      },
    },
    jiraCreatedCommentSchema
  );
  return updated.ok
    ? { ok: true, externalRef: updated.value.id }
    : {
        ok: false,
        error: updated.error.message,
        retryable: updated.error.retryable,
      };
}
