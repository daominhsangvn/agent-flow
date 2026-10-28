import {
  OrchestratorConcurrency,
  OrchestratorMessageOrigin,
} from "@repo/api/src/types/orchestrator";
import { withDb } from "@repo/database";
import { z } from "zod";
import { loadOrchestratorWorkflows } from "./workflow-settings";

/**
 * Supersede (docs/orchestrator.md "Supersede"): once a newer external message
 * waits in a `supersede` conversation, the running turn's write tools are
 * refused so the turn ends and the next one answers both messages.
 */

export const TURN_SUPERSEDED_ERROR =
  "superseded: a newer message arrived; end the turn";

const supersedeRequestSchema = z.object({ supersedeRequestedAt: z.string() });

/** The turn's usage records that a supersede was asked. */
export function supersedeRequested(usage: unknown): boolean {
  return supersedeRequestSchema.safeParse(usage).success;
}

/** An external message no turn took yet. */
export async function newerMessageWaiting(
  conversationId: string
): Promise<boolean> {
  const newer = await withDb((db) =>
    db.orchestratorMessage.findFirst({
      where: {
        conversationId,
        turnId: null,
        origin: OrchestratorMessageOrigin.External,
      },
      select: { id: true },
    })
  );
  return newer !== null;
}

/** Whether the turn must stop writing: a newer message waits (or was asked). */
export async function turnSuperseded(turn: {
  turnId: string;
  organizationId: string;
  conversationId: string;
}): Promise<boolean> {
  const stored = await withDb((db) =>
    db.orchestratorTurn.findUnique({
      where: { id: turn.turnId },
      select: { usage: true },
    })
  );
  if (supersedeRequested(stored?.usage)) {
    return true;
  }
  const conversation = await withDb((db) =>
    db.orchestratorConversation.findUnique({
      where: { id: turn.conversationId },
      select: { case: { select: { workflowId: true } } },
    })
  );
  if (!conversation) {
    return false;
  }
  const workflowId = conversation.case.workflowId;
  const workflows = await loadOrchestratorWorkflows(turn.organizationId, [
    workflowId,
  ]);
  if (
    workflows.get(workflowId)?.concurrency !== OrchestratorConcurrency.Supersede
  ) {
    return false;
  }
  return newerMessageWaiting(turn.conversationId);
}
