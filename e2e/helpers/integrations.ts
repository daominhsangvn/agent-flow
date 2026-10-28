import type { APIRequestContext } from "@playwright/test";
import {
  createIntegrationConnectionInputSchema,
  type IntegrationConnection,
  type IntegrationInboundDetails,
} from "@repo/api/src/types/integration";
import {
  createProjectConnectionInputSchema,
  type ProjectConnection,
} from "@repo/api/src/types/project-connection";
import type { z } from "zod";
import { bearer, deleteQuietly, readApiResult } from "./api-result";
import { getApiBaseUrl } from "./api-url";

export type CreateIntegrationConnectionRequest = z.input<
  typeof createIntegrationConnectionInputSchema
>;

export async function createIntegrationConnection(
  request: APIRequestContext,
  {
    input,
    token,
  }: {
    input: CreateIntegrationConnectionRequest;
    token: string;
  }
): Promise<IntegrationConnection> {
  const response = await request.post(
    `${getApiBaseUrl()}/integrations/connections`,
    {
      data: createIntegrationConnectionInputSchema.parse(input),
      headers: bearer(token),
    }
  );
  return readApiResult<IntegrationConnection>(
    response,
    `Create ${input.provider} integration connection`
  );
}

/** Admin-only: the inbound URL and shared secret of a connection. */
export async function getIntegrationInboundDetails(
  request: APIRequestContext,
  connectionId: string,
  token: string
): Promise<IntegrationInboundDetails> {
  const response = await request.get(
    `${getApiBaseUrl()}/integrations/connections/${connectionId}/inbound`,
    { headers: bearer(token) }
  );
  return readApiResult<IntegrationInboundDetails>(
    response,
    "Read integration inbound details"
  );
}

export async function deleteIntegrationConnection(
  request: APIRequestContext,
  connectionId: string | null,
  token: string
): Promise<void> {
  if (!connectionId) {
    return;
  }
  await deleteQuietly(
    request,
    `${getApiBaseUrl()}/integrations/connections/${connectionId}`,
    token
  );
}

/** Adds an organization connection to a project under a key (org admins). */
export async function createProjectConnection(
  request: APIRequestContext,
  {
    projectId,
    input,
    token,
  }: {
    projectId: string;
    input: z.input<typeof createProjectConnectionInputSchema>;
    token: string;
  }
): Promise<ProjectConnection> {
  const response = await request.post(
    `${getApiBaseUrl()}/projects/${projectId}/connections`,
    {
      data: createProjectConnectionInputSchema.parse(input),
      headers: bearer(token),
    }
  );
  return readApiResult<ProjectConnection>(
    response,
    `Add ${input.key} to the project`
  );
}

export async function deleteProjectConnection(
  request: APIRequestContext,
  projectId: string | null,
  projectConnectionId: string | null,
  token: string
): Promise<void> {
  if (!(projectId && projectConnectionId)) {
    return;
  }
  await deleteQuietly(
    request,
    `${getApiBaseUrl()}/projects/${projectId}/connections/${projectConnectionId}`,
    token
  );
}

/**
 * The inbound URL as served by the API under test. The API builds inbound
 * URLs from PUBLIC_WEBHOOK_BASE_URL (often a public tunnel, possibly with a
 * path prefix), so tests keep only the ingress route and post it to the API
 * origin under test.
 */
export function toLocalInboundUrl(inboundUrl: string): string {
  const { pathname, search } = new URL(inboundUrl);
  const routeStart = pathname.indexOf(INBOUND_ROUTE_PREFIX);
  const route = routeStart === -1 ? pathname : pathname.slice(routeStart);
  return `${getApiBaseUrl()}${route}${search}`;
}

/** Public ingress route of integration webhooks (docs/workflows.md). */
const INBOUND_ROUTE_PREFIX = "/webhooks/integrations/";
