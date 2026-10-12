import type { IntegrationProvidersResponse } from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  listIntegrationProviders,
  toProviderSummary,
} from "@/lib/integrations/registry";
import { successResponse } from "@/lib/route-utils";

/**
 * GET /integrations/providers
 * The provider catalog (connection fields, delivery modes, triggers and
 * actions) the connection and workflow forms render from. Any org member.
 * Built from the in-code registry; no database access.
 */
export const GET = withAnyAuth<
  IntegrationProvidersResponse,
  "/integrations/providers"
>(() =>
  Promise.resolve(
    successResponse({
      providers: listIntegrationProviders().map(toProviderSummary),
    })
  )
);
