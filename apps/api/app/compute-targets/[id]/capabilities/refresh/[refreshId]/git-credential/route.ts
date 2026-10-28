import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { NextResponse } from "next/server";
import { computeTargetCapabilitiesRefreshService } from "@/app/compute-targets/capabilities-refresh-service";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";
import {
  formatGitCredential,
  parseGitCredentialRequest,
} from "@/lib/loops/loop-git-credential";
import { errorResponse } from "@/lib/route-utils";

/** Git sends a few short lines; anything larger is not a credential request. */
const MAX_BODY_BYTES = 4096;

/**
 * POST /compute-targets/:id/capabilities/refresh/:refreshId/git-credential
 * Git credential for the toolkit repository of a running refresh. Called by
 * the runner's git credential helper with the runner owner's API key (browser sessions are refused: only a
 * programmatic key may fetch repository tokens). The
 * body and the response are git's credential format (`key=value` lines).
 */
export const POST = withApiKeyAuth<
  string,
  "/compute-targets/[id]/capabilities/refresh/[refreshId]/git-credential"
>(
  async ({ user }, request, params) => {
    try {
      const { id, refreshId } = await params;
      const body = await request.text();
      const credentialRequest =
        body.length <= MAX_BODY_BYTES ? parseGitCredentialRequest(body) : null;
      if (!credentialRequest) {
        return errorResponse(
          "Expected a git credential request (protocol and host)",
          new Error("Bad Request"),
          400
        );
      }
      const issued =
        await computeTargetCapabilitiesRefreshService.issueGitCredential(
          user.organizationId,
          user.id,
          id,
          refreshId,
          credentialRequest
        );
      if (!issued.ok) {
        return errorResponse(
          issued.error.message,
          new Error(issued.error.message),
          issued.error.status
        );
      }
      return new NextResponse(formatGitCredential(issued.value), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      return errorResponse("Failed to issue a git credential", error);
    }
  },
  { requiredScopes: [ApiKeyScope.Write] }
);
