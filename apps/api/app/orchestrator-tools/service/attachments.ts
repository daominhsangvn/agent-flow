import { Result } from "@repo/api/src/types/result";
import {
  cleanFileName,
  uploadContentType,
} from "@/app/integration-tools/service/attachments";
import { createProviderContext } from "@/lib/integrations/connection-service";
import type { loadProjectConnectionRuntime } from "@/lib/integrations/project-connections";
import type { SourceItemFile, SourceItemRef } from "@/lib/integrations/types";
import { getLoopAttachment } from "@/lib/loops/loop-state";
import {
  findCaseTaskFiles,
  type TaskFileRef,
} from "@/lib/orchestrator/task-files";
import { scrubProviderError } from "@/lib/workflows/engine/errors";

/**
 * Files of the case's tasks that `reply` attaches to the conversation's item
 * before it posts the message (the provider's `attachFile`, the code behind
 * `$AGENTFLOW_ATTACH`).
 */

export const REPLY_ATTACHMENTS_MAX = 10;

const LOG_PREFIX = "[orchestrator-tools]";

type ConversationConnection = NonNullable<
  Awaited<ReturnType<typeof loadProjectConnectionRuntime>>
>["connection"];

type UploadFailure = { error: string; retryable: boolean };

/** Uploads the referenced files one after the other; the first failure stops it, nothing is posted. */
export async function uploadReplyFiles(input: {
  caseId: string;
  refs: TaskFileRef[];
  connection: ConversationConnection;
  item: SourceItemRef;
}): Promise<Result<SourceItemFile[], UploadFailure>> {
  const { connection, item } = input;
  const attachFile = connection.provider.source?.attachFile;
  if (!attachFile) {
    return failure(
      `This conversation's thread takes no files (${item.provider}): reply without attachments and name the files instead.`,
      false
    );
  }
  const found = await findCaseTaskFiles(input.caseId, input.refs);
  if (!found.ok) {
    return failure(found.error, false);
  }
  const uploaded: SourceItemFile[] = [];
  for (const file of found.value) {
    let bytes: Uint8Array;
    try {
      bytes = await getLoopAttachment(file.storageKey);
    } catch {
      return failure(
        withProgress(
          `File "${file.name}" could not be read from storage.`,
          uploaded
        ),
        false
      );
    }
    const name = cleanFileName(file.name) ?? "file";
    try {
      const attached = await attachFile(
        createProviderContext(connection.runtime, LOG_PREFIX),
        item,
        { name, contentType: uploadContentType(null, name), bytes }
      );
      if (!attached.ok) {
        return failure(
          withProgress(
            scrubProviderError(
              attached.error.message,
              connection.runtime.secrets
            ),
            uploaded
          ),
          attached.error.retryable
        );
      }
      uploaded.push(attached.value);
    } catch (error) {
      return failure(
        withProgress(
          scrubProviderError(error, connection.runtime.secrets),
          uploaded
        ),
        false
      );
    }
  }
  return Result.ok(uploaded);
}

function failure(
  error: string,
  retryable: boolean
): Result<SourceItemFile[], UploadFailure> {
  return Result.err({ error, retryable });
}

function withProgress(message: string, uploaded: SourceItemFile[]): string {
  const names = uploaded.map((file) => file.name).join(", ") || "none";
  return `${message} Attached before it: ${names}. Nothing was posted.`;
}
