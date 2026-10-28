import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JWK,
  jwtVerify,
} from "jose";
import { z } from "zod";
import {
  HttpMethod,
  type InboundRequest,
  type InboundVerification,
  type InboundVerifyContext,
  type ProviderHttp,
} from "../../types";
import type { TeamsConnectionConfig } from "./connection";

/**
 * Authenticates requests the Bot Framework sends to the bot's messaging
 * endpoint (our inbound URL): an RS256 JWT in `Authorization: Bearer`, issued
 * by https://api.botframework.com for the bot's App ID, signed by a key the
 * Bot Framework publishes for the activity's channel ("msteams"), whose
 * `serviceurl` claim is the activity's serviceUrl. See "Authenticate requests
 * from the Bot Connector service" in the Bot Framework docs.
 *
 * The signing keys are fetched through the OpenID metadata and kept for a
 * day; an unknown key id refetches them (at most every few minutes).
 */

export const BOT_FRAMEWORK_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

export const TeamsAuthFailure = {
  BotNotConfigured: "bot_not_configured",
  MissingToken: "missing_token",
  InvalidActivity: "invalid_activity",
  SigningKeysUnavailable: "signing_keys_unavailable",
  UnknownSigningKey: "unknown_signing_key",
  ChannelNotEndorsed: "channel_not_endorsed",
  InvalidToken: "invalid_token",
  ServiceUrlMismatch: "service_url_mismatch",
} as const;
export type TeamsAuthFailure =
  (typeof TeamsAuthFailure)[keyof typeof TeamsAuthFailure];

const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const KEYS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 5 * 60;
const KEYS_TIMEOUT_MS = 10_000;
const BEARER_RE = /^Bearer\s+(\S+)$/i;
const TRAILING_SLASHES_RE = /\/+$/;
const SIGNING_ALGORITHMS = ["RS256"];
const BOT_FRAMEWORK_KEYS_HOST = "login.botframework.com";

const openIdConfigurationSchema = z.object({ jwks_uri: z.url() });

const signingKeySchema = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
  use: z.string().optional(),
  x5c: z.array(z.string()).optional(),
  endorsements: z.array(z.string()).optional(),
});
type SigningKey = z.infer<typeof signingKeySchema>;

const signingKeySetSchema = z.object({ keys: z.array(z.unknown()) });

/** The activity fields authentication depends on. */
const authActivitySchema = z.looseObject({
  channelId: z.string().min(1),
  serviceUrl: z.string().min(1),
});

const serviceUrlClaimSchema = z.object({ serviceurl: z.string().min(1) });

type KeyCache = { keys: SigningKey[]; fetchedAt: number };
let keyCache: KeyCache | null = null;

export async function verifyTeamsRequest(
  request: InboundRequest,
  context: InboundVerifyContext<TeamsConnectionConfig>
): Promise<InboundVerification> {
  const appId = context.connection.config.appId;
  if (!appId) {
    return fail(TeamsAuthFailure.BotNotConfigured);
  }
  const token = BEARER_RE.exec(
    request.headers.get("authorization")?.trim() ?? ""
  )?.[1];
  if (!token) {
    return fail(TeamsAuthFailure.MissingToken);
  }
  const activity = parseActivity(request.rawBody);
  if (!activity) {
    return fail(TeamsAuthFailure.InvalidActivity);
  }
  const kid = readKeyId(token);
  if (!kid) {
    return fail(TeamsAuthFailure.InvalidToken);
  }
  const now = context.now();
  const key = await findSigningKey(context.http, kid, now);
  if (key === null) {
    return fail(TeamsAuthFailure.SigningKeysUnavailable);
  }
  if (key === undefined) {
    return fail(TeamsAuthFailure.UnknownSigningKey);
  }
  if (key.endorsements && !key.endorsements.includes(activity.channelId)) {
    return fail(TeamsAuthFailure.ChannelNotEndorsed);
  }
  const claims = await verifyToken(token, key, appId, now);
  if (!claims) {
    return fail(TeamsAuthFailure.InvalidToken);
  }
  const serviceUrl = serviceUrlClaimSchema.safeParse(claims);
  if (
    !(
      serviceUrl.success &&
      sameServiceUrl(serviceUrl.data.serviceurl, activity.serviceUrl)
    )
  ) {
    return fail(TeamsAuthFailure.ServiceUrlMismatch);
  }
  return { ok: true };
}

