import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboundRequest, ProviderHttpRequest } from "../../../types";
import {
  BOT_FRAMEWORK_ISSUER,
  BOT_FRAMEWORK_OPENID_URL,
  clearBotFrameworkKeyCache,
  TeamsAuthFailure,
  verifyTeamsRequest,
} from "../bot-auth";
import {
  BOT_APP_ID,
  BOT_TENANT_ID,
  jsonResponse,
  routedHttp,
} from "./teams.test-helpers";

const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const NOW = new Date("2026-10-04T12:00:00.000Z");

let privateKey: KeyLike;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1" };
});

beforeEach(() => {
  clearBotFrameworkKeyCache();
});

function keysHttp(
  keys: unknown[] = [{ ...publicJwk, endorsements: ["msteams"] }]
) {
  return routedHttp((request: ProviderHttpRequest) => {
    if (request.url === BOT_FRAMEWORK_OPENID_URL) {
      return jsonResponse({ jwks_uri: JWKS_URL });
    }
    if (request.url === JWKS_URL) {
      return jsonResponse({ keys });
    }
    return undefined;
  });
}

function sign(claims: Record<string, unknown> = {}, kid = "key-1") {
  return new SignJWT({
    iss: BOT_FRAMEWORK_ISSUER,
    aud: BOT_APP_ID,
    serviceurl: SERVICE_URL,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 60)
    .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 3600)
    .sign(privateKey);
}

function request(token: string | null, body: Record<string, unknown> = {}) {
  const headers = new Headers();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return {
    rawBody: JSON.stringify({
      type: "message",
      channelId: "msteams",
      serviceUrl: SERVICE_URL,
      ...body,
    }),
    headers,
    url: new URL("https://api.example.com/webhooks/integrations/key"),
  } satisfies InboundRequest;
}

function context(http = keysHttp().http, appId: string | null = BOT_APP_ID) {
  return {
    connection: {
      id: "connection-1",
      provider: IntegrationProviderKey.MicrosoftTeams,
      name: "Teams",
      config: { appId: appId ?? undefined, tenantId: BOT_TENANT_ID },
      account: null,
    },
    inboundSecret: "unused",
    http,
    now: () => NOW,
  };
}

describe("verifyTeamsRequest", () => {
  it("accepts a token the Bot Framework signed for the bot", async () => {
    expect(await verifyTeamsRequest(request(await sign()), context())).toEqual({
      ok: true,
    });
  });

  it("caches the signing keys", async () => {
    const { http, requests } = keysHttp();
    await verifyTeamsRequest(request(await sign()), context(http));
    await verifyTeamsRequest(request(await sign()), context(http));

    expect(requests).toHaveLength(2);
  });

  it.each([
    ["no token", null, {}, TeamsAuthFailure.MissingToken],
    [
      "another audience",
      "aud",
      { aud: "00000000-0000-4000-8000-000000000000" },
      TeamsAuthFailure.InvalidToken,
    ],
    [
      "another issuer",
      "iss",
      { iss: "https://evil.example" },
      TeamsAuthFailure.InvalidToken,
    ],
    [
      "a service URL other than the activity's",
      "serviceurl",
      { serviceurl: "https://evil.example/" },
      TeamsAuthFailure.ServiceUrlMismatch,
    ],
  ])("refuses %s", async (_name, mode, claims, reason) => {
    const token = mode === null ? null : await sign(claims);

    expect(await verifyTeamsRequest(request(token), context())).toEqual({
      ok: false,
      reason,
    });
  });

  it("refuses a token signed by a key the Bot Framework does not publish", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({ serviceurl: SERVICE_URL })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(BOT_FRAMEWORK_ISSUER)
      .setAudience(BOT_APP_ID)
      .setExpirationTime("1h")
      .sign(other.privateKey);

    expect(await verifyTeamsRequest(request(token), context())).toEqual({
      ok: false,
      reason: TeamsAuthFailure.InvalidToken,
    });
    expect(
      await verifyTeamsRequest(request(await sign({}, "key-2")), context())
    ).toEqual({ ok: false, reason: TeamsAuthFailure.UnknownSigningKey });
  });

  it("refuses a key not endorsed for the activity's channel", async () => {
    const http = keysHttp([{ ...publicJwk, endorsements: ["skype"] }]).http;

    expect(
      await verifyTeamsRequest(request(await sign()), context(http))
    ).toEqual({ ok: false, reason: TeamsAuthFailure.ChannelNotEndorsed });
  });

  it("refuses everything while the bot is not configured", async () => {
    expect(
      await verifyTeamsRequest(request(await sign()), context(undefined, null))
    ).toEqual({ ok: false, reason: TeamsAuthFailure.BotNotConfigured });
  });

  it("only takes signing keys from the Bot Framework's host", async () => {
    const http = routedHttp((candidate) =>
      candidate.url === BOT_FRAMEWORK_OPENID_URL
        ? jsonResponse({ jwks_uri: "https://evil.example/keys" })
        : undefined
    );

    expect(
      await verifyTeamsRequest(request(await sign()), context(http.http))
    ).toEqual({ ok: false, reason: TeamsAuthFailure.SigningKeysUnavailable });
    expect(http.requests.map((entry) => entry.url)).toEqual([
      BOT_FRAMEWORK_OPENID_URL,
    ]);
  });
});
