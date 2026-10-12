/**
 * Unit tests for buildDesktopLoopExecutionBody() in loop-desktop.ts.
 *
 * Covers:
 * - When harness is provided in LaunchDesktopOpts, it appears in the LoopBody output
 * - When harness is undefined or not provided, it is not included in the LoopBody output
 */

import { ExecuteReview } from "@agentflow-ai/loops-api/context-pack";
import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import { HarnessType } from "@repo/api/src/types/compute-target";
import { LoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import type { LaunchDesktopOpts } from "../loop-desktop";
import { buildDesktopLoopExecutionBody } from "../loop-desktop";

// Minimal ContextPack required to call buildDesktopLoopExecutionBody
const baseContextPack: LaunchDesktopOpts["contextPack"] = {
  command: LoopCommand.Execute,
  artifacts: [],
};

// Minimal required opts (omitting desktopUserIntentSignature per the function signature)
const baseOpts: Omit<LaunchDesktopOpts, "desktopUserIntentSignature"> = {
  loopId: "loop-1",
  organizationId: "org-1",
  command: LoopCommand.Execute,
  computeTargetId: "ct-1",
  agentFlowAuthToken: "tok-abc",
  apiBaseUrl: "https://api.example.com",
  contextPack: baseContextPack,
};

describe("buildDesktopLoopExecutionBody — harness field", () => {
  it.each([
    {
      description: "includes harness field when HarnessType.Claude is provided",
      harness: HarnessType.Claude,
      expectedHarness: HarnessType.Claude,
    },
    {
      description: "includes harness field when HarnessType.Codex is provided",
      harness: HarnessType.Codex,
      expectedHarness: HarnessType.Codex,
    },
  ])("$description", ({ harness, expectedHarness }) => {
    const body = buildDesktopLoopExecutionBody({ ...baseOpts, harness });

    expect(body).toMatchObject({ harness: expectedHarness });
  });

  it.each([
    {
      description: "omits harness field when harness is undefined",
      opts: { ...baseOpts, harness: undefined },
    },
    {
      description: "omits harness field when harness is not provided",
      opts: baseOpts,
    },
  ])("$description", ({ opts }) => {
    const body = buildDesktopLoopExecutionBody(opts);

    expect(body).not.toHaveProperty("harness");
  });
});

describe("buildDesktopLoopExecutionBody — process step", () => {
  const step = {
    runId: "run-1",
    stepId: "specify",
    name: "Specify",
    fresh: true,
    askQuestions: false,
    artifacts: [],
    finish: LoopStepFinish.None,
    toolkit: null,
  };

  it("sends the step of a STEP loop with the project's instructions", () => {
    const body = buildDesktopLoopExecutionBody({
      ...baseOpts,
      command: LoopCommand.Step,
      contextPack: {
        ...baseContextPack,
        command: LoopCommand.Step,
        projectInstructions: "Use pnpm.",
        step,
      },
    });

    expect(body).toMatchObject({ projectInstructions: "Use pnpm.", step });
  });

  it("sends no step for other loops", () => {
    const body = buildDesktopLoopExecutionBody(baseOpts);

    expect(body).not.toHaveProperty("step");
    expect(body).not.toHaveProperty("projectInstructions");
    expect(body).not.toHaveProperty("replan");
    expect(body).not.toHaveProperty("agentPolicy");
  });

  it("sends what the workflow's process step lets the agents decide", () => {
    const body = buildDesktopLoopExecutionBody({
      ...baseOpts,
      contextPack: {
        ...baseContextPack,
        agentPolicy: { review: ExecuteReview.Fast },
      },
    });

    expect(body).toMatchObject({ agentPolicy: { review: ExecuteReview.Fast } });
  });

  it("marks a workflow re-plan so the computer hands it the earlier plan", () => {
    const body = buildDesktopLoopExecutionBody({
      ...baseOpts,
      command: LoopCommand.Plan,
      contextPack: {
        ...baseContextPack,
        command: LoopCommand.Plan,
        replan: true,
      },
    });

    expect(body).toMatchObject({ replan: true });
  });
});
