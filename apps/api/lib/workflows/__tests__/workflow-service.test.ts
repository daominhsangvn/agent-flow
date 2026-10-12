import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import {
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import { Status } from "@repo/api/src/types/result";
import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
  WorkflowActionStage,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEWER } from "@/lib/integrations/connection/url-redaction";
import {
  FAKE_ACTION_TYPE,
  FAKE_TRIGGER_TYPE,
} from "@/lib/workflows/__tests__/support/workflow-registry.test-fake";
import { workflowService } from "@/lib/workflows/workflow-service";

type Row = Record<string, unknown> & { id: string };

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  caller: "0199a5f0-0000-7000-8000-0000000000a1",
  runAs: "0199a5f0-0000-7000-8000-0000000000a2",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
  jira: "0199a5f0-0000-7000-8000-0000000000e1",
  teams: "0199a5f0-0000-7000-8000-0000000000e2",
  workflow: "0199a5f0-0000-7000-8000-0000000000f1",
  trigger: "0199a5f0-0000-7000-8000-0000000000b1",
  oldTrigger: "0199a5f0-0000-7000-8000-0000000000b2",
  action: "0199a5f0-0000-7000-8000-0000000000b3",
  preAction: "0199a5f0-0000-7000-8000-0000000000b4",
};

const MEMBER_VIEWER = { isAdmin: false };
const HOOK_URL = "https://hooks.example.com/hooks/catch/123/abc?token=secret";

const TRIGGER_TYPE = FAKE_TRIGGER_TYPE;
const POST_ACTION_1_MESSAGE_RE = /^Post action 1: message: /;
const NEW_TRIGGER_ID_RE = /^trigger-new-\d+$/;
const ACTION_TYPE = FAKE_ACTION_TYPE;

const mocks = vi.hoisted(() => ({
  projectExists: true,
  activeUsers: new Set<string>(),
  connections: [] as Row[],
  workflow: null as Row | null,
  triggers: [] as Row[],
  actions: [] as Row[],
  runGroups: [] as Array<{
    workflowId: string;
    status: string;
    _count: { _all: number };
  }>,
  findOwnedById: vi.fn(),
  findAccessibleById: vi.fn(),
  checkProcessToolkit: vi.fn(),
  writes: [] as string[],
}));

