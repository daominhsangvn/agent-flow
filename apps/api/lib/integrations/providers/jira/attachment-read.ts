import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import {
  HttpMethod,
  type SourceItemFileError,
  type SourceItemFileText,
  type SourceItemRef,
} from "../../types";
import { jiraRestBaseUrl } from "./auth";
import {
  type JiraContext,
  jiraDownloadText,
  jiraIssuePath,
  jiraRequest,
} from "./client";
import { JiraDeployment } from "./constants";
import { type JiraAttachment, jiraAttachmentSchema } from "./schemas";

/**
 * The text of one file attached to the run's Jira issue, read with the
 * connection's credentials for an agent's `source_item_attachment_read`
 * (the computer that runs the agent holds none). The file is found by its
 * name among the issue's attachments; only text files up to
 * ATTACHMENT_TEXT_MAX_BYTES are read. Cloud downloads through the REST
 * content endpoint, Data Center through the attachment's link on the site.
 */

export const ATTACHMENT_TEXT_MAX_BYTES = 1_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const BINARY_MARKER = "\u0000";
const LISTED_NAMES_MAX = 20;

const issueAttachmentsSchema = z.looseObject({
  fields: z.looseObject({
    attachment: z.array(jiraAttachmentSchema).nullish().catch(null),
  }),
});

export async function readJiraAttachment(
  ctx: JiraContext,
  ref: SourceItemRef,
  name: string
): Promise<Result<SourceItemFileText, SourceItemFileError>> {
  const issue = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(ref.externalId || ref.key),
      query: { fields: "attachment" },
    },
    issueAttachmentsSchema
  );
  if (!issue.ok) {
    return Result.err({
      message: `Could not read the attachments of ${ref.key}: ${issue.error.message}`,
      retryable: issue.error.retryable,
    });
  }
  const attachments = issue.value.fields.attachment ?? [];
  const wanted = name.trim().toLowerCase();
  const attachment = attachments.find(
    (candidate) => candidate.filename?.trim().toLowerCase() === wanted
  );
  if (!attachment) {
    return notFound(ref.key, name, attachments);
  }
  const fileName = attachment.filename ?? name;
  if ((attachment.size ?? 0) > ATTACHMENT_TEXT_MAX_BYTES) {
    return Result.err({
      message: `${fileName} is ${attachment.size} bytes; only files up to ${ATTACHMENT_TEXT_MAX_BYTES} bytes are read.`,
      retryable: false,
    });
  }
  const url = contentUrl(ctx, attachment);
  if (!url) {
    return Result.err({
      message: `${fileName} has no download link on this Jira site.`,
      retryable: false,
    });
  }
  const text = await jiraDownloadText(ctx, url, DOWNLOAD_TIMEOUT_MS);
  if (!text.ok) {
    return Result.err({
      message: `Jira could not send ${fileName}: ${text.error.message}`,
      retryable: text.error.retryable,
    });
  }
  if (text.value.includes(BINARY_MARKER)) {
    return Result.err({
      message: `${fileName} is not a text file (${attachment.mimeType ?? "unknown type"}).`,
      retryable: false,
    });
  }
  return Result.ok({
    name: fileName,
    contentType: attachment.mimeType ?? null,
    size: attachment.size ?? null,
    text: text.value,
  });
}

function notFound(
  key: string,
  name: string,
  attachments: JiraAttachment[]
): Result<never, SourceItemFileError> {
  const names = attachments
    .map((attachment) => attachment.filename)
    .filter((filename): filename is string => Boolean(filename));
  const listed =
    names.length > 0
      ? names.slice(0, LISTED_NAMES_MAX).join(", ")
      : "it has none";
  return Result.err({
    message: `${key} has no attachment named "${name}" (attachments: ${listed}).`,
    retryable: false,
  });
}

/**
 * Cloud: the REST content endpoint (through the API gateway for a scoped
 * token). Data Center: the issue's own content link, on the connection's site.
 */
function contentUrl(
  ctx: JiraContext,
  attachment: JiraAttachment
): string | null {
  const { config } = ctx.connection;
  if (config.deployment === JiraDeployment.Cloud) {
    return attachment.id
      ? `${jiraRestBaseUrl(config)}/attachment/content/${encodeURIComponent(attachment.id)}`
      : null;
  }
  const url = attachment.content ?? "";
  return url.toLowerCase().startsWith(`${config.siteUrl.toLowerCase()}/`)
    ? url
    : null;
}
