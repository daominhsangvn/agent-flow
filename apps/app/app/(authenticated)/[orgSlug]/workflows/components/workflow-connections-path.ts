import { INTEGRATION_CONNECTIONS_ANCHOR } from "@repo/app/integrations/lib/integration-anchors";
import { SettingsTab } from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";

/**
 * Org-relative link to the Connections section of Settings, handed to the
 * workflow editor's "add a connection first" hints.
 */
export const WORKFLOW_CONNECTIONS_SETTINGS_PATH = `/settings?tab=${SettingsTab.Integrations}#${INTEGRATION_CONNECTIONS_ANCHOR}`;