vi.mock("@repo/database", () => {
  const db = {
    project: {
      findFirst: vi.fn(() =>
        Promise.resolve(mocks.projectExists ? { id: "project" } : null)
      ),
    },
    user: {
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(
          mocks.activeUsers.has(args.where.id) ? { id: args.where.id } : null
        )
      ),
    },
    integrationConnection: {
      findMany: vi.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          mocks.connections.filter((row) => args.where.id.in.includes(row.id))
        )
      ),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    workflow: {
      create: vi.fn((args: { data: Row }) => {
        mocks.workflow = {
          ...args.data,
          id: "0199a5f0-0000-7000-8000-0000000000f1",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
        };
        return Promise.resolve({ id: mocks.workflow.id });
      }),
      updateMany: vi.fn((args: { data: Row }) => {
        mocks.writes.push("workflow.update");
        Object.assign(mocks.workflow ?? {}, args.data);
        return Promise.resolve({ count: 1 });
      }),
      deleteMany: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve({ count: mocks.workflow?.id === args.where.id ? 1 : 0 })
      ),
      findMany: vi.fn(() => Promise.resolve(mocks.workflow ? [record()] : [])),
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(mocks.workflow?.id === args.where.id ? record() : null)
      ),
    },
    workflowTrigger: childDelegate(() => mocks.triggers, "trigger"),
    workflowAction: childDelegate(() => mocks.actions, "action"),
    workflowRun: {
      groupBy: vi.fn(() => Promise.resolve(mocks.runGroups)),
    },
  };
  const withDb = (fn: (client: unknown) => unknown) => fn(db);
  withDb.tx = (fn: (client: unknown) => unknown) => fn(db);
  return { withDb };

  function record() {
    return {
      ...mocks.workflow,
      project: { id: "project", name: "Platform" },
      runAsUser: {
        id: mocks.workflow?.runAsUserId,
        firstName: "Bot",
        lastName: null,
        email: "bot@example.test",
      },
      triggers: [...mocks.triggers].sort(byPosition),
      actions: [...mocks.actions].sort(byPosition),
    };
  }

  function byPosition(left: Row, right: Row) {
    return Number(left.position) - Number(right.position);
  }

  function childDelegate(rows: () => Row[], label: string) {
    let next = 1;
    return {
      deleteMany: vi.fn((args: { where: { id: { notIn: string[] } } }) => {
        const keep = rows().filter((row) =>
          args.where.id.notIn.includes(row.id)
        );
        rows().splice(0, rows().length, ...keep);
        mocks.writes.push(`${label}.delete`);
        return Promise.resolve({ count: 0 });
      }),
      updateMany: vi.fn((args: { where: { id: string }; data: Row }) => {
        const row = rows().find((entry) => entry.id === args.where.id);
        Object.assign(row ?? {}, args.data);
        mocks.writes.push(`${label}.update:${args.where.id}`);
        return Promise.resolve({ count: row ? 1 : 0 });
      }),
      create: vi.fn((args: { data: Row }) => {
        const row = { ...args.data, id: `${label}-new-${next++}` };
        rows().push(row);
        mocks.writes.push(`${label}.create`);
        return Promise.resolve({ id: row.id });
      }),
    };
  }
});
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
    findAccessibleById: mocks.findAccessibleById,
  },
}));
vi.mock("@/app/projects/project-process-service", () => ({
  checkProcessToolkit: mocks.checkProcessToolkit,
}));
vi.mock("@/lib/integrations/registry", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/workflow-registry.test-fake"
  );
  return support.fakeWorkflowRegistry;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectExists = true;
  mocks.activeUsers = new Set([IDS.caller, IDS.runAs]);
  mocks.connections = [
    {
      id: IDS.jira,
      name: "Jira",
      provider: "fake",
      status: IntegrationConnectionStatus.Active,
    },
    {
      id: IDS.teams,
      name: "Teams",
      provider: "fake",
      status: IntegrationConnectionStatus.Active,
    },
  ];
  mocks.workflow = null;
  mocks.triggers = [];
  mocks.actions = [];
  mocks.runGroups = [];
  mocks.writes = [];
  mocks.findOwnedById.mockResolvedValue({ id: IDS.target });
  mocks.findAccessibleById.mockResolvedValue(null);
  mocks.checkProcessToolkit.mockResolvedValue(null);
});

function action(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: IDS.teams,
    type: ACTION_TYPE,
    config: { message: "{{summary}}" },
    events: [WorkflowRunEvent.Succeeded],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}): SaveWorkflowInput {
  return saveWorkflowInputSchema.parse({
    name: "Jira to PR",
    projectId: IDS.project,
    agent: { computeTargetId: IDS.target, mode: WorkflowAgentMode.Plan },
    triggers: [{ connectionId: IDS.jira, type: TRIGGER_TYPE }],
    actions: [
      {
        connectionId: IDS.teams,
        type: ACTION_TYPE,
        config: { message: "{{summary}}" },
        events: [WorkflowRunEvent.Succeeded, WorkflowRunEvent.Succeeded],
      },
    ],
    ...overrides,
  });
}

