import {
  createIntegrationRepositoryInputSchema,
  INTEGRATION_REPOSITORY_LIST_MAX,
  type IntegrationRepositoriesResponse,
  type IntegrationRepository,
  integrationRepositoriesQuerySchema,
} from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  createConnectionRepository,
  listConnectionRepositories,
} from "@/lib/integrations/repositories";
import {
  errorResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  connectionErrorResponse,
  denyUnlessOrgAdmin,
} from "../../route-helpers";

const ROUTE = "/integrations/connections/[id]/repositories";

/**
 * GET /integrations/connections/{id}/repositories?query=&limit=
 * Repositories the connection can access, for adding them to a project.
 * Org admins only (adding project repositories is admin-only too).
 */
export const GET = withAnyAuth<
  IntegrationRepositoriesResponse,
  "/integrations/connections/[id]/repositories"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { params: query, errorResponse: queryError } = parseQueryParams(
      request,
      integrationRepositoriesQuerySchema
    );
    if (queryError || !query) {
      return queryError;
    }
    const { id } = await params;
    const result = await listConnectionRepositories(
      auth.user.organizationId,
      id,
      {
        query: query.query || null,
        limit: query.limit ?? INTEGRATION_REPOSITORY_LIST_MAX,
      }
    );
    if (!result.ok) {
      return connectionErrorResponse(result.error);
    }
    return successResponse({ repositories: result.value });
  } catch (error) {
    return errorResponse("Failed to list integration repositories", error);
  }
});

/** Upper bound for a create body (a name, a description and a flag). */
const CREATE_BODY_MAX_BYTES = 4 * 1024;

/**
 * POST /integrations/connections/{id}/repositories
 * Creates a repository through a connection whose provider hosts
 * repositories itself (capability repository_creation, Local Git). Org
 * admins only, like adding project repositories.
 */
export const POST = withAnyAuth<
  IntegrationRepository,
  "/integrations/connections/[id]/repositories"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createIntegrationRepositoryInputSchema,
      { maxBytes: CREATE_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const { id } = await params;
    const result = await createConnectionRepository(
      auth.user.organizationId,
      id,
      body
    );
    if (!result.ok) {
      return connectionErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to create the repository", error);
  }
});
