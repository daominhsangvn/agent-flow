import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  type UpdateIntegrationConnectionInput,
} from "@repo/api/src/types/integration";
import {
  type IntegrationConnection as IntegrationConnectionRecord,
  Prisma,
} from "@repo/database";
import { parseConnectionStatus } from "./stored-json";

/**
 * What an update does to a connection's status and poll schedule (the
 * connection service's update path): pure, so it is decided from the stored
 * row and the request alone.
 */

export type PollScheduleInput = {
  deliveryMode: IntegrationDeliveryMode;
  status: IntegrationConnectionStatus;
  /** Submitted interval; undefined keeps the stored one. */
  pollIntervalSeconds: number | undefined;
  now: Date;
};

/**
 * An explicit status wins. A successful re-validation clears an error status
 * but never re-enables a disabled connection.
 */
export function resolveNextStatus(
  record: IntegrationConnectionRecord,
  requested: UpdateIntegrationConnectionInput["status"],
  revalidated: boolean
): IntegrationConnectionStatus {
  const current = parseConnectionStatus(record.status);
  if (requested !== undefined) {
    return requested;
  }
  if (revalidated && current !== IntegrationConnectionStatus.Disabled) {
    return IntegrationConnectionStatus.Active;
  }
  return current;
}

/**
 * Entering poll mode polls right away from a fresh cursor (a stale cursor
 * would replay a backlog); re-enabling a polling connection polls right away;
 * a changed poll interval takes effect now; leaving poll mode unschedules it.
 */
export function pollScheduleChanges(
  record: IntegrationConnectionRecord,
  next: PollScheduleInput
): Prisma.IntegrationConnectionUpdateInput {
  const wasPolling = record.deliveryMode === IntegrationDeliveryMode.Poll;
  if (next.deliveryMode !== IntegrationDeliveryMode.Poll) {
    return wasPolling ? { nextPollAt: null } : {};
  }
  if (!wasPolling) {
    return { nextPollAt: next.now, pollCursor: Prisma.DbNull };
  }
  const reEnabled =
    record.status === IntegrationConnectionStatus.Disabled &&
    next.status !== IntegrationConnectionStatus.Disabled;
  if (reEnabled) {
    return { nextPollAt: next.now };
  }
  return rescheduleForInterval(record, next);
}

/**
 * A new poll interval moves the next poll to at most one new interval from
 * now; a poll that is already due sooner keeps its time.
 */
function rescheduleForInterval(
  record: IntegrationConnectionRecord,
  next: PollScheduleInput
): Prisma.IntegrationConnectionUpdateInput {
  const interval = next.pollIntervalSeconds;
  if (interval === undefined || interval === record.pollIntervalSeconds) {
    return {};
  }
  const latest = new Date(next.now.getTime() + interval * 1000);
  const current = record.nextPollAt;
  return { nextPollAt: current && current < latest ? current : latest };
}
