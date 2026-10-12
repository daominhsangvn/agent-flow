import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  LOCAL_TRUSTED_USER_ID,
} from "../auth-mode";

// FEA-4334: prove the @repo/auth/server wrappers route BOTH ways — the default
// session mode resolves the caller from the request (bearer JWT or session
// cookie), and the guarded local_trusted mode returns the synthetic identity
// WITHOUT touching the request. The session resolver and Next's request APIs
// are mocked so the test stays offline.

const { resolveSessionClaimsMock, headersMock } = vi.hoisted(() => ({
  resolveSessionClaimsMock: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("../session-token", () => ({
  resolveSessionClaims: resolveSessionClaimsMock,
  verifySessionToken: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: headersMock }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => url,
}));

const MUTATED_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const REFUSED_PATTERN = /refused/;

const original = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("@repo/auth/server auth-mode wrappers", () => {
  beforeEach(() => {
    for (const key of MUTATED_KEYS) {
      original.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
    resolveSessionClaimsMock.mockReset();
    headersMock.mockReset();
    headersMock.mockResolvedValue(
      new Headers({ authorization: "Bearer session-jwt", cookie: "a=b" })
    );
  });

  afterEach(() => {
    for (const [key, value] of original) {
      setEnv(key, value);
    }
    original.clear();
  });

  it("resolves the caller from the request in the default session mode", async () => {
    resolveSessionClaimsMock.mockResolvedValue({
      token: "session-jwt",
      claims: {
        sub: "user_real",
        email: "real@example.test",
        name: "Real Person",
        org_id: "org_real",
        org_slug: "acme",
        org_role: "org:admin",
      },
    });
    const { auth, currentUser } = await import("../server");

    const authResult = await auth();
    const user = await currentUser();

    expect(resolveSessionClaimsMock).toHaveBeenCalledWith({
      authorization: "Bearer session-jwt",
      cookie: "a=b",
    });
    expect(authResult.userId).toBe("user_real");
    expect(authResult.orgId).toBe("org_real");
    expect(authResult.orgSlug).toBe("acme");
    expect(authResult.has({ role: "org:admin" })).toBe(true);
    await expect(authResult.getToken()).resolves.toBe("session-jwt");
    expect(user?.id).toBe("user_real");
    expect(user?.primaryEmailAddress?.emailAddress).toBe("real@example.test");
  });

  it("reports a signed-out caller when the request carries no session", async () => {
    resolveSessionClaimsMock.mockResolvedValue(null);
    const { auth, currentUser } = await import("../server");

    const authResult = await auth();

    expect(authResult.isAuthenticated).toBe(false);
    expect(authResult.userId).toBeNull();
    await expect(authResult.getToken()).resolves.toBeNull();
    await expect(currentUser()).resolves.toBeNull();
  });

  it("returns the synthetic identity WITHOUT reading the request in guarded local_trusted mode", async () => {
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    const { auth, currentUser } = await import("../server");

    const authResult = await auth();
    const user = await currentUser();

    expect(resolveSessionClaimsMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
    expect(authResult.userId).toBe(LOCAL_TRUSTED_USER_ID);
    expect(user?.id).toBe(LOCAL_TRUSTED_USER_ID);
  });

  it("refuses (never grants) when local_trusted is set in production", async () => {
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "production");

    const { auth, currentUser } = await import("../server");

    await expect(auth()).rejects.toThrow(REFUSED_PATTERN);
    await expect(currentUser()).rejects.toThrow(REFUSED_PATTERN);
    expect(resolveSessionClaimsMock).not.toHaveBeenCalled();
  });
});
