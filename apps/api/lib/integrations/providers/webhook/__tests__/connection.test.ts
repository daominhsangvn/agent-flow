import { describe, expect, it } from "vitest";
import { z } from "zod";
import { verifyStandardWebhook } from "../../../inbound-auth";
import { ValidateConnectionReason } from "../../../types";
import { ALLOWED_CALLBACK_HOSTS_MAX } from "../callback-hosts";
import {
  validateWebhookConnection,
  WEBHOOK_PING_EVENT_TYPE,
  webhookConnectionConfigSchema,
  webhookConnectionSecretsSchema,
} from "../connection";
import { SIGNING_SECRET_ERROR } from "../signing-secret";
import {
  fakeHttp,
  httpResponse,
  makeWebhookContext,
  NOW,
  NOW_SECONDS,
  SIGNING_SECRET,
} from "./webhook.test-helpers";

const CALLBACK_URL = "https://example.com/hooks/agentflow";

const pingSchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  connection: z.object({ id: z.string(), name: z.string() }),
});

describe("webhookConnectionConfigSchema", () => {
  it("has no allowed callback hosts by default and never keeps a callback URL in config", () => {
    expect(webhookConnectionConfigSchema.parse({})).toEqual({
      allowedCallbackHosts: [],
    });
    expect(
      webhookConnectionConfigSchema.parse({
        allowedCallbackHosts: null,
        callbackUrl: CALLBACK_URL,
      })
    ).toEqual({ allowedCallbackHosts: [] });
  });

  it("normalizes allowed callback hosts", () => {
    expect(
      webhookConnectionConfigSchema.parse({
        allowedCallbackHosts: [
          " Hooks.Example.com ",
          "hooks.example.com.",
          "",
          "10.0.0.5",
          "[FD00::1]",
          "fd00:0::1",
          "bücher.example",
        ],
      })
    ).toEqual({
      allowedCallbackHosts: [
        "hooks.example.com",
        "10.0.0.5",
        "fd00::1",
        "xn--bcher-kva.example",
      ],
    });
  });

  it.each([
    "https://hooks.example.com",
    "hooks.example.com:8443",
    "hooks.example.com/path",
    "user@hooks.example.com",
    "two words",
    "fe80::1%eth0",
    "[hooks.example.com]",
  ])("rejects the allowed callback host %s", (host) => {
    const result = webhookConnectionConfigSchema.safeParse({
      allowedCallbackHosts: ["ok.example.com", host],
    });

    expect(
      result.error?.issues.map((issue) => [issue.path, issue.message])
    ).toEqual([
      [
        ["allowedCallbackHosts", 1],
        `"${host}": enter a host name only, e.g. hooks.example.com (no scheme, port or path)`,
      ],
    ]);
  });

  it("limits the number of allowed callback hosts", () => {
    const hosts = Array.from(
      { length: ALLOWED_CALLBACK_HOSTS_MAX + 1 },
      (_value, index) => `h${index}.example.com`
    );

    expect(
      webhookConnectionConfigSchema.safeParse({ allowedCallbackHosts: hosts })
        .success
    ).toBe(false);
  });
});

describe("webhookConnectionSecretsSchema", () => {
  it("accepts and trims an http(s) default callback URL, including private hosts", () => {
    expect(
      webhookConnectionSecretsSchema.parse({ callbackUrl: ` ${CALLBACK_URL} ` })
    ).toEqual({ callbackUrl: CALLBACK_URL });
    expect(
      webhookConnectionSecretsSchema.parse({
        callbackUrl: "http://192.168.1.10:8080/x",
      })
    ).toEqual({ callbackUrl: "http://192.168.1.10:8080/x" });
  });

  it("treats a blank or null default callback URL as not set", () => {
    expect(webhookConnectionSecretsSchema.parse({ callbackUrl: "" })).toEqual(
      {}
    );
    expect(webhookConnectionSecretsSchema.parse({ callbackUrl: null })).toEqual(
      {}
    );
  });

  it.each([
    "ftp://example.com/x",
    "file:///etc/passwd",
    "example.com/x",
  ])("rejects the default callback URL %s", (callbackUrl) => {
    expect(
      webhookConnectionSecretsSchema.safeParse({ callbackUrl }).success
    ).toBe(false);
  });

  it.each([
    ["a whsec_ secret", SIGNING_SECRET],
    ["a bare base64 secret", SIGNING_SECRET.slice("whsec_".length)],
    ["an empty value", ""],
    ["null", null],
  ])("accepts %s", (_label, signingSecret) => {
    expect(
      webhookConnectionSecretsSchema.safeParse({ signingSecret }).success
    ).toBe(true);
  });

  it("accepts a missing secret", () => {
    expect(webhookConnectionSecretsSchema.parse({})).toEqual({});
  });

  it.each([
    ["not base64", "my secret!"],
    ["too short", `whsec_${Buffer.alloc(8, 1).toString("base64")}`],
  ])("rejects a secret that is %s", (_label, signingSecret) => {
    const result = webhookConnectionSecretsSchema.safeParse({ signingSecret });

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      SIGNING_SECRET_ERROR,
    ]);
  });
});

describe("validateWebhookConnection", () => {
  it("does not call out on save", async () => {
    const { http, requests } = fakeHttp();
    const context = makeWebhookContext({
      http,
      secrets: { callbackUrl: CALLBACK_URL },
    });

    expect(
      await validateWebhookConnection(context, ValidateConnectionReason.Save)
    ).toEqual({
      ok: true,
      account: null,
    });
    expect(requests).toEqual([]);
  });

  it("has nothing to test without a callback URL", async () => {
    const { http, requests } = fakeHttp();

    const result = await validateWebhookConnection(
      makeWebhookContext({ http }),
      ValidateConnectionReason.Test
    );

    expect(result).toEqual({ ok: true, account: null });
    expect(requests).toEqual([]);
  });

  it("sends a signed ping to the callback URL on test", async () => {
    const { http, requests } = fakeHttp(httpResponse({ status: 204 }));
    const context = makeWebhookContext({
      http,
      secrets: { callbackUrl: CALLBACK_URL, signingSecret: SIGNING_SECRET },
    });

    const result = await validateWebhookConnection(
      context,
      ValidateConnectionReason.Test
    );

    expect(result).toEqual({ ok: true, account: null });
    const request = requests[0];
    expect(request?.url).toBe(CALLBACK_URL);
    expect(request?.followRedirects).toBe(false);
    const rawBody = String(request?.body);
    expect(pingSchema.parse(JSON.parse(rawBody))).toEqual({
      type: WEBHOOK_PING_EVENT_TYPE,
      timestamp: NOW.toISOString(),
      connection: { id: context.connection.id, name: context.connection.name },
    });
    expect(
      verifyStandardWebhook(
        rawBody,
        new Headers(request?.headers),
        SIGNING_SECRET,
        NOW_SECONDS
      )
    ).toEqual({ ok: true });
  });

  it("reports a failing callback URL", async () => {
    const { http } = fakeHttp(httpResponse({ status: 500 }));
    const context = makeWebhookContext({
      http,
      secrets: { callbackUrl: CALLBACK_URL },
    });

    expect(
      await validateWebhookConnection(context, ValidateConnectionReason.Test)
    ).toEqual({
      ok: false,
      error: "The callback URL answered HTTP 500.",
    });
  });
});
