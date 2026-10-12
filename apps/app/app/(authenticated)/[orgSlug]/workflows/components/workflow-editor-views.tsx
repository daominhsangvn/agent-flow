"use client";

import { WorkflowDetailView } from "@repo/app/workflows/components/workflow-detail-view";
import { WorkflowEditor } from "@repo/app/workflows/components/workflow-editor";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { ShieldIcon } from "lucide-react";
import { useWorkflowComputeTargetChoices } from "./use-workflow-compute-targets";
import { WORKFLOW_CONNECTIONS_SETTINGS_PATH } from "./workflow-connections-path";

/**
 * Web shell of the "New workflow" page: supplies the desktop compute targets
 * (web-only hook) to the shared editor. Creating a workflow is admin-only.
 */
export function NewWorkflowView({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const buildOrgPath = useOrgPath();

  if (!isAdmin) {
    return (
      <EmptyState
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={buildOrgPath("/workflows")}>Back to workflows</Link>
          </Button>
        }
        description="Only organization admins and owners can create workflows."
        icon={ShieldIcon}
        title="Admins only"
      />
    );
  }

  return <NewWorkflowEditor />;
}

/** Web shell of a workflow detail page: the shared view plus the compute targets. */
export function WorkflowDetailPageView({
  workflowId,
  isAdmin,
}: Readonly<{ workflowId: string; isAdmin: boolean }>) {
  const computeTargets = useWorkflowComputeTargetChoices();

  return (
    <WorkflowDetailView
      computeTargets={computeTargets}
      connectionsSettingsPath={WORKFLOW_CONNECTIONS_SETTINGS_PATH}
      isAdmin={isAdmin}
      workflowId={workflowId}
    />
  );
}

// Separate component so members never fetch compute targets they cannot use.
function NewWorkflowEditor() {
  const computeTargets = useWorkflowComputeTargetChoices();

  return (
    <WorkflowEditor
      computeTargets={computeTargets}
      connectionsSettingsPath={WORKFLOW_CONNECTIONS_SETTINGS_PATH}
      isAdmin
    />
  );
}
