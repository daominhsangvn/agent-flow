import { createHash } from "node:crypto";
import {
  INTEGRATION_ATTACHMENT_NAME_MAX,
  type IntegrationToolCallResponse,
  IntegrationToolCallStatus,
  IntegrationToolName,
  type IntegrationUploadedFile,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { acceptsAttachments } from "@/lib/integrations/agent-tools/catalog";
import { createProviderContext } from "@/lib/integrations/connection-service";
import type {
  SourceItemFile,
  SourceItemFileError,
} from "@/lib/integrations/types";
import { isRecord } from "@/lib/type-guards";
import { scrubProviderError } from "@/lib/workflows/engine/errors";
import {
  type CallRecordInput,
  finishCall,
  recordSettledCall,
  startWriteCall,
  writeBudgetSpent,
} from "./call-records";
import type { ToolSessionContext } from "./session-context";

/**
 * Files an agent attaches to the run's source item for a comment
 * (`source_item_comment` `attachments`, docs/workflows.md "Integration
 * tools"). The upload is a write of its own: allowed only when the session's
 * comment tool takes files (a `source: [comment]` grant without approval, on
 * a provider that attaches files), counted in the write budget, recorded as
 * `source_item_attach` and idempotent on the file's content and name. The
 * provider attaches the file at once; the comment then names it by the id
 * the upload answered, which must be one of this session's uploads.
 */

export type FileUpload = {
  /** As the agent sent it (URI-encoded header), cleaned here. */
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

/** What a session's upload is recorded under (counted as a write). */
export const SOURCE_ATTACH_OPERATION = "source.attach_file";

export async function attachSourceFile(
  context: ToolSessionContext,
  upload: FileUpload
): Promise<IntegrationToolCallResponse> {
  const name = cleanFileName(upload.name);
  const record: CallRecordInput = {
    session: context.session,
    tool: IntegrationToolName.SourceItemAttach,
    operationType: SOURCE_ATTACH_OPERATION,
    connectionKey: context.input.source.key,
    input: {
      name: name ?? upload.name.slice(0, INTEGRATION_ATTACHMENT_NAME_MAX),
      contentType: upload.contentType,
      size: upload.bytes.byteLength,
      sha256: createHash("sha256").update(upload.bytes).digest("hex"),
    },
  };
  const attachFile = context.sourceConnection?.provider.source?.attachFile;
  if (!(context.tools.some(acceptsAttachments) && attachFile)) {
    return await refuse(
      record,
      "This session cannot attach files: the workflow must grant source: [comment] (without approval) on a connection whose provider attaches files to comments."
    );
  }
  if (!name) {
    return await refuse(record, "Name the file in the X-File-Name header.");
  }
  if (await writeBudgetSpent(context.session.id, context.writeBudget)) {
    return await refuse(
      record,
      `This session already carried out its ${context.writeBudget} writes; post the comment without more files.`
    );
  }
  const started = await startWriteCall(record);
  if (!started.ok) {
    return started.error.kind === "succeeded" && started.error.externalRef
      ? { ok: true, output: uploadedOutput(started.error.externalRef, record) }
      : {
          ok: false,
          error: "An identical upload is still running.",
          retryable: true,
        };
  }
  const { runtime } = context.sourceConnection ?? {};
  const attached: Result<SourceItemFile, SourceItemFileError> = runtime
    ? await attachFile(
        createProviderContext(runtime, LOG_PREFIX),
        context.snapshot.source,
        { name, contentType: upload.contentType, bytes: upload.bytes }
      ).catch((error: unknown) =>
        Result.err({
          message: scrubProviderError(error, runtime.secrets),
          retryable: true,
        })
      )
    : Result.err({
        message: "The run's source connection is no longer available.",
        retryable: false,
      });
  await finishCall(started.value.id, {
    status: attached.ok
      ? IntegrationToolCallStatus.Succeeded
      : IntegrationToolCallStatus.Failed,
    externalRef: attached.ok ? attached.value.id : null,
    error: attached.ok ? null : attached.error.message,
  });
  return attached.ok
    ? { ok: true, output: uploadedOutput(attached.value.id, record) }
    : {
        ok: false,
        error: attached.error.message,
        retryable: attached.error.retryable,
      };
}

/**
 * The files of this session's uploads with these ids, in the order given;
 * an error names the first id that is not one.
 */
export async function findSessionFiles(
  sessionId: string,
  ids: readonly string[]
): Promise<Result<SourceItemFile[], string>> {
  if (ids.length === 0) {
    return Result.ok([]);
  }
  const rows = await withDb((db) =>
    db.integrationToolCall.findMany({
      where: {
        sessionId,
        tool: IntegrationToolName.SourceItemAttach,
        status: IntegrationToolCallStatus.Succeeded,
        externalRef: { in: [...ids] },
      },
      select: { externalRef: true, input: true },
    })
  );
  const files: SourceItemFile[] = [];
  for (const id of new Set(ids)) {
    const row = rows.find((candidate) => candidate.externalRef === id);
    const input = isRecord(row?.input) ? row.input : null;
    if (!(input && typeof input.name === "string")) {
      return Result.err(
        `attachments: "${id}" is not a file this session uploaded. Upload it first and use the id the upload returned.`
      );
    }
    files.push({
      id,
      name: input.name,
      contentType:
        typeof input.contentType === "string"
          ? input.contentType
          : DEFAULT_CONTENT_TYPE,
    });
  }
  return Result.ok(files);
}

/**
 * The Content-Type of an upload; without a specific one (a runner without
 * `file`), the type of a common evidence file by its extension.
 */
export function uploadContentType(
  header: string | null,
  fileName: string
): string {
  const type = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (CONTENT_TYPE_RE.test(type) && type !== DEFAULT_CONTENT_TYPE) {
    return type;
  }
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return TYPES_BY_EXTENSION[extension] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * A file name safe for every provider (Jira wiki markup uses `!`, `|`, `[`,
 * `]` and `^`): the last path segment, those and control characters replaced.
 * Null when nothing is left.
 */
export function cleanFileName(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not URI-encoded: used as sent.
  }
  const base = decoded.split(PATH_SEPARATOR_RE).pop() ?? "";
  const cleaned = base
    .replaceAll(UNSAFE_NAME_CHARS_RE, "_")
    .trim()
    .slice(0, INTEGRATION_ATTACHMENT_NAME_MAX);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? null : cleaned;
}

const LOG_PREFIX = "[integration-tools]";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const CONTENT_TYPE_RE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const PATH_SEPARATOR_RE = /[/\\]/;
const TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const UNSAFE_NAME_CHARS_RE = /[\u0000-\u001f\u007f!|[\]^*?"<>:]/g;

function uploadedOutput(
  id: string,
  record: CallRecordInput
): IntegrationUploadedFile {
  return {
    id,
    name: String(record.input.name),
    contentType: String(record.input.contentType),
    size: Number(record.input.size),
  };
}

async function refuse(
  record: CallRecordInput,
  error: string
): Promise<IntegrationToolCallResponse> {
  await recordSettledCall(record, {
    status: IntegrationToolCallStatus.Refused,
    error,
  });
  return { ok: false, error: `Not allowed: ${error}`, retryable: false };
}
