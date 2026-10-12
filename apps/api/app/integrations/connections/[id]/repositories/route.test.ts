import type { IntegrationRepository } from "@repo/api/src/types/integration";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
  listConnectionRepositories: vi.fn(),
  createConnectionRepository: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));
vi.mock("@/lib/integrations/repositories", () => ({
  listConnectionRepositories: mocks.listConnectionRepositories,
  createConnectionRepository: mocks.createConnectionRepository,
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

import { POST } from "./route";

const CONNECTION_ID = "0199a5f0-0000-7000-8000-000000000001";

const NOTES: IntegrationRepository = {
  externalId: "12",
  fullName: "agentflow/notes",
  name: "notes",
  namespace: "agentflow",
  defaultBranch: "main",
  webUrl: "http://localhost:3300/agentflow/notes",
  isPrivate: true,
};

function createRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/integrations/connections/${CONNECTION_ID}/repositories`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

function idParams() {
  return { params: Promise.resolve({ id: CONNECTION_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true, reason: "admin" });
});

describe("POST /integrations/connections/{id}/repositories", () => {
  it("creates a private repository by default", async () => {
    mocks.createConnectionRepository.mockResolvedValue(Result.ok(NOTES));

    const response = await POST(createRequest({ name: " notes " }), idParams());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: NOTES,
    });
    expect(mocks.createConnectionRepository).toHaveBeenCalledWith(
      "org-1",
      CONNECTION_ID,
      { name: "notes", description: "", private: true }
    );
  });

  it("is for org admins only", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });

    const response = await POST(createRequest({ name: "notes" }), idParams());

    expect(response.status).toBe(403);
    expect(mocks.createConnectionRepository).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "two words" }],
    [{ name: "" }],
    [{ name: "notes", extra: true }],
  ])("rejects an invalid body %j", async (body) => {
    const response = await POST(createRequest(body), idParams());

    expect(response.status).toBe(400);
    expect(mocks.createConnectionRepository).not.toHaveBeenCalled();
  });

  it("answers the provider's refusal with its status and message", async () => {
    mocks.createConnectionRepository.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: 'A repository named "notes" already exists',
      })
    );

    const response = await POST(createRequest({ name: "notes" }), idParams());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'A repository named "notes" already exists',
    });
  });
});
