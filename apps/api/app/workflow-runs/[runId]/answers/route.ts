import { answerStepQuestionsInputSchema } from "@repo/api/src/types/project-process";
import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import { serviceErrorResponse } from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunStepInputService } from "@/lib/workflows/run-step-input-service";

/** Up to 20 answers of ≤ 4000 characters each. */
const BODY_MAX_BYTES = 128 * 1024;

/**
 * POST /workflow-runs/{runId}/answers
 * Answers the questions of the process step the run waits on (`{ answers:
 * [{ id, answer }] }`); the step resumes its agent session with them. Any org
 * member, like answering on the source item.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/answers"
>(async ({ user }, request, params) => {
  try {
    const { runId } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      answerStepQuestionsInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await workflowRunStepInputService.answerQuestions(
      user.organizationId,
      user.id,
      runId,
      body
    );
    scheduleLogFlush();
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to answer the run's questions", error);
  }
});
