import { describe, expect, it } from "vitest";
import {
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "../orchestrator.ts";
import {
  resolveWorkflowOrchestratorConfig,
  workflowAgentConfigSchema,
  workflowOrchestratorConfigSchema,
} from "../workflow.ts";

const BASE = { computeTargetId: "0199a5f0-0000-7000-8000-0000000000c1" };

describe("workflow orchestrator config", () => {
  it("leaves orchestrator undefined when absent", () => {
    expect(workflowAgentConfigSchema.parse(BASE).orchestrator).toBeUndefined();
  });

  it("resolves defaults", () => {
    expect(resolveWorkflowOrchestratorConfig({})).toEqual({
      concurrency: OrchestratorConcurrency.Supersede,
      debounceSeconds: 20,
      turnTimeoutMinutes: 10,
      cancelOn: [
        OrchestratorTicketChange.StatusChanged,
        OrchestratorTicketChange.LabelRemoved,
      ],
    });
  });

  it("refuses an out-of-range debounce", () => {
    expect(
      workflowOrchestratorConfigSchema.safeParse({ debounceSeconds: 601 })
        .success
    ).toBe(false);
  });

  it("round-trips queue concurrency", () => {
    const parsed = workflowAgentConfigSchema.parse({
      ...BASE,
      orchestrator: {
        concurrency: OrchestratorConcurrency.Queue,
        debounceSeconds: 5,
        turnTimeoutMinutes: 3,
      },
    });
    expect(parsed.orchestrator).toEqual({
      concurrency: OrchestratorConcurrency.Queue,
      debounceSeconds: 5,
      turnTimeoutMinutes: 3,
      cancelOn: [
        OrchestratorTicketChange.StatusChanged,
        OrchestratorTicketChange.LabelRemoved,
      ],
    });
  });
});
