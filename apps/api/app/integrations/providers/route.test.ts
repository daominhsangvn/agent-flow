import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

import {
  listIntegrationProviders,
  toProviderSummary,
} from "@/lib/integrations/registry";
import { GET } from "./route";

describe("GET /integrations/providers", () => {
  it("serves the registry catalog to any member", async () => {
    const response = await GET(
      new NextRequest("http://localhost/integrations/providers"),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.providers).toEqual(
      JSON.parse(
        JSON.stringify(listIntegrationProviders().map(toProviderSummary))
      )
    );
    expect(
      json.data.providers.map((provider: { key: string }) => provider.key)
    ).toEqual(expect.arrayContaining(Object.values(IntegrationProviderKey)));
  });
});
