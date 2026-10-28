"use client";

import {
  OrchestratorCaseStatus,
  type OrchestratorCaseSummary,
} from "@repo/api/src/types/orchestrator";
// Cross-slice: same provider icon as the workflow runs table.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
// Cross-slice: same retryable error block as the repositories list.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
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
import {
  isCaseActive,
  useWorkflowOrchestratorCases,
} from "../hooks/use-orchestrator-cases";
import { caseSourceProvider } from "../lib/case-source";

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
    <div
      className="overflow-x-auto rounded-md border"
      data-testid="orchestrator-case-list"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead>Tasks</TableHead>
            <TableHead>Turns</TableHead>
            <TableHead>Cost</TableHead>
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
  const provider = caseSourceProvider(item.sourceKey);

  return (
    <TableRow>
      <TableCell className="max-w-[24rem]">
        <div className="flex min-w-0 items-center gap-2">
          {provider ? <ProviderIcon provider={provider} /> : null}
          <Link
            className="min-w-0 truncate font-medium hover:underline"
            href={href}
          >
            {item.title}
          </Link>
        </div>
      </TableCell>
      <TableCell>
        <CaseStatus item={item} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatRelativeTime(item.updatedAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {item.taskCount}
        {item.activeTaskCount > 0 ? (
          <span className="text-muted-foreground">
            {" "}
            · {item.activeTaskCount} active
          </span>
        ) : null}
      </TableCell>
      <TableCell className="tabular-nums">{item.turnCount}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        <CaseCost costUsd={item.costUsd} />
      </TableCell>
    </TableRow>
  );
}

function CaseStatus({ item }: Readonly<{ item: OrchestratorCaseSummary }>) {
  const isOpen = item.status === OrchestratorCaseStatus.Open;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={isOpen ? "default" : "outline"}>
        {isOpen ? "Open" : "Closed"}
      </Badge>
      {isCaseActive(item) ? <Badge variant="info">Running</Badge> : null}
      {item.pendingDecisionCount > 0 ? (
        <Badge variant="secondary">{item.pendingDecisionCount} pending</Badge>
      ) : null}
    </div>
  );
}

function CaseCost({ costUsd }: Readonly<{ costUsd: number | null }>) {
  if (costUsd === null) {
    return <span className="text-muted-foreground">-</span>;
  }
  return <>{formatCostPrecise(costUsd)}</>;
}
