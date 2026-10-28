import { LOOP_STEP_PATHS_MAX } from "@agentflow-ai/loops-api/loop-step";
import {
  type AgentProcessStep,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
  type ProjectProcess,
  RunProcessSource,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowAgentConfig,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toLoopStepConfig } from "@/lib/workflows/engine/agent-step";
import { resolveIngestProcess } from "@/lib/workflows/engine/process";

const mocks = vi.hoisted(() => ({ findCurrent: vi.fn() }));

vi.mock("@/app/projects/project-process-service", () => ({
  CurrentProcessKind: { None: "none", Found: "found", Invalid: "invalid" },
  projectProcessService: { findCurrent: mocks.findCurrent },
}));

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const PROJECT = "0199a5f0-0000-7000-8000-0000000000d1";

const answerStep: AgentProcessStep = {
  type: ProcessStepType.Agent,
  id: "answer",
  name: "Answer",
  instruction: "Answer the question on {{issue.key}}",
  questions: ProcessQuestionsPolicy.Ask,
  artifacts: [".agentflow-ai/work/evidence.md"],
  reply: ".agentflow-ai/work/answer.md",
  document: null,
  finish: ProcessStepFinish.None,
  timeoutMinutes: null,
};

const ownProcess: ProjectProcess = { toolkit: null, steps: [answerStep] };

const projectProcess: ProjectProcess = {
  toolkit: null,
  steps: [{ ...answerStep, id: "project-step", reply: null }],
};

function agent(process: ProjectProcess | null): WorkflowAgentConfig {
  return {
    mode: WorkflowAgentMode.PlanAndExecute,
    stopOnOpenQuestions: true,
    computeTargetId: "0199a5f0-0000-7000-8000-0000000000c1",
    runners: [],
    repository: null,
    prd: workflowPrdRuleSchema.parse({}),
    instructions: "",
    titleTemplate: "{{source.key}}",
    process,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCurrent.mockResolvedValue({
    kind: "found",
    snapshot: {
      version: 7,
      source: RunProcessSource.Project,
      definition: projectProcess,
    },
  });
});

describe("the process a new run follows", () => {
  it("is the workflow's own process when it has one, even with a project process", async () => {
    const resolved = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored: null,
      agent: agent(ownProcess),
    });

    expect(resolved).toEqual({
      ok: true,
      value: {
        process: ownProcess,
        snapshot: true,
        newSnapshot: {
          version: 1,
          source: RunProcessSource.Workflow,
          definition: ownProcess,
        },
      },
    });
    expect(mocks.findCurrent).not.toHaveBeenCalled();
  });

  it("is the project's process for a workflow without its own", async () => {
    const resolved = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored: null,
      agent: agent(null),
    });

    expect(resolved.ok ? resolved.value.newSnapshot : null).toEqual({
      version: 7,
      source: RunProcessSource.Project,
      definition: projectProcess,
    });
  });

  it("stays the one a resumed run started with", async () => {
    const stored = {
      version: 7,
      source: RunProcessSource.Project,
      definition: projectProcess,
    };

    const resolved = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored,
      agent: agent(ownProcess),
    });

    expect(resolved.ok ? resolved.value.process : null).toEqual(projectProcess);
    expect(resolved.ok ? resolved.value.newSnapshot : "error").toBeNull();
  });

  it("keeps the steps, not the YAML they were written in", async () => {
    const yaml = "# Answer the question\nsteps:\n  - type: agent\n";
    mocks.findCurrent.mockResolvedValue({
      kind: "found",
      snapshot: {
        version: 8,
        source: RunProcessSource.Project,
        definition: { ...projectProcess, source: yaml },
      },
    });

    const own = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored: null,
      agent: agent({ ...ownProcess, source: yaml }),
    });
    const project = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored: null,
      agent: agent(null),
    });

    expect(own.ok ? own.value.newSnapshot?.definition : null).toStrictEqual(
      ownProcess
    );
    expect(own.ok ? own.value.process : null).toStrictEqual(ownProcess);
    expect(
      project.ok ? project.value.newSnapshot?.definition : null
    ).toStrictEqual(projectProcess);
  });

  it("reads a snapshot stored before workflows had processes as a project one", async () => {
    const resolved = await resolveIngestProcess({
      organizationId: ORG,
      projectId: PROJECT,
      stored: { version: 3, definition: projectProcess },
      agent: agent(null),
    });

    expect(resolved.ok ? resolved.value.process : null).toEqual(projectProcess);
  });
});

describe("a step's reply file", () => {
  it("is collected first with the step's artifacts", () => {
    const config = toLoopStepConfig({
      runId: "run-1",
      step: answerStep,
      toolkit: null,
      fresh: true,
    });

    expect(config.artifacts).toEqual([
      ".agentflow-ai/work/answer.md",
      ".agentflow-ai/work/evidence.md",
    ]);
  });

  it("is collected once when it is also an artifact, and always fits", () => {
    const artifacts = Array.from(
      { length: LOOP_STEP_PATHS_MAX },
      (_, index) => `notes/${index}.md`
    );

    const config = toLoopStepConfig({
      runId: "run-1",
      step: { ...answerStep, reply: "notes/7.md", artifacts },
      toolkit: null,
      fresh: false,
    });

    expect(config.artifacts).toHaveLength(LOOP_STEP_PATHS_MAX);
    expect(config.artifacts[0]).toBe("notes/7.md");
    expect(new Set(config.artifacts).size).toBe(LOOP_STEP_PATHS_MAX);

    const overflow = toLoopStepConfig({
      runId: "run-1",
      step: { ...answerStep, reply: "answer.md", artifacts },
      toolkit: null,
      fresh: false,
    });
    expect(overflow.artifacts).toHaveLength(LOOP_STEP_PATHS_MAX);
    expect(overflow.artifacts[0]).toBe("answer.md");
  });
});
