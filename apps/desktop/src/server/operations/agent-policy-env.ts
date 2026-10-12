/**
 * @file agent-policy-env.ts
 * @description The environment that tells a loop's agents what its workflow
 * process step lets them decide on their own (docs/workflows.md "Agent
 * decisions"). Only a step that changes the built-in behaviour sends a
 * policy, so other loops get no extra variables.
 *
 * - `AGENTFLOW_PLAN_RECOMMENDATIONS=suggest` (PLAN): the plan validator keeps
 *   a question open even when the planning agents recommend an answer.
 * - `AGENTFLOW_EXECUTE_REVIEW=fast` (EXECUTE): the orchestrator implements
 *   the approved plan without evaluating, critic-reviewing and finalizing it
 *   again.
 */

import {
  type LoopAgentPolicy,
  LoopAgentPolicySchema,
} from "@agentflow-ai/loops-api/context-pack";

export const AgentPolicyEnvVar = {
  Recommendations: "AGENTFLOW_PLAN_RECOMMENDATIONS",
  Review: "AGENTFLOW_EXECUTE_REVIEW",
} as const;

/** The variables for `policy`; none for a missing or unreadable policy. */
export function agentPolicyEnv(
  policy: LoopAgentPolicy | undefined
): Record<string, string> {
  const parsed = LoopAgentPolicySchema.safeParse(policy ?? {});
  if (!parsed.success) {
    return {};
  }
  const { recommendations, review } = parsed.data;
  return {
    ...(recommendations
      ? { [AgentPolicyEnvVar.Recommendations]: recommendations }
      : {}),
    ...(review ? { [AgentPolicyEnvVar.Review]: review } : {}),
  };
}