describe("workflowService.create", () => {
  it("validates against the registry and stores parsed configs", async () => {
    const result = await workflowService.create(IDS.org, IDS.caller, input());

    expect(result.ok).toBe(true);
    const workflow = result.ok
      ? result.value
      : expect.fail("workflow expected");
    expect(workflow).toMatchObject({
      name: "Jira to PR",
      enabled: true,
      project: { id: "project", name: "Platform" },
      runAsUser: { id: IDS.caller, name: "Bot", email: "bot@example.test" },
      agent: {
        computeTargetId: IDS.target,
        mode: WorkflowAgentMode.Plan,
        stopOnOpenQuestions: true,
      },
      triggers: [
        {
          connectionId: IDS.jira,
          type: TRIGGER_TYPE,
          config: { projectKeys: [] },
          position: 0,
        },
      ],
      actions: [
        {
          connectionId: IDS.teams,
          type: ACTION_TYPE,
          stage: WorkflowActionStage.Post,
          events: [WorkflowRunEvent.Succeeded],
          continueOnError: false,
          position: 0,
        },
      ],
      runCounts: { total: 0, active: 0, succeeded: 0, failed: 0 },
    });
    expect(mocks.workflow?.runAsUserId).toBe(IDS.caller);
  });

  it("stores pre actions on run.triggered and counts positions per stage", async () => {
    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        actions: [
          action({ config: { message: "post A" } }),
          action({
            config: { message: "pre B" },
            stage: WorkflowActionStage.Pre,
            events: [WorkflowRunEvent.Failed],
            continueOnError: true,
          }),
          action({
            config: { message: "post C" },
            events: [WorkflowRunEvent.Failed],
            continueOnError: true,
          }),
          action({
            config: { message: "pre D" },
            stage: WorkflowActionStage.Pre,
          }),
        ],
      })
    );

    const stored = mocks.actions.map((row) => ({
      message: (row.config as { message: string }).message,
      stage: row.stage,
      position: row.position,
      events: row.events,
      continueOnError: row.continueOnError,
    }));
    expect(stored).toEqual([
      {
        message: "post A",
        stage: WorkflowActionStage.Post,
        position: 0,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
      },
      {
        message: "pre B",
        stage: WorkflowActionStage.Pre,
        position: 0,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: true,
      },
      {
        message: "post C",
        stage: WorkflowActionStage.Post,
        position: 1,
        events: [WorkflowRunEvent.Failed],
        continueOnError: false,
      },
      {
        message: "pre D",
        stage: WorkflowActionStage.Pre,
        position: 1,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: false,
      },
    ]);
    // The DTO lists pre actions first (they run first), each stage by position.
    const workflow = result.ok
      ? result.value
      : expect.fail("workflow expected");
    expect(
      workflow.actions.map((entry) => [entry.config.message, entry.stage])
    ).toEqual([
      ["pre B", WorkflowActionStage.Pre],
      ["pre D", WorkflowActionStage.Pre],
      ["post A", WorkflowActionStage.Post],
      ["post C", WorkflowActionStage.Post],
    ]);
    expect(workflow.actions[0]).toMatchObject({
      events: [WorkflowRunEvent.Triggered],
      continueOnError: true,
    });
  });

  it.each([
    ["no event", [], "Post action 1: select at least one run event."],
    [
      "run.triggered",
      [WorkflowRunEvent.Triggered, WorkflowRunEvent.Failed],
      "Post action 1: run.triggered is reserved for pre actions.",
    ],
  ])("rejects a post action with %s even when the schema was bypassed", async (_label, events, message) => {
    const unchecked = input();
    unchecked.actions[0].events = events;

    const result = await workflowService.create(IDS.org, IDS.caller, unchecked);

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest, message },
    });
    expect(mocks.workflow).toBeNull();
  });

  it("names actions by stage and position within the stage, like the editor", async () => {
    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        actions: [
          action({ stage: WorkflowActionStage.Pre }),
          action({ stage: WorkflowActionStage.Pre }),
          action({ config: { message: "" } }),
        ],
      })
    );

    expect(result.ok ? "" : result.error.message).toMatch(
      POST_ACTION_1_MESSAGE_RE
    );

    const pre = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        actions: [
          action(),
          action({ stage: WorkflowActionStage.Pre }),
          action({ stage: WorkflowActionStage.Pre, type: "fake.unknown" }),
        ],
      })
    );

    expect(pre.ok ? "" : pre.error.message).toContain(
      'Pre action 2: "fake.unknown" is not offered'
    );
  });

  it("accepts an org-shared compute target when the workflow runs as another member", async () => {
    mocks.findOwnedById.mockResolvedValue(null);
    mocks.findAccessibleById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: true,
    });

    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({ runAsUserId: IDS.runAs })
    );

    expect(result.ok).toBe(true);
    expect(mocks.findAccessibleById).toHaveBeenCalledWith(
      IDS.target,
      IDS.org,
      IDS.runAs
    );
  });

  it("refuses the run-as member's private desktop when the caller is someone else", async () => {
    // The target belongs to the run-as user and is not shared with the org.
    mocks.findOwnedById.mockResolvedValue({ id: IDS.target });
    mocks.findAccessibleById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: false,
    });

    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({ runAsUserId: IDS.runAs })
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
    expect(result.ok ? "" : result.error.message).toContain(
      "must be shared with the organization"
    );
    expect(mocks.workflow).toBeNull();
  });

  it("accepts the caller's own private desktop when the caller runs the workflow", async () => {
    mocks.findOwnedById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: false,
    });

    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({ runAsUserId: IDS.caller })
    );

    expect(result.ok).toBe(true);
    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      IDS.target,
      IDS.org,
      IDS.caller
    );
  });

  it("accepts triggers and actions on a disabled connection (skipped at run time)", async () => {
    mocks.connections[0].status = IntegrationConnectionStatus.Disabled;
    mocks.connections[1].status = IntegrationConnectionStatus.Disabled;

    const result = await workflowService.create(IDS.org, IDS.caller, input());

    expect(result.ok).toBe(true);
  });

  it.each([
    [
      "an unknown project",
      () => {
        mocks.projectExists = false;
      },
      "Project not found",
    ],
    [
      "an inactive run-as user",
      () => {
        mocks.activeUsers.delete(IDS.caller);
      },
      "active member",
    ],
    [
      "an inaccessible compute target",
      () => {
        mocks.findOwnedById.mockResolvedValue(null);
      },
      "compute target",
    ],
    [
      "a connection of another organization",
      () => {
        mocks.connections = mocks.connections.slice(1);
      },
      "connection not found",
    ],
  ])("rejects %s", async (_label, arrange, message) => {
    arrange();

    const result = await workflowService.create(IDS.org, IDS.caller, input());

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
    expect(result.ok ? "" : result.error.message).toContain(message);
    expect(mocks.workflow).toBeNull();
  });

  it("rejects a type the connection's provider does not offer", async () => {
    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({ triggers: [{ connectionId: IDS.jira, type: "fake.unknown" }] })
    );

    expect(result.ok ? "" : result.error.message).toContain(
      'Trigger 1: "fake.unknown" is not offered'
    );
  });

  it("rejects a config the definition's schema refuses", async () => {
    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        actions: [
          {
            connectionId: IDS.teams,
            type: ACTION_TYPE,
            config: { message: "" },
            events: [WorkflowRunEvent.Failed],
          },
        ],
      })
    );

    expect(result.ok ? "" : result.error.message).toContain(
      "Post action 1: message:"
    );
  });
});

