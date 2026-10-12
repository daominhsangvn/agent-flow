import { describe, expect, it } from "vitest";
import { verifyStandardWebhook } from "../../../apps/api/lib/integrations/inbound-auth";
import {
  buildStandardWebhookHeaders,
  StandardWebhookHeader,
  signStandardWebhookMessage,
} from "../standard-webhooks";

// Reference vector from the Standard Webhooks / svix test suites.
const VECTOR = {
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestampSeconds: 1_614_265_330,
  rawBody: '{"test": 2432232314}',
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
} as const;

describe("signStandardWebhookMessage", () => {
  it("matches the reference signature", () => {
    expect(signStandardWebhookMessage(VECTOR)).toBe(VECTOR.signature);
  });

  it("accepts the secret without its whsec_ prefix", () => {
    expect(
      signStandardWebhookMessage({
        ...VECTOR,
        secret: VECTOR.secret.slice("whsec_".length),
      })
    ).toBe(VECTOR.signature);
  });

  it("changes when the body changes", () => {
    expect(
      signStandardWebhookMessage({ ...VECTOR, rawBody: '{"test": 1}' })
    ).not.toBe(VECTOR.signature);
  });
});

describe("buildStandardWebhookHeaders", () => {
  it("builds the id, timestamp, signature and content-type headers", () => {
    const headers = buildStandardWebhookHeaders(VECTOR);

    expect(headers).toEqual({
      "content-type": "application/json",
      [StandardWebhookHeader.Id]: VECTOR.id,
      [StandardWebhookHeader.Timestamp]: String(VECTOR.timestampSeconds),
      [StandardWebhookHeader.Signature]: VECTOR.signature,
    });
  });

  it("defaults the timestamp to now", () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = buildStandardWebhookHeaders({
      id: VECTOR.id,
      rawBody: VECTOR.rawBody,
      secret: VECTOR.secret,
    });
    const after = Math.floor(Date.now() / 1000);

    const timestamp = Number(headers[StandardWebhookHeader.Timestamp]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it("produces headers the API's inbound verifier accepts", () => {
    const rawBody = JSON.stringify({ id: "evt-1", title: "Add CSV export" });
    const headers = buildStandardWebhookHeaders({
      id: "msg_e2e",
      rawBody,
      secret: VECTOR.secret,
    });

    expect(
      verifyStandardWebhook(rawBody, new Headers(headers), VECTOR.secret)
    ).toEqual({ ok: true });
    expect(
      verifyStandardWebhook(`${rawBody} `, new Headers(headers), VECTOR.secret)
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});
