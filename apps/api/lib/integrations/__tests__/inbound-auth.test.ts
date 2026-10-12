import { createHmac } from "node:crypto";
import { Webhook } from "svix";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  generateInboundSecret,
  generateStandardWebhookSecret,
  INBOUND_TOKEN_HEADER,
  INBOUND_TOKEN_HEADER_DISPLAY,
  STANDARD_WEBHOOK_TOLERANCE_SECONDS,
  signStandardWebhook,
  verifyHubSignature,
  verifyStandardWebhook,
  verifyStaticToken,
} from "@/lib/integrations/inbound-auth";

// Test vector from Atlassian's webhook documentation ("Secure admin webhooks").
const JIRA_SECRET = "It's a Secret to Everybody";
const JIRA_BODY = "Hello World!";
const JIRA_SIGNATURE =
  "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";

const STATIC_SECRET = "static-inbound-secret-value";
const MESSAGE_ID = "msg_2Lf5wTkH2vM9nW3k";
const NOW_SECONDS = 1_790_000_000;
const BODY = JSON.stringify({ id: "evt-1", title: "Add CSV export" });
const BASE64URL_32_BYTES_RE = /^[A-Za-z0-9_-]{43}$/;
const V1_SIGNATURE_RE = /^v1,[A-Za-z0-9+/]+=*$/;

describe("generateInboundSecret", () => {
  it("returns 32 random bytes as base64url", () => {
    const first = generateInboundSecret();
    const second = generateInboundSecret();

    expect(first).toMatch(BASE64URL_32_BYTES_RE);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(first).not.toBe(second);
  });
});

describe("generateStandardWebhookSecret", () => {
  it("returns a whsec_-prefixed base64 key of 32 bytes", () => {
    const secret = generateStandardWebhookSecret();

    expect(secret.startsWith("whsec_")).toBe(true);
    expect(Buffer.from(secret.slice("whsec_".length), "base64")).toHaveLength(
      32
    );
    expect(secret).not.toBe(generateStandardWebhookSecret());
  });
});

describe("constantTimeEqual", () => {
  it("compares strings of equal and different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("é", "e")).toBe(false);
  });
});

describe("verifyHubSignature", () => {
  it("accepts the Atlassian test vector", () => {
    expect(verifyHubSignature(JIRA_BODY, JIRA_SIGNATURE, JIRA_SECRET)).toEqual({
      ok: true,
    });
  });

  it("accepts upper-case method and digest and surrounding whitespace", () => {
    expect(
      verifyHubSignature(
        JIRA_BODY,
        ` ${JIRA_SIGNATURE.toUpperCase()} `,
        JIRA_SECRET
      )
    ).toEqual({ ok: true });
  });

  it("accepts sha512 signatures", () => {
    const digest = createHmac("sha512", JIRA_SECRET)
      .update(JIRA_BODY, "utf8")
      .digest("hex");

    expect(
      verifyHubSignature(JIRA_BODY, `sha512=${digest}`, JIRA_SECRET)
    ).toEqual({ ok: true });
  });

  it("signs the raw UTF-8 body", () => {
    const body = '{"summary":"Übersicht ✓"}';
    const digest = createHmac("sha256", JIRA_SECRET)
      .update(Buffer.from(body, "utf8"))
      .digest("hex");

    expect(verifyHubSignature(body, `sha256=${digest}`, JIRA_SECRET)).toEqual({
      ok: true,
    });
  });

  it.each([
    [null, "missing_signature"],
    ["", "missing_signature"],
    [
      "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
      "malformed_signature",
    ],
    ["=a4771c39", "malformed_signature"],
    [
      "sha1=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
      "unsupported_signature_method",
    ],
    [
      "sha256=b4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
      "signature_mismatch",
    ],
    ["sha256=a477", "signature_mismatch"],
  ])("rejects %j with %s", (header, reason) => {
    expect(verifyHubSignature(JIRA_BODY, header, JIRA_SECRET)).toEqual({
      ok: false,
      reason,
    });
  });

  it("rejects a tampered body and a wrong secret", () => {
    expect(
      verifyHubSignature(`${JIRA_BODY} `, JIRA_SIGNATURE, JIRA_SECRET)
    ).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyHubSignature(JIRA_BODY, JIRA_SIGNATURE, "other")).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });
});

