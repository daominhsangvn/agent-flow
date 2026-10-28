import {
  OrchestratorDecisionStatus,
  type OrchestratorDecisionVia,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
} from "@repo/api/src/types/orchestrator";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";

/**
 * Decisions the orchestrator asks people for (docs/orchestrator.md): an
 * approval of a plan, a go for an implementation. An admin decides with the
 * button in AgentFlow, or someone says it in the thread and the orchestrator
 * records it. Either way the decision is taken once, and an internal message
 * wakes the conversation that asked.
 */

const QUESTION_MAX = 4000;
const COMMENT_MAX = 4000;

export async function requestDecision(input: {
  organizationId: string;
  caseId: string;
  conversationId: string;
  question: string;
}): Promise<string> {
  const decision = await withDb((db) =>
    db.orchestratorDecision.create({
      data: {
        organizationId: input.organizationId,
        caseId: input.caseId,
        conversationId: input.conversationId,
        question: input.question.slice(0, QUESTION_MAX),
      },
      select: { id: true },
    })
  );
  return decision.id;
}

export type DecideInput = {
  organizationId: string;
  decisionId: string;
  approved: boolean;
  comment: string | null;
  via: OrchestratorDecisionVia;
  /** Who decided: their name as shown, and their user id when in AgentFlow. */
  decidedBy: string;
  decidedById: string | null;
  /** Limits the decision to one case (the orchestrator's own case). */
  caseId?: string;
  /**
   * Wake the conversation with the decision (false when the orchestrator
   * records one it was told in the running turn: it knows already).
   */
  notify?: boolean;
};

/** Takes the decision once; NotFound for a decision that is not pending. */
export async function decide(
  input: DecideInput,
  now: Date = new Date()
): Promise<Result<{ conversationId: string }, StatusCode>> {
  const decision = await withDb((db) =>
    db.orchestratorDecision.findFirst({
      where: {
        id: input.decisionId,
        organizationId: input.organizationId,
        status: OrchestratorDecisionStatus.Pending,
        ...(input.caseId ? { caseId: input.caseId } : {}),
      },
      select: { id: true, conversationId: true, question: true },
    })
  );
  if (!decision) {
    return Result.err(Status.NotFound);
  }
  const status = input.approved
    ? OrchestratorDecisionStatus.Approved
    : OrchestratorDecisionStatus.Rejected;
  const comment = input.comment?.trim().slice(0, COMMENT_MAX) || null;
  const taken = await withDb.tx(async (tx) => {
    const updated = await tx.orchestratorDecision.updateMany({
      where: { id: decision.id, status: OrchestratorDecisionStatus.Pending },
      data: {
        status,
        via: input.via,
        decidedBy: input.decidedBy.slice(0, 255),
        decidedById: input.decidedById,
        comment,
        decidedAt: now,
      },
    });
    if (updated.count !== 1) {
      return false;
    }
    if (input.notify === false) {
      return true;
    }
    await tx.orchestratorMessage.create({
      data: {
        organizationId: input.organizationId,
        conversationId: decision.conversationId,
        origin: OrchestratorMessageOrigin.Internal,
        kind: OrchestratorMessageKind.Decision,
        actor: input.decidedBy.slice(0, 255),
        text: `Decision ${decision.id} was ${status} by ${input.decidedBy} (${input.via})${comment ? `: ${comment}` : "."}\nIt asked: ${decision.question}`,
        dedupKey: `decision:${decision.id}`,
        payload: { decisionId: decision.id, status, via: input.via },
      },
    });
    await tx.orchestratorConversation.update({
      where: { id: decision.conversationId },
      data: { nextWakeAt: now },
    });
    return true;
  });
  return taken
    ? Result.ok({ conversationId: decision.conversationId })
    : Result.err(Status.NotFound);
}
