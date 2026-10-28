import type {
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "@repo/api/src/types/orchestrator";
import { resolveWorkflowOrchestratorConfig } from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { withDb } from "@repo/database";
import { readAgentConfig } from "@/lib/workflows/engine/run-data";

/**
 * The orchestrator of an orchestrated workflow (docs/orchestrator.md): its
 * runner, rules and turn settings all live in the workflow's agent config.
 */

/** Callers pass a handful of ids; this bounds the query regardless. */
const WORKFLOW_IDS_MAX = 50;

export type OrchestratorWorkflow = {
  workflowId: string;
  name: string;
  description: string;
  enabled: boolean;
  computeTargetId: string | null;
  rules: string;
  concurrency: OrchestratorConcurrency;
  debounceSeconds: number;
  turnTimeoutMinutes: number;
  cancelOn: OrchestratorTicketChange[];
};

/** The orchestrated workflows among the ids, by id (others are left out). */
export async function loadOrchestratorWorkflows(
  organizationId: string,
  workflowIds: readonly string[]
): Promise<Map<string, OrchestratorWorkflow>> {
  const ids = [...new Set(workflowIds)].slice(0, WORKFLOW_IDS_MAX);
  const result = new Map<string, OrchestratorWorkflow>();
  if (ids.length === 0) {
    return result;
  }
  const rows = await withDb((db) =>
    db.workflow.findMany({
      where: { organizationId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        description: true,
        enabled: true,
        agentConfig: true,
      },
    })
  );
  for (const row of rows) {
    const agent = readAgentConfig(row.agentConfig);
    if (agent?.mode !== WorkflowAgentMode.Orchestrated) {
      continue;
    }
    const settings = resolveWorkflowOrchestratorConfig(agent);
    result.set(row.id, {
      workflowId: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      computeTargetId: agent.computeTargetId,
      rules: agent.instructions,
      concurrency: settings.concurrency,
      debounceSeconds: settings.debounceSeconds,
      turnTimeoutMinutes: settings.turnTimeoutMinutes,
      cancelOn: settings.cancelOn,
    });
  }
  return result;
}