describe("a workflow's own process", () => {
  const ownProcess = {
    toolkit: {
      repository: "brenock/ip-okf",
      mounts: [".claude/commands"],
      instructions: "",
    },
    steps: [
      {
        type: ProcessStepType.Agent,
        id: "answer",
        name: "Answer",
        instruction: "Answer the question on {{issue.key}}",
        reply: ".agentflow-ai/work/answer.md",
      },
    ],
  };

  it("is stored with the agent config, its toolkit checked against the project", async () => {
    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        agent: {
          computeTargetId: IDS.target,
          mode: WorkflowAgentMode.Plan,
          process: ownProcess,
        },
      })
    );

    expect(result.ok).toBe(true);
    const workflow = result.ok
      ? result.value
      : expect.fail("workflow expected");
    expect(workflow.agent.process).toMatchObject({
      toolkit: { repository: "brenock/ip-okf" },
      steps: [
        {
          id: "answer",
          reply: ".agentflow-ai/work/answer.md",
          questions: ProcessQuestionsPolicy.Continue,
          finish: ProcessStepFinish.None,
        },
      ],
    });
    expect(mocks.checkProcessToolkit).toHaveBeenCalledWith(
      IDS.org,
      IDS.project,
      expect.objectContaining({ toolkit: expect.anything() })
    );
  });

  it("is refused when its toolkit is not one of the project's repositories", async () => {
    mocks.checkProcessToolkit.mockResolvedValue(
      "The toolkit repository brenock/ip-okf is not one of the project's repositories. Add it on the Repositories tab first."
    );

    const result = await workflowService.create(
      IDS.org,
      IDS.caller,
      input({
        agent: {
          computeTargetId: IDS.target,
          mode: WorkflowAgentMode.Plan,
          process: ownProcess,
        },
      })
    );

    expect(result.ok ? null : result.error.message).toContain(
      "The toolkit repository brenock/ip-okf"
    );
    expect(mocks.workflow).toBeNull();
  });

  it("defaults to none: the project's process", async () => {
    const result = await workflowService.create(IDS.org, IDS.caller, input());

    expect(result.ok ? result.value.agent.process : "error").toBeNull();
  });
});

