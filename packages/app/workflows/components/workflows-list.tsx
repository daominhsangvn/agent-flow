"use client";

import type { IntegrationProviderSummary } from "@repo/api/src/types/integration";
import type {
  Workflow,
  WorkflowCaseCounts,
} from "@repo/api/src/types/workflow";
// Cross-slice: trigger labels come from the integrations provider catalog, and
// the provider glyph map / inline error state are owned by that slice.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { useIntegrationProviders } from "@repo/app/integrations/hooks/use-integrations";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { PlusIcon, ZapIcon } from "lucide-react";
import { useSetWorkflowEnabled, useWorkflows } from "../hooks/use-workflows";
import { getTriggerLabel, getTypeProviderKey } from "../lib/workflow-catalog";
import { describeCaseCount } from "../lib/workflow-labels";

export type WorkflowsListProps = {
  isAdmin: boolean;
};

/** The org's workflows with their triggers, last run and run counts. */
export function WorkflowsList({ isAdmin }: Readonly<WorkflowsListProps>) {
  const workflows = useWorkflows();
  const providers = useIntegrationProviders();
  const buildOrgPath = useOrgPath();

  if (workflows.isLoading) {
    return (
      <div aria-label="Loading workflows" className="space-y-2" role="status">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (workflows.error) {
    return (
      <QueryErrorMessage
        error={workflows.error}
        onRetry={() => {
          workflows.refetch();
        }}
        title="Couldn't load workflows"
      />
    );
  }
  if (!workflows.data || workflows.data.length === 0) {
    return (
      <EmptyState
        action={
          isAdmin ? (
            <Button asChild size="sm">
              <Link href={buildOrgPath("/workflows/new")}>
                <PlusIcon className="size-4" />
                New workflow
              </Link>
            </Button>
          ) : undefined
        }
        description={
          isAdmin
            ? "Start the agent team automatically when a Jira issue or Azure DevOps work item is assigned to the bot, or when a system calls a webhook."
            : "An organization admin can create workflows that start the agent team from Jira, Azure DevOps or a webhook."
        }
        icon={ZapIcon}
        title="No workflows yet"
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Triggers</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead className="text-right">Enabled</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.data.map((workflow) => (
            <WorkflowRow
              href={buildOrgPath(`/workflows/${workflow.id}`)}
              isAdmin={isAdmin}
              key={workflow.id}
              providers={providers.data}
              workflow={workflow}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WorkflowRow({
  workflow,
  providers,
  href,
  isAdmin,
}: Readonly<{
  workflow: Workflow;
  providers: IntegrationProviderSummary[] | undefined;
  href: string;
  isAdmin: boolean;
}>) {
  return (
    <TableRow>
      <TableCell className="max-w-[20rem]">
        <Link className="font-medium hover:underline" href={href}>
          {workflow.name}
        </Link>
        {workflow.description ? (
          <p className="truncate text-muted-foreground text-xs">
            {workflow.description}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <TriggerSummary providers={providers} workflow={workflow} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {workflow.project?.name ?? "Project removed"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {describeLastActivity(workflow)}
      </TableCell>
      <TableCell>
        {workflow.caseCounts ? (
          <CaseCounts counts={workflow.caseCounts} />
        ) : (
          <RunCounts workflow={workflow} />
        )}
      </TableCell>
      <TableCell className="text-right">
        <EnabledCell isAdmin={isAdmin} workflow={workflow} />
      </TableCell>
    </TableRow>
  );
}

function TriggerSummary({
  workflow,
  providers,
}: Readonly<{
  workflow: Workflow;
  providers: IntegrationProviderSummary[] | undefined;
}>) {
  if (workflow.triggers.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {workflow.triggers.map((trigger) => (
        <li key={trigger.id}>
          <Badge
            className={cn("gap-1.5", trigger.enabled ? null : "opacity-60")}
            title={trigger.enabled ? undefined : "Trigger disabled"}
            variant="neutral"
          >
            <ProviderIcon
              className="size-3"
              provider={getTypeProviderKey(trigger.type)}
            />
            {getTriggerLabel(providers, trigger.type)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function RunCounts({ workflow }: Readonly<{ workflow: Workflow }>) {
  const { total, active, succeeded, failed } = workflow.runCounts;
  if (total === 0) {
    return <span className="text-muted-foreground">0</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium tabular-nums">{total}</span>
      {active > 0 ? <Badge variant="info">{active} active</Badge> : null}
      {succeeded > 0 ? (
        <Badge variant="success">{succeeded} succeeded</Badge>
      ) : null}
      {failed > 0 ? <Badge variant="error">{failed} failed</Badge> : null}
    </div>
  );
}

/**
 * The enabled switch only flips the flag (`PATCH /workflows/{id}`): turning a
 * workflow off works even when its connection, run-as user or compute target
 * is broken. Turning on a workflow whose project is gone cannot succeed.
 */
function EnabledCell({
  workflow,
  isAdmin,
}: Readonly<{ workflow: Workflow; isAdmin: boolean }>) {
  const setEnabled = useSetWorkflowEnabled();

  if (!isAdmin) {
    return (
      <Badge variant={workflow.enabled ? "success" : "muted"}>
        {workflow.enabled ? "On" : "Off"}
      </Badge>
    );
  }

  const cannotEnable = !(workflow.enabled || workflow.project);

  return (
    <Switch
      aria-label={`${workflow.enabled ? "Disable" : "Enable"} ${workflow.name}`}
      checked={workflow.enabled}
      disabled={setEnabled.isPending || cannotEnable}
      onCheckedChange={(enabled) =>
        setEnabled.mutate({ id: workflow.id, input: { enabled } })
      }
    />
  );
}

function describeLastActivity(workflow: Workflow): string {
  const at = workflow.caseCounts
    ? workflow.caseCounts.lastActivityAt
    : workflow.lastRunAt;
  return at ? formatRelativeTime(at) : "Never";
}

function CaseCounts({ counts }: Readonly<{ counts: WorkflowCaseCounts }>) {
  if (counts.total === 0) {
    return <span className="text-muted-foreground">0</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium tabular-nums">
        {describeCaseCount(counts.total)}
      </span>
      {counts.open > 0 ? (
        <Badge variant="info">{counts.open} open</Badge>
      ) : null}
    </div>
  );
}
