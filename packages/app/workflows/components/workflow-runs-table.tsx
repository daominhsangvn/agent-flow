"use client";

import type {
  WorkflowRunError,
  WorkflowRunSummary,
} from "@repo/api/src/types/workflow";
// Cross-slice: the provider glyph map and the inline error state are owned by
// the integrations slice; runs show the provider of their source item.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
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
import { HistoryIcon, Loader2Icon } from "lucide-react";
import {
  flattenRunPages,
  useOrgWorkflowRuns,
  useWorkflowRuns,
} from "../hooks/use-workflows";
import { describeWorkflowRunError } from "../lib/workflow-error-messages";
import { WorkflowRunPullRequests } from "./workflow-run-pull-requests";
import { WorkflowRunStatusBadge } from "./workflow-status-badges";

/** Run history of one workflow. */
export function WorkflowRunHistory({
  workflowId,
}: Readonly<{ workflowId: string }>) {
  const runs = useWorkflowRuns(workflowId);
  return (
    <WorkflowRunsTable
      emptyDescription="Runs appear here when a trigger fires or someone starts a run by hand."
      error={runs.error}
      hasNextPage={runs.hasNextPage}
      isFetchingNextPage={runs.isFetchingNextPage}
      isLoading={runs.isLoading}
      onLoadMore={() => {
        runs.fetchNextPage();
      }}
      onRetry={() => {
        runs.refetch();
      }}
      runs={flattenRunPages(runs.data)}
      showWorkflow={false}
    />
  );
}

/** Run history across every workflow of the org. */
export function OrgWorkflowRunHistory() {
  const runs = useOrgWorkflowRuns();
  return (
    <WorkflowRunsTable
      emptyDescription="No workflow has run yet. Runs appear here when a trigger fires."
      error={runs.error}
      hasNextPage={runs.hasNextPage}
      isFetchingNextPage={runs.isFetchingNextPage}
      isLoading={runs.isLoading}
      onLoadMore={() => {
        runs.fetchNextPage();
      }}
      onRetry={() => {
        runs.refetch();
      }}
      runs={flattenRunPages(runs.data)}
      showWorkflow
    />
  );
}

export type WorkflowRunsTableProps = {
  runs: WorkflowRunSummary[];
  isLoading: boolean;
  error: Error | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Show the workflow column (org-wide history). */
  showWorkflow: boolean;
  emptyDescription: string;
};

export function WorkflowRunsTable({
  runs,
  isLoading,
  error,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  showWorkflow,
  emptyDescription,
}: Readonly<WorkflowRunsTableProps>) {
  const buildOrgPath = useOrgPath();

  if (isLoading) {
    return (
      <div aria-label="Loading runs" className="space-y-2" role="status">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <QueryErrorMessage
        error={error}
        onRetry={onRetry}
        title="Couldn't load runs"
      />
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        description={emptyDescription}
        icon={HistoryIcon}
        size="compact"
        title="No runs yet"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Source item</TableHead>
              {showWorkflow ? <TableHead>Workflow</TableHead> : null}
              <TableHead>Pull requests</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <WorkflowRunStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="max-w-[24rem]">
                  <RunSourceCell
                    href={buildOrgPath(
                      `/workflows/${run.workflowId}/runs/${run.id}`
                    )}
                    run={run}
                  />
                </TableCell>
                {showWorkflow ? (
                  <TableCell>
                    <Link
                      className="hover:underline"
                      href={buildOrgPath(`/workflows/${run.workflowId}`)}
                    >
                      {run.workflowName}
                    </Link>
                  </TableCell>
                ) : null}
                <TableCell className="max-w-[16rem]">
                  <WorkflowRunPullRequests
                    emptyText="-"
                    pullRequests={run.pullRequests}
                    variant="compact"
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatRelativeTime(run.createdAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {run.completedAt ? formatRelativeTime(run.completedAt) : "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
            size="sm"
            type="button"
            variant="outline"
          >
            {isFetchingNextPage ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RunSourceCell({
  run,
  href,
}: Readonly<{ run: WorkflowRunSummary; href: string }>) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderIcon provider={run.source.provider} />
        <Link className="min-w-0 truncate hover:underline" href={href}>
          <span className="font-medium">{run.source.key}</span>
          {run.source.title ? (
            <span className="text-muted-foreground"> {run.source.title}</span>
          ) : null}
        </Link>
      </div>
      {run.error ? <RunErrorLine error={run.error} /> : null}
    </div>
  );
}

/** The readable failure reason; the engine's message is in the tooltip. */
function RunErrorLine({ error }: Readonly<{ error: WorkflowRunError }>) {
  const text = describeWorkflowRunError(error);
  return (
    <p className="truncate text-destructive text-xs" title={text.detail}>
      {text.title}
      {text.detail ? (
        <span className="text-muted-foreground">{` - ${text.detail}`}</span>
      ) : null}
    </p>
  );
}
