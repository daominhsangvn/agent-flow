"use client";

import { IntegrationConnectionsPanel } from "@repo/app/integrations/components/integration-connections-panel";
import { INTEGRATION_CONNECTIONS_ANCHOR } from "@repo/app/integrations/lib/integration-anchors";

export type IntegrationConnectionsSectionProps = {
  isAdmin: boolean;
};

/**
 * The generic integration connections (Jira, Azure DevOps, Microsoft Teams,
 * HTTPS webhooks) in the Compute & Integrations tab. Admins manage them;
 * members see a read-only list. The section owns the
 * `#integration-connections` anchor so the workflow editor can deep-link here.
 */
export function IntegrationConnectionsSection({
  isAdmin,
}: Readonly<IntegrationConnectionsSectionProps>) {
  return (
    <IntegrationConnectionsPanel
      id={INTEGRATION_CONNECTIONS_ANCHOR}
      isAdmin={isAdmin}
    />
  );
}
