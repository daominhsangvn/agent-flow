import { z } from "zod";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { planStateService } from "../../plan-state-service";

const uploadValidator = z.object({
  // Whether this state also becomes the plan's latest (a failed loop saves
  // only its own copy: its plan may be half-made, its code unpushed).
  latest: z.boolean(),
});

/**
 * GET /api/loops/:id/plan-state — a presigned GET for the latest saved state
 * of the loop's plan, or `state: null` when there is none yet. The runner
 * restores it before an EXECUTE, a REQUEST_CHANGES or a re-plan.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;
    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/plan-state"
    );
    if (claims instanceof Response) {
      return claims;
    }
    const url = await planStateService.latestDownloadUrl(
      loopId,
      claims.organizationId
    );
    return successResponse({ state: url ? { url } : null });
  } catch (error) {
    return errorResponse("Failed to read the plan state", error);
  }
}

/**
 * POST /api/loops/:id/plan-state — presigned PUTs for the state the loop
 * saves at its end: its own copy, plus the plan's latest when `latest`.
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
      "loops/[id]/plan-state"
    );
    if (claims instanceof Response) {
      return claims;
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      uploadValidator
    );
    if (parseError || !body) {
      return parseError;
    }
    const urls = await planStateService.uploadUrls(
      loopId,
      claims.organizationId,
      body.latest
    );
    if (!urls) {
      return errorResponse(
        "The loop does not work on a plan",
        new Error("Not Found"),
        404
      );
    }
    return successResponse({ urls });
  } catch (error) {
    return errorResponse("Failed to prepare the plan state upload", error);
  }
}
