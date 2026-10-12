"use client";

import type { Workflow } from "@repo/api/src/types/workflow";
// Cross-slice: the manual-run triggers come from the integrations provider
// catalog, and the inline error state is owned by that slice.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { useIntegrationProviders } from "@repo/app/integrations/hooks/use-integrations";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { PlayIcon, TrashIcon, ZapOffIcon } from "lucide-react";
import { useState } from "react";
import { useDeleteWorkflow, useWorkflow } from "../hooks/use-workflows";
import { getManualRunTriggers } from "../lib/workflow-catalog";
import type { WorkflowComputeTargetChoices } from "../lib/workflow-editor-options";
import { WorkflowEditor } from "./workflow-editor";
import { WorkflowRunNowDialog } from "./workflow-run-now-dialog";
import { WorkflowRunHistory } from "./workflow-runs-table";

export const WorkflowDetailTab = {
  Configuration: "configuration",
  Runs: "runs",
} as const;
export type WorkflowDetailTab =
  (typeof WorkflowDetailTab)[keyof typeof WorkflowDetailTab];

export type WorkflowDetailViewProps = {
  workflowId: string;
  isAdmin: boolean;
  computeTargets: WorkflowComputeTargetChoices;
  connectionsSettingsPath?: string;
};

/**
 * One workflow: its configuration (the editor, read-only for members) and its
 * run history as URL-synced tabs, plus the admin actions "Run now" (for
 * triggers that support a manual run) and "Delete".
 */
export function WorkflowDetailView({
  workflowId,
  isAdmin,
  computeTargets,
  connectionsSettingsPath,
}: Readonly<WorkflowDetailViewProps>) {
  const workflow = useWorkflow(workflowId);
  const buildOrgPath = useOrgPath();

  if (workflow.isLoading) {
    return (
      <div aria-label="Loading workflow" className="space-y-4" role="status">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (workflow.error instanceof ApiError && workflow.error.isNotFound()) {
    return (
      <EmptyState
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={buildOrgPath("/workflows")}>Back to workflows</Link>
          </Button>
        }
        description="It may have been deleted."
        icon={ZapOffIcon}
        title="Workflow not found"
      />
    );
  }
  if (workflow.error || !workflow.data) {
    return (
      <QueryErrorMessage
        error={workflow.error}
        onRetry={() => {
          workflow.refetch();
        }}
        title="Couldn't load the workflow"
      />
    );
  }

  return (
    <WorkflowDetailContent
      computeTargets={computeTargets}
      connectionsSettingsPath={connectionsSettingsPath}
      isAdmin={isAdmin}
      workflow={workflow.data}
    />
  );
}

function WorkflowDetailContent({
  workflow,
  isAdmin,
  computeTargets,
  connectionsSettingsPath,
}: Readonly<{
  workflow: Workflow;
  isAdmin: boolean;
  computeTargets: WorkflowComputeTargetChoices;
  connectionsSettingsPath: string | undefined;
}>) {
  const providers = useIntegrationProviders();
  const deleteWorkflow = useDeleteWorkflow();
  const { navigate } = useNavigation();
  const buildOrgPath = useOrgPath();
  const [runNowOpen, setRunNowOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { activeTab, setActiveTab } = useTabParam<WorkflowDetailTab>({
    defaultTab: WorkflowDetailTab.Configuration,
    validTabs: WORKFLOW_DETAIL_TABS,
  });
  const manualTriggers = getManualRunTriggers(
    providers.data ?? [],
    workflow.triggers
  );
  const canRunNow = isAdmin && workflow.enabled && manualTriggers.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold text-xl">{workflow.name}</h2>
            <Badge variant={workflow.enabled ? "success" : "muted"}>
              {workflow.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {workflow.runCounts.total} runs ({workflow.runCounts.active} active)
            {" · "}
            {workflow.lastRunAt
              ? `last run ${formatRelativeTime(workflow.lastRunAt)}`
              : "never run"}
          </p>
        </div>
        {isAdmin ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canRunNow ? (
              <Button
                onClick={() => setRunNowOpen(true)}
                size="sm"
                type="button"
              >
                <PlayIcon className="size-4" />
                Run now
              </Button>
            ) : null}
            <Button
              onClick={() => setConfirmDelete(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <TrashIcon className="size-4" />
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      <Tabs onValueChange={setActiveTab} value={activeTab}>
        <TabsList>
          <TabsTrigger
            className="flex-initial px-4"
            value={WorkflowDetailTab.Configuration}
          >
            Configuration
          </TabsTrigger>
          <TabsTrigger
            className="flex-initial px-4"
            value={WorkflowDetailTab.Runs}
          >
            Runs
          </TabsTrigger>
        </TabsList>
        <TabsContent className="mt-3" value={WorkflowDetailTab.Configuration}>
          <WorkflowEditor
            computeTargets={computeTargets}
            connectionsSettingsPath={connectionsSettingsPath}
            isAdmin={isAdmin}
            key={workflow.id}
            workflow={workflow}
          />
        </TabsContent>
        <TabsContent className="mt-3" value={WorkflowDetailTab.Runs}>
          <WorkflowRunHistory workflowId={workflow.id} />
        </TabsContent>
      </Tabs>

      {runNowOpen ? (
        <WorkflowRunNowDialog
          onClose={() => setRunNowOpen(false)}
          triggers={manualTriggers}
          workflowId={workflow.id}
        />
      ) : null}
      <ConfirmationDialog
        confirmLabel="Delete"
        description={`Delete "${workflow.name}"? Its triggers stop immediately and its run history is deleted. Issues, plans and pull requests created by its runs are kept.`}
        isPending={deleteWorkflow.isPending}
        onConfirm={async () => {
          await deleteWorkflow.mutateAsync(workflow.id);
          navigate(buildOrgPath("/workflows"));
        }}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        title="Delete workflow?"
        variant="destructive"
      />
    </div>
  );
}

const WORKFLOW_DETAIL_TABS: readonly WorkflowDetailTab[] = [
  WorkflowDetailTab.Configuration,
  WorkflowDetailTab.Runs,
];
