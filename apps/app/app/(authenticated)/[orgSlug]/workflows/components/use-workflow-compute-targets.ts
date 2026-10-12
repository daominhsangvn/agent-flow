"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import type {
  WorkflowComputeTargetChoices,
  WorkflowComputeTargetOption,
} from "@repo/app/workflows/lib/workflow-editor-options";
import { useMemo } from "react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";

/**
 * The desktop compute targets the workflow editor offers. Compute targets are
 * read through the web-only hook (it also primes the command-signing cache),
 * so the shell maps them here and hands plain options to the shared editor.
 */
export function useWorkflowComputeTargetChoices(): WorkflowComputeTargetChoices {
  const targets = useComputeTargets();
  const options = useMemo(
    () => (targets.data ?? []).map(toComputeTargetOption),
    [targets.data]
  );

  return { options, isLoading: targets.isLoading, error: targets.error };
}

export function toComputeTargetOption(
  target: ComputeTarget
): WorkflowComputeTargetOption {
  return {
    id: target.id,
    label: target.machineName,
    description: describeComputeTarget(target),
    isOnline: target.isOnline,
  };
}

function describeComputeTarget(target: ComputeTarget): string | undefined {
  if (target.isSharedWithOrg) {
    return target.ownerName
      ? `Shared with the organization by ${target.ownerName}`
      : "Shared with the organization";
  }
  return target.ownerName;
}
