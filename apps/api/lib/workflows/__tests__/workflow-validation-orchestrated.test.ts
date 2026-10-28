import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { describe, expect, it, vi } from "vitest";
import { FAKE_TRIGGER_TYPE } from "@/lib/workflows/__tests__/support/workflow-registry.test-fake";
import { validateWorkflowInput } from "@/lib/workflows/workflow-validation";

/**
 * A workflow handed to the orchestrator (`agent.mode: orchestrated`,
 * docs/orchestrator.md) starts no run: it has no process of its own and runs
 * on one runner.
 */

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  caller: "0199a5f0-0000-7000-8000-0000000000a1",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
};

vi.mock("@repo/database", () => {
  const db = {
    project: {
      findMany: (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => ({ id, name: "Billing" }))
        ),
    },
    user: {
      findFirst: (args: { where: { id: string } }) =>
        Promise.resolve({ id: args.where.id }),
    },
    projectConnection: {
      findMany: () =>
        Promise.resolve([
          {
            id: "pc-jira",
            projectId: IDS.project,
            key: "jira",
            name: "jira",
            provider: "fake",
            settings: { projectKeys: ["PROJ"] },
            connectionId: "conn-jira",
            credentialsEncrypted: null,
            connection: { provider: "fake" },
          },
        ]),
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
  listProjectRepositoryCheckouts: () => Promise.resolve([]),
}));
vi.mock("@/lib/integrations/registry", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/workflow-registry.test-fake"
  );
  return support.fakeWorkflowRegistry;
});

describe("validateWorkflowInput — orchestrated", () => {
  it("accepts an orchestrated workflow without any project setup", async () => {
    const result = await validate(WorkflowAgentMode.Orchestrated);
    expect(result.ok).toBe(true);
  });

  it("refuses a process of its own", async () => {
    const result = await validate(WorkflowAgentMode.Orchestrated, {
      toolkit: null,
      steps: [
        {
          type: "agentflow.plan",
          id: "plan",
          name: "Plan",
        },
      ],
    });
    expect(result.ok ? "" : result.error).toContain(
      "has no process of its own"
    );
  });

  it("refuses runner rules", async () => {
    const result = await validate(WorkflowAgentMode.Orchestrated, null, [
      { condition: 'source.type == "bug"', computeTargetId: IDS.target },
    ]);
    expect(result.ok ? "" : result.error).toContain("remove agent.runners");
  });

  it("leaves the other modes unaffected", async () => {
    const result = await validate(WorkflowAgentMode.Plan);
    expect(result.ok).toBe(true);
  });
});

function validate(
  mode: WorkflowAgentMode,
  process: unknown = null,
  runners: unknown[] = []
) {
  const input: SaveWorkflowInput = saveWorkflowInputSchema.parse({
    name: "Questions to the orchestrator",
    projectId: IDS.project,
    agent: { computeTargetId: IDS.target, mode, process, runners },
    triggers: [{ connectionKey: "jira", type: FAKE_TRIGGER_TYPE }],
    actions: [],
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
