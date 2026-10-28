import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowRunDetail,
  WorkflowRunRetryMode,
  workflowRunRetryRequestSchema,
} from "@repo/api/src/types/workflow";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

const ROUTE = "/workflow-runs/[runId]/retry";

/**
 * POST /workflow-runs/{runId}/retry
 * Runs the failed step of a failed run again (a new loop in a new cycle):
 * body `{ mode: "restart" }` (default) starts the step over, `{ mode:
 * "resume" }` goes on with its failed agent session in a fork. Org admins only.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/retry"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { runId } = await params;
    const mode = await readRetryMode(request);
    if (!mode.ok) {
      return badRequestResponse(mode.error);
    }
    const result = await workflowRunService.retry(
      auth.user.organizationId,
      runId,
      mode.value
    );
    scheduleLogFlush();
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to retry workflow run", error);
  }
});

/** The retry mode of the body; without a body (older clients) the step restarts. */
async function readRetryMode(
  request: Request
): Promise<Result<WorkflowRunRetryMode, string>> {
  const text = (await request.text()).trim();
  if (!text) {
    return Result.ok(WorkflowRunRetryMode.Restart);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return Result.err("Invalid JSON body");
  }
  const body = workflowRunRetryRequestSchema.safeParse(raw);
  return body.success
    ? Result.ok(body.data.mode)
    : Result.err(
        `Invalid retry mode: use "${WorkflowRunRetryMode.Resume}" or "${WorkflowRunRetryMode.Restart}"`
      );
}
