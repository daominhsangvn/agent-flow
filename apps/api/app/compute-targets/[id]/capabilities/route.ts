import {
  type ComputeTargetCapabilities,
  RUNNER_CAPABILITIES_MAX_CHARS,
  uploadRunnerCapabilitiesInputSchema,
} from "@repo/api/src/types/runner-capabilities";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetCapabilitiesService } from "../../capabilities-service";

/** The file plus its JSON envelope and warnings. */
const UPLOAD_MAX_BYTES = RUNNER_CAPABILITIES_MAX_CHARS * 4 + 65_536;

/**
 * GET /compute-targets/:id/capabilities
 * The runner's `AGENTFLOW.md` files, one per project.
 */
export const GET = withAnyAuth<
  ComputeTargetCapabilities[],
  "/compute-targets/[id]/capabilities"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const files = await computeTargetCapabilitiesService.listForTarget(
      user.organizationId,
      user.id,
      id
    );
    if (!files) {
      return notFoundResponse("Compute target");
    }
    return successResponse(files);
  } catch (error) {
    return errorResponse("Failed to fetch runner capabilities", error);
  }
});

/**
 * PUT /compute-targets/:id/capabilities
 * The runner uploads its `AGENTFLOW.md` for a project (its owner's API key).
 */
export const PUT = withAnyAuth<
  ComputeTargetCapabilities,
  "/compute-targets/[id]/capabilities"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      uploadRunnerCapabilitiesInputSchema,
      { maxBytes: UPLOAD_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await computeTargetCapabilitiesService.upload(
      user.organizationId,
      user.id,
      id,
      body
    );
    if (!result.ok) {
      return notFoundResponse("Compute target or project");
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to store runner capabilities", error);
  }
});
