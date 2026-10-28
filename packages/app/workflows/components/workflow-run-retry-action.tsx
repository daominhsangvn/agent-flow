"use client";

import {
  WorkflowRunRetryMode,
  type WorkflowRunRetryStep,
} from "@repo/api/src/types/workflow";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { PlayIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { useRetryWorkflowRun } from "../hooks/use-workflows";

/**
 * Retry of a failed run's step (workflow admins), with the run's documents,
 * approved plan and answers; the steps before it do not run again. Retry
 * goes on with the step's failed agent session (a fork of it), when its
 * computer recorded one; Restart runs the step again from its start.
 */
export function WorkflowRunRetryAction({
  runId,
  step,
}: Readonly<{ runId: string; step: WorkflowRunRetryStep }>) {
  const retryRun = useRetryWorkflowRun();
  const [confirmMode, setConfirmMode] = useState<WorkflowRunRetryMode | null>(
    null
  );
  const copy = confirmMode ? retryCopy(confirmMode, step.name) : null;

  return (
    <>
      {step.resumable ? (
        <Button
          disabled={retryRun.isPending}
          onClick={() => setConfirmMode(WorkflowRunRetryMode.Resume)}
          size="sm"
          title={`Continue the failed step where it stopped: ${step.name}`}
          type="button"
          variant="outline"
        >
          <PlayIcon className="size-4" />
          Retry {step.name}
        </Button>
      ) : null}
      <Button
        disabled={retryRun.isPending}
        onClick={() => setConfirmMode(WorkflowRunRetryMode.Restart)}
        size="sm"
        title={`Run the failed step again from its start: ${step.name}`}
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-4" />
        Restart {step.name}
      </Button>
      <ConfirmationDialog
        confirmLabel={copy?.confirmLabel ?? ""}
        description={copy?.description ?? ""}
        isPending={retryRun.isPending}
        onConfirm={async () => {
          if (confirmMode) {
            await retryRun.mutateAsync({ runId, mode: confirmMode });
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmMode(null);
          }
        }}
        open={confirmMode !== null}
        title={copy?.title ?? ""}
      />
    </>
  );
}

function retryCopy(mode: WorkflowRunRetryMode, stepName: string) {
  if (mode === WorkflowRunRetryMode.Resume) {
    return {
      title: "Retry the failed step?",
      confirmLabel: `Retry ${stepName}`,
      description: `"${stepName}" goes on where it stopped: its agent continues a copy of the failed session on the same computer, so finished work is kept. Fix what made it fail first (for example an expired model token).`,
    };
  }
  return {
    title: "Restart the failed step?",
    confirmLabel: `Restart ${stepName}`,
    description: `"${stepName}" runs again from its start in a new agent session. The run keeps its documents, its approved plan and the answers given; the steps before it do not run again. Fix what made it fail first (for example an expired model token).`,
  };
}
