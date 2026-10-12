import {
  LOOP_STEP_ARTIFACT_KEY,
  LoopStepFinish,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import {
  LOOP_STEP_METADATA_KEY,
  readLoopStepConfig,
  readStepResult,
} from "@/lib/loops/loop-commands/step-handler";

const STEP = {
  runId: "run-1",
  stepId: "clarify",
  name: "Clarify",
  fresh: false,
  askQuestions: true,
  artifacts: ["specs/*/spec.md"],
  finish: LoopStepFinish.None,
  toolkit: {
    repository: "acme/speckit",
    mounts: [".specify"],
    instructions: "",
  },
};

describe("STEP loops", () => {
  it("need a repository, include the run's document and no parent state", () => {
    expect(getCommandHandler(LoopCommand.Step)).toMatchObject({
      requiresRepo: true,
      requiresParent: false,
      includePrimaryArtifact: true,
    });
  });

  it("send the step the engine stored in the loop's metadata", () => {
    expect(
      readLoopStepConfig({
        command: LoopCommand.Step,
        metadata: { workflowRunId: "run-1", [LOOP_STEP_METADATA_KEY]: STEP },
      })
    ).toEqual(STEP);
  });

  it("send no step for another command or settings that are not valid", () => {
    expect(
      readLoopStepConfig({
        command: LoopCommand.Execute,
        metadata: { [LOOP_STEP_METADATA_KEY]: STEP },
      })
    ).toBeUndefined();
    expect(
      readLoopStepConfig({
        command: LoopCommand.Step,
        metadata: {
          [LOOP_STEP_METADATA_KEY]: { ...STEP, artifacts: ["../secrets"] },
        },
      })
    ).toBeUndefined();
    expect(
      readLoopStepConfig({ command: LoopCommand.Step, metadata: null })
    ).toBeUndefined();
  });

  it("read the step's questions and files from the uploaded artifacts", () => {
    const result = {
      stepId: "clarify",
      questions: [{ id: "q1", question: "CSV or TSV?" }],
      files: [{ path: "specs/001/spec.md", content: "spec", truncated: false }],
      questionsError: null,
    };

    expect(readStepResult({ [LOOP_STEP_ARTIFACT_KEY]: result })).toEqual(
      result
    );
    expect(readStepResult({ plan: { content: "x" } })).toBeNull();
    expect(readStepResult(null)).toBeNull();
  });
});
