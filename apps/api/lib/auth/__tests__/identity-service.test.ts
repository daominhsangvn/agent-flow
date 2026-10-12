import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, sendInvitationEmailMock } = vi.hoisted(() => ({
  db: {
    authMember: { findFirst: vi.fn() },
    authUser: { findUnique: vi.fn() },
    authInvitation: { create: vi.fn() },
  },
  sendInvitationEmailMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (client: typeof db) => unknown) => fn(db),
}));
vi.mock("@/lib/auth/auth-email", () => ({
  sendInvitationEmail: sendInvitationEmailMock,
}));

import {
  identityService,
  splitDisplayName,
  toAuthRole,
  toOrgRole,
} from "@/lib/auth/identity-service";

describe("role mapping", () => {
  it("prefixes Better Auth roles the way the API compares them", () => {
    expect(toOrgRole("owner")).toBe("org:owner");
    expect(toOrgRole("admin,member")).toBe("org:admin");
    expect(toOrgRole("")).toBe("org:member");
  });

  it("strips the prefix when writing roles back", () => {
    expect(toAuthRole("org:admin")).toBe("admin");
    expect(toAuthRole("member")).toBe("member");
  });
});

describe("splitDisplayName", () => {
  it("splits on the first space", () => {
    expect(splitDisplayName("Ada King Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "King Lovelace",
    });
    expect(splitDisplayName("Ada")).toEqual({
      firstName: "Ada",
      lastName: null,
    });
    expect(splitDisplayName("  ")).toEqual({ firstName: null, lastName: null });
  });
});

describe("identityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports membership roles in org: form and null for non-members", async () => {
    db.authMember.findFirst.mockResolvedValueOnce({ role: "admin" });
    await expect(
      identityService.getOrganizationMembershipRole("org-1", "user-1")
    ).resolves.toBe("org:admin");

    db.authMember.findFirst.mockResolvedValueOnce(null);
    await expect(
      identityService.getOrganizationMembershipRole("org-1", "user-2")
    ).resolves.toBeNull();
  });

  it("maps an identity user to the profile shape the services expect", async () => {
    db.authUser.findUnique.mockResolvedValue({
      id: "user-1",
      email: "ada@example.test",
      name: "Ada Lovelace",
      image: null,
    });

    await expect(identityService.getUser("user-1")).resolves.toEqual({
      id: "user-1",
      email: "ada@example.test",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: null,
      phoneNumber: null,
    });
  });

  it("records a pending invitation with a bare role and emails the invitee", async () => {
    db.authInvitation.create.mockResolvedValue({
      id: "inv-1",
      email: "new@example.test",
      organization: { name: "Acme" },
      inviter: { name: "Ada", email: "ada@example.test" },
    });

    await expect(
      identityService.createOrganizationInvitation({
        organizationId: "org-1",
        emailAddress: "New@Example.test",
        role: "org:member",
        inviterUserId: "user-1",
      })
    ).resolves.toEqual({ id: "inv-1" });

    expect(db.authInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "new@example.test",
          role: "member",
          status: "pending",
        }),
      })
    );
    expect(sendInvitationEmailMock).toHaveBeenCalledWith({
      email: "new@example.test",
      organizationName: "Acme",
      inviterName: "Ada",
    });
  });
});
