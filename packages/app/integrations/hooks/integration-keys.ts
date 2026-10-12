/**
 * Query-key factory for the generic integration connections (Jira, Azure
 * DevOps, Microsoft Teams, generic HTTPS webhooks, ...). Lives in its own
 * module so other slices (workflows) can invalidate connection caches without
 * importing the hooks.
 *
 * Everything that belongs to one connection (its inbound endpoint details and
 * its recent deliveries) nests under `connectionDetail(id)`, so invalidating
 * `connections()` refreshes the list, every detail and every nested read.
 */
export const integrationKeys = {
  all: ["integrations"] as const,
  providers: () => [...integrationKeys.all, "providers"] as const,
  connections: () => [...integrationKeys.all, "connections"] as const,
  connectionList: () => [...integrationKeys.connections(), "list"] as const,
  connectionDetails: () =>
    [...integrationKeys.connections(), "detail"] as const,
  connectionDetail: (id: string) =>
    [...integrationKeys.connectionDetails(), id] as const,
  inbound: (id: string) =>
    [...integrationKeys.connectionDetail(id), "inbound"] as const,
  deliveries: (id: string) =>
    [...integrationKeys.connectionDetail(id), "deliveries"] as const,
};
