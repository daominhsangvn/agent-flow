import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";

/** Badge tones used by the integrations UI (a subset of the design-system Badge variants). */
export type IntegrationBadgeTone =
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "info";

export const CONNECTION_STATUS_LABELS: Record<
  IntegrationConnectionStatus,
  string
> = {
  [IntegrationConnectionStatus.Active]: "Active",
  [IntegrationConnectionStatus.Error]: "Error",
  [IntegrationConnectionStatus.Disabled]: "Disabled",
};

export const CONNECTION_STATUS_TONES: Record<
  IntegrationConnectionStatus,
  IntegrationBadgeTone
> = {
  [IntegrationConnectionStatus.Active]: "success",
  [IntegrationConnectionStatus.Error]: "error",
  [IntegrationConnectionStatus.Disabled]: "muted",
};

export const DELIVERY_MODE_LABELS: Record<IntegrationDeliveryMode, string> = {
  [IntegrationDeliveryMode.Webhook]: "Webhook",
  [IntegrationDeliveryMode.Poll]: "Polling",
  [IntegrationDeliveryMode.None]: "Actions only",
};

export const DELIVERY_MODE_DESCRIPTIONS: Record<
  IntegrationDeliveryMode,
  string
> = {
  [IntegrationDeliveryMode.Webhook]:
    "The source system calls a public HTTPS URL on every change. Fastest, but the API must be reachable from the internet.",
  [IntegrationDeliveryMode.Poll]:
    "AgentFlow asks the source system for changes on an interval. Works behind NAT or a firewall.",
  [IntegrationDeliveryMode.None]:
    "No inbound events. Use the connection only for workflow actions (status changes, comments, messages, callbacks).",
};

export const DELIVERY_OUTCOME_LABELS: Record<
  IntegrationDeliveryOutcome,
  string
> = {
  [IntegrationDeliveryOutcome.Accepted]: "Accepted",
  [IntegrationDeliveryOutcome.Ignored]: "Ignored",
  [IntegrationDeliveryOutcome.Duplicate]: "Duplicate",
  [IntegrationDeliveryOutcome.Error]: "Error",
};

export const DELIVERY_OUTCOME_TONES: Record<
  IntegrationDeliveryOutcome,
  IntegrationBadgeTone
> = {
  [IntegrationDeliveryOutcome.Accepted]: "success",
  [IntegrationDeliveryOutcome.Ignored]: "muted",
  [IntegrationDeliveryOutcome.Duplicate]: "info",
  [IntegrationDeliveryOutcome.Error]: "error",
};

export const DELIVERY_SOURCE_LABELS: Record<IntegrationDeliverySource, string> =
  {
    [IntegrationDeliverySource.Webhook]: "Webhook",
    [IntegrationDeliverySource.Poll]: "Poll",
    [IntegrationDeliverySource.Manual]: "Manual",
  };

/**
 * Delivery modes offered for a provider: its own inbound modes plus "none"
 * (actions only), in a stable order.
 */
export function getSelectableDeliveryModes(
  provider: Pick<IntegrationProviderSummary, "deliveryModes">
): IntegrationDeliveryMode[] {
  const modes = new Set<IntegrationDeliveryMode>(provider.deliveryModes);
  modes.add(IntegrationDeliveryMode.None);
  return DELIVERY_MODE_ORDER.filter((mode) => modes.has(mode));
}

/** The delivery mode a new connection of this provider starts with. */
export function getDefaultDeliveryMode(
  provider: Pick<IntegrationProviderSummary, "deliveryModes">
): IntegrationDeliveryMode {
  return provider.deliveryModes[0] ?? IntegrationDeliveryMode.None;
}

/** Display name of a provider key, falling back to the raw key for an unknown provider. */
export function getProviderDisplayName(
  providers: readonly IntegrationProviderSummary[] | undefined,
  providerKey: string
): string {
  return (
    providers?.find((provider) => provider.key === providerKey)?.displayName ??
    providerKey
  );
}

const DELIVERY_MODE_ORDER: readonly IntegrationDeliveryMode[] = [
  IntegrationDeliveryMode.Webhook,
  IntegrationDeliveryMode.Poll,
  IntegrationDeliveryMode.None,
];
