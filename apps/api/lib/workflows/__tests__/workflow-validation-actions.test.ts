import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { WORKFLOW_EMAIL_ACTION_TYPE } from "@repo/api/src/types/workflow-email";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_ACTION_TYPE,
  FAKE_COMMENT_TYPE,
  FAKE_HTTP_TRIGGER_TYPE,
  FAKE_REPO_ACTION_TYPE,
  FAKE_TRIGGER_TYPE,
} from "@/lib/workflows/__tests__/support/workflow-registry.test-fake";
import { validateWorkflowInput } from "@/lib/workflows/workflow-validation";

/**
 * Saving triggers and actions on project connections (docs/workflows.md
 * "Actions"): keys resolved in every trigger project, trigger filters within
 * the project connection's settings, instructions read-only unless their
 * `connections:` grant writes, actions without a connection that only one
 * connection can serve, list order positions and "Action N" labels.
 */

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  caller: "0199a5f0-0000-7000-8000-0000000000a1",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  otherProject: "0199a5f0-0000-7000-8000-0000000000d2",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
};

type ProjectConnectionRow = {
  id: string;
  projectId: string;
  key: string;
  provider: string;
  settings: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  checkouts: [] as Array<{ connectionId: string; provider: string }>,
  projectConnections: [] as ProjectConnectionRow[],
}));

vi.mock("@repo/database", () => {
  const db = {
    project: {
      findMany: (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => ({
            id,
            name: id === IDS.project ? "Billing" : "Payments",
          }))
        ),
    },
    user: {
      findFirst: (args: { where: { id: string } }) =>
        Promise.resolve({ id: args.where.id }),
    },
    projectConnection: {
      findMany: (args: { where: { projectId: { in: string[] } } }) =>
        Promise.resolve(
          mocks.projectConnections
            .filter((row) => args.where.projectId.in.includes(row.projectId))
            .map((row) => ({
              ...row,
              name: row.key,
              connectionId: `conn-${row.key}`,
              credentialsEncrypted: null,
              connection: { provider: row.provider },
            }))
        ),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: () => Promise.resolve({ id: "target" }),
    findAccessibleById: () => Promise.resolve(null),
  },
}));
vi.mock("@/app/projects/project-process-service", () => ({
  checkProcessToolkit: () => Promise.resolve(null),
}));
vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts: () => Promise.resolve(mocks.checkouts),
}));
vi.mock("@/lib/integrations/registry", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/workflow-registry.test-fake"
  );
  return support.fakeWorkflowRegistry;
});

const JIRA_TRIGGER = { connectionKey: "jira", type: FAKE_TRIGGER_TYPE };
const HTTP_TRIGGER = { connectionKey: null, type: FAKE_HTTP_TRIGGER_TYPE };

beforeEach(() => {
  mocks.checkouts = [];
  mocks.projectConnections = [
    projectConnection(IDS.project, "jira", "fake", { projectKeys: ["PROJ"] }),
    projectConnection(IDS.project, "teams", "teams"),
  ];
});

describe("validateWorkflowInput — triggers", () => {
  it("resolves the key in the trigger's project and keeps the project connection", async () => {
    const result = await validate([], [JIRA_TRIGGER]);

    expect(result.ok && result.value.triggers[0]).toMatchObject({
      projectId: IDS.project,
      projectConnectionId: "pc-jira",
      connectionId: "conn-jira",
    });
  });

  it("refuses a key the trigger's project does not have", async () => {
    const result = await validate(
      [],
      [{ ...JIRA_TRIGGER, projectId: IDS.otherProject }]
    );

    expect(result.ok ? "" : result.error).toBe(
      'Trigger 1: project Payments has no connection "jira". Add it on the project\'s Integrations tab.'
    );
  });

  it("refuses a filter outside the project connection's projects", async () => {
    const result = await validate(
      [],
      [{ ...JIRA_TRIGGER, config: { projectKeys: ["PROJ", "OPS"] } }]
    );

    expect(result.ok ? "" : result.error).toContain(
      'Trigger 1: OPS is not in the settings of connection "jira".'
    );
  });
});

