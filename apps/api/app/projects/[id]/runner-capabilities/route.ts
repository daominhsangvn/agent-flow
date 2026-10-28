import type { ComputeTargetCapabilities } from "@repo/api/src/types/runner-capabilities";
import { computeTargetCapabilitiesService } from "@/app/compute-targets/capabilities-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /projects/{id}/runner-capabilities
 * Every runner's `AGENTFLOW.md` for the project: the commands and skills each
 * runner declares (docs/runner.md "Capabilities (AGENTFLOW.md)"). Any org member.
 */
export const GET = withAnyAuth<
  ComputeTargetCapabilities[],
  "/projects/[id]/runner-capabilities"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const projectId = await resolveProjectId(id, user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    return successResponse(
      await computeTargetCapabilitiesService.listForProject(
        user.organizationId,
        projectId
      )
    );
  } catch (error) {
    return errorResponse("Failed to read the runners' capabilities", error);
  }
});
