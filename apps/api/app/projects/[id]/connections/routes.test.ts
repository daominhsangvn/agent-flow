import type { ProjectConnection } from "@repo/api/src/types/project-connection";
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
    update: vi.fn(),
    remove: vi.fn(),
    listForConnection: vi.fn(),
    listAll: vi.fn(),
  },
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
vi.mock("@/app/projects/project-connection-service", () => ({
  projectConnectionService: mocks.service,
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

import { GET as listConnectionProjects } from "@/app/integrations/connections/[id]/projects/route";
import { GET as listOrgProjectConnections } from "@/app/project-connections/route";
import {
  DELETE as removeProjectConnection,
  PATCH as updateProjectConnection,
} from "./[projectConnectionId]/route";
import {
  POST as createProjectConnection,
  GET as listProjectConnections,
} from "./route";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const PC_ID = "0199a5f0-0000-7000-8000-0000000000c1";
const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const OTHER_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e2";
const BASE_URL = `http://localhost/projects/${PROJECT_ID}/connections`;

const PROJECT_CONNECTION: ProjectConnection = {
  id: PC_ID,
  projectId: PROJECT_ID,
  connectionId: CONNECTION_ID,
  connectionName: "Acme Jira",
  provider: "jira",
  key: "jira-billing",
  name: "Jira billing",
  settings: { projectKeys: ["BIL"] },
  createdAt: new Date("2026-10-13T00:00:00Z"),
  updatedAt: new Date("2026-10-13T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true, reason: "admin" });
  mocks.resolveProjectId.mockResolvedValue(PROJECT_ID);
});

describe("/projects/{id}/connections", () => {
  it.each([
    {
      name: "GET",
      call: () => listProjectConnections(request("GET"), projectParams()),
    },
    {
      name: "POST",
      call: () =>
        createProjectConnection(
          request("POST", "", createBody()),
          projectParams()
        ),
    },
    {
      name: "PATCH",
      call: () =>
        updateProjectConnection(
          request("PATCH", `/${PC_ID}`, { name: "x" }),
          itemParams()
        ),
    },
    {
      name: "DELETE",
      call: () =>
        removeProjectConnection(request("DELETE", `/${PC_ID}`), itemParams()),
    },
    {
      name: "GET project-connections",
      call: () =>
        listOrgProjectConnections(request("GET"), {
          params: Promise.resolve({}),
        }),
    },
    {
      name: "GET connection projects",
      call: () =>
        listConnectionProjects(request("GET"), {
          params: Promise.resolve({ id: CONNECTION_ID }),
        }),
    },
  ])("$name is for org admins only", async ({ call }) => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });

    const response = await call();

    expect(response.status).toBe(Status.Forbidden);
    for (const method of Object.values(mocks.service)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("lists every project connection of the organization", async () => {
    mocks.service.listAll.mockResolvedValue([PROJECT_CONNECTION]);

    const response = await listOrgProjectConnections(request("GET"), {
      params: Promise.resolve({}),
    });

    expect((await response.json()).data.connections).toHaveLength(1);
    expect(mocks.service.listAll).toHaveBeenCalledWith("org-1");
  });

  it("lists the project's connections", async () => {
    mocks.service.list.mockResolvedValue([PROJECT_CONNECTION]);

    const response = await listProjectConnections(
      request("GET"),
      projectParams()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.connections).toHaveLength(1);
    expect(mocks.service.list).toHaveBeenCalledWith("org-1", PROJECT_ID);
  });

  it("returns 404 for an unknown project", async () => {
    mocks.resolveProjectId.mockResolvedValue(null);

    const response = await listProjectConnections(
      request("GET"),
      projectParams()
    );

    expect(response.status).toBe(404);
  });

  it("adds with the parsed body and maps conflicts to 409", async () => {
    mocks.service.add
      .mockResolvedValueOnce({ ok: true, value: [PROJECT_CONNECTION] })
      .mockResolvedValueOnce({
        ok: false,
        error: { status: Status.Conflict, message: "BIL already belongs" },
      });

    const created = await createProjectConnection(
      request("POST", "", createBody()),
      projectParams()
    );
    const conflict = await createProjectConnection(
      request("POST", "", createBody()),
      projectParams()
    );

    expect(created.status).toBe(200);
    expect((await created.json()).data.connections).toHaveLength(1);
    expect(mocks.service.add).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      "user-1",
      createBody()
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("BIL already belongs");
  });

  it("refuses a reserved or malformed key, and a key or connection given twice", async () => {
    const reserved = await createProjectConnection(
      request("POST", "", createBody({ key: "source" })),
      projectParams()
    );
    const malformed = await createProjectConnection(
      request("POST", "", createBody({ key: "Jira Billing" })),
      projectParams()
    );
    const entry = createBody().connections[0];
    const sameKey = await createProjectConnection(
      request("POST", "", {
        ...createBody(),
        connections: [entry, { ...entry, connectionId: OTHER_CONNECTION_ID }],
      }),
      projectParams()
    );
    const sameConnection = await createProjectConnection(
      request("POST", "", {
        ...createBody(),
        connections: [entry, { ...entry, key: "jira-qc" }],
      }),
      projectParams()
    );

    expect(reserved.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(sameKey.status).toBe(400);
    expect(sameConnection.status).toBe(400);
    expect(mocks.service.add).not.toHaveBeenCalled();
  });

  it("updates only the submitted fields", async () => {
    mocks.service.update.mockResolvedValue({
      ok: true,
      value: PROJECT_CONNECTION,
    });

    await updateProjectConnection(
      request("PATCH", `/${PC_ID}`, { name: "Jira" }),
      itemParams()
    );

    expect(mocks.service.update).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      PC_ID,
      { name: "Jira" }
    );
  });

  it("removes a project connection", async () => {
    mocks.service.remove.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });

    const response = await removeProjectConnection(
      request("DELETE", `/${PC_ID}`),
      itemParams()
    );

    expect(response.ok).toBe(true);
    expect(mocks.service.remove).toHaveBeenCalledWith(
      "org-1",
      PROJECT_ID,
      PC_ID
    );
  });
});

function createBody(entry: { key?: string } = {}) {
  return {
    connections: [
      {
        connectionId: CONNECTION_ID,
        key: entry.key ?? "jira-billing",
        name: "Jira billing",
      },
    ],
    settings: { projectKeys: ["BIL"] },
  };
}

function request(method: string, path = "", body?: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function projectParams() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

function itemParams() {
  return {
    params: Promise.resolve({ id: PROJECT_ID, projectConnectionId: PC_ID }),
  };
}
