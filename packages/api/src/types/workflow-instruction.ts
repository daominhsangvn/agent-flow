import { z } from "zod";

/**
 * The computer's side of an instruction action (WORKFLOW_INSTRUCTION_ACTION_TYPE
 * in ./workflow.ts). The API asks the run's computer, through the desktop
 * command relay, to run the instruction's agent read-only in the run's
 * workspace (the plan folder its loops share). The computer answers with an
 * ndjson stream: a `status` line at once, then one `result` line carrying the
 * agent's final answer, which the API checks and carries out with the
 * connection's own actions.
 */

export const WORKFLOW_INSTRUCTION_GATEWAY_PATH =
  "/api/gateway/workflow-actions/instruction";
export const WORKFLOW_INSTRUCTION_OPERATION_ID = "workflow_instruction";
/** Longest an instruction's agent may run on the computer. */
export const WORKFLOW_INSTRUCTION_TIMEOUT_MS = 15 * 60_000;
export const WORKFLOW_INSTRUCTION_PROMPT_MAX = 120_000;
export const WORKFLOW_INSTRUCTION_ANSWER_MAX = 100_000;
export const WORKFLOW_INSTRUCTION_ERROR_MAX = 2000;

export const workflowInstructionRequestSchema = z.object({
  /** The action run the agent works for; names its folder in the workspace. */
  actionRunId: z.string().uuid(),
  /** The run's workspace key: the slug of the document its loops run on. */
  workspaceKey: z.string().trim().min(1).max(200),
  /** The run's primary repository: the workspace sits next to its checkout. */
  repository: z.object({
    fullName: z.string().trim().min(3).max(256),
    cloneUrl: z.string().trim().min(1).max(2048),
  }),
  prompt: z.string().min(1).max(WORKFLOW_INSTRUCTION_PROMPT_MAX),
});
export type WorkflowInstructionRequest = z.infer<
  typeof workflowInstructionRequestSchema
>;

/** The `result` line of the computer's answer. */
export const workflowInstructionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("result"),
    ok: z.literal(true),
    /** The agent's final answer: the JSON the API checks. */
    answer: z.string().max(WORKFLOW_INSTRUCTION_ANSWER_MAX),
    /** Claude Code's own cost of the session; null when it did not know it. */
    costUsd: z.number().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("result"),
    ok: z.literal(false),
    error: z.string().max(WORKFLOW_INSTRUCTION_ERROR_MAX),
    /** False when trying again cannot help (a bad request, no repository). */
    retryable: z.boolean(),
  }),
]);
export type WorkflowInstructionResult = z.infer<
  typeof workflowInstructionResultSchema
>;
