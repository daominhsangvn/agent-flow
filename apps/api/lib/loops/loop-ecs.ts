/**
 * Cloud runner layer for loop orchestration.
 *
 * The hosted product launched loops as AWS ECS tasks. Self-hosted deployments
 * have no cloud runner: every loop executes on a registered desktop compute
 * target, where Claude Code CLI runs with the operator's own login or proxy
 * settings. The resolver never selects cloud execution, so these entry points
 * are only reachable through a stale `preferredComputeMode`/explicit cloud
 * request, and they fail with an actionable message instead of a missing-SDK
 * crash.
 */

export const CLOUD_EXECUTION_UNAVAILABLE_MESSAGE =
  "Cloud execution is not available in this self-hosted deployment. " +
  "Connect a desktop compute target and run the loop there.";

export type RunEcsTaskOptions = {
  loopId: string;
  /** Identifier unique to this launch attempt (the runner token JTI). */
  launchAttemptId: string;
  organizationId: string;
  command: string;
  s3StateKey: string;
  s3ContextKey: string;
  s3ContextUrl: string;
  repo?: { fullName: string; branch: string };
  agentFlowAuthToken: string;
  documentId?: string;
  parentS3StateKey?: string;
  parentSessionId?: string;
  parentBranchName?: string;
};

/** Always rejects: there is no cloud runner to launch. */
export function runEcsTask(_opts: RunEcsTaskOptions): Promise<string> {
  return Promise.reject(new Error(CLOUD_EXECUTION_UNAVAILABLE_MESSAGE));
}

/**
 * No cloud task can exist, so there is nothing to stop. Resolves so cancel and
 * timeout sweeps for legacy rows still settle the loop row.
 */
export function stopLoopTask(
  _taskArn: string,
  _reason = "Loop cancelled"
): Promise<void> {
  return Promise.resolve();
}
