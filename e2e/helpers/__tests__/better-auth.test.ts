import { describe, expect, it } from "vitest";
import {
  decodeSessionClaims,
  getE2ECredentials,
  isOrgAdminRole,
  OrgRole,
  requireOrgClaims,
} from "../better-auth";

const LOCAL_ENV: NodeJS.ProcessEnv = { BASE_URL: "http://localhost:3100" };

const RE_PASSWORD_REQUIRED = /E2E_USER_PASSWORD is required/;
const RE_NOT_A_JWT = /not a JWT/;
const RE_AUTO_JOIN_HINT = /AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION/;

describe("getE2ECredentials", () => {
  it("uses the defaults against localhost", () => {
    const credentials = getE2ECredentials(LOCAL_ENV);

    expect(credentials.email).toBe("e2e@example.com");
    expect(credentials.name).toBe("E2E Bot");
    expect(credentials.password.length).toBeGreaterThanOrEqual(8);
  });

  it("prefers E2E_USER_* over the legacy password variable", () => {
    expect(
      getE2ECredentials({
        ...LOCAL_ENV,
        E2E_USER_EMAIL: "bot@example.com",
        E2E_USER_PASSWORD: "explicit-password",
        E2E_USER_NAME: "Bot",
        DEVOPS_AGENTFLOW_APP_PWD: "legacy-password",
      })
    ).toEqual({
      email: "bot@example.com",
      password: "explicit-password",
      name: "Bot",
    });
  });

  it("treats empty values as unset", () => {
    const credentials = getE2ECredentials({
      ...LOCAL_ENV,
      E2E_USER_PASSWORD: "",
      DEVOPS_AGENTFLOW_APP_PWD: "legacy-password",
    });

    expect(credentials.password).toBe("legacy-password");
  });

  it("requires an explicit password for remote targets", () => {
    expect(() =>
      getE2ECredentials({ BASE_URL: "https://app.example.com" })
    ).toThrow(RE_PASSWORD_REQUIRED);
  });
});

describe("decodeSessionClaims", () => {
  it("decodes the payload of a session JWT", () => {
    const token = makeToken({
      sub: "user-1",
      exp: 1_900_000_000,
      email: "e2e@example.com",
      org_id: "org-1",
      org_slug: "agentflow",
      org_role: OrgRole.Owner,
      org_logo: null,
    });

    expect(decodeSessionClaims(token)).toEqual({
      sub: "user-1",
      exp: 1_900_000_000,
      email: "e2e@example.com",
      org_id: "org-1",
      org_slug: "agentflow",
      org_role: OrgRole.Owner,
    });
  });

  it("rejects values that are not JWTs", () => {
    expect(() => decodeSessionClaims("not-a-token")).toThrow(RE_NOT_A_JWT);
  });

  it("rejects payloads without a subject", () => {
    expect(() => decodeSessionClaims(makeToken({ exp: 1 }))).toThrow();
  });
});

describe("requireOrgClaims", () => {
  it("returns the organization claims", () => {
    const token = makeToken({
      sub: "user-1",
      exp: 1_900_000_000,
      org_id: "org-1",
      org_slug: "agentflow",
      org_role: OrgRole.Member,
    });

    expect(requireOrgClaims(token)).toEqual({
      userId: "user-1",
      orgId: "org-1",
      orgSlug: "agentflow",
      orgRole: OrgRole.Member,
    });
  });

  it("explains how to fix a user without an organization", () => {
    const token = makeToken({ sub: "user-1", exp: 1_900_000_000 });

    expect(() => requireOrgClaims(token)).toThrow(RE_AUTO_JOIN_HINT);
  });
});

describe("isOrgAdminRole", () => {
  it("accepts owners and admins only", () => {
    expect(isOrgAdminRole(OrgRole.Owner)).toBe(true);
    expect(isOrgAdminRole(OrgRole.Admin)).toBe(true);
    expect(isOrgAdminRole(OrgRole.Member)).toBe(false);
    expect(isOrgAdminRole(null)).toBe(false);
  });
});

function makeToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.signature`;
}
