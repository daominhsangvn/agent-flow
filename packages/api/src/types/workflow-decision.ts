import { z } from "zod";

/**
 * A workflow decision: the API asks a computer, through the desktop command
 * relay, to answer one question with Claude Code and nothing else (no tools,
 * no MCP server, no workspace). Today: whether a run's source item is a PRD
 * (`agent.prd.instruction`, docs/workflows.md "PRD or Issue"). The computer
 * answers with an ndjson stream: a `status` line at once, then one `result`
 * line carrying the model's final answer, then `done`.
 */

export const WORKFLOW_DECISION_GATEWAY_PATH =
  "/api/gateway/workflow-actions/decision";
export const WORKFLOW_DECISION_OPERATION_ID = "workflow_decision";
/** Longest a decision may run on the computer. */
export const WORKFLOW_DECISION_TIMEOUT_MS = 5 * 60_000;
export const WORKFLOW_DECISION_PROMPT_MAX = 60_000;
export const WORKFLOW_DECISION_ANSWER_MAX = 4000;
export const WORKFLOW_DECISION_ERROR_MAX = 2000;

export const workflowDecisionRequestSchema = z.object({
  /** The record the decision is for (the run); names its folder. */
  decisionId: z.uuid(),
  prompt: z.string().min(1).max(WORKFLOW_DECISION_PROMPT_MAX),
});
export type WorkflowDecisionRequest = z.infer<
  typeof workflowDecisionRequestSchema
>;

/** The `result` line of the computer's answer. */
export const workflowDecisionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("result"),
    ok: z.literal(true),
    /** The model's final answer. */
    answer: z.string().max(WORKFLOW_DECISION_ANSWER_MAX),
    /** Claude Code's own cost of the session; null when it did not know it. */
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal("result"),
    ok: z.literal(false),
    error: z.string().max(WORKFLOW_DECISION_ERROR_MAX),
  }),
]);
export type WorkflowDecisionResult = z.infer<
  typeof workflowDecisionResultSchema
>;