describe("workflowService.update", () => {
  beforeEach(async () => {
    await workflowService.create(IDS.org, IDS.caller, input());
    mocks.triggers.splice(0, mocks.triggers.length);
    mocks.triggers.push(
      {
        id: IDS.trigger,
        connectionId: IDS.jira,
        type: TRIGGER_TYPE,
        config: {},
        enabled: true,
        position: 0,
      },
      {
        id: IDS.oldTrigger,
        connectionId: IDS.jira,
        type: TRIGGER_TYPE,
        config: {},
        enabled: true,
        position: 1,
      }
    );
    mocks.writes = [];
  });

  it("keeps triggers sent back with their id, deletes the rest and creates new ones", async () => {
    const result = await workflowService.update(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      input({
        name: "Renamed",
        triggers: [
          { connectionId: IDS.jira, type: TRIGGER_TYPE },
          {
            id: IDS.trigger,
            connectionId: IDS.jira,
            type: TRIGGER_TYPE,
            config: { projectKeys: ["PROJ"] },
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(mocks.writes).toEqual([
      "workflow.update",
      "trigger.delete",
      "trigger.create",
      `trigger.update:${IDS.trigger}`,
      "action.delete",
      "action.create",
    ]);
    expect(mocks.triggers.map((row) => row.id)).toEqual([
      IDS.trigger,
      expect.stringMatching(NEW_TRIGGER_ID_RE),
    ]);
    expect(mocks.triggers.find((row) => row.id === IDS.trigger)).toMatchObject({
      config: { projectKeys: ["PROJ"] },
      position: 1,
    });
    expect(mocks.workflow?.name).toBe("Renamed");
  });

  it("keeps the stored run-as user when the update omits it", async () => {
    Object.assign(mocks.workflow ?? {}, { runAsUserId: IDS.runAs });
    mocks.findAccessibleById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: true,
    });

    const result = await workflowService.update(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      input({ name: "Renamed" })
    );

    expect(result.ok).toBe(true);
    expect(mocks.workflow?.runAsUserId).toBe(IDS.runAs);
    expect(mocks.findAccessibleById).toHaveBeenLastCalledWith(
      IDS.target,
      IDS.org,
      IDS.runAs
    );
  });

  it("refuses an edit by another admin that keeps the run-as member's private desktop", async () => {
    Object.assign(mocks.workflow ?? {}, { runAsUserId: IDS.runAs });
    mocks.findAccessibleById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: false,
    });

    const result = await workflowService.update(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      input({ name: "Renamed" })
    );

    expect(result.ok ? "" : result.error.message).toContain(
      "must be shared with the organization"
    );
    expect(mocks.writes).toEqual([]);
  });

  it("changes the run-as user when the update sends one", async () => {
    Object.assign(mocks.workflow ?? {}, { runAsUserId: IDS.runAs });

    await workflowService.update(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      input({ runAsUserId: IDS.caller })
    );

    expect(mocks.workflow?.runAsUserId).toBe(IDS.caller);
  });

  it("rejects an id that does not belong to the workflow", async () => {
    const result = await workflowService.update(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      input({
        triggers: [
          { id: IDS.action, connectionId: IDS.jira, type: TRIGGER_TYPE },
        ],
      })
    );

    expect(result.ok ? "" : result.error.message).toContain(
      "does not belong to this workflow"
    );
    expect(mocks.writes).toEqual([]);
  });

  it("answers 404 for an unknown workflow", async () => {
    const result = await workflowService.update(
      IDS.org,
      IDS.action,
      IDS.caller,
      input()
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
  });
});

describe("workflowService.setEnabled", () => {
  beforeEach(async () => {
    await workflowService.create(
      IDS.org,
      IDS.caller,
      input({ enabled: false })
    );
    // Stored rows carry database ids.
    mocks.triggers.splice(0, mocks.triggers.length, {
      id: IDS.trigger,
      connectionId: IDS.jira,
      type: TRIGGER_TYPE,
      config: { projectKeys: [] },
      enabled: true,
      position: 0,
    });
    mocks.actions.splice(
      0,
      mocks.actions.length,
      {
        id: IDS.action,
        connectionId: IDS.teams,
        type: ACTION_TYPE,
        config: { message: "{{summary}}" },
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
        position: 0,
      },
      {
        id: IDS.preAction,
        connectionId: IDS.teams,
        type: ACTION_TYPE,
        config: { message: "pre" },
        stage: WorkflowActionStage.Pre,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: false,
        enabled: true,
        position: 0,
      }
    );
    mocks.writes = [];
    vi.clearAllMocks();
    mocks.findOwnedById.mockResolvedValue({ id: IDS.target });
  });

  it("turns a workflow off without checking any dependency", async () => {
    mocks.workflow = { ...mocks.workflow, enabled: true } as Row;
    // Everything the workflow depends on broke.
    mocks.activeUsers.clear();
    mocks.projectExists = false;
    mocks.connections = [];
    mocks.findOwnedById.mockResolvedValue(null);

    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      { enabled: false }
    );

    expect(result.ok ? result.value.enabled : null).toBe(false);
    expect(mocks.workflow?.enabled).toBe(false);
    expect(mocks.writes).toEqual(["workflow.update"]);
    expect(mocks.findOwnedById).not.toHaveBeenCalled();
  });

  it("turns it on after re-validating the stored workflow, writing only the flag", async () => {
    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      { enabled: true }
    );

    expect(result.ok ? result.value.enabled : null).toBe(true);
    expect(mocks.writes).toEqual(["workflow.update"]);
    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      IDS.target,
      IDS.org,
      IDS.caller
    );
  });

  it("refuses to turn on a workflow whose dependency broke, with the reason", async () => {
    mocks.connections = mocks.connections.filter(
      (connection) => connection.id !== IDS.teams
    );

    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      { enabled: true }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: "Pre action 1: integration connection not found.",
      },
    });
    expect(mocks.workflow?.enabled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it("validates as the caller: another member's private desktop cannot be turned on", async () => {
    Object.assign(mocks.workflow ?? {}, { runAsUserId: IDS.runAs });
    mocks.findAccessibleById.mockResolvedValue({
      id: IDS.target,
      isSharedWithOrg: false,
    });

    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      { enabled: true }
    );

    expect(result.ok ? "" : result.error.message).toContain(
      "must be shared with the organization"
    );
    expect(mocks.workflow?.enabled).toBe(false);
  });

  it("refuses to turn on a workflow whose run-as user was removed", async () => {
    Object.assign(mocks.workflow ?? {}, { runAsUserId: null });

    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.workflow,
      IDS.caller,
      { enabled: true }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
    expect(mocks.workflow?.enabled).toBe(false);
  });

  it("answers 404 for an unknown workflow", async () => {
    const result = await workflowService.setEnabled(
      IDS.org,
      IDS.action,
      IDS.caller,
      { enabled: false }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
  });
});

