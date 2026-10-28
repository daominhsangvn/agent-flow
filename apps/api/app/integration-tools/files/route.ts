import {
  INTEGRATION_ATTACHMENT_MAX_BYTES,
  INTEGRATION_FILE_NAME_HEADER,
  type IntegrationToolCallResponse,
} from "@repo/api/src/types/integration-tools";
import { Status } from "@repo/api/src/types/result";
import type { NextRequest } from "next/server";
import { integrationToolService } from "@/app/integration-tools/integration-tool-service";
import { uploadContentType } from "@/app/integration-tools/service/attachments";
import {
  badRequestResponse,
  errorResponse,
  getBearerToken,
  notFoundResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * A file an agent attaches to the run's source item for a comment
 * (docs/workflows.md "Integration tools"): the raw bytes as the body, the
 * session token as Bearer, the URI-encoded name in X-File-Name. Answers like
 * a tool call: `{ ok: true, output: { id, name, contentType, size } }`, or a
 * refusal or provider failure the agent can read.
 */
export async function POST(request: NextRequest) {
  const token = getBearerToken(request);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > INTEGRATION_ATTACHMENT_MAX_BYTES) {
    return payloadTooLargeResponse(TOO_LARGE);
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > INTEGRATION_ATTACHMENT_MAX_BYTES) {
      return payloadTooLargeResponse(TOO_LARGE);
    }
    if (bytes.byteLength === 0) {
      return badRequestResponse(
        "The file is empty: send its bytes as the body."
      );
    }
    const name = request.headers.get(INTEGRATION_FILE_NAME_HEADER) ?? "";
    const result = await integrationToolService.attach(token, {
      name,
      contentType: uploadContentType(request.headers.get("content-type"), name),
      bytes,
    });
    if (result.ok) {
      return successResponse<IntegrationToolCallResponse>(result.value);
    }
    return result.error === Status.Unauthorized
      ? unauthorizedResponse()
      : notFoundResponse("Integration tool session");
  } catch (error) {
    return errorResponse("Failed to attach the file", error);
  }
}

const TOO_LARGE = `The file is larger than ${INTEGRATION_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`;
