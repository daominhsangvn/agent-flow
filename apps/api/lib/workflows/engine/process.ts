import type { LoopAgentPolicy } from "@agentflow-ai/loops-api/context-pack";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  deriveProcessFromAgentConfig,
  ProcessExecuteReview,
  ProcessPlanRecommendations,
  type ProcessStep,
  ProcessStepType,
  type ProjectProcess,
  type RunProcessSnapshot,
  RunProcessSource,
  runProcessSnapshotSchema,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import {
  CurrentProcessKind,
  projectProcessService,
} from "@/app/projects/project-process-service";
import { runError } from "./errors";
import { toJsonObject } from "./run-data";

/**
 * The process a run follows between its pre and post actions
 * (packages/api/src/types/project-process.ts). A run on a project with a
 * process carries a snapshot of it (WorkflowRun.process) and its current step
 * (WorkflowRun.stepId). Any other run follows the built-in AgentFlow flow,
 * derived from its agent config exactly as before processes existed; such a
 * run writes neither column, so its rows are unchanged.
 */

export type RunProcess = {
  process: ProjectProcess;
  /** True for a project process snapshot; false for the derived built-in flow. */
  snapshot: boolean;
};

/** The run's snapshot, else the built-in flow of its agent config. */
export function resolveRunProcess(
  stored: unknown,
  agent: WorkflowAgentConfig
): RunProcess {
  const snapshot = readRunProcessSnapshot(stored);
  return snapshot
    ? { process: snapshot.definition, snapshot: true }
    : { process: deriveProcessFromAgentConfig(agent), snapshot: false };
}

export function readRunProcessSnapshot(
  value: unknown
): RunProcessSnapshot | null {
  const parsed = runProcessSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The process a run starts (or resumes) with when it is ingested: the
 * snapshot it already has (a resumed run keeps its process), else the
 * workflow's own process, else the project's current process, else the
 * built-in flow. `newSnapshot` is set
 * when a project process is snapshotted now and must be stored on the run.
 */
export async function resolveIngestProcess(input: {
  organizationId: string;
  projectId: string;
  stored: unknown;
  agent: WorkflowAgentConfig;
}): Promise<
  Result<
    RunProcess & { newSnapshot: RunProcessSnapshot | null },
    WorkflowRunError
  >
> {
  const existing = readRunProcessSnapshot(input.stored);
  if (existing) {
    return Result.ok({
      process: existing.definition,
      snapshot: true,
      newSnapshot: null,
    });
  }
  // The workflow's own process wins over the project's.
  if (input.agent.process) {
    const own = withoutYaml({
      version: 1,
      source: RunProcessSource.Workflow,
      definition: input.agent.process,
    });
    return Result.ok({
      process: own.definition,
      snapshot: true,
      newSnapshot: own,
    });
  }
  const current = await projectProcessService.findCurrent(
    input.organizationId,
    input.projectId
  );
  if (current.kind === CurrentProcessKind.Invalid) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        `The project's process (version ${current.version}) is not valid. Open the project's process and save it again.`
      )
    );
  }
  if (current.kind === CurrentProcessKind.Found) {
    const snapshot = withoutYaml(current.snapshot);
    return Result.ok({
      process: snapshot.definition,
      snapshot: true,
      newSnapshot: snapshot,
    });
  }
  return Result.ok({
    process: deriveProcessFromAgentConfig(input.agent),
    snapshot: false,
    newSnapshot: null,
  });
}

/** The step with this id, else the first step of the given type. */
export function findStep<T extends ProcessStep["type"]>(
  process: ProjectProcess,
  type: T,
  stepId: string | null | undefined
): Extract<ProcessStep, { type: T }> | null {
  const byId = stepId
    ? process.steps.find((step) => step.id === stepId && step.type === type)
    : undefined;
  const step =
    byId ?? process.steps.find((candidate) => candidate.type === type);
  return (step as Extract<ProcessStep, { type: T }> | undefined) ?? null;
}

/**
 * Columns a transition into `stepId` writes: nothing on the built-in flow
 * (its step follows from the status, and its transitions stay exactly as they
 * were), the step id (plus a new snapshot) otherwise.
 */
export function stepTransitionData(
  runProcess: Pick<RunProcess, "snapshot">,
  stepId: string,
  newSnapshot: RunProcessSnapshot | null = null
): { stepId: string; process?: JsonObject } | undefined {
  if (!runProcess.snapshot) {
    return;
  }
  return newSnapshot
    ? { stepId, process: toJsonObject(newSnapshot) }
    : { stepId };
}

/** A step type this build cannot run yet (processes are saved by newer builds). */
export function unsupportedStepError(step: ProcessStep): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.AgentConfigInvalid,
    `The process step "${step.name}" (${step.type}) cannot run here yet.`
  );
}

/**
 * A run keeps what runs: the toolkit and the steps, not the YAML the process
 * was written in (`definition.source`, which only the editor shows).
 */
function withoutYaml(snapshot: RunProcessSnapshot): RunProcessSnapshot {
  const { source: _yaml, ...definition } = snapshot.definition;
  return { ...snapshot, definition };
}

/**
 * What the agents of a plan or implement step decide on their own, sent to
 * the computer with the step's loop when the step changes the built-in
 * behaviour; undefined otherwise, so built-in runs launch exactly as before.
 */
export function stepAgentPolicy(
  step: ProcessStep | null
): LoopAgentPolicy | undefined {
  if (
    step?.type === ProcessStepType.AgentFlowPlan &&
    step.recommendations !== ProcessPlanRecommendations.Accept
  ) {
    return { recommendations: step.recommendations };
  }
  if (
    step?.type === ProcessStepType.AgentFlowExecute &&
    step.review !== ProcessExecuteReview.Full
  ) {
    return { review: step.review };
  }
  return;
}
