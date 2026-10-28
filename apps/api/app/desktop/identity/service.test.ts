import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

import { desktopIdentityService } from "./service";

function installDb() {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
    cb({ user: { findFirst: mocks.findFirst } })
  );
}

// Session sync is always on, so the identity always reports it enabled —
// with the ISS-4705 capability marker installed desktops rely on to tell a
// capable server from an old one — whatever the org row holds.
describe("desktopIdentityService.get — session sync is always on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb();
  });

  it.each([
    { name: "an org", organization: { name: "Acme", slug: "acme" } },
    { name: "a missing org relation", organization: null },
  ])("reports session sync enabled and supported for $name", async ({
    organization,
  }) => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization,
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    expect(identity?.sessionSyncPolicyEnabled).toBe(true);
    expect(identity?.sessionSyncPolicySupported).toBe(true);
  });

  it("returns null when the user cannot be resolved", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const identity = await desktopIdentityService.get("nobody", "org-x");

    expect(identity).toBeNull();
  });
});

// ISS-4898 — the desktop renderer holds an `organizationId` but the web app's
// artifact routes are org-SLUG-scoped, so the slug rides this payload. It is an
// additive optional wire field: the AGENTS.md cross-repo rule is that an absent
// optional value is OMITTED, never serialized as `null`, because an old client
// must be free to treat "key present" as "usable value".
describe("desktopIdentityService.get — organizationSlug (ISS-4898)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb();
  });

  it("selects the org slug column", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@agentflow.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: {
        name: "AgentFlow",
        slug: "agentflow",
      },
    });

    await desktopIdentityService.get("user-1", "org-1");

    const select = mocks.findFirst.mock.calls[0]?.[0]?.select;
    expect(select?.organization?.select?.slug).toBe(true);
  });

  it("emits the slug the web artifact route is scoped by", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@agentflow.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: {
        name: "AgentFlow",
        slug: "agentflow",
      },
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    expect(identity?.organizationSlug).toBe("agentflow");
  });

  it("OMITS the key entirely when the org relation is missing", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-3",
      organizationId: "org-3",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: null,
    });

    const identity = await desktopIdentityService.get("user-3", "org-3");

    // Absence, not `null`: one careless `?? null` here would ship a value a
    // consumer could interpolate into `/<slug>/issues/...` and produce
    // `/null/issues/...`. Asserting the KEY is what catches that.
    expect(identity).not.toBeNull();
    expect("organizationSlug" in (identity as object)).toBe(false);
  });

  it("OMITS the key when the org row carries an empty slug", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-4",
      organizationId: "org-4",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: {
        name: "Acme",
        slug: "",
      },
    });

    const identity = await desktopIdentityService.get("user-4", "org-4");

    expect("organizationSlug" in (identity as object)).toBe(false);
  });
});
