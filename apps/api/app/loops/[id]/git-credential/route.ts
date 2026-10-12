import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  formatGitCredential,
  issueLoopGitCredential,
  parseGitCredentialRequest,
} from "@/lib/loops/loop-git-credential";
import { errorResponse } from "@/lib/route-utils";

/** Git sends a few short lines; anything larger is not a credential request. */
const MAX_BODY_BYTES = 4096;

/**
 * POST /api/loops/:id/git-credential — git credential for one of the loop's
 * project repositories (lib/loops/loop-git-credential.ts).
 *
 * Called by the git credential helper of a running loop, authenticated with
 * the loop-runner JWT. The body and the response are git's credential format
 * (`key=value` lines), so the helper pipes them straight through.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;
    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/git-credential"
    );
    if (claims instanceof Response) {
      return claims;
    }

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

    const issued = await issueLoopGitCredential({
      loopId,
      organizationId: claims.organizationId,
      request: credentialRequest,
    });
    if (!issued.ok) {
      return errorResponse(
        issued.error.message,
        new Error(issued.error.message),
        issued.error.status
      );
    }
    return new Response(formatGitCredential(issued.value), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return errorResponse("Failed to issue a git credential", error);
  }
}
