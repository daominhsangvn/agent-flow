import type { WorkflowAgentConfig } from "@repo/api/src/types/workflow";
import {
  chooseRunnerByRules,
  type WorkflowRunnerConditionFacts,
  WorkflowRunnerConditionField,
} from "@repo/api/src/types/workflow-runner-rules";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { SourceItem } from "@/lib/integrations/types";
import { toJsonObject } from "./run-data";
import type { EngineRun } from "./step-outcome";

const LOG_PREFIX = "[workflows/runner-rules]";

/**
 * The run's runner from the workflow's runner rules (docs/workflows.md
 * "Runner rules"), decided once, when the run imports its source item: the
 * first rule whose condition holds for the item names it, else the
 * workflow's runner. The decision is stored in the run's agent config (that
 * runner, no rules), so every later step, and a run resumed in a new cycle,
 * keeps it. A config without rules is returned as it is.
 */
export async function applyRunnerRules(
  run: Pick<EngineRun, "id" | "organizationId">,
  agent: WorkflowAgentConfig,
  item: SourceItem
): Promise<WorkflowAgentConfig> {
  if (agent.runners.length === 0) {
    return agent;
  }
  const choice = chooseRunnerByRules(
    agent.runners,
    runnerConditionFacts(item),
    agent.computeTargetId
  );
  const decided: WorkflowAgentConfig = {
    ...agent,
    computeTargetId: choice.computeTargetId,
    runners: [],
  };
  await withDb((db) =>
    db.workflowRun.updateMany({
      where: { id: run.id, organizationId: run.organizationId },
      data: { agentConfig: toJsonObject(decided) },
    })
  );
  log.info(`${LOG_PREFIX} Runner chosen for the run`, {
    runId: run.id,
    organizationId: run.organizationId,
    computeTargetId: choice.computeTargetId,
    rule: choice.ruleIndex === null ? "default" : choice.ruleIndex + 1,
  });
  return decided;
}

/** What a runner condition reads from a source item. */
export function runnerConditionFacts(
  item: SourceItem
): WorkflowRunnerConditionFacts {
  return {
    [WorkflowRunnerConditionField.Key]: item.key,
    [WorkflowRunnerConditionField.Title]: item.title,
    [WorkflowRunnerConditionField.Type]: item.itemType,
    [WorkflowRunnerConditionField.Status]: item.status,
    [WorkflowRunnerConditionField.Priority]: item.priority,
    [WorkflowRunnerConditionField.Labels]: item.labels,
    [WorkflowRunnerConditionField.Assignee]: item.assignee,
    [WorkflowRunnerConditionField.AssigneeEmail]: item.assigneeEmail ?? null,
    [WorkflowRunnerConditionField.Reporter]: item.reporter,
    [WorkflowRunnerConditionField.ReporterEmail]: item.reporterEmail ?? null,
    [WorkflowRunnerConditionField.Provider]: item.provider,
  };
}
