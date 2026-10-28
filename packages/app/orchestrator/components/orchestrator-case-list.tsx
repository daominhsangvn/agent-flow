"use client";

import {
  OrchestratorCaseStatus,
  type OrchestratorCaseSummary,
} from "@repo/api/src/types/orchestrator";
// Cross-slice: same retryable error block as the repositories list.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
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
import { InboxIcon } from "lucide-react";
import { useWorkflowOrchestratorCases } from "../hooks/use-orchestrator-cases";

export type OrchestratorCaseListProps = {
  workflowId: string;
};

/** Workflow → Cases: the workflow's cases, most recently updated first. */
export function OrchestratorCaseList({
  workflowId,
}: Readonly<OrchestratorCaseListProps>) {
  const cases = useWorkflowOrchestratorCases(workflowId);
  const buildOrgPath = useOrgPath();

  if (cases.isLoading) {
    return (
      <div aria-label="Loading cases" className="space-y-2" role="status">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (cases.error || !cases.data) {
    return (
      <QueryErrorMessage
        error={cases.error}
        onRetry={() => {
          cases.refetch();
        }}
        title="Couldn't load the cases"
      />
    );
  }
  if (cases.data.length === 0) {
    return (
      <EmptyState
        description="A request on one of the workflow's triggers opens one."
        icon={InboxIcon}
        size="compact"
        title="No cases yet."
      />
    );
  }

  return (
    <div data-testid="orchestrator-case-list">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Pending decisions</TableHead>
            <TableHead>Activity</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.data.map((item) => (
            <CaseRow
              href={buildOrgPath(`/orchestrator/cases/${item.id}`)}
              item={item}
              key={item.id}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CaseRow({
  item,
  href,
}: Readonly<{ item: OrchestratorCaseSummary; href: string }>) {
  const isRunning = item.turnRunning || item.activeTaskCount > 0;

  return (
    <TableRow>
      <TableCell>
        <Link className="font-medium hover:underline" href={href}>
          {item.title}
        </Link>
      </TableCell>
      <TableCell>
        <Badge
          variant={
            item.status === OrchestratorCaseStatus.Open ? "default" : "outline"
          }
        >
          {item.status === OrchestratorCaseStatus.Open ? "Open" : "Closed"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {item.sourceKey ?? "—"}
      </TableCell>
      <TableCell>
        <PendingDecisions count={item.pendingDecisionCount} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {isRunning ? "Running" : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatRelativeTime(item.updatedAt)}
      </TableCell>
    </TableRow>
  );
}

function PendingDecisions({ count }: Readonly<{ count: number }>) {
  if (count > 0) {
    return <Badge variant="secondary">{count}</Badge>;
  }
  return <span className="text-muted-foreground">—</span>;
}