describe("validateWorkflowInput — instructions", () => {
  it("accepts a read-only instruction and stores it without a connection", async () => {
    const result = await validate([instruction()]);

    expect(result.ok && result.value.actions).toEqual([
      {
        connectionKey: null,
        automaticConnection: true,
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        config: { instruction: "Move the issue to In Progress." },
        enabled: true,
        position: 0,
        stage: WorkflowActionStage.Pre,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: false,
      },
    ]);
  });

  it("refuses an instruction that names a connection", async () => {
    const result = await validate([
      instruction({ connectionKey: "jira", automaticConnection: false }),
    ]);

    expect(result.ok ? "" : result.error).toContain(
      "Action 1: an instruction works on the run's source item"
    );
  });

  it("accepts source writes a trigger's provider offers, and keeps the grant", async () => {
    const grants = {
      source: ["comment"],
      teams: "read",
    };
    const result = await validate([
      instruction({ config: withGrants(grants) }),
    ]);

    expect(result.ok && result.value.actions[0].config).toEqual(
      withGrants(grants)
    );
  });

  it("accepts a pull_requests grant without a project connection", async () => {
    const grants = {
      pull_requests: { allow: ["reply", "resolve"], approval: "required" },
    };
    const result = await validate([
      instruction({ config: withGrants(grants) }),
    ]);

    expect(result.ok).toBe(true);
  });

  it("refuses source writes no trigger's connection offers", async () => {
    const result = await validate(
      [instruction({ config: withGrants({ source: ["comment"] }) })],
      [HTTP_TRIGGER]
    );

    expect(result.ok ? "" : result.error).toBe(
      "Action 1: connections.source: no trigger's connection can comment its items."
    );
  });

  it.each([
    [
      { "jira-9": "read" },
      'connections.jira-9: project Billing has no connection "jira-9".',
    ],
    [
      { teams: ["fake.post"] },
      'connections.teams: "fake.post" is not an operation of Fake.',
    ],
    [
      { jira: [FAKE_COMMENT_TYPE] },
      `connections.jira: "${FAKE_COMMENT_TYPE}" works on the run's source item; grant it as source: [comment].`,
    ],
    [
      { jira: { allow: [FAKE_ACTION_TYPE], with: { color: "red" } } },
      'connections.jira.with: "color" is not an option of the allowed operations.',
    ],
    [
      { source: ["delete"] },
      'connections.source allows comment, transition, label, link, not "delete".',
    ],
    [
      { pull_requests: ["merge"] },
      'connections.pull_requests allows read, reply, resolve, not "merge".',
    ],
    [
      { pull_requests: { allow: ["reply"], with: { body: "x" } } },
      "connections.pull_requests has no options to fix with `with`.",
    ],
  ])("refuses the grant %j", async (grants, message) => {
    const result = await validate([
      instruction({ config: withGrants(grants) }),
    ]);

    expect(result.ok ? "" : result.error).toContain(message);
  });

  it("refuses an empty instruction", async () => {
    const result = await validate([
      instruction({ config: { instruction: " " } }),
    ]);

    expect(result.ok ? "" : result.error).toMatch(INSTRUCTION_ISSUE_RE);
  });
});

describe("validateWorkflowInput — email", () => {
  it("accepts an email on input.needed and stores it without a connection", async () => {
    const result = await validate([
      {
        ...automatic(WORKFLOW_EMAIL_ACTION_TYPE, {
          to: ["ada@acme.dev"],
          subject: "{{source.key}} needs you",
        }),
        events: [WorkflowRunEvent.NeedsInput],
      },
    ]);

    expect(result.ok && result.value.actions).toEqual([
      {
        connectionKey: null,
        automaticConnection: true,
        type: WORKFLOW_EMAIL_ACTION_TYPE,
        config: { to: ["ada@acme.dev"], subject: "{{source.key}} needs you" },
        enabled: true,
        position: 0,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.NeedsInput],
        continueOnError: false,
      },
    ]);
  });

  it("refuses an email that names a connection", async () => {
    const result = await validate([
      {
        ...automatic(WORKFLOW_EMAIL_ACTION_TYPE, { to: ["ada@acme.dev"] }),
        connectionKey: "jira",
        automaticConnection: false,
      },
    ]);

    expect(result.ok ? "" : result.error).toContain(
      "Action 1: an email is sent by AgentFlow itself"
    );
  });

  it("refuses an email without recipients or with an invalid address", async () => {
    const empty = await validate([
      automatic(WORKFLOW_EMAIL_ACTION_TYPE, { to: [] }),
    ]);
    const invalid = await validate([
      automatic(WORKFLOW_EMAIL_ACTION_TYPE, { to: ["ada"] }),
    ]);

    expect(empty.ok ? "" : empty.error).toMatch(EMAIL_TO_ISSUE_RE);
    expect(invalid.ok ? "" : invalid.error).toMatch(EMAIL_TO_ISSUE_RE);
  });
});

