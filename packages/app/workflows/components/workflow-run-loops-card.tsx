"use client";

import { LoopStatusSchema } from "@agentflow-ai/loops-api/commands";
import type { WorkflowRunLoopRef } from "@repo/api/src/types/workflow";
// Cross-slice: loops render with the loops slice status badge.
import { LoopStatusBadge } from "@repo/app/loops/components/loop-status-badge";
import { formatDateTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
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
import { getLoopCommandLabel } from "../lib/loop-command-label";
import { ExternalOrText } from "./external-or-text";

export function WorkflowRunLoopsCard({
  loops,
  stepName,
  emptyText = "No loop has been launched for this run yet.",
  commandLabel = getLoopCommandLabel,
}: Readonly<{
  loops: readonly WorkflowRunLoopRef[];
  /** Process step name by id, for the loops that ran a step. */
  stepName: (stepId: string) => string;
  emptyText?: string;
  commandLabel?: (command: string) => string;
}>) {
  const buildOrgPath = useOrgPath();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent loops</CardTitle>
      </CardHeader>
      <CardContent>
        {loops.length === 0 ? (
          <p className="text-muted-foreground text-sm">{emptyText}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Command</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Pull request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loops.map((loop) => (
                  <TableRow key={loop.loopId}>
                    <TableCell>
                      <Link
                        className="font-medium hover:underline"
                        href={buildOrgPath(`/loops/${loop.loopId}`)}
                      >
                        {commandLabel(loop.command)}
                      </Link>
                      {loop.stepId ? (
                        <span className="ml-2 text-muted-foreground text-xs">
                          {stepName(loop.stepId)}
                        </span>
                      ) : null}
                      {loop.adopted ? (
                        <Badge
                          className="ml-2"
                          title="Started by a person and attached to this run"
                          variant="muted"
                        >
                          Adopted
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <RunLoopStatus status={loop.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {loop.startedAt ? formatDateTime(loop.startedAt) : "-"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {loop.completedAt
                        ? formatDateTime(loop.completedAt)
                        : "-"}
                    </TableCell>
                    <TableCell>
                      {loop.prUrl ? (
                        <ExternalOrText href={loop.prUrl} text="Open" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunLoopStatus({ status }: Readonly<{ status: string }>) {
  const parsed = LoopStatusSchema.safeParse(status);
  if (parsed.success) {
    return <LoopStatusBadge status={parsed.data} />;
  }
  return <Badge variant="muted">{status}</Badge>;
}
