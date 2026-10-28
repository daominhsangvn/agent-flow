import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import type { WorkflowActionRun } from "@repo/database";

/**
 * The order a run's action runs go in, both stages (docs/workflows.md
 * "Actions"): transition by transition (the rows one transition enqueues
 * share their creation time), then the workflow's action order (rows of
 * removed actions last), then event order for an action on several of the
 * transition's events. A row that cannot finish yet holds the rows after it.
 */

export type OrderedActionRun = Pick<
  WorkflowActionRun,
  "id" | "event" | "createdAt"
> & { action: { position: number } | null };

export function compareActionRunOrder(
  left: OrderedActionRun,
  right: OrderedActionRun
): number {
  const byTransition = left.createdAt.getTime() - right.createdAt.getTime();
  if (byTransition !== 0) {
    return byTransition;
  }
  if (left.action && right.action) {
    const byPosition = left.action.position - right.action.position;
    if (byPosition !== 0) {
      return byPosition;
    }
  } else if (left.action || right.action) {
    return left.action ? -1 : 1;
  }
  const byEvent = eventOrder(left.event) - eventOrder(right.event);
  return byEvent === 0 ? left.id.localeCompare(right.id) : byEvent;
}

/** succeeded, failed or skipped: the row will not run again. */
export function isFinalActionRunStatus(status: string): boolean {
  return FINAL_ACTION_RUN_STATUSES.has(status);
}

const FINAL_ACTION_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  WorkflowActionRunStatus.Succeeded,
  WorkflowActionRunStatus.Failed,
  WorkflowActionRunStatus.Skipped,
]);

const EVENT_ORDER: readonly string[] = Object.values(WorkflowRunEvent);

function eventOrder(event: string): number {
  const index = EVENT_ORDER.indexOf(event);
  return index === -1 ? EVENT_ORDER.length : index;
}
