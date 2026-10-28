import { Status } from "@repo/api/src/types/result";
import { integrationToolSessionService } from "@/app/integration-tools/integration-tool-session-service";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * POST /api/loops/:id/integration-session — the integration tool session
 * token of a STEP loop whose process step grants connections
 * (docs/workflows.md "Integration tools"). Called by the loop's runner,
 * authenticated with the loop-runner JWT; 404 when the step grants none.
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
      "loops/[id]/integration-session"
    );
    if (claims instanceof Response) {
      return claims;
    }
    const issued = await integrationToolSessionService.issueForLoop({
      organizationId: claims.organizationId,
      loopId,
    });
    if (issued.ok) {
      return successResponse(issued.value);
    }
    return issued.error === Status.NotFound
      ? notFoundResponse("Integration tool session")
      : errorResponse("Failed to open the integration tool session", null);
  } catch (error) {
    return errorResponse("Failed to open the integration tool session", error);
  }
}