describe("validateWorkflowInput — actions", () => {
  it("accepts a source item action without a connection", async () => {
    const result = await validate([
      automatic(FAKE_COMMENT_TYPE, { body: "Done" }),
    ]);

    expect(result.ok && result.value.actions[0]).toMatchObject({
      connectionKey: null,
      automaticConnection: true,
    });
  });

  it("accepts a pull request without a connection that a repository connection offers", async () => {
    mocks.checkouts = [{ connectionId: "conn-repo", provider: "repo" }];

    const result = await validate([
      automatic(FAKE_REPO_ACTION_TYPE, { title: "{{source.key}}" }),
    ]);

    expect(result.ok && result.value.actions[0]).toMatchObject({
      automaticConnection: true,
      config: { title: "{{source.key}}" },
    });
  });

  it("refuses a pull request without a connection no connection offers", async () => {
    const result = await validate([
      automatic(FAKE_REPO_ACTION_TYPE, { title: "PR" }),
    ]);

    expect(result.ok ? "" : result.error).toBe(
      `Action 1: no connection of project Billing offers "${FAKE_REPO_ACTION_TYPE}". Add one on the project's Integrations tab.`
    );
  });

  it("refuses an external action without a connection when several could serve it", async () => {
    mocks.projectConnections.push(
      projectConnection(IDS.project, "jira-2", "fake", { projectKeys: ["OPS"] })
    );

    const result = await validate([
      automatic(FAKE_ACTION_TYPE, { message: "{{summary}}" }),
    ]);

    expect(result.ok ? "" : result.error).toBe(
      `Action 1: several connections of project Billing offer "${FAKE_ACTION_TYPE}" (jira, jira-2). Name one with connection:.`
    );
  });

  it("requires an action's key in every trigger project", async () => {
    mocks.projectConnections.push(
      projectConnection(IDS.otherProject, "jira", "fake", {
        projectKeys: ["PAY"],
      })
    );

    const result = await validate(
      [keyed("teams")],
      [JIRA_TRIGGER, { ...JIRA_TRIGGER, projectId: IDS.otherProject }]
    );

    expect(result.ok ? "" : result.error).toBe(
      'Action 1: project Payments has no connection "teams". Add it on the project\'s Integrations tab.'
    );
  });

  it("keeps the list order as position across stages and names actions by it", async () => {
    const result = await validate([
      instruction(),
      keyed("jira"),
      instruction({ config: { instruction: "Summarize." } }),
    ]);

    expect(
      result.ok && result.value.actions.map((action) => action.position)
    ).toEqual([0, 1, 2]);

    const invalid = await validate([
      instruction(),
      { ...keyed("jira"), config: { message: "" } },
    ]);
    expect(invalid.ok ? "" : invalid.error).toMatch(ACTION_2_MESSAGE_RE);
  });
});

describe("saveWorkflowInputSchema — ids", () => {
  it("refuses an action id given to two actions", () => {
    const id = "0199a5f0-0000-7000-8000-0000000000e1";
    const parsed = saveWorkflowInputSchema.safeParse({
      name: "Jira to PR",
      projectId: IDS.project,
      agent: { computeTargetId: IDS.target, mode: WorkflowAgentMode.Plan },
      triggers: [JIRA_TRIGGER],
      actions: [instruction({ id }), instruction({ id })],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ["actions", 1, "id"],
      message: `The id ${id} is given to more than one item`,
    });
  });
});

const INSTRUCTION_ISSUE_RE = /^Action 1: instruction: /;
const ACTION_2_MESSAGE_RE = /^Action 2: message: /;
const EMAIL_TO_ISSUE_RE = /^Action 1: to/;

function validate(actions: unknown[], triggers: unknown[] = [JIRA_TRIGGER]) {
  const input: SaveWorkflowInput = saveWorkflowInputSchema.parse({
    name: "Jira to PR",
    projectId: IDS.project,
    agent: { computeTargetId: IDS.target, mode: WorkflowAgentMode.Plan },
    triggers,
    actions,
  });
  return validateWorkflowInput(
    {
      organizationId: IDS.org,
      callerId: IDS.caller,
      defaultRunAsUserId: IDS.caller,
      existing: { triggerIds: new Set(), actionIds: new Set() },
      workflowId: null,
    },
    input
  );
}

function projectConnection(
  projectId: string,
  key: string,
  provider: string,
  settings: Record<string, unknown> = {}
): ProjectConnectionRow {
  return { id: `pc-${key}`, projectId, key, provider, settings };
}

function instruction(overrides: Record<string, unknown> = {}) {
  return {
    connectionKey: null,
    automaticConnection: true,
    type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
    config: { instruction: "Move the issue to In Progress." },
    stage: WorkflowActionStage.Pre,
    ...overrides,
  };
}

function withGrants(connections: unknown) {
  return { instruction: "Move the issue to In Progress.", connections };
}

function automatic(type: string, config: Record<string, unknown>) {
  return {
    connectionKey: null,
    automaticConnection: true,
    type,
    config,
    events: [WorkflowRunEvent.Succeeded],
  };
}

function keyed(key: string) {
  return {
    connectionKey: key,
    type: FAKE_ACTION_TYPE,
    config: { message: "{{summary}}" },
    events: [WorkflowRunEvent.ExecuteCompleted],
  };
}
