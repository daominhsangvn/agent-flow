import {
  LOOP_STEP_ARTIFACT_KEY,
  LOOP_STEP_ATTACH_FILE_BYTES_MAX,
  LOOP_STEP_ATTACH_FILES_MAX,
  LOOP_STEP_ATTACH_TOTAL_BYTES_MAX,
  type LoopStepAttachment,
  LoopStepAttachmentSchema,
} from "@agentflow-ai/loops-api/loop-step";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  cleanFileName,
  uploadContentType,
} from "@/app/integration-tools/service/attachments";
import { getLoopPrefix, putLoopAttachment } from "@/lib/loops/loop-state";
import { isRecord } from "@/lib/type-guards";

const stepWithAttachmentsSchema = z
  .object({ attachments: z.array(LoopStepAttachmentSchema) })
  .passthrough();

/**
 * Moves the bytes of a step's collected attachments (`data`, base64) into the
 * loop-state bucket and replaces them with `storageKey`, so the loop record
 * stays small. Oversized or failed files are kept as `skipped` entries.
 */
export async function storeStepAttachments<
  T extends Record<string, unknown>,
>(input: { organizationId: string; loopId: string; artifacts: T }): Promise<T> {
  const { organizationId, loopId, artifacts } = input;
  const parsed = stepWithAttachmentsSchema.safeParse(
    artifacts[LOOP_STEP_ARTIFACT_KEY]
  );
  if (!parsed.success) {
    return withoutAttachments(artifacts);
  }
  if (parsed.data.attachments.length === 0) {
    return artifacts;
  }

  const prefix = `${getLoopPrefix(organizationId, loopId)}step-attachments/`;
  const stored: LoopStepAttachment[] = [];
  const entries = parsed.data.attachments.slice(0, LOOP_STEP_ATTACH_FILES_MAX);
  let totalBytes = 0;
  for (const [index, attachment] of entries.entries()) {
    const entry = await storeOne({
      attachment,
      index,
      prefix,
      loopId,
      totalBytes,
    });
    if (entry.storageKey) {
      totalBytes += entry.size;
    }
    stored.push(entry);
  }

  return {
    ...artifacts,
    [LOOP_STEP_ARTIFACT_KEY]: { ...parsed.data, attachments: stored },
  };
}

async function storeOne(input: {
  attachment: LoopStepAttachment;
  index: number;
  prefix: string;
  loopId: string;
  totalBytes: number;
}): Promise<LoopStepAttachment> {
  const { attachment, index, prefix, loopId, totalBytes } = input;
  const { path, data } = attachment;
  // A key sent by the runner is never trusted: only keys built here are kept.
  if (data === undefined) {
    return {
      path,
      size: attachment.size,
      skipped: attachment.skipped ?? "not collected",
    };
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > LOOP_STEP_ATTACH_FILE_BYTES_MAX) {
    return { path, size: attachment.size, skipped: "larger than 4 MB" };
  }
  if (totalBytes + bytes.byteLength > LOOP_STEP_ATTACH_TOTAL_BYTES_MAX) {
    return {
      path,
      size: bytes.byteLength,
      skipped: "over the 5 MB of all attached files",
    };
  }
  const basename = path.split("/").pop() ?? path;
  const storageKey = `${prefix}${index}-${cleanFileName(basename) ?? "file"}`;
  try {
    await putLoopAttachment({
      key: storageKey,
      bytes,
      contentType: uploadContentType(null, basename),
    });
    return { path, size: bytes.byteLength, storageKey };
  } catch {
    log.warn("[step-attachments] not stored", { loopId, path });
    return { path, size: bytes.byteLength, skipped: "could not be stored" };
  }
}

/** The artifacts without the step's raw attachments, so no base64 data is persisted. */
function withoutAttachments<T extends Record<string, unknown>>(
  artifacts: T
): T {
  const step = artifacts[LOOP_STEP_ARTIFACT_KEY];
  if (!(isRecord(step) && Object.hasOwn(step, "attachments"))) {
    return artifacts;
  }
  const { attachments: _dropped, ...rest } = step;
  return { ...artifacts, [LOOP_STEP_ARTIFACT_KEY]: rest };
}
