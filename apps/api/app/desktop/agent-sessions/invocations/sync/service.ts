import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { computeTargetsService } from "@/app/compute-targets/service";

type DesktopAgentComponentInvocationsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  part: AgentComponentInvocationSyncPart;
  userId: string;
};

/**
 * Verifies target ownership, then ingests one independently acknowledged part.
 * Session data is always ingested: there is no org policy to switch it off.
 */
export const desktopAgentComponentInvocationsSyncService = {
  async sync(
    input: DesktopAgentComponentInvocationsSyncInput
  ): Promise<Result<AgentComponentInvocationSyncAck, StatusCode>> {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }

    const result = await agentComponentInvocationsService.ingestPart({
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      part: input.part,
    });
    if (result.ok) {
      return Result.ok({
        accepted: true,
        protocolVersion: input.part.protocolVersion,
        externalGenerationId: input.part.externalGenerationId,
        partIndex: input.part.partIndex,
        partHash: input.part.partHash,
        state: result.value.state,
      });
    }
    return Result.ok({
      accepted: false,
      protocolVersion: input.part.protocolVersion,
      externalGenerationId: input.part.externalGenerationId,
      partIndex: input.part.partIndex,
      partHash: input.part.partHash,
      reason: result.error,
    });
  },
};
