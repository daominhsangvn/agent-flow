import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_HTTP_TRIGGER_TYPE,
  FAKE_TRIGGER_TYPE,
} from "@/lib/workflows/__tests__/support/workflow-registry.test-fake";
import {
  removeUnusedWorkflowHttpEndpoint,
  resolveBuiltInHttpChildren,
} from "@/lib/workflows/workflow-http-endpoint";
import { validateWorkflowInput } from "@/lib/workflows/workflow-validation";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  caller: "0199a5f0-0000-7000-8000-0000000000a1",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
  jira: "0199a5f0-0000-7000-8000-0000000000e1",
  endpoint: "0199a5f0-0000-7000-8000-0000000000e3",
  workflow: "0199a5f0-0000-7000-8000-0000000000f1",
};

const mocks = vi.hoisted(() => ({
  managed: null as { id: string } | null,
  connections: [] as Array<{ id: string; name: string; provider: string }>,
  updates: [] as unknown[],
  deletes: [] as unknown[],
  createConnection: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const db = {
    project: {
      findMany: vi.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => ({ id, name: "Requests" }))
        )
      ),
    },
    projectConnection: {
      findMany: vi.fn(() =>
        Promise.resolve(
          mocks.connections.map((row) => ({
            id: `pc-${row.id}`,
            projectId: IDS.project,
            key: "jira",
            name: row.name,
            connectionId: row.id,
            settings: {},
            credentialsEncrypted: null,
            connection: { provider: row.provider },
          }))
        )
      ),
    },
    user: {
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve({ id: args.where.id })
      ),
    },
    integrationConnection: {
      findFirst: vi.fn(() => Promise.resolve(mocks.managed)),
      update: vi.fn((args: unknown) => {
        mocks.updates.push(args);
        return Promise.resolve({});
      }),
      deleteMany: vi.fn((args: { where: unknown }) => {
        mocks.deletes.push(args.where);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});
vi.mock("@/lib/integrations/connection-service", () => ({
  integrationConnectionService: { create: mocks.createConnection },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(() => Promise.resolve({ id: "target" })),
    findAccessibleById: vi.fn(() => Promise.resolve(null)),
  },
}));
vi.mock("@/lib/integrations/registry", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/workflow-registry.test-fake"
  );
  return support.fakeWorkflowRegistry;
});

const httpTrigger = {
  connectionKey: null,
  type: FAKE_HTTP_TRIGGER_TYPE,
  config: { types: ["feature"] },
};

function input(triggers: unknown[]): SaveWorkflowInput {
  return saveWorkflowInputSchema.parse({
    name: "Requests to PR",
    projectId: IDS.project,
    agent: { computeTargetId: IDS.target, mode: WorkflowAgentMode.Plan },
    triggers,
    actions: [],
  });
}

function validate(triggers: unknown[], workflowId: string | null = null) {
  return validateWorkflowInput(
    {
      organizationId: IDS.org,
      callerId: IDS.caller,
      defaultRunAsUserId: IDS.caller,
      existing: { triggerIds: new Set(), actionIds: new Set() },
      workflowId,
    },
    input(triggers)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managed = null;
  mocks.connections = [{ id: IDS.jira, name: "Jira", provider: "fake" }];
  mocks.updates = [];
  mocks.deletes = [];
  mocks.createConnection.mockResolvedValue({
    ok: true,
    value: { id: IDS.endpoint },
  });
});

describe("validateWorkflowInput with the built-in HTTP trigger", () => {
  it("accepts a webhook request trigger without a connection", async () => {
    const result = await validate([httpTrigger]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        triggers: [
          {
            projectId: IDS.project,
            projectConnectionId: null,
            connectionId: null,
            type: FAKE_HTTP_TRIGGER_TYPE,
            config: { types: ["feature"] },
            position: 0,
          },
        ],
      },
    });
  });

  it("refuses any other trigger type on the built-in endpoint", async () => {
    const result = await validate([
      { ...httpTrigger, type: FAKE_TRIGGER_TYPE },
    ]);

    expect(result).toEqual({
      ok: false,
      error: `Trigger 1: the workflow's HTTP endpoint only offers "${FAKE_HTTP_TRIGGER_TYPE}".`,
    });
  });

  it("resolves a keyed trigger to the project connection beside the built-in one", async () => {
    const result = await validate([
      httpTrigger,
      { connectionKey: "jira", type: FAKE_TRIGGER_TYPE },
    ]);

    expect(
      result.ok &&
        result.value.triggers.map((trigger) => trigger.projectConnectionId)
    ).toEqual([null, `pc-${IDS.jira}`]);
  });
});

