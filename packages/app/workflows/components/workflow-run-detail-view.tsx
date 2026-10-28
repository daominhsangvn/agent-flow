"use client";

import { DocumentType } from "@repo/api/src/types/document";
import {
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowInstructionRunDetail,
  type WorkflowRunDetail,
  type WorkflowRunDocumentRef,
  type WorkflowRunError,
  type WorkflowRunSourceClassification,
  WorkflowRunSourceClassificationOrigin,
} from "@repo/api/src/types/workflow";
// Cross-slice: run documents route through the documents slice, loops render
// with the loops slice badge, and providers/errors come from integrations.
import { getDocumentRoute } from "@repo/app/documents/lib/document-navigation";
import { DOCUMENT_TYPE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { useIntegrationProviders } from "@repo/app/integrations/hooks/use-integrations";
import { getProviderDisplayName } from "@repo/app/integrations/lib/integration-labels";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  formatCostPrecise,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
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
import {
  AlertCircleIcon,
  BanIcon,
  HistoryIcon,
  Loader2Icon,
  RotateCcwIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import {
  isFinalWorkflowRunStatus,
  useCancelWorkflowRun,
  useRetryWorkflowActionRun,
  useWorkflowRun,
} from "../hooks/use-workflows";
import { getLoopCommandLabel } from "../lib/loop-command-label";
import { getActionLabel } from "../lib/workflow-catalog";
import { describeWorkflowRunError } from "../lib/workflow-error-messages";
import {
  WORKFLOW_ACTION_STAGE_LABELS,
  WORKFLOW_INSTRUCTION_OPERATION_STATUS_LABELS,
  WORKFLOW_RUN_EVENT_LABELS,
} from "../lib/workflow-labels";
import { ExternalOrText, isHttpUrl } from "./external-or-text";
import { WorkflowRunLoopsCard } from "./workflow-run-loops-card";
import { WorkflowRunProcessCard } from "./workflow-run-process-card";
import { WorkflowRunPullRequests } from "./workflow-run-pull-requests";
import { WorkflowRunRetryAction } from "./workflow-run-retry-action";
import { WorkflowRunSessionsCard } from "./workflow-run-sessions-card";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import { WorkflowRunToolCallsCard } from "./workflow-run-tool-calls-card";
import {
  WorkflowActionRunStatusBadge,
  WorkflowRunStatusBadge,
} from "./workflow-status-badges";

export type WorkflowRunDetailViewProps = {
  runId: string;
  /** Admins can cancel an active run and retry failed or skipped post actions. */
  isAdmin: boolean;
};

/**
 * One workflow run: its progress (received, importing, triggered actions,
 * planning, implementing), the source item, the imported Issue and plan, the
 * loops the agent team ran and their sessions, the pull request, and every pre
 * and post action run with its delivery status. Polls while the run is still
 * moving.
 */
export function WorkflowRunDetailView({
  runId,
  isAdmin,
}: Readonly<WorkflowRunDetailViewProps>) {
  const run = useWorkflowRun(runId);

  if (run.isLoading) {
    return (
      <div aria-label="Loading run" className="space-y-4" role="status">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (run.error instanceof ApiError && run.error.isNotFound()) {
    return (
      <EmptyState
        description="It may belong to a deleted workflow."
        icon={HistoryIcon}
        title="Run not found"
      />
    );
  }
  if (run.error || !run.data) {
    return (
      <QueryErrorMessage
        error={run.error}
        onRetry={() => {
          run.refetch();
        }}
        title="Couldn't load the run"
      />
    );
  }

  return <RunDetailContent isAdmin={isAdmin} run={run.data} />;
}

function RunDetailContent({
  run,
  isAdmin,
}: Readonly<{ run: WorkflowRunDetail; isAdmin: boolean }>) {
  const providers = useIntegrationProviders();
  const cancelRun = useCancelWorkflowRun();
  const buildOrgPath = useOrgPath();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const isActive = !isFinalWorkflowRunStatus(run.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon className="size-5" provider={run.source.provider} />
            <h2 className="font-semibold text-xl">
              {run.source.key}
              {run.source.title ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  {run.source.title}
                </span>
              ) : null}
            </h2>
            <WorkflowRunStatusBadge status={run.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {"Workflow "}
            <Link
              className="text-foreground hover:underline"
              href={buildOrgPath(`/workflows/${run.workflowId}`)}
            >
              {run.workflowName}
            </Link>
            {` · started ${formatRelativeTime(run.createdAt)}`}
            {run.completedAt
              ? ` · finished ${formatRelativeTime(run.completedAt)}`
              : null}
          </p>
        </div>
        {isAdmin && isActive ? (
          <Button
            disabled={cancelRun.isPending}
            onClick={() => setConfirmCancel(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <BanIcon className="size-4" />
            Cancel run
          </Button>
        ) : null}
        {isAdmin && run.retryStep ? (
          <WorkflowRunRetryAction runId={run.id} step={run.retryStep} />
        ) : null}
      </div>

      <WorkflowRunTimeline run={run} />

      {run.error ? <RunErrorAlert error={run.error} /> : null}

      <WorkflowRunProcessCard isAdmin={isAdmin} run={run} />

      <RunLinksCard
        providerName={getProviderDisplayName(
          providers.data,
          run.source.provider
        )}
        run={run}
      />
      <WorkflowRunLoopsCard
        loops={run.loops}
        stepName={(stepId) => stepNames(run).get(stepId) ?? stepId}
      />
      <WorkflowRunSessionsCard
        commandLabel={getLoopCommandLabel}
        sessions={run.sessions}
        stepName={(stepId) => stepNames(run).get(stepId) ?? stepId}
      />
      <ActionRunsCard
        actionRuns={run.actionRuns}
        getLabel={(type) => getActionLabel(providers.data, type)}
        isAdmin={isAdmin}
        runId={run.id}
      />
      <WorkflowRunToolCallsCard
        isAdmin={isAdmin}
        runId={run.id}
        stepName={(stepId) => stepNames(run).get(stepId) ?? stepId}
        toolCalls={run.toolCalls}
      />

      <ConfirmationDialog
        confirmLabel="Cancel run"
        description="Active loops of this run are cancelled and the run stops. Actions already delivered are not undone."
        isPending={cancelRun.isPending}
        onConfirm={async () => {
          await cancelRun.mutateAsync(run.id);
        }}
        onOpenChange={setConfirmCancel}
        open={confirmCancel}
        title="Cancel this run?"
        variant="destructive"
      />
    </div>
  );
}

function RunErrorAlert({ error }: Readonly<{ error: WorkflowRunError }>) {
  const text = describeWorkflowRunError(error);

  return (
    <Alert variant="error">
      <AlertCircleIcon />
      <AlertTitle>{text.title}</AlertTitle>
      <AlertDescription>
        <p className="break-words">{text.detail}</p>
        {text.title === error.code ? null : (
          <p className="font-mono text-muted-foreground text-xs">
            {error.code}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function RunLinksCard({
  run,
  providerName,
}: Readonly<{ run: WorkflowRunDetail; providerName: string }>) {
  const buildOrgPath = useOrgPath();
  const sourceType = run.feature?.type ?? DocumentType.Feature;
  const featureRoute = documentRoute(sourceType, run.feature);
  const planRoute = documentRoute(DocumentType.ImplementationPlan, run.plan);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Work items</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Source</dt>
          <dd>
            <ExternalOrText
              href={run.source.url}
              text={`${providerName} ${run.source.key}`}
            />
          </dd>
          <dt className="text-muted-foreground">
            {sourceType === DocumentType.Prd ? "PRD" : "Issue"}
          </dt>
          <dd data-testid="run-source-document">
            <DocumentLink
              document={run.feature}
              href={featureRoute ? buildOrgPath(featureRoute) : null}
              pendingText="Not imported yet"
            />
            {run.sourceClassification ? (
              <SourceClassificationNote
                classification={run.sourceClassification}
              />
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Implementation plan</dt>
          <dd>
            <DocumentLink
              document={run.plan}
              href={planRoute ? buildOrgPath(planRoute) : null}
              pendingText="Not created yet"
            />
          </dd>
          {run.documents.map((document) => {
            const route = documentRoute(document.type, document);
            return (
              <Fragment key={document.id}>
                <dt className="text-muted-foreground">
                  {DOCUMENT_TYPE_LABELS[document.type]}
                </dt>
                <dd data-testid="run-published-document">
                  <DocumentLink
                    document={document}
                    href={route ? buildOrgPath(route) : null}
                    pendingText=""
                  />
                </dd>
              </Fragment>
            );
          })}
          <dt className="text-muted-foreground">Pull requests</dt>
          <dd data-testid="run-pull-requests">
            <WorkflowRunPullRequests
              emptyText="None yet"
              pullRequests={run.pullRequests}
              variant="detailed"
            />
            {run.pullRequests.length === 0 && run.branchName ? (
              <span className="ml-2 font-mono text-muted-foreground text-xs">
                {run.branchName}
              </span>
            ) : null}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function DocumentLink({
  document,
  href,
  pendingText,
}: Readonly<{
  document: WorkflowRunDocumentRef | null;
  href: string | null;
  pendingText: string;
}>) {
  if (!document) {
    return <span className="text-muted-foreground">{pendingText}</span>;
  }
  const label = document.slug
    ? `${document.slug} ${document.title}`
    : document.title;
  if (!href) {
    return <span>{label}</span>;
  }
  return (
    <Link className="text-[var(--link)] hover:underline" href={href}>
      {label}
    </Link>
  );
}

function ActionRunsCard({
  actionRuns,
  runId,
  isAdmin,
  getLabel,
}: Readonly<{
  actionRuns: WorkflowActionRun[];
  runId: string;
  isAdmin: boolean;
  getLabel: (actionType: string) => string;
}>) {
  const orderedRuns = sortActionRuns(actionRuns);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>
      <CardContent>
        {orderedRuns.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No action has run for this run yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="text-right">Cycle</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Result</TableHead>
                  {isAdmin ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderedRuns.map((actionRun) => (
                  <ActionRunRow
                    actionRun={actionRun}
                    isAdmin={isAdmin}
                    key={actionRun.id}
                    label={getLabel(actionRun.actionType)}
                    runId={runId}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionRunRow({
  actionRun,
  label,
  runId,
  isAdmin,
}: Readonly<{
  actionRun: WorkflowActionRun;
  label: string;
  runId: string;
  isAdmin: boolean;
}>) {
  const retry = useRetryWorkflowActionRun();
  const canRetry = isAdmin && isRetryableActionRun(actionRun);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {label}
        {actionRun.actionId ? null : (
          <span className="ml-2 text-muted-foreground text-xs">(removed)</span>
        )}
      </TableCell>
      <TableCell>
        <Badge
          variant={
            actionRun.stage === WorkflowActionStage.Pre ? "info" : "neutral"
          }
        >
          {WORKFLOW_ACTION_STAGE_LABELS[actionRun.stage] ?? actionRun.stage}
        </Badge>
      </TableCell>
      <TableCell>
        {WORKFLOW_RUN_EVENT_LABELS[actionRun.event] ?? actionRun.event}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {actionRun.cycle}
      </TableCell>
      <TableCell>
        <WorkflowActionRunStatusBadge status={actionRun.status} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {actionRun.attempts}
      </TableCell>
      <TableCell className="max-w-[24rem] text-xs">
        <ActionRunResult actionRun={actionRun} />
      </TableCell>
      {isAdmin ? (
        <TableCell className="text-right">
          {canRetry ? (
            <Button
              disabled={retry.isPending}
              onClick={() => retry.mutate({ runId, actionRunId: actionRun.id })}
              size="sm"
              type="button"
              variant="outline"
            >
              {retry.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-3.5" />
              )}
              Retry
            </Button>
          ) : null}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function ActionRunResult({
  actionRun,
}: Readonly<{ actionRun: WorkflowActionRun }>) {
  return (
    <>
      <ActionRunOutcome actionRun={actionRun} />
      {actionRun.instruction ? (
        <InstructionDetail detail={actionRun.instruction} />
      ) : null}
    </>
  );
}

/** What an instruction's agent did: its note, each tool call, its usage. */
function InstructionDetail({
  detail,
}: Readonly<{ detail: WorkflowInstructionRunDetail }>) {
  const operations = detail.operations.map((operation, position) => ({
    ...operation,
    position,
  }));
  return (
    <div className="mt-1 space-y-1 text-muted-foreground">
      {detail.note ? <p className="break-words">{detail.note}</p> : null}
      {operations.length > 0 ? (
        <ul className="space-y-0.5">
          {operations.map((operation) => (
            <li className="break-words" key={operation.position}>
              <span className="font-mono">{operation.type}</span>{" "}
              {operation.connection ? (
                <>
                  on <span className="font-mono">
                    {operation.connection}
                  </span>{" "}
                </>
              ) : null}
              {WORKFLOW_INSTRUCTION_OPERATION_STATUS_LABELS[operation.status]}
              {operation.error ? `: ${operation.error}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="tabular-nums">{describeInstructionUsage(detail)}</p>
    </div>
  );
}

function ActionRunOutcome({
  actionRun,
}: Readonly<{ actionRun: WorkflowActionRun }>) {
  if (actionRun.lastError) {
    return (
      <span className="break-words text-destructive">
        {actionRun.lastError}
      </span>
    );
  }
  if (actionRun.externalRef) {
    return isHttpUrl(actionRun.externalRef) ? (
      <ExternalOrText href={actionRun.externalRef} text="View" />
    ) : (
      <span className="font-mono text-muted-foreground">
        {actionRun.externalRef}
      </span>
    );
  }
  if (actionRun.completedAt) {
    return (
      <span className="text-muted-foreground">
        {formatRelativeTime(actionRun.completedAt)}
      </span>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

/**
 * Pre actions run inline in the run state machine, before the agent team;
 * only post actions are re-delivered by the outbox. A failed one, and a
 * skipped one (its connection was disabled, its config no longer parsed, it
 * had no target) can be put back once the admin fixed the cause.
 */
function isRetryableActionRun(actionRun: WorkflowActionRun): boolean {
  return (
    actionRun.stage === WorkflowActionStage.Post &&
    RETRYABLE_ACTION_RUN_STATUSES.includes(actionRun.status)
  );
}

function documentRoute(
  type: DocumentType,
  document: WorkflowRunDocumentRef | null
): string | null {
  if (!document?.slug) {
    return null;
  }
  return getDocumentRoute({ type, slug: document.slug });
}

/**
 * Pre action runs first (they ran before the agent team), then post action
 * runs; within a stage by cycle, then in the order they were created.
 */
function sortActionRuns(
  actionRuns: readonly WorkflowActionRun[]
): WorkflowActionRun[] {
  return [...actionRuns].sort(
    (a, b) =>
      stageRank(a.stage) - stageRank(b.stage) ||
      a.cycle - b.cycle ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function stageRank(stage: WorkflowActionStage): number {
  return stage === WorkflowActionStage.Pre ? 0 : 1;
}

function stepNames(run: WorkflowRunDetail): ReadonlyMap<string, string> {
  return new Map(run.process?.steps.map((step) => [step.id, step.name]) ?? []);
}

/** Tokens and cost of an instruction's agent; an unknown cost says so. */
function describeInstructionUsage(
  detail: WorkflowInstructionRunDetail
): string {
  const tokens = `${formatTokenCount(detail.inputTokens)} in · ${formatTokenCount(detail.outputTokens)} out`;
  const cost =
    detail.costUsd === null
      ? "cost unknown"
      : formatCostPrecise(detail.costUsd);
  return `${tokens} · ${cost}`;
}

const RETRYABLE_ACTION_RUN_STATUSES: readonly WorkflowActionRunStatus[] = [
  WorkflowActionRunStatus.Failed,
  WorkflowActionRunStatus.Skipped,
];

/** Why the workflow's PRD instruction made the item a PRD or an Issue. */
function SourceClassificationNote({
  classification,
}: Readonly<{ classification: WorkflowRunSourceClassification }>) {
  const lead =
    classification.origin === WorkflowRunSourceClassificationOrigin.Fallback
      ? "The PRD instruction could not decide, so this is an Issue:"
      : "PRD instruction:";
  return (
    <p
      className="mt-1 text-muted-foreground text-xs"
      data-testid="run-source-classification"
    >
      {lead} {classification.reason}
    </p>
  );
}
