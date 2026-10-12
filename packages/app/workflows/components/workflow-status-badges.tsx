"use client";

import type {
  WorkflowActionRunStatus,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  WORKFLOW_ACTION_RUN_STATUS_LABELS,
  WORKFLOW_ACTION_RUN_STATUS_TONES,
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_RUN_STATUS_TONES,
} from "../lib/workflow-labels";

export function WorkflowRunStatusBadge({
  status,
}: Readonly<{ status: WorkflowRunStatus }>) {
  return (
    <Badge variant={WORKFLOW_RUN_STATUS_TONES[status] ?? "muted"}>
      {WORKFLOW_RUN_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function WorkflowActionRunStatusBadge({
  status,
}: Readonly<{ status: WorkflowActionRunStatus }>) {
  return (
    <Badge variant={WORKFLOW_ACTION_RUN_STATUS_TONES[status] ?? "muted"}>
      {WORKFLOW_ACTION_RUN_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
