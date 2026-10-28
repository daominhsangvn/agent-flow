import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import {
  HttpMethod,
  type SourceItemFile,
  type SourceItemFileError,
  type SourceItemFileUpload,
  type SourceItemRef,
} from "../../types";
import {
  type AdfBlockNode,
  type AdfListItem,
  markdownToAdf,
} from "../atlassian/adf";
import { type JiraContext, jiraIssuePath, jiraRequest } from "./client";
import { JiraDeployment } from "./constants";
import { type JiraConnectionConfig, jiraAttachmentSchema } from "./schemas";

/**
 * Files an agent attaches to the run's Jira issue for a comment (test
 * evidence, screenshots): uploaded to the issue's attachments, then shown in
 * the comment. Cloud comments are ADF: images as external media pointing at
 * the attachment's content URL (rendered with the reader's own Jira session),
 * every file as a link. Data Center comments are wiki markup: `!name|thumbnail!`
 * for images and `[^name]` for other files, resolved against the issue's
 * attachments.
 */

export async function attachJiraFile(
  ctx: JiraContext,
  ref: SourceItemRef,
  file: SourceItemFileUpload
): Promise<Result<SourceItemFile, SourceItemFileError>> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
    file.name
  );
  const created = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: jiraIssuePath(ref.externalId || ref.key, "attachments"),
      // Jira refuses multipart uploads without it (XSRF check).
      headers: { "x-atlassian-token": "no-check" },
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    },
    jiraCreatedAttachmentsSchema
  );
  if (!created.ok) {
    return Result.err({
      message: `Jira could not attach ${file.name}: ${created.error.message}`,
      retryable: created.error.retryable,
    });
  }
  const [attachment] = created.value;
  if (!attachment?.id) {
    return Result.err({
      message: `Jira did not return the attachment of ${file.name}.`,
      retryable: false,
    });
  }
  return Result.ok({
    id: attachment.id,
    name: attachment.filename ?? file.name,
    contentType: attachment.mimeType ?? file.contentType,
  });
}

/** ADF blocks that show the files below a Cloud comment. */
export function jiraCloudAttachmentBlocks(
  config: JiraConnectionConfig,
  files: readonly SourceItemFile[]
): AdfBlockNode[] {
  if (files.length === 0) {
    return [];
  }
  const images: AdfBlockNode[] = files.filter(isImage).map((file) => ({
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [
      {
        type: "media",
        attrs: { type: "external", url: jiraAttachmentUrl(config, file) },
      },
    ],
  }));
  const links: AdfListItem[] = files.map((file) => ({
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: file.name,
            marks: [
              {
                type: "link",
                attrs: { href: jiraAttachmentUrl(config, file) },
              },
            ],
          },
        ],
      },
    ],
  }));
  return [
    ...images,
    {
      type: "paragraph",
      content: [{ type: "text", text: "Attachments", marks: [STRONG] }],
    },
    { type: "bulletList", content: links },
  ];
}

/** Wiki markup that shows the files below a Data Center comment. */
export function jiraDataCenterAttachmentText(
  files: readonly SourceItemFile[]
): string {
  if (files.length === 0) {
    return "";
  }
  const images = files
    .filter(isImage)
    .map((file) => `!${file.name}|thumbnail!`);
  const links = files.map((file) => `* [^${file.name}]`);
  return [
    ...(images.length > 0 ? [images.join(" ")] : []),
    "*Attachments*",
    ...links,
  ].join("\n");
}

/** The attachment as a person opens it in the browser (not the API gateway). */
export function jiraAttachmentUrl(
  config: JiraConnectionConfig,
  file: SourceItemFile
): string {
  const id = encodeURIComponent(file.id);
  return config.deployment === JiraDeployment.Cloud
    ? `${config.siteUrl}/rest/api/3/attachment/content/${id}`
    : `${config.siteUrl}/secure/attachment/${id}/${encodeURIComponent(file.name)}`;
}

const UPLOAD_TIMEOUT_MS = 60_000;
const STRONG = { type: "strong" } as const;

const jiraCreatedAttachmentsSchema = z.array(jiraAttachmentSchema);

function isImage(file: SourceItemFile): boolean {
  return file.contentType.toLowerCase().startsWith("image/");
}

/** The comment's text with the files it shows. */
export function jiraCommentBody(
  config: JiraConnectionConfig,
  text: string,
  files: readonly SourceItemFile[]
): JsonValue {
  if (config.deployment === JiraDeployment.Cloud) {
    const document = markdownToAdf(text);
    return {
      ...document,
      content: [
        ...document.content,
        ...jiraCloudAttachmentBlocks(config, files),
      ],
    };
  }
  const attached = jiraDataCenterAttachmentText(files);
  return attached ? `${text}\n\n${attached}` : text;
}
