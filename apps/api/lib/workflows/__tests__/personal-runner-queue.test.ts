import { LoopStatus } from "@repo/api/src/types/loop";
import {
  WorkflowRunErrorCode,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  personalRunnerBusy,
  RUNNER_QUEUE_RETRY_MS,
  stepLaunchFailure,
} from "@/lib/workflows/engine/personal-runner-queue";
import {
  applyRunnerRules,
  runnerConditionFacts,
} from "@/lib/workflows/engine/runner-rules";

const mocks = vi.hoisted(() => ({
  findTargetById: vi.fn(),
  findLoop: vi.fn(),
  updateRuns: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      loop: { findFirst: mocks.findLoop },
      workflowRun: { updateMany: mocks.updateRuns },
    }),
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findById: mocks.findTargetById },
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORG_ID = "org-1";
const TARGET_ID = "01a16128-f37d-7672-af04-62977e1c387c";
const AN_TARGET_ID = "01a1612f-c47b-73fe-bf72-32855ed7cf2c";
const OWN_LOOP_ID = "01a16200-0000-7000-8000-000000000002";

function personalTarget(parallel: boolean) {
  return {
    id: TARGET_ID,
    organizationId: ORG_ID,
    machineName: "an-PRO-1",
    capabilities: { personalRunner: { projectKey: "PRO-1", parallel } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateRuns.mockResolvedValue({ count: 1 });
});

describe("personalRunnerBusy", () => {
  it("is busy while another loop holds a one-at-a-time personal runner", async () => {
    mocks.findTargetById.mockResolvedValue(personalTarget(false));
    mocks.findLoop.mockResolvedValue({ id: "other-loop" });

    const busy = await personalRunnerBusy({
      organizationId: ORG_ID,
      computeTargetId: TARGET_ID,
    });

    expect(busy?.code).toBe(WorkflowRunErrorCode.RunnerBusy);
    expect(busy?.message).toContain("an-PRO-1");
    expect(mocks.findLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computeTargetId: TARGET_ID,
          status: {
            in: [LoopStatus.Pending, LoopStatus.Claimed, LoopStatus.Running],
          },
        }),
      })
    );
  });

  it("after creating its loop, only counts loops created before it", async () => {
    mocks.findTargetById.mockResolvedValue(personalTarget(false));
    mocks.findLoop.mockResolvedValue(null);

    const busy = await personalRunnerBusy({
      organizationId: ORG_ID,
      computeTargetId: TARGET_ID,
      ownLoopId: OWN_LOOP_ID,
    });

    expect(busy).toBeNull();
    expect(mocks.findLoop.mock.calls[0]?.[0].where.id).toEqual({
      lt: OWN_LOOP_ID,
    });
  });

  it("never queues a parallel personal runner, another runner, or another organization's", async () => {
    for (const target of [
      personalTarget(true),
      { ...personalTarget(false), capabilities: { headlessRunner: true } },
      { ...personalTarget(false), organizationId: "org-2" },
      null,
    ]) {
      mocks.findTargetById.mockResolvedValue(target);
      expect(
        await personalRunnerBusy({
          organizationId: ORG_ID,
          computeTargetId: TARGET_ID,
        })
      ).toBeNull();
    }
    expect(mocks.findLoop).not.toHaveBeenCalled();
  });
});

describe("stepLaunchFailure", () => {
  it("makes a step wait for a busy runner and fails the run otherwise", () => {
    expect(
      stepLaunchFailure({ code: WorkflowRunErrorCode.RunnerBusy, message: "x" })
    ).toEqual({
      kind: "retry",
      delayMs: RUNNER_QUEUE_RETRY_MS,
      error: { code: WorkflowRunErrorCode.RunnerBusy, message: "x" },
    });
    expect(
      stepLaunchFailure({
        code: WorkflowRunErrorCode.DispatchFailed,
        message: "y",
      }).kind
    ).toBe("transition");
  });
});

describe("applyRunnerRules", () => {
  const agent = {
    mode: WorkflowAgentMode.PlanAndExecute,
    stopOnOpenQuestions: true,
    computeTargetId: TARGET_ID,
    runners: [
      {
        computeTargetId: AN_TARGET_ID,
        condition: 'source.assignee_email == "an@acme.dev"',
      },
    ],
    repository: null,
    prd: workflowPrdRuleSchema.parse({}),
    instructions: "",
    titleTemplate: "{{source.key}}: {{source.title}}",
    process: null,
  };
  const item = {
    provider: "jira",
    externalId: "10001",
    key: "PRO-12",
    url: null,
    title: "Export CSV",
    container: "PRO",
    bodyMarkdown: "",
    itemType: "Story",
    status: "Ready for Development",
    priority: null,
    labels: ["ai"],
    reporter: "Bình",
    assignee: "An",
    assigneeEmail: "an@acme.dev",
    sections: [],
    comments: [],
    attachments: [],
  };

  it("stores the runner of the matching rule as the run's runner, once", async () => {
    const decided = await applyRunnerRules(
      { id: "run-1", organizationId: ORG_ID },
      agent,
      item
    );

    expect(decided.computeTargetId).toBe(AN_TARGET_ID);
    expect(decided.runners).toEqual([]);
    expect(mocks.updateRuns).toHaveBeenCalledWith({
      where: { id: "run-1", organizationId: ORG_ID },
      data: {
        agentConfig: expect.objectContaining({
          computeTargetId: AN_TARGET_ID,
          runners: [],
        }),
      },
    });
  });

  it("keeps the workflow's runner when no rule matches", async () => {
    const decided = await applyRunnerRules(
      { id: "run-1", organizationId: ORG_ID },
      agent,
      { ...item, assigneeEmail: null }
    );

    expect(decided.computeTargetId).toBe(TARGET_ID);
  });

  it("leaves a config without rules alone", async () => {
    const plain = { ...agent, runners: [] };

    expect(
      await applyRunnerRules(
        { id: "run-1", organizationId: ORG_ID },
        plain,
        item
      )
    ).toBe(plain);
    expect(mocks.updateRuns).not.toHaveBeenCalled();
  });

  it("reads the item's fields for conditions", () => {
    expect(runnerConditionFacts(item)).toMatchObject({
      "source.key": "PRO-12",
      "source.labels": ["ai"],
      "source.assignee_email": "an@acme.dev",
      "source.reporter_email": null,
      "source.provider": "jira",
    });
  });
});