/** Forgets the cached signing keys (tests). */
export function clearBotFrameworkKeyCache(): void {
  keyCache = null;
}

/**
 * The published key with this id: undefined when no published key has it,
 * null when the keys cannot be loaded.
 */
async function findSigningKey(
  http: ProviderHttp,
  kid: string,
  now: Date
): Promise<SigningKey | null | undefined> {
  const age = keyCache
    ? now.getTime() - keyCache.fetchedAt
    : Number.POSITIVE_INFINITY;
  const known = keyCache?.keys.find((key) => key.kid === kid);
  if (known && age < KEYS_TTL_MS) {
    return known;
  }
  if (keyCache && age < KEYS_REFRESH_MIN_INTERVAL_MS) {
    return undefined;
  }
  const keys = await fetchSigningKeys(http);
  if (!keys) {
    // Keys we already had stay usable while the Bot Framework cannot be reached.
    return known ?? (keyCache ? undefined : null);
  }
  keyCache = { keys, fetchedAt: now.getTime() };
  return keys.find((key) => key.kid === kid);
}

async function fetchSigningKeys(
  http: ProviderHttp
): Promise<SigningKey[] | null> {
  const metadata = await http.request({
    method: HttpMethod.Get,
    url: BOT_FRAMEWORK_OPENID_URL,
    timeoutMs: KEYS_TIMEOUT_MS,
  });
  const configuration = openIdConfigurationSchema.safeParse(metadata.json);
  if (!(metadata.ok && configuration.success)) {
    return null;
  }
  const jwksUri = new URL(configuration.data.jwks_uri);
  // The key set must come from the Bot Framework itself, over HTTPS.
  if (
    jwksUri.protocol !== "https:" ||
    jwksUri.hostname !== BOT_FRAMEWORK_KEYS_HOST
  ) {
    return null;
  }
  const response = await http.request({
    method: HttpMethod.Get,
    url: jwksUri.toString(),
    timeoutMs: KEYS_TIMEOUT_MS,
  });
  const keySet = signingKeySetSchema.safeParse(response.json);
  if (!(response.ok && keySet.success)) {
    return null;
  }
  return keySet.data.keys.flatMap((candidate) => {
    const key = signingKeySchema.safeParse(candidate);
    return key.success ? [key.data] : [];
  });
}

async function verifyToken(
  token: string,
  key: SigningKey,
  appId: string,
  now: Date
): Promise<Record<string, unknown> | null> {
  const jwk: JWK = { kty: key.kty, kid: key.kid, n: key.n, e: key.e };
  try {
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: [jwk] }),
      {
        issuer: BOT_FRAMEWORK_ISSUER,
        audience: appId,
        algorithms: SIGNING_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: now,
      }
    );
    return payload;
  } catch {
    return null;
  }
}

function readKeyId(token: string): string | null {
  try {
    return decodeProtectedHeader(token).kid ?? null;
  } catch {
    return null;
  }
}

function parseActivity(rawBody: string) {
  try {
    const parsed = authActivitySchema.safeParse(JSON.parse(rawBody));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function sameServiceUrl(claim: string, activity: string): boolean {
  return normalizeServiceUrl(claim) === normalizeServiceUrl(activity);
}

function normalizeServiceUrl(value: string): string {
  return value.trim().replace(TRAILING_SLASHES_RE, "").toLowerCase();
}

function fail(reason: TeamsAuthFailure): InboundVerification {
  return { ok: false, reason };
}
