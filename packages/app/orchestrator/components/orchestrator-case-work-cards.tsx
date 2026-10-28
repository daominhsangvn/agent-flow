"use client";

import type { OrchestratorCaseDetail } from "@repo/api/src/types/orchestrator";
// Cross-slice: retryable error block for the loops request.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
// Cross-slice: the case page shows the same loop, session and pull request
// cards as the workflow run page.
import { WorkflowRunLoopsCard } from "@repo/app/workflows/components/workflow-run-loops-card";
import { WorkflowRunPullRequests } from "@repo/app/workflows/components/workflow-run-pull-requests";
import { WorkflowRunSessionsCard } from "@repo/app/workflows/components/workflow-run-sessions-card";
import { getLoopCommandLabel } from "@repo/app/workflows/lib/loop-command-label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  isCaseActive,
  useOrchestratorCaseLoops,
} from "../hooks/use-orchestrator-cases";

/** Work items, Agent loops and Sessions of a case, as the run page shows them. */
export function OrchestratorCaseWorkCards({
  detail,
}: Readonly<{ detail: OrchestratorCaseDetail }>) {
  const query = useOrchestratorCaseLoops(detail.id, {
    poll: isCaseActive(detail),
  });

  if (query.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (query.error || !query.data) {
    return (
      <QueryErrorMessage
        error={query.error}
        onRetry={() => {
          query.refetch();
        }}
        title="Couldn't load the case's loops"
      />
    );
  }
  const data = query.data;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Work items</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Source</dt>
            <dd>{detail.sourceKey ?? "-"}</dd>
            <dt className="text-muted-foreground">Pull requests</dt>
            <dd data-testid="case-pull-requests">
              <WorkflowRunPullRequests
                emptyText="None yet"
                pullRequests={data.pullRequests}
                variant="detailed"
              />
            </dd>
          </dl>
        </CardContent>
      </Card>
      <WorkflowRunLoopsCard
        emptyText="No task has launched a loop yet."
        loops={data.loops}
        stepName={(id) => id}
      />
      <WorkflowRunSessionsCard
        commandLabel={getLoopCommandLabel}
        description="The agent sessions the case's tasks ran."
        emptyText="No session has synced for this case yet."
        sessions={data.sessions}
        stepName={(id) => id}
      />
    </>
  );
}