describe("workflowService read redaction", () => {
  beforeEach(async () => {
    await workflowService.create(IDS.org, IDS.caller, input());
    mocks.triggers[0].config = {
      projectKeys: ["PROJ"],
      callbackUrl: "https://cb.example.com/hook/tok",
    };
    mocks.actions[0].config = { message: "{{summary}}", url: HOOK_URL };
  });

  it("shows members who are not admins only the origin of url fields", async () => {
    const [listed] = await workflowService.list(IDS.org, MEMBER_VIEWER);
    const single = await workflowService.get(
      IDS.org,
      IDS.workflow,
      MEMBER_VIEWER
    );

    for (const workflow of [listed, single]) {
      expect(workflow?.actions[0].config).toEqual({
        message: "{{summary}}",
        url: "https://hooks.example.com/…",
      });
      expect(workflow?.triggers[0].config).toEqual({
        projectKeys: ["PROJ"],
        callbackUrl: "https://cb.example.com/…",
      });
    }
    expect(JSON.stringify(listed)).not.toContain("secret");
  });

  it("shows admins the full values", async () => {
    const workflow = await workflowService.get(
      IDS.org,
      IDS.workflow,
      ADMIN_VIEWER
    );

    expect(workflow?.actions[0].config.url).toBe(HOOK_URL);
    expect(workflow?.triggers[0].config.callbackUrl).toBe(
      "https://cb.example.com/hook/tok"
    );
  });

  it("hides the config of a type the registry no longer knows from members", async () => {
    mocks.actions[0].type = "gone.post";

    const workflow = await workflowService.get(
      IDS.org,
      IDS.workflow,
      MEMBER_VIEWER
    );

    expect(workflow?.actions[0].config).toEqual({});
  });
});

