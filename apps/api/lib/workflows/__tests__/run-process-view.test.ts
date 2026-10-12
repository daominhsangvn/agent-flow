import { LOOP_STEP_ARTIFACT_KEY } from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ProcessStepType,
  projectProcessSchema,
  RunProcessSource,
} from "@repo/api/src/types/project-process";
import { describe, expect, it } from "vitest";
import { runLoopState as loop } from "@/lib/workflows/__tests__/support/advance.test-helpers";
import { buildRunProcessView } from "@/lib/workflows/engine/run-process-view";

/** The process part of a run's detail (GET /workflow-runs/{id}). */

const SNAPSHOT = {
  version: 3,
  definition: projectProcessSchema.parse({
    toolkit: {
      repository: "acme/toolkit",
      mounts: [".claude/skills"],
      instructions: "",
    },
    steps: [
      {
        type: ProcessStepType.Agent,
        id: "specify",
        name: "Specify",
        instruction: "/specify",
      },
      {
        type: ProcessStepType.Approval,
        id: "review",
        name: "Review",
        show: ["specify", "specs/**/*.md"],
      },
    ],
  }),
};

function stepLoop(loopId: string, stepId: string, files: string[]) {
  return loop({
    loopId,
    command: LoopCommand.Step,
    stepId,
    status: LoopStatus.Completed,
    uploadedArtifacts: {
      [LOOP_STEP_ARTIFACT_KEY]: {
        stepId,
        questions: [],
        questionsError: null,
        files: files.map((path) => ({
          path,
          content: `# ${path}`,
          truncated: false,
        })),
      },
    },
  });
}

describe("buildRunProcessView", () => {
  it("is null for a run on the built-in flow", () => {
    expect(
      buildRunProcessView({ process: null, stepId: null, stepState: null }, [])
    ).toBeNull();
  });

  it("shows the steps, the approval waited for and the latest files of each step", () => {
    const view = buildRunProcessView(
      {
        process: SNAPSHOT,
        stepId: "review",
        stepState: {
          waiting: null,
          approval: {
            stepId: "review",
            requestedAt: "2026-10-01T00:00:00.000Z",
            decision: null,
          },
        },
      },
      [
        stepLoop("loop-1", "specify", ["specs/001/spec.md"]),
        stepLoop("loop-2", "specify", [
          "specs/001/spec.md",
          "specs/001/plan.md",
        ]),
        loop({ loopId: "plan-1", command: LoopCommand.Plan }),
      ]
    );

    expect(view).toEqual({
      source: RunProcessSource.Project,
      version: 3,
      toolkit: "acme/toolkit",
      steps: [
        { id: "specify", name: "Specify", type: ProcessStepType.Agent },
        { id: "review", name: "Review", type: ProcessStepType.Approval },
      ],
      stepId: "review",
      waiting: null,
      approval: {
        stepId: "review",
        requestedAt: "2026-10-01T00:00:00.000Z",
        show: ["specify", "specs/**/*.md"],
        decided: false,
      },
      stepFiles: [
        {
          stepId: "specify",
          loopId: "loop-2",
          files: [
            {
              path: "specs/001/spec.md",
              content: "# specs/001/spec.md",
              truncated: false,
            },
            {
              path: "specs/001/plan.md",
              content: "# specs/001/plan.md",
              truncated: false,
            },
          ],
        },
      ],
    });
  });

  it("shows the questions a step waits on and whether they were answered", () => {
    const view = buildRunProcessView(
      {
        process: SNAPSHOT,
        stepId: "specify",
        stepState: {
          waiting: {
            stepId: "specify",
            loopId: "loop-1",
            questions: [{ id: "q1", question: "Which format?" }],
            askedAt: "2026-10-01T00:00:00.000Z",
            answers: [{ id: "q1", answer: "CSV" }],
            answeredBy: "user-1",
          },
          approval: null,
        },
      },
      []
    );

    expect(view?.waiting).toEqual({
      stepId: "specify",
      questions: [{ id: "q1", question: "Which format?" }],
      askedAt: "2026-10-01T00:00:00.000Z",
      answered: true,
    });
    expect(view?.approval).toBeNull();
    expect(view?.stepFiles).toEqual([]);
  });
});
