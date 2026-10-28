import type { AgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { resolveDisplayedStatusParity } from "../route-helpers";
import { agentSessionsService } from "../service";
import { baseAgentSessionQuerySchema } from "../validators";

// FEA-4155: no `monitoringEnabled` flag gate (see the sibling list route). The
// Sessions surface is always-on now, so this analytics read must not 403 as the
// winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. Reads stay
// org-scoped in the service.
export const GET = withAnyAuth<
  AgentSessionAnalytics,
  "/agent-sessions/analytics"
>(async ({ user, clerkUserId }, request) => {
  const { params, errorResponse } = parseQueryParams(
    request,
    baseAgentSessionQuerySchema
  );
  if (errorResponse) {
    return errorResponse;
  }

  const analytics = await agentSessionsService.getAnalytics({
    organizationId: user.organizationId,
    // FEA-3534: enforce `viewerScope=self` for Me-scoped analytics reads.
    viewerId: user.id,
    // ISS-4556 / ISS-4559: same cohort as the list and usage reads — resolve the
    // same gate so the analytics fold cannot count a different population.
    displayedStatusParity: await resolveDisplayedStatusParity({
      userId: user.id,
      clerkUserId,
    }),
    filters: params,
  });

  return successResponse(analytics);
});