describe("verifyStaticToken", () => {
  it("accepts the secret in the X-AgentFlow-Token header", () => {
    const headers = new Headers({
      [INBOUND_TOKEN_HEADER]: ` ${STATIC_SECRET} `,
    });

    expect(verifyStaticToken(headers, STATIC_SECRET)).toEqual({ ok: true });
  });

  it("accepts the secret as the Basic auth password, whatever the user name", () => {
    const encoded = Buffer.from(`azure-devops:${STATIC_SECRET}`).toString(
      "base64"
    );
    const headers = new Headers({ authorization: `Basic ${encoded}` });

    expect(verifyStaticToken(headers, STATIC_SECRET)).toEqual({ ok: true });
  });

  it("keeps colons that belong to the Basic password", () => {
    const secret = "pa:ss:word";
    const encoded = Buffer.from(`user:${secret}`).toString("base64");
    const headers = new Headers({ authorization: `basic ${encoded}` });

    expect(verifyStaticToken(headers, secret)).toEqual({ ok: true });
  });

  it("prefers the header over Basic auth", () => {
    const encoded = Buffer.from(`user:${STATIC_SECRET}`).toString("base64");
    const headers = new Headers({
      [INBOUND_TOKEN_HEADER]: "wrong",
      authorization: `Basic ${encoded}`,
    });

    expect(verifyStaticToken(headers, STATIC_SECRET)).toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });

  it("rejects wrong tokens and never reads a Bearer token", () => {
    const wrongBasic = Buffer.from("user:wrong").toString("base64");

    expect(
      verifyStaticToken(
        new Headers({ authorization: `Basic ${wrongBasic}` }),
        STATIC_SECRET
      )
    ).toEqual({ ok: false, reason: "token_mismatch" });
    expect(
      verifyStaticToken(
        new Headers({ authorization: `Bearer ${STATIC_SECRET}` }),
        STATIC_SECRET
      )
    ).toEqual({ ok: false, reason: "missing_token" });
    expect(verifyStaticToken(new Headers(), STATIC_SECRET)).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });
});

describe("Standard Webhooks", () => {
  const secret = generateStandardWebhookSecret();

  function signedHeaders(
    timestampSeconds: number,
    signature: string,
    prefix = "webhook"
  ): Headers {
    return new Headers({
      [`${prefix}-id`]: MESSAGE_ID,
      [`${prefix}-timestamp`]: String(timestampSeconds),
      [`${prefix}-signature`]: signature,
    });
  }

  it("round-trips signStandardWebhook through verifyStandardWebhook", () => {
    const signature = signStandardWebhook(
      MESSAGE_ID,
      NOW_SECONDS,
      BODY,
      secret
    );

    expect(signature).toMatch(V1_SIGNATURE_RE);
    expect(
      verifyStandardWebhook(
        BODY,
        signedHeaders(NOW_SECONDS, signature),
        secret,
        NOW_SECONDS
      )
    ).toEqual({ ok: true });
  });

  it("matches the svix reference implementation", () => {
    const reference = new Webhook(secret).sign(
      MESSAGE_ID,
      new Date(NOW_SECONDS * 1000),
      BODY
    );

    expect(signStandardWebhook(MESSAGE_ID, NOW_SECONDS, BODY, secret)).toBe(
      reference
    );
  });

  it("accepts svix-* headers and any matching signature in a rotated list", () => {
    const valid = signStandardWebhook(MESSAGE_ID, NOW_SECONDS, BODY, secret);
    const stale = signStandardWebhook(
      MESSAGE_ID,
      NOW_SECONDS,
      BODY,
      generateStandardWebhookSecret()
    );

    expect(
      verifyStandardWebhook(
        BODY,
        signedHeaders(NOW_SECONDS, `${stale} ${valid}`, "svix"),
        secret,
        NOW_SECONDS
      )
    ).toEqual({ ok: true });
  });

  it("accepts timestamps at the edge of the tolerance and rejects beyond it", () => {
    const sentAt = NOW_SECONDS - STANDARD_WEBHOOK_TOLERANCE_SECONDS;
    const signature = signStandardWebhook(MESSAGE_ID, sentAt, BODY, secret);
    const headers = signedHeaders(sentAt, signature);

    expect(verifyStandardWebhook(BODY, headers, secret, NOW_SECONDS)).toEqual({
      ok: true,
    });
    expect(
      verifyStandardWebhook(BODY, headers, secret, NOW_SECONDS + 1)
    ).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(
      verifyStandardWebhook(
        BODY,
        headers,
        secret,
        sentAt - STANDARD_WEBHOOK_TOLERANCE_SECONDS - 1
      )
    ).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a non-numeric timestamp", () => {
    const headers = new Headers({
      "webhook-id": MESSAGE_ID,
      "webhook-timestamp": "yesterday",
      "webhook-signature": "v1,abc",
    });

    expect(verifyStandardWebhook(BODY, headers, secret, NOW_SECONDS)).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("rejects missing headers, tampered bodies, wrong secrets and other versions", () => {
    const signature = signStandardWebhook(
      MESSAGE_ID,
      NOW_SECONDS,
      BODY,
      secret
    );
    const headers = signedHeaders(NOW_SECONDS, signature);

    expect(
      verifyStandardWebhook(BODY, new Headers(), secret, NOW_SECONDS)
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      verifyStandardWebhook(`${BODY} `, headers, secret, NOW_SECONDS)
    ).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(
      verifyStandardWebhook(
        BODY,
        headers,
        generateStandardWebhookSecret(),
        NOW_SECONDS
      )
    ).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(
      verifyStandardWebhook(
        BODY,
        signedHeaders(NOW_SECONDS, signature.replace("v1,", "v1a,")),
        secret,
        NOW_SECONDS
      )
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("INBOUND_TOKEN_HEADER_DISPLAY", () => {
  it("is the token header as instructions show it", () => {
    expect(INBOUND_TOKEN_HEADER_DISPLAY.toLowerCase()).toBe(
      INBOUND_TOKEN_HEADER
    );
  });
});
