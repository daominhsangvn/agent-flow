import { randomUUID } from "node:crypto";
import {
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
} from "@repo/api/src/types/orchestrator";
import { withDb } from "@repo/database";

const TOOL_NAME_MAX = 60;
const AUDIT_TEXT_MAX = 2000;

export type RefusalScope = {
  organizationId: string;
  conversationId: string;
  turnId: string;
};

/**
 * Audit of a refused tool call (F10): a message on the conversation. `turnId`
 * is set so it never wakes a turn; advance.ts keeps it with a superseded turn.
 */
export async function recordRefusedCall(
  scope: RefusalScope,
  tool: string,
  error: string
): Promise<void> {
  const name = tool.slice(0, TOOL_NAME_MAX);
  await withDb((db) =>
    db.orchestratorMessage.create({
      data: {
        organizationId: scope.organizationId,
        conversationId: scope.conversationId,
        origin: OrchestratorMessageOrigin.Internal,
        kind: OrchestratorMessageKind.ToolRefused,
        actor: null,
        text: `${name} refused: ${error}`.slice(0, AUDIT_TEXT_MAX),
        payload: { tool: name },
        externalRef: null,
        dedupKey: `refused:${scope.turnId}:${randomUUID()}`,
        turnId: scope.turnId,
      },
    })
  );
}
