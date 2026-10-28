import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import type { ActionResult } from "@/lib/integrations/types";

/**
 * One result for an action that ran on several connections (a
 * repository-scoped action left without a connection: a pull request per
 * connection's repositories, action-connection.ts). Every output is kept, so
 * the run records each pull request; the action failed when one connection
 * failed (retryable when any failure is), succeeded when one succeeded, and
 * was skipped only when every connection skipped it.
 */
export function mergeActionResults(
  results: readonly ActionResult[]
): ActionResult {
  const [only, ...others] = results;
  if (!only) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      reason: "No connection ran the action.",
    };
  }
  if (others.length === 0) {
    return only;
  }
  const pullRequests = results.flatMap((result) =>
    result.status === WorkflowActionRunStatus.Skipped
      ? []
      : (result.outputs?.pullRequests ?? [])
  );
  const outputs = pullRequests.length > 0 ? { outputs: { pullRequests } } : {};
  const failures = results.filter(
    (result): result is Extract<ActionResult, { status: "failed" }> =>
      result.status === WorkflowActionRunStatus.Failed
  );
  if (failures.length > 0) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: failures.map((failure) => failure.error).join("; "),
      retryable: failures.some((failure) => failure.retryable),
      ...outputs,
    };
  }
  const succeeded = results.filter(
    (result): result is Extract<ActionResult, { status: "succeeded" }> =>
      result.status === WorkflowActionRunStatus.Succeeded
  );
  const [first] = succeeded;
  if (first) {
    const detail = succeeded
      .map((result) => result.detail)
      .filter(Boolean)
      .join("; ");
    return {
      status: WorkflowActionRunStatus.Succeeded,
      ...(first.externalRef ? { externalRef: first.externalRef } : {}),
      ...(detail ? { detail } : {}),
      ...outputs,
    };
  }
  return {
    status: WorkflowActionRunStatus.Skipped,
    reason: results
      .map((result) =>
        result.status === WorkflowActionRunStatus.Skipped ? result.reason : ""
      )
      .filter(Boolean)
      .join("; "),
  };
}