describe("resolveBuiltInHttpChildren", () => {
  const owner = {
    organizationId: IDS.org,
    workflowId: IDS.workflow,
    userId: IDS.caller,
    workflowName: "Requests to PR",
    actions: [],
  };
  const builtIn = {
    projectId: IDS.project,
    projectConnectionId: null,
    connectionId: null,
    type: FAKE_HTTP_TRIGGER_TYPE,
    config: {},
    enabled: true,
    position: 0,
  };

  it("creates the endpoint as a webhook connection owned by the workflow", async () => {
    const result = await resolveBuiltInHttpChildren({
      ...owner,
      triggers: [builtIn],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        triggers: [{ ...builtIn, connectionId: IDS.endpoint }],
        actions: [],
      },
    });
    expect(mocks.createConnection).toHaveBeenCalledWith(IDS.org, IDS.caller, {
      provider: "webhook",
      name: "HTTP · Requests to PR",
      config: {},
      secrets: {},
      deliveryMode: "webhook",
      pollIntervalSeconds: expect.any(Number),
    });
    expect(mocks.updates).toEqual([
      {
        where: { id: IDS.endpoint },
        data: { managedByWorkflowId: IDS.workflow },
      },
    ]);
  });

  it("reuses the existing endpoint and leaves other triggers alone", async () => {
    mocks.managed = { id: IDS.endpoint };
    const other = {
      ...builtIn,
      projectConnectionId: `pc-${IDS.jira}`,
      connectionId: IDS.jira,
      position: 1,
    };

    const result = await resolveBuiltInHttpChildren({
      ...owner,
      triggers: [builtIn, other],
    });

    expect(
      result.ok && result.value.triggers.map((trigger) => trigger.connectionId)
    ).toEqual([IDS.endpoint, IDS.jira]);
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  it("points a built-in HTTPS call at the same endpoint", async () => {
    mocks.managed = { id: IDS.endpoint };
    const post = {
      connectionKey: null,
      type: "webhook.post",
      config: { url: "https://hooks.example.com/runs" },
      enabled: true,
      position: 0,
      stage: WorkflowActionStage.Post,
      events: [],
      continueOnError: false,
    };

    const result = await resolveBuiltInHttpChildren({
      ...owner,
      triggers: [],
      actions: [{ ...post, automaticConnection: false }],
    });

    expect(result.ok && result.value.actions).toEqual([
      { ...post, connectionId: IDS.endpoint },
    ]);
  });

  it("keeps an action with an automatic connection off the endpoint", async () => {
    const instruction = {
      connectionKey: null,
      type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
      config: { instruction: "Move the issue to In Progress." },
      enabled: true,
      position: 0,
      stage: WorkflowActionStage.Pre,
      events: [WorkflowRunEvent.Triggered],
      continueOnError: false,
    };

    const result = await resolveBuiltInHttpChildren({
      ...owner,
      triggers: [],
      actions: [{ ...instruction, automaticConnection: true }],
    });

    expect(result.ok && result.value.actions).toEqual([
      { ...instruction, connectionId: null },
    ]);
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  it("reports a failed endpoint creation", async () => {
    mocks.createConnection.mockResolvedValue({
      ok: false,
      error: { status: 400, message: "Invalid configuration" },
    });

    const result = await resolveBuiltInHttpChildren({
      ...owner,
      triggers: [builtIn],
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Could not create the workflow's HTTP endpoint: Invalid configuration",
    });
  });

  it("removes the endpoint only when nothing uses it", async () => {
    await removeUnusedWorkflowHttpEndpoint(IDS.org, IDS.workflow);

    expect(mocks.deletes).toEqual([
      {
        organizationId: IDS.org,
        managedByWorkflowId: IDS.workflow,
        triggers: { none: {} },
        actions: { none: {} },
      },
    ]);
  });
});
