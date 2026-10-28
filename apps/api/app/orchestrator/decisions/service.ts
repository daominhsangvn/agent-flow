import type { DecideOrchestratorDecisionInput } from "@repo/api/src/types/orchestrator";
import { OrchestratorDecisionVia } from "@repo/api/src/types/orchestrator";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { advanceConversation } from "@/lib/orchestrator/advance";
import { decide } from "@/lib/orchestrator/decisions";
import { displayUserName } from "@/lib/user-display-name";
import { waitUntil } from "@/lib/wait-until";

/**
 * An admin's decision on what a project orchestrator asked
 * (docs/orchestrator.md): taken once, in the admin's name; the conversation
 * that asked moves at once.
 */
export const orchestratorDecisionService = {
  async decideByButton(
    organizationId: string,
    userId: string,
    decisionId: string,
    input: DecideOrchestratorDecisionInput
  ): Promise<Result<{ conversationId: string }, StatusCode>> {
    const user = await withDb((db) =>
      db.user.findFirst({
        where: { id: userId, organizationId },
        select: { firstName: true, lastName: true, email: true },
      })
    );
    if (!user) {
      return Result.err(Status.Forbidden);
    }
    const decided = await decide({
      organizationId,
      decisionId,
      approved: input.approved,
      comment: input.comment ?? null,
      via: OrchestratorDecisionVia.Button,
      decidedBy: displayUserName(user),
      decidedById: userId,
    });
    if (decided.ok) {
      waitUntil(advanceConversation(decided.value.conversationId));
    }
    return decided;
  },
};