describe("workflowService.list", () => {
  it("aggregates run counts per workflow", async () => {
    await workflowService.create(IDS.org, IDS.caller, input());
    mocks.runGroups = [
      {
        workflowId: IDS.workflow,
        status: WorkflowRunStatus.Planning,
        _count: { _all: 2 },
      },
      {
        workflowId: IDS.workflow,
        status: WorkflowRunStatus.NeedsInput,
        _count: { _all: 1 },
      },
      {
        workflowId: IDS.workflow,
        status: WorkflowRunStatus.Succeeded,
        _count: { _all: 4 },
      },
      {
        workflowId: IDS.workflow,
        status: WorkflowRunStatus.Failed,
        _count: { _all: 3 },
      },
      {
        workflowId: IDS.workflow,
        status: WorkflowRunStatus.Cancelled,
        _count: { _all: 1 },
      },
    ];

    const [workflow] = await workflowService.list(IDS.org, ADMIN_VIEWER);

    expect(workflow.runCounts).toEqual({
      total: 11,
      active: 3,
      succeeded: 4,
      failed: 3,
    });
  });
});

describe("workflowService.remove", () => {
  it("answers 404 for an unknown or malformed id", async () => {
    await expect(
      workflowService.remove(IDS.org, "nope")
    ).resolves.toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
    await expect(
      workflowService.remove(IDS.org, IDS.workflow)
    ).resolves.toMatchObject({ ok: false, error: { status: Status.NotFound } });
  });
});
