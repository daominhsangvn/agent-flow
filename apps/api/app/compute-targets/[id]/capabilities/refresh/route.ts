import { failure } from "@repo/api/src/types/common";
import {
  type RunnerCapabilitiesRefresh,
  requestRunnerCapabilitiesRefreshInputSchema,
} from "@repo/api/src/types/runner-capabilities";
import { NextResponse } from "next/server";
import { computeTargetCapabilitiesRefreshService } from "@/app/compute-targets/capabilities-refresh-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

const ROUTE = "/compute-targets/[id]/capabilities/refresh";
const BODY_MAX_BYTES = 8192;

/**
 * POST /compute-targets/:id/capabilities/refresh
 * Asks an auto runner to read AGENTFLOW.md from the project's toolkit
 * repository. Org admins only.
 */
export const POST = withAnyAuth<
  RunnerCapabilitiesRefresh,
  "/compute-targets/[id]/capabilities/refresh"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      "the runner capabilities refresh"
    );
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      requestRunnerCapabilitiesRefreshInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await computeTargetCapabilitiesRefreshService.request(
      auth.user.organizationId,
      id,
      body
    );
    if (!result.ok) {
      return NextResponse.json(failure(result.error.message), {
        status: result.error.status,
      });
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to request a capabilities refresh", error);
  }
});
