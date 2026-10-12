import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, withDbMock } = vi.hoisted(() => {
  const fakeDb = {
    authInvitation: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    authMember: { create: vi.fn(), findFirst: vi.fn() },
    authOrganization: { findFirst: vi.fn(), create: vi.fn() },
    authSession: { updateMany: vi.fn() },
  };
  const run = (fn: (client: typeof fakeDb) => unknown) => fn(fakeDb);
  return {
    db: fakeDb,
    withDbMock: Object.assign(vi.fn(run), { tx: vi.fn(run) }),
  };
});

vi.mock("@repo/database", () => ({ withDb: withDbMock }));
vi.mock("@repo/observability/log", () => ({ log: { info: vi.fn() } }));
vi.mock("@/app/organizations/service", () => ({ organizationsService: {} }));
vi.mock("@/app/users/service", () => ({ usersService: {} }));
vi.mock("@/lib/db-utils", () => ({
  getPrismaErrorCode: (error: { code?: string }) => error?.code,
}));

import {
  hasPendingInvitation,
  provisionNewUser,
} from "@/lib/auth/identity-provisioning";

const USER = { id: "user-1", email: "Ada@Example.test", name: "Ada" };

describe("provisionNewUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    db.authInvitation.findMany.mockResolvedValue([]);
    db.authOrganization.findFirst.mockResolvedValue(null);
    db.authOrganization.create.mockResolvedValue({ id: "org-new" });
    db.authMember.findFirst.mockResolvedValue({ organizationId: "org-new" });
    db.authSession.updateMany.mockResolvedValue({ count: 1 });
  });

  it("creates the default organization with the first account as owner", async () => {
    await provisionNewUser(USER);

    expect(db.authOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "AgentFlow",
          slug: "agentflow",
        }),
      })
    );
    expect(db.authMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-new",
        userId: "user-1",
        role: "owner",
      }),
    });
  });

  it("names the default organization from the environment", async () => {
    vi.stubEnv("AUTH_DEFAULT_ORGANIZATION_NAME", "Acme");
    vi.stubEnv("AUTH_DEFAULT_ORGANIZATION_SLUG", "acme");

    await provisionNewUser(USER);

    expect(db.authOrganization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Acme", slug: "acme" }),
      })
    );
  });

  it("adds later accounts to the existing organization as members", async () => {
    db.authOrganization.findFirst.mockResolvedValue({ id: "org-1" });

    await provisionNewUser(USER);

    expect(db.authOrganization.create).not.toHaveBeenCalled();
    expect(db.authMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        role: "member",
      }),
    });
  });

  it("leaves the account without a membership when auto-join is off", async () => {
    vi.stubEnv("AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION", "false");
    db.authOrganization.findFirst.mockResolvedValue({ id: "org-1" });
    db.authMember.findFirst.mockResolvedValue(null);

    await provisionNewUser(USER);

    expect(db.authMember.create).not.toHaveBeenCalled();
    expect(db.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("joins invited organizations with the invited role instead of the default", async () => {
    db.authInvitation.findMany.mockResolvedValue([
      { id: "inv-1", organizationId: "org-9", role: "admin" },
    ]);
    db.authMember.findFirst.mockResolvedValue({ organizationId: "org-9" });

    await provisionNewUser(USER);

    expect(db.authInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: "ada@example.test",
          status: "pending",
        }),
      })
    );
    expect(db.authMember.create).toHaveBeenCalledTimes(1);
    expect(db.authMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-9", role: "admin" }),
    });
    expect(db.authInvitation.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "accepted" },
    });
    expect(db.authOrganization.findFirst).not.toHaveBeenCalled();
  });

  it("activates the joined organization on sessions created before the hook ran", async () => {
    await provisionNewUser(USER);

    expect(db.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", activeOrganizationId: null },
      data: { activeOrganizationId: "org-new" },
    });
  });

  it("joins the winner's organization when two first sign-ups race", async () => {
    db.authOrganization.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "org-winner" });
    db.authOrganization.create.mockRejectedValueOnce({ code: "P2002" });

    await provisionNewUser(USER);

    expect(db.authMember.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        organizationId: "org-winner",
        role: "member",
      }),
    });
  });
});

describe("hasPendingInvitation", () => {
  it("looks up unexpired pending invitations case-insensitively", async () => {
    db.authInvitation.findFirst.mockResolvedValueOnce({ id: "inv-1" });
    await expect(hasPendingInvitation("New@Example.test")).resolves.toBe(true);
    expect(db.authInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: "new@example.test",
          status: "pending",
          expiresAt: { gt: expect.any(Date) },
        }),
      })
    );

    db.authInvitation.findFirst.mockResolvedValueOnce(null);
    await expect(hasPendingInvitation("other@example.test")).resolves.toBe(
      false
    );
  });
});
