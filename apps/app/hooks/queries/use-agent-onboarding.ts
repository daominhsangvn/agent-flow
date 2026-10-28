"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { useAgentComponents } from "@repo/app/agents/hooks/use-agent-components";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { useOrganization } from "@repo/auth/client";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";

const DISMISS_KEY_PREFIX = "agents:onboarding:dismissed";
const BOOTSTRAP_LOOP_KEY_PREFIX = "agents:bootstrap:activeLoopId";

export type AgentOnboardingState = {
  needsBootstrap: boolean;
  /** The runners this user can start a loop on: their own and the org-shared ones. */
  runner: AgentRunnerStatus;
  prereqsMet: boolean;
  isDismissed: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  bootstrapInProgress: boolean;
  shouldShow: boolean;
  dismiss: () => void;
};

export function useAgentOnboarding(): AgentOnboardingState {
  const { membership, organization } = useOrganization();
  const orgId = organization?.id;
  const dismissKey = orgId
    ? `${DISMISS_KEY_PREFIX}:${orgId}`
    : DISMISS_KEY_PREFIX;
  const bootstrapKey = orgId
    ? `${BOOTSTRAP_LOOP_KEY_PREFIX}:${orgId}`
    : BOOTSTRAP_LOOP_KEY_PREFIX;
  const [dismissed, setDismissed] = useLocalStorageState(dismissKey, false);
  const [activeLoopId] = useLocalStorageState<string | null>(
    bootstrapKey,
    null
  );
  const isAdmin = isAdminRole(membership?.role);
  const shouldFetch = !dismissed && isAdmin;
  const bootstrapInProgress = activeLoopId !== null;

  const { data: componentData, isLoading: agentsLoading } = useAgentComponents(
    {},
    { enabled: shouldFetch }
  );
  const { data: computeTargets, isLoading: computeLoading } = useComputeTargets(
    { enabled: shouldFetch }
  );

  const needsBootstrap = componentData?.total === 0;
  const runner = runnerStatusOf(computeTargets);
  // Generating agents is a loop, and a loop needs a runner that is online now.
  // Nothing else: the repositories are read by the runner, not through the
  // GitHub integration.
  const prereqsMet = runner === AgentRunnerStatus.Online;
  const isLoading = shouldFetch && (agentsLoading || computeLoading);

  const shouldShow =
    !isLoading && needsBootstrap === true && !dismissed && isAdmin;

  return {
    needsBootstrap: needsBootstrap ?? false,
    runner,
    prereqsMet,
    isDismissed: dismissed,
    isLoading,
    isAdmin,
    bootstrapInProgress,
    shouldShow,
    dismiss: () => setDismissed(true),
  };
}

/** Whether a runner can take a loop now, is installed but offline, or is not installed yet. */
export const AgentRunnerStatus = {
  Online: "online",
  Offline: "offline",
  None: "none",
} as const;
export type AgentRunnerStatus =
  (typeof AgentRunnerStatus)[keyof typeof AgentRunnerStatus];

function runnerStatusOf(
  targets: readonly ComputeTarget[] | undefined
): AgentRunnerStatus {
  if (targets?.some((target) => target.isOnline)) {
    return AgentRunnerStatus.Online;
  }
  return targets && targets.length > 0
    ? AgentRunnerStatus.Offline
    : AgentRunnerStatus.None;
}
