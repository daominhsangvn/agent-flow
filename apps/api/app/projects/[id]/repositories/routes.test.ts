import type { ProjectRepository } from "@repo/api/src/types/project-repository";
import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
  resolveProjectId: vi.fn(),
  service: {
    list: vi.fn(),
    add: vi.fn(),
    setPrimary: vi.fn(),
    remove: vi.fn(),
  },
  listConnectionRepositories: vi.fn(),
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
vi.mock("@/lib/identifier-utils", () => ({
  resolveProjectId: mocks.resolveProjectId,
}));
vi.mock("@/app/projects/project-repository-service", () => ({
  projectRepositoryService: mocks.service,
}));
vi.mock("@/lib/integrations/repositories", () => ({
  listConnectionRepositories: mocks.listConnectionRepositories,
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

import { GET as listConnectionRepositoriesRoute } from "../../../integrations/connections/[id]/repositories/route";
import {
  DELETE as removeRepository,
  PATCH as updateRepository,
} from "./[repositoryId]/route";
import { POST as addRepository, GET as listRepositories } from "./route";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const REPOSITORY_ID = "0199a5f0-0000-7000-8000-0000000000f1";

const REPOSITORY: ProjectRepository = {
  id: REPOSITORY_ID,
  projectId: PROJECT_ID,
  connectionId: CONNECTION_ID,
  connectionName: "Contoso GitHub",
  provider: "github",
  externalId: "1296269",
  fullName: "contoso/shop",
  name: "shop",
  defaultBranch: "main",
  webUrl: "https://github.com/contoso/shop",
  isPrimary: true,
  createdAt: new Date("2026-10-05T00:00:00Z"),
  updatedAt: new Date("2026-10-05T00:00:00Z"),
};

function request(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

function asAdmin() {
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true, reason: "admin" });
}

function asMember() {
  mocks.getOrgAdminStatus.mockResolvedValue({
    isAdmin: false,
    reason: "not_admin",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProjectId.mockResolvedValue(PROJECT_ID);
});

describe("GET /projects/{id}/repositories", () => {
  it("lists the repositories for any member", async () => {
    asMember();
    mocks.service.list.mockResolvedValue([REPOSITORY]);

    const response = await listRepositories(
      request("GET", "/projects/shop/repositories"),
      params({ id: "shop" })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.repositories).toHaveLength(1);
    expect(mocks.resolveProjectId).toHaveBeenCalledWith("shop", "org-1");
    expect(mocks.service.list).toHaveBeenCalledWith("org-1", PROJECT_ID);
  });

  it("returns 404 for an unknown project", async () => {
    mocks.resolveProjectId.mockResolvedValue(null);

    const response = await listRepositories(
      request("GET", "/projects/nope/repositories"),
      params({ id: "nope" })
    );

    expect(response.status).toBe(404);
    expect(mocks.service.list).not.toHaveBeenCalled();
  });
});

describe("POST /projects/{id}/repositories", () => {
  const body = { connectionId: CONNECTION_ID, externalId: "1296269" };

  it("is admin-only", async () => {
    asMember();

    const response = await addRepository(
      request("POST", `/projects/${PROJECT_ID}/repositories`, body),
      params({ id: PROJECT_ID })
    );

    expect(response.status).toBe(403);
    expect(mocks.service.add).not.toHaveBeenCalled();
  });

  it("adds the repository for an admin", async () => {
    asAdmin();
    mocks.service.add.mockResolvedValue({ ok: true, value: REPOSITORY });

    const response = await addRepository(
      request("POST", `/projects/${PROJECT_ID}/repositories`, body),
      params({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.service.add).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      "user-1",
      body
    );
  });

  it("rejects an invalid body and maps service errors to their status", async () => {
    asAdmin();
    mocks.service.add.mockResolvedValue({
      ok: false,
      error: {
        status: Status.Conflict,
        message: "contoso/shop is already a repository of this project",
      },
    });

    const invalid = await addRepository(
      request("POST", `/projects/${PROJECT_ID}/repositories`, {
        connectionId: "not-a-uuid",
        externalId: "",
      }),
      params({ id: PROJECT_ID })
    );
    const conflict = await addRepository(
      request("POST", `/projects/${PROJECT_ID}/repositories`, body),
      params({ id: PROJECT_ID })
    );

    expect(invalid.status).toBe(400);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe(
      "contoso/shop is already a repository of this project"
    );
  });
});

describe("PATCH / DELETE /projects/{id}/repositories/{repositoryId}", () => {
  const ids = { id: PROJECT_ID, repositoryId: REPOSITORY_ID };

  it("is admin-only", async () => {
    asMember();

    const patch = await updateRepository(
      request("PATCH", "/x", { isPrimary: true }),
      params(ids)
    );
    const remove = await removeRepository(request("DELETE", "/x"), params(ids));

    expect(patch.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(mocks.service.setPrimary).not.toHaveBeenCalled();
    expect(mocks.service.remove).not.toHaveBeenCalled();
  });

  it("makes the repository primary and removes it for an admin", async () => {
    asAdmin();
    mocks.service.setPrimary.mockResolvedValue({ ok: true, value: REPOSITORY });
    mocks.service.remove.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });

    const patch = await updateRepository(
      request("PATCH", "/x", { isPrimary: true }),
      params(ids)
    );
    const remove = await removeRepository(request("DELETE", "/x"), params(ids));

    expect(patch.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(mocks.service.setPrimary).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      REPOSITORY_ID
    );
    expect(mocks.service.remove).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      REPOSITORY_ID
    );
  });

  it("only accepts isPrimary: true", async () => {
    asAdmin();

    const response = await updateRepository(
      request("PATCH", "/x", { isPrimary: false }),
      params(ids)
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /integrations/connections/{id}/repositories", () => {
  it("is admin-only", async () => {
    asMember();

    const response = await listConnectionRepositoriesRoute(
      request("GET", `/integrations/connections/${CONNECTION_ID}/repositories`),
      params({ id: CONNECTION_ID })
    );

    expect(response.status).toBe(403);
    expect(mocks.listConnectionRepositories).not.toHaveBeenCalled();
  });

  it("passes the search and limit through and maps provider failures", async () => {
    asAdmin();
    mocks.listConnectionRepositories
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          status: Status.BadGateway,
          message: "GitHub could not list repositories: rate limited",
        },
      });

    const found = await listConnectionRepositoriesRoute(
      request(
        "GET",
        `/integrations/connections/${CONNECTION_ID}/repositories?query=shop&limit=20`
      ),
      params({ id: CONNECTION_ID })
    );
    const failed = await listConnectionRepositoriesRoute(
      request("GET", `/integrations/connections/${CONNECTION_ID}/repositories`),
      params({ id: CONNECTION_ID })
    );

    expect(found.status).toBe(200);
    expect(mocks.listConnectionRepositories).toHaveBeenNthCalledWith(
      1,
      "org-1",
      CONNECTION_ID,
      { query: "shop", limit: 20 }
    );
    expect(mocks.listConnectionRepositories).toHaveBeenNthCalledWith(
      2,
      "org-1",
      CONNECTION_ID,
      { query: null, limit: 100 }
    );
    expect(failed.status).toBe(502);
  });

  it("rejects unknown query parameters", async () => {
    asAdmin();

    const response = await listConnectionRepositoriesRoute(
      request(
        "GET",
        `/integrations/connections/${CONNECTION_ID}/repositories?owner=contoso`
      ),
      params({ id: CONNECTION_ID })
    );

    expect(response.status).toBe(400);
  });
});
