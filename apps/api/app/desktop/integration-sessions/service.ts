import type {
  IntegrationSessionGrant,
  IntegrationSessionRequest,
} from "@repo/api/src/types/integration-tools";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { computeTargetsService } from "@/app/compute-targets/service";
import { integrationToolSessionService } from "@/app/integration-tools/integration-tool-session-service";

/**
 * A runner exchanges an agent it was asked to run for its integration tool
 * session token: only for a computer the caller owns, and only the computer
 * the agent was dispatched to has an open session.
 */
export const desktopIntegrationSessionService = {
  async issue(input: {
    organizationId: string;
    userId: string;
    clerkUserId: string | null;
    computeTargetId: string;
    request: IntegrationSessionRequest;
  }): Promise<Result<IntegrationSessionGrant, StatusCode>> {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }
    return await integrationToolSessionService.issueForComputer(input);
  },
};
