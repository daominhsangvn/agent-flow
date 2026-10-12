import { getApiBaseUrl } from "./helpers/api-url";
import { authUrl, decodeSessionClaims, OrgRole } from "./helpers/better-auth";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const ORG_ROLES: readonly string[] = Object.values(OrgRole);
const SECONDS_PER_MINUTE = 60;
const MAX_TOKEN_LIFETIME_SECONDS = 15 * SECONDS_PER_MINUTE;
const CLOCK_SKEW_SECONDS = 60;

test.describe("session token", { tag: E2ETag.Smoke }, () => {
  test("the session JWT carries the user and organization claims", ({
    apiToken,
  }) => {
    const claims = decodeSessionClaims(apiToken);
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(claims.sub).toBeTruthy();
    expect(claims.org_id).toBeTruthy();
    expect(claims.org_slug).toBeTruthy();
    expect(ORG_ROLES).toContain(claims.org_role);
    expect(claims.exp).toBeGreaterThan(nowSeconds);
    expect(claims.exp).toBeLessThanOrEqual(
      nowSeconds + MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS
    );
  });

  test("the API accepts the bearer token and rejects requests without it", async ({
    apiToken,
    playwright,
    request,
  }) => {
    const meUrl = `${getApiBaseUrl()}/me`;

    const authorized = await request.get(meUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    expect(authorized.status()).toBe(200);
    expect(await authorized.json()).toMatchObject({ success: true });

    // The request fixture (and any context created in a test) carries the
    // project storageState session cookie, which the API also accepts
    // (localhost cookies are not port-scoped), so clear it explicitly.
    const anonymousContext = await playwright.request.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const anonymous = await anonymousContext.get(meUrl);
      expect(anonymous.status()).toBe(401);
    } finally {
      await anonymousContext.dispose();
    }
  });

  test("the JWKS used to verify session tokens is published", async ({
    request,
  }) => {
    const response = await request.get(authUrl("/jwks"));

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      keys: expect.arrayContaining([expect.anything()]),
    });
  });
});
