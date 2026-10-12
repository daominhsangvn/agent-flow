import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ISSUER = "http://app.example.test";
const API_URL = "http://api.example.test";

let privateKey: KeyLike;
let publicJwk: Record<string, unknown>;

async function signToken(
  claims: Record<string, unknown>,
  options: { issuer?: string; expiresIn?: string } = {}
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setSubject("user-1")
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "15m")
    .sign(privateKey);
}

const fetchMock = vi.fn();

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "EdDSA",
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_API_URL", API_URL);
  vi.stubEnv("BETTER_AUTH_URL", ISSUER);
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL) => {
    const url = input.toString();
    if (url === `${API_URL}/api/auth/jwks`) {
      return Promise.resolve(Response.json({ keys: [publicJwk] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("verifySessionToken", () => {
  it("accepts a token signed by the API key set", async () => {
    const { verifySessionToken } = await import("../session-token");
    const token = await signToken({ org_id: "org-1", org_role: "org:admin" });

    const claims = await verifySessionToken(token);

    expect(claims).toMatchObject({
      sub: "user-1",
      org_id: "org-1",
      org_role: "org:admin",
    });
  });

  it("rejects a token from another issuer", async () => {
    const { verifySessionToken } = await import("../session-token");
    const token = await signToken({}, { issuer: "http://evil.example.test" });

    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { verifySessionToken } = await import("../session-token");
    const token = await signToken({}, { expiresIn: "-1m" });

    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("rejects non-session tokens without fetching the key set", async () => {
    const { verifySessionToken } = await import("../session-token");
    const hsToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("secret-secret-secret-secret-secret"));

    await expect(verifySessionToken(hsToken)).resolves.toBeNull();
    await expect(verifySessionToken("sk_live_abc")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveSessionClaims", () => {
  it("prefers a valid bearer token", async () => {
    const { resolveSessionClaims } = await import("../session-token");
    const token = await signToken({ org_slug: "acme" });

    const resolved = await resolveSessionClaims({
      authorization: `Bearer ${token}`,
      cookie: null,
    });

    expect(resolved?.token).toBe(token);
    expect(resolved?.claims.org_slug).toBe("acme");
  });

  it("exchanges the session cookie for a token at the API", async () => {
    const token = await signToken({});
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === `${API_URL}/api/auth/token`) {
        expect(new Headers(init?.headers).get("cookie")).toContain(
          "agentflow.session_token=abc"
        );
        return Promise.resolve(Response.json({ token }));
      }
      return Promise.resolve(Response.json({ keys: [publicJwk] }));
    });
    const { resolveSessionClaims } = await import("../session-token");

    const resolved = await resolveSessionClaims({
      authorization: null,
      cookie: "theme=dark; agentflow.session_token=abc",
    });

    expect(resolved?.token).toBe(token);
  });

  it("does not call the API when there is no session cookie", async () => {
    const { resolveSessionClaims } = await import("../session-token");

    await expect(
      resolveSessionClaims({ authorization: null, cookie: "theme=dark" })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
