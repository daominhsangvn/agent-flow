"use client";

import { isLiveDisplayedSessionStatus } from "@repo/api/src/types/session-status";
import type { WorkflowRunSession } from "@repo/api/src/types/workflow";
// Cross-slice: sessions render with the agents slice's status badge and
// harness labels so a session reads the same here as on the Sessions page.
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { resolveHarnessDisplayConfig } from "@repo/app/agents/lib/harness-labels";
import {
  resolveSessionDurationDetail,
  resolveSessionDurationWindow,
  resolveSessionWallClockLabel,
  SESSION_DURATION_TICK_MS,
  toSessionInstant,
} from "@repo/app/agents/lib/session-duration";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import {
  formatDateTime,
  formatRelativeTime,
} from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { RadioIcon } from "lucide-react";

/**
 * The agent sessions the run's loops ran (synced from the run's computer),
 * newest first. A session that is still running opens its detail page, where
 * its transcript follows the agent as it works.
 */
export function WorkflowRunSessionsCard({
  sessions,
  commandLabel,
  stepName,
}: Readonly<{
  sessions: readonly WorkflowRunSession[];
  /** Display label of a loop command. */
  commandLabel: (command: string) => string;
  /** The process step's name for a step id. */
  stepName: (stepId: string) => string;
}>) {
  const buildOrgPath = useOrgPath();
  const live = sessions.filter(isLiveSession).length;
  // A running session's duration grows: re-read the clock while one runs.
  const now = useCoarseNow(SESSION_DURATION_TICK_MS, live > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sessions</CardTitle>
        <CardDescription>
          {live > 0
            ? `${live} ${live === 1 ? "session is" : "sessions are"} running. Open one to follow it live.`
            : "The agent sessions the run's loops ran."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No session has synced for this run yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Loop</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const href = buildOrgPath(`/sessions/${session.id}`);
                  return (
                    <TableRow
                      data-live={isLiveSession(session) || undefined}
                      data-testid="run-session"
                      key={session.id}
                    >
                      <TableCell className="max-w-80">
                        <Link
                          className="block truncate font-medium hover:underline"
                          href={href}
                          title={sessionLabel(session)}
                        >
                          {sessionLabel(session)}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Link
                          className="hover:underline"
                          href={buildOrgPath(`/loops/${session.loopId}`)}
                        >
                          {commandLabel(session.command)}
                        </Link>
                        {session.stepId ? (
                          <span className="ml-2 text-muted-foreground text-xs">
                            {stepName(session.stepId)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <SessionStatusBadge status={session.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {resolveHarnessDisplayConfig(session.harness).label}
                        {session.model ? (
                          <span className="ml-2 font-mono text-muted-foreground text-xs">
                            {session.model}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(session.startedAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <SessionDuration now={now} session={session} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {session.lastActivityAt
                          ? formatRelativeTime(session.lastActivityAt)
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {isLiveSession(session) ? (
                          <Button asChild size="sm" variant="outline">
                            <Link href={href}>
                              <RadioIcon className="size-4" />
                              Watch live
                            </Link>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function isLiveSession(session: WorkflowRunSession): boolean {
  return isLiveDisplayedSessionStatus(session.status);
}

function sessionLabel(session: WorkflowRunSession): string {
  const name = session.name?.trim() || "Untitled session";
  return session.slug ? `${session.slug} ${name}` : name;
}

/**
 * Wall time of the session, as the Sessions page shows it: start to now while
 * it runs, start to end once it is over, a dash when the end is unknown.
 */
function SessionDuration({
  session,
  now,
}: Readonly<{ session: WorkflowRunSession; now: Date }>) {
  const window = resolveSessionDurationWindow(
    session.status,
    toSessionInstant(session.endedAt)
  );
  const label = resolveSessionWallClockLabel(
    session.startedAt,
    window,
    now.getTime()
  );
  if (!label) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <span
      className="tabular-nums"
      data-testid="run-session-duration"
      title={resolveSessionDurationDetail(window) ?? undefined}
    >
      {label}
    </span>
  );
}
