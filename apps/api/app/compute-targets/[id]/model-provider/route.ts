import {
  type ComputeTargetModelProvider,
  updateComputeTargetModelProviderInputSchema,
} from "@repo/api/src/types/compute-target-model-provider";
import { computeTargetModelProviderService } from "@/app/compute-targets/model-provider-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/** Bodies hold a base URL, a token and up to 30 short variables. */
const MODEL_PROVIDER_BODY_MAX_BYTES = 256 * 1024;

/**
 * GET /compute-targets/{id}/model-provider
 * The target's model provider (the token only as isSet + last four). Owner only.
 */
export const GET = withAnyAuth<
  ComputeTargetModelProvider,
  "/compute-targets/[id]/model-provider"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const provider = await computeTargetModelProviderService.get(
      user.organizationId,
      user.id,
      id
    );
    if (!provider) {
      return notFoundResponse("Compute target");
    }
    return successResponse(provider);
  } catch (error) {
    return errorResponse("Failed to load the model provider", error);
  }
});

/**
 * PUT /compute-targets/{id}/model-provider
 * Sets which endpoint Claude Code uses for loops on this computer, e.g. an
 * Anthropic-compatible API such as DeepSeek. Owner only.
 */
export const PUT = withAnyAuth<
  ComputeTargetModelProvider,
  "/compute-targets/[id]/model-provider"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateComputeTargetModelProviderInputSchema,
      { maxBytes: MODEL_PROVIDER_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const provider = await computeTargetModelProviderService.update(
      user.organizationId,
      user.id,
      id,
      body
    );
    if (!provider) {
      return notFoundResponse("Compute target");
    }
    return successResponse(provider);
  } catch (error) {
    return errorResponse("Failed to save the model provider", error);
  }
});
