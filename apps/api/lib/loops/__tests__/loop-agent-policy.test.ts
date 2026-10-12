import {
  ExecuteReview,
  PlanRecommendations,
} from "@agentflow-ai/loops-api/context-pack";
import { describe, expect, it } from "vitest";
import { readLoopAgentPolicy } from "../loop-agent-policy";

describe("readLoopAgentPolicy", () => {
  it("reads the policy a process step stored on its loop", () => {
    expect(
      readLoopAgentPolicy({
        workflowRunId: "run-1",
        agentPolicy: { recommendations: PlanRecommendations.Suggest },
      })
    ).toEqual({ recommendations: PlanRecommendations.Suggest });
    expect(
      readLoopAgentPolicy({ agentPolicy: { review: ExecuteReview.Fast } })
    ).toEqual({ review: ExecuteReview.Fast });
  });

  it("is undefined without a readable policy", () => {
    expect(readLoopAgentPolicy(null)).toBeUndefined();
    expect(readLoopAgentPolicy({ workflowRunId: "run-1" })).toBeUndefined();
    expect(
      readLoopAgentPolicy({ agentPolicy: { review: "sometimes" } })
    ).toBeUndefined();
  });
});
