import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type AgentSessionFeatureIdentity = FeatureFlagIdentity;

/**
 * Whether the viewer has the `desktop-agent-session-sync` flag. It gates only
 * the golden-candidates surface now: agent-session sync and the Sessions and
 * Agents pages are always on, with no flag or org policy to switch them off.
 */
export function isAgentMonitoringEnabledForUser(
  identity: AgentSessionFeatureIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
    identity,
    "agent_session_feature_flag_unavailable"
  );
}
