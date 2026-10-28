import { type LoopEvent, LoopEventType } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { stopDesktopLoopBestEffort } from "@/app/loops/desktop-cancel";
import { isInvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { isLoopTerminal, listRunLoops } from "./run-loops";

/**
 * Cancels the active loops of a run the way POST /loops/{id}/cancel does:
 * best-effort desktop kill, then the database cancellation and the
 * `cancelled` loop event. A loop that finished in the meantime is left alone.
 */
export async function cancelRunLoops(
  runId: string,
  organizationId: string
): Promise<number> {
  const loops = await listRunLoops(runId);
  let cancelled = 0;
  for (const loop of loops) {
    if (isLoopTerminal(loop.status)) {
      continue;
    }
    if (await cancelLoop(loop.loopId, loop.computeTargetId, organizationId)) {
      cancelled += 1;
    }
  }
  return cancelled;
}

const CANCEL_REASON = "Cancelled with its workflow run";

/**
 * Cancels one loop (desktop kill, database cancellation, `cancelled` event).
 * Also used by the orchestrator's `task_cancel`, which passes its own reason.
 * Returns false when the loop had already reached a terminal status.
 */
export async function cancelLoop(
  loopId: string,
  computeTargetId: string | null,
  organizationId: string,
  reason: string = CANCEL_REASON
): Promise<boolean> {
  if (computeTargetId) {
    await stopDesktopLoopBestEffort({ loopId, computeTargetId });
  }
  try {
    await loopsService.cancel(loopId, organizationId);
  } catch (error) {
    if (!isInvalidStatusTransitionError(error)) {
      throw error;
    }
    // The loop reached a terminal status while we were cancelling it.
    log.info("[workflows/cancel] Loop already finished", { loopId });
    return false;
  }
  const event: LoopEvent = {
    type: LoopEventType.Cancelled,
    reason,
    timestamp: new Date().toISOString(),
  };
  await loopsService.addEvent(loopId, organizationId, {
    type: event.type,
    data: event,
  });
  loopEventBus.publish(loopId, event);
  return true;
}
