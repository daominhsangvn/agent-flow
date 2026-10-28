import {
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "@repo/api/src/types/orchestrator";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOrchestratorWorkflows } from "@/lib/orchestrator/workflow-settings";

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const RUNNER = "0199a5f0-0000-7000-8000-0000000000c1";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ workflow: { findMany: mocks.findMany } }),
}));

function row(id: string, agentConfig: Record<string, unknown>, enabled = true) {
  return { id, name: `Workflow ${id}`, description: "d", enabled, agentConfig };
}

describe("loadOrchestratorWorkflows", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
  });

  it("returns an empty map without querying for no ids", async () => {
    const result = await loadOrchestratorWorkflows(ORG, []);
    expect(result.size).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("drops workflows that are not orchestrated", async () => {
    mocks.findMany.mockResolvedValue([
      row("w1", {
        mode: WorkflowAgentMode.PlanAndExecute,
        computeTargetId: RUNNER,
      }),
    ]);
    const result = await loadOrchestratorWorkflows(ORG, ["w1"]);
    expect(result.size).toBe(0);
  });

  it("applies the defaults without an orchestrator mapping", async () => {
    mocks.findMany.mockResolvedValue([
      row("w1", {
        mode: WorkflowAgentMode.Orchestrated,
        computeTargetId: RUNNER,
        instructions: "Rules.",
      }),
    ]);
    const settings = (await loadOrchestratorWorkflows(ORG, ["w1"])).get("w1");
    expect(settings).toMatchObject({
      computeTargetId: RUNNER,
      rules: "Rules.",
      concurrency: OrchestratorConcurrency.Supersede,
      debounceSeconds: 20,
      turnTimeoutMinutes: 10,
      cancelOn: [
        OrchestratorTicketChange.StatusChanged,
        OrchestratorTicketChange.LabelRemoved,
      ],
      enabled: true,
    });
  });

  it("keeps an explicit empty cancelOn and deduplicates values", async () => {
    mocks.findMany.mockResolvedValue([
      row("w1", {
        mode: WorkflowAgentMode.Orchestrated,
        computeTargetId: RUNNER,
        orchestrator: { cancelOn: [] },
      }),
      row("w2", {
        mode: WorkflowAgentMode.Orchestrated,
        computeTargetId: RUNNER,
        orchestrator: {
          cancelOn: [
            OrchestratorTicketChange.LabelAdded,
            OrchestratorTicketChange.LabelAdded,
          ],
        },
      }),
    ]);
    const result = await loadOrchestratorWorkflows(ORG, ["w1", "w2"]);
    expect(result.get("w1")?.cancelOn).toEqual([]);
    expect(result.get("w2")?.cancelOn).toEqual([
      OrchestratorTicketChange.LabelAdded,
    ]);
  });

  it("reads a stored orchestrator config and keeps enabled false", async () => {
    mocks.findMany.mockResolvedValue([
      row(
        "w1",
        {
          mode: WorkflowAgentMode.Orchestrated,
          computeTargetId: RUNNER,
          orchestrator: {
            concurrency: OrchestratorConcurrency.Queue,
            debounceSeconds: 5,
            turnTimeoutMinutes: 3,
          },
        },
        false
      ),
    ]);
    const settings = (await loadOrchestratorWorkflows(ORG, ["w1"])).get("w1");
    expect(settings).toMatchObject({
      concurrency: OrchestratorConcurrency.Queue,
      debounceSeconds: 5,
      turnTimeoutMinutes: 3,
      enabled: false,
    });
  });

  it("scopes the query to the organization and unique ids", async () => {
    mocks.findMany.mockResolvedValue([]);
    await loadOrchestratorWorkflows(ORG, ["w1", "w1", "w2"]);
    expect(mocks.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      id: { in: ["w1", "w2"] },
    });
  });
});
