import { LoopStatus } from "@repo/api/src/types/loop";
import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
  type WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { z } from "zod";
import { computeTargetsService } from "@/app/compute-targets/service";
import { runError } from "./errors";
import { failRun, type StepOutcome } from "./step-outcome";

/**
 * The queue of a personal runner that runs one loop at a time
 * (docs/runner.md "Personal runner"; its `personalRunner.parallel` is
 * false). A step about to start on it while another loop is active there
 * waits: the run keeps its status and tries again after RUNNER_QUEUE_RETRY_MS,
 * so runs take the runner in turn instead of failing. Two runs that start at
 * the same moment both create their loop; the one created later (loop ids
 * are UUIDv7, ordered by creation) is cancelled and waits.
 */

/** How long a step waits before it asks for the busy runner again. */
export const RUNNER_QUEUE_RETRY_MS = 60_000;

/** Loops that hold a runner: waiting for it, accepted, or running. */
const ACTIVE_LOOP_STATUSES = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

const sequentialPersonalRunnerSchema = z.object({
  personalRunner: z.object({ parallel: z.literal(false) }),
});
const personalRunnerSchema = z.object({
  personalRunner: z.object({ projectKey: z.string() }),
});

/**
 * True when the compute target is a personal runner. A workflow that names
 * one (directly or by a runner rule) runs there even when the project lists
 * other runners: the runner itself refuses another project's loops.
 */
export async function isPersonalRunnerTarget(input: {
  organizationId: string;
  computeTargetId: string;
}): Promise<boolean> {
  const target = await findOrganizationTarget(input);
  return personalRunnerSchema.safeParse(target?.capabilities).success;
}

/**
 * The RunnerBusy error when the compute target is a personal runner that
 * runs one loop at a time and another loop holds it; null otherwise. With
 * `ownLoopId`, only loops created before that one count (the check after
 * creating it).
 */
export async function personalRunnerBusy(input: {
  organizationId: string;
  computeTargetId: string;
  ownLoopId?: string;
}): Promise<WorkflowRunError | null> {
  const target = await findOrganizationTarget(input);
  if (
    !(
      target &&
      sequentialPersonalRunnerSchema.safeParse(target.capabilities).success
    )
  ) {
    return null;
  }
  const holder = await withDb((db) =>
    db.loop.findFirst({
      where: {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        status: { in: ACTIVE_LOOP_STATUSES },
        ...(input.ownLoopId ? { id: { lt: input.ownLoopId } } : {}),
      },
      select: { id: true },
    })
  );
  return holder
    ? runError(
        WorkflowRunErrorCode.RunnerBusy,
        `Waiting for ${target.machineName}: it runs one task at a time and is running another one.`
      )
    : null;
}

/**
 * What a failed step launch does to the run: a busy runner makes the step
 * wait its turn; any other error fails the run.
 */
export function stepLaunchFailure(
  error: WorkflowRunError,
  events: WorkflowRunEvent[] = []
): StepOutcome {
  return error.code === WorkflowRunErrorCode.RunnerBusy
    ? { kind: "retry", delayMs: RUNNER_QUEUE_RETRY_MS, error }
    : failRun(error, events);
}

/** The compute target when it belongs to the organization. */
async function findOrganizationTarget(input: {
  organizationId: string;
  computeTargetId: string;
}) {
  const target = await computeTargetsService.findById(input.computeTargetId);
  return target?.organizationId === input.organizationId ? target : null;
}
