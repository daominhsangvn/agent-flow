import {
  type ProjectAgentInstructions,
  updateProjectAgentInstructionsInputSchema,
} from "@repo/api/src/types/project-agent-instructions";
import { projectAgentInstructionsService } from "@/app/projects/project-agent-instructions-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const ROUTE = "/projects/[id]/agent-instructions";
const BODY_MAX_BYTES = 64 * 1024;

/**
 * GET /projects/{id}/agent-instructions
 * The project's agent instructions ("" when unset). Any org member.
 */
export const GET = withAnyAuth<
  ProjectAgentInstructions,
  "/projects/[id]/agent-instructions"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const projectId = await resolveProjectId(id, user.organizationId);
    const found = projectId
      ? await projectAgentInstructionsService.get(
          user.organizationId,
          projectId
        )
      : null;
    return found ? successResponse(found) : notFoundResponse("Project");
  } catch (error) {
    return errorResponse("Failed to read agent instructions", error);
  }
});

/**
 * PUT /projects/{id}/agent-instructions
 * Saves the instructions every agent loop of the project reads first. Org
 * admins only, like the project's repositories.
 */
export const PUT = withAnyAuth<
  ProjectAgentInstructions,
  "/projects/[id]/agent-instructions"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      "agent instructions"
    );
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateProjectAgentInstructionsInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const saved = await projectAgentInstructionsService.update(
      auth.user.organizationId,
      projectId,
      body
    );
    return saved ? successResponse(saved) : notFoundResponse("Project");
  } catch (error) {
    return errorResponse("Failed to save agent instructions", error);
  }
});
