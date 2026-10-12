import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ExecuteReview,
  type LoopAgentPolicy,
  PlanRecommendations,
} from "@agentflow-ai/loops-api/context-pack";
import {
  AgentPolicyEnvVar,
  agentPolicyEnv,
} from "../src/server/operations/agent-policy-env.js";

describe("agentPolicyEnv", () => {
  test("adds no variable without a policy", () => {
    assert.deepEqual(agentPolicyEnv(undefined), {});
    assert.deepEqual(agentPolicyEnv({}), {});
  });

  test("tells the plan validator to keep recommendations as suggestions", () => {
    assert.deepEqual(
      agentPolicyEnv({ recommendations: PlanRecommendations.Suggest }),
      { [AgentPolicyEnvVar.Recommendations]: PlanRecommendations.Suggest }
    );
  });

  test("tells the orchestrator to implement the approved plan as it is", () => {
    assert.deepEqual(agentPolicyEnv({ review: ExecuteReview.Fast }), {
      [AgentPolicyEnvVar.Review]: ExecuteReview.Fast,
    });
  });

  test("ignores a policy it cannot read", () => {
    const unreadable = { review: "sometimes" } as unknown as LoopAgentPolicy;
    assert.deepEqual(agentPolicyEnv(unreadable), {});
  });
});
