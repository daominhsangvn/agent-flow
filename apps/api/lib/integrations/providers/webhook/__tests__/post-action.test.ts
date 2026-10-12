import type { JsonObject } from "@repo/api/src/types/common";
import {
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionRunStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { verifyStandardWebhook } from "../../../inbound-auth";
import {
  HttpMethod,
  type ProviderHttpRequest,
  type WorkflowRunSnapshot,
} from "../../../types";
import { webhookConnectionConfigSchema } from "../connection";
import { WEBHOOK_ATTEMPT_HEADER, WEBHOOK_USER_AGENT } from "../outbound";
import {
  NO_TARGET_URL_REASON,
  resolvePostTarget,
  WebhookActionType,
  type WebhookPostConfig,
  WebhookPostTarget,
  webhookPostAction,
  webhookPostConfigSchema,
} from "../post-action";
import {
  ACTION_RUN_ID,
  fakeHttp,
  httpResponse,
  makePreActionRunSnapshot,
  makeRunSnapshot,
  makeWebhookContext,
  NOW,
  NOW_SECONDS,
  SIGNING_SECRET,
} from "./webhook.test-helpers";

const SIGNATURE_V1_RE = /^v1,/;
const SOURCE_CALLBACK = "https://caller.example.com/callback";
const ACTION_URL = "https://hooks.example.com/action";
const CONNECTION_CALLBACK = "http://10.0.0.5:8080/agentflow";

const postedBodySchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  run: z.object({ id: z.string(), event: z.string() }).loose(),
});
const preActionBodySchema = z.object({
  type: z.string(),
  run: z
    .object({
      status: z.string(),
      event: z.string(),
      feature: z.null(),
      plan: z.null(),
      pullRequest: z.null(),
      step: z.null(),
      summaryMarkdown: z.string(),
    })
    .loose(),
});

function postContext(
  options: {
    config?: Partial<WebhookPostConfig>;
    allowedCallbackHosts?: string[];
    /** The connection's default callback URL (a secret); null for none. */
    connectionCallback?: string | null;
    signingSecret?: string;
    sourceCallback?: unknown;
    response?: ReturnType<typeof httpResponse>;
    run?: WorkflowRunSnapshot;
    attempt?: number;
  } = {}
) {
  const { http, requests } = fakeHttp(options.response ?? httpResponse());
  const run =
    options.run ??
    makeRunSnapshot({ sourceExtras: sourceExtras(options.sourceCallback) });
  const connectionCallback =
    options.connectionCallback === undefined
      ? CONNECTION_CALLBACK
      : options.connectionCallback;
  const context = {
    ...makeWebhookContext({
      http,
      config: webhookConnectionConfigSchema.parse({
        allowedCallbackHosts: options.allowedCallbackHosts,
      }),
      secrets: {
        ...(connectionCallback ? { callbackUrl: connectionCallback } : {}),
        ...(options.signingSecret === undefined
          ? {}
          : { signingSecret: options.signingSecret }),
      },
    }),
    config: webhookPostConfigSchema.parse(options.config ?? {}),
    run,
    actionRunId: ACTION_RUN_ID,
    attempt: options.attempt ?? 1,
    render: (template: string) => template,
  };
  return { context, requests };
}

function sourceExtras(sourceCallback: unknown): JsonObject {
  if (sourceCallback === undefined) {
    return {};
  }
  return { callbackUrl: z.string().nullable().parse(sourceCallback) };
}

function headersOf(request: ProviderHttpRequest | undefined): Headers {
  return new Headers(request?.headers);
}

describe("webhook.post definition", () => {
  it("subscribes to every post action event by default", () => {
    expect(webhookPostAction.key).toBe(WebhookActionType.Post);
    expect(webhookPostAction.defaultEvents).toEqual(
      WORKFLOW_POST_ACTION_EVENTS
    );
    expect(webhookPostAction.defaultEvents).not.toContain(
      WorkflowRunEvent.Triggered
    );
  });

  it("parses config with defaults and treats a blank URL as unset", () => {
    expect(webhookPostConfigSchema.parse({})).toEqual({
      useSourceCallback: true,
    });
    expect(webhookPostConfigSchema.parse({ url: "  " })).toEqual({
      useSourceCallback: true,
    });
    expect(
      webhookPostConfigSchema.safeParse({ url: "file:///etc/passwd" }).success
    ).toBe(false);
  });
});

describe("resolvePostTarget", () => {
  it("prefers the request's callbackUrl", () => {
    const { context } = postContext({
      sourceCallback: SOURCE_CALLBACK,
      config: { url: ACTION_URL },
    });

    expect(resolvePostTarget(context)).toEqual({
      resolved: {
        url: SOURCE_CALLBACK,
        target: WebhookPostTarget.SourceCallback,
      },
      sourceCallbackRefusal: null,
    });
  });

  it("uses the action URL when the source callback is not preferred", () => {
    const { context } = postContext({
      sourceCallback: SOURCE_CALLBACK,
      config: { url: ACTION_URL, useSourceCallback: false },
    });

    expect(resolvePostTarget(context)).toEqual({
      resolved: { url: ACTION_URL, target: WebhookPostTarget.ActionUrl },
      sourceCallbackRefusal: null,
    });
  });

  it("ignores a source callback that is not an http(s) URL", () => {
    const { context } = postContext({
      sourceCallback: "ftp://caller.example.com/x",
      config: { url: ACTION_URL },
    });

    expect(resolvePostTarget(context)).toEqual({
      resolved: { url: ACTION_URL, target: WebhookPostTarget.ActionUrl },
      sourceCallbackRefusal: null,
    });
  });

  it("falls back to the connection callback URL (a secret), even on a private host", () => {
    const { context } = postContext({ sourceCallback: null });

    expect(resolvePostTarget(context)).toEqual({
      resolved: {
        url: CONNECTION_CALLBACK,
        target: WebhookPostTarget.ConnectionCallback,
      },
      sourceCallbackRefusal: null,
    });
  });

  it("returns no target without any URL", () => {
    const { context } = postContext({ connectionCallback: null });

    expect(resolvePostTarget(context)).toEqual({
      resolved: null,
      sourceCallbackRefusal: null,
    });
  });

  it.each([
    ["cloud metadata (link-local)", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:3002/internal"],
    ["a *.localhost name", "http://api.localhost/hook"],
    ["a *.local name", "http://printer.local/hook"],
    [
      "a *.internal name",
      "http://metadata.google.internal/computeMetadata/v1/",
    ],
    ["a single-label name", "http://jenkins:8080/job"],
    ["IPv4 loopback", "http://127.0.0.1:8080/hook"],
    ["IPv4 loopback in hex notation", "http://0x7f.1/hook"],
    ["unspecified IPv4", "http://0.0.0.0/hook"],
    ["10/8", "http://10.0.0.5:8080/hook"],
    ["172.16/12", "http://172.31.255.1/hook"],
    ["192.168/16", "http://192.168.1.10/hook"],
    ["carrier-grade NAT (100.64/10)", "http://100.64.0.1/hook"],
    ["IPv6 loopback", "http://[::1]:3002/hook"],
    ["unspecified IPv6", "http://[::]/hook"],
    ["IPv6 link-local", "http://[fe80::1]/hook"],
    ["IPv6 unique-local", "http://[fd12:3456::1]/hook"],
    ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/hook"],
    ["IPv4-mapped IPv6 private", "http://[::ffff:10.0.0.5]/hook"],
  ])("refuses a request callbackUrl on %s and uses the admin's URL", (_label, url) => {
    const { context } = postContext({
      sourceCallback: url,
      config: { url: ACTION_URL },
    });

    const resolution = resolvePostTarget(context);

    expect(resolution.resolved).toEqual({
      url: ACTION_URL,
      target: WebhookPostTarget.ActionUrl,
    });
    expect(resolution.sourceCallbackRefusal).toContain(
      "is a local or private address"
    );
  });

  it.each([
    "https://caller.example.com/callback",
    "http://8.8.8.8/hook",
    "http://172.32.0.1/hook",
    "http://100.128.0.1/hook",
    "http://[2001:4860:4860::8888]/hook",
  ])("uses a request callbackUrl on a public host (%s) when no hosts are listed", (url) => {
    const { context } = postContext({
      sourceCallback: url,
      config: { url: ACTION_URL },
    });

    expect(resolvePostTarget(context).resolved).toEqual({
      url,
      target: WebhookPostTarget.SourceCallback,
    });
  });

  it("uses a request callbackUrl only on an allowed host (case-insensitive, exact)", () => {
    const allowed = postContext({
      allowedCallbackHosts: ["Caller.Example.com"],
      sourceCallback: "https://CALLER.example.COM./callback",
    });
    const subdomain = postContext({
      allowedCallbackHosts: ["caller.example.com"],
      sourceCallback: "https://evil.caller.example.com/callback",
      config: { url: ACTION_URL },
    });

    expect(resolvePostTarget(allowed.context).resolved?.target).toBe(
      WebhookPostTarget.SourceCallback
    );
    expect(resolvePostTarget(subdomain.context)).toEqual({
      resolved: { url: ACTION_URL, target: WebhookPostTarget.ActionUrl },
      sourceCallbackRefusal:
        "its host evil.caller.example.com is not in the connection's allowed callback hosts",
    });
  });

  it("lets an admin allow a private host explicitly", () => {
    const { context } = postContext({
      allowedCallbackHosts: ["10.0.0.5"],
      sourceCallback: "http://10.0.0.5:8080/hook",
      config: { url: ACTION_URL },
    });

    expect(resolvePostTarget(context).resolved).toEqual({
      url: "http://10.0.0.5:8080/hook",
      target: WebhookPostTarget.SourceCallback,
    });
  });
});

describe("webhook.post execute", () => {
  it("skips without a target URL", async () => {
    const { context, requests } = postContext({ connectionCallback: null });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason: NO_TARGET_URL_REASON,
    });
    expect(requests).toEqual([]);
  });

  it("never posts to a refused request callbackUrl and records why", async () => {
    const { context, requests } = postContext({
      sourceCallback: "http://169.254.169.254/latest/meta-data/",
      config: { url: ACTION_URL },
    });

    const result = await webhookPostAction.execute(context);

    expect(requests.map((request) => request.url)).toEqual([ACTION_URL]);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "200",
      detail:
        "Delivered to the action URL (HTTP 200). The request's callbackUrl was not used: its host 169.254.169.254 is a local or private address (list it in the connection's allowed callback hosts to allow it).",
    });
  });

  it("skips with the refusal when the request callbackUrl is refused and nothing else is set", async () => {
    const { context, requests } = postContext({
      connectionCallback: null,
      sourceCallback: "http://localhost:3002/internal",
    });

    const result = await webhookPostAction.execute(context);

    expect(requests).toEqual([]);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason: `${NO_TARGET_URL_REASON}. The request's callbackUrl was not used: its host localhost is a local or private address (list it in the connection's allowed callback hosts to allow it).`,
    });
  });

  it("adds the refusal to a failed delivery", async () => {
    const { context } = postContext({
      allowedCallbackHosts: ["hooks.partner.com"],
      sourceCallback: SOURCE_CALLBACK,
      response: httpResponse({ status: 500 }),
    });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "The connection's callback URL answered HTTP 500. The request's callbackUrl was not used: its host caller.example.com is not in the connection's allowed callback hosts.",
      retryable: true,
    });
  });

  it("never follows redirects", async () => {
    const { context, requests } = postContext({
      sourceCallback: SOURCE_CALLBACK,
      response: httpResponse({ status: 302 }),
    });

    const result = await webhookPostAction.execute(context);

    expect(requests[0]?.followRedirects).toBe(false);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "The request's callback URL answered HTTP 302.",
      retryable: false,
    });
  });

  it("posts {type, timestamp, run} unsigned when there is no signing secret", async () => {
    const { context, requests } = postContext({
      sourceCallback: SOURCE_CALLBACK,
    });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "200",
      detail: "Delivered to the request's callback URL (HTTP 200).",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe(HttpMethod.Post);
    expect(request?.url).toBe(SOURCE_CALLBACK);
    expect(typeof request?.body).toBe("string");
    expect(JSON.parse(String(request?.body))).toEqual({
      type: WorkflowRunEvent.Succeeded,
      timestamp: NOW.toISOString(),
      run: context.run,
    });
    const headers = headersOf(request);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(WEBHOOK_USER_AGENT);
    expect(headers.get(WEBHOOK_ATTEMPT_HEADER)).toBe("1");
    expect(headers.has("webhook-signature")).toBe(false);
    expect(headers.has("webhook-id")).toBe(false);
  });

  it.each([
    ["with the whsec_ prefix", SIGNING_SECRET],
    ["without the whsec_ prefix", SIGNING_SECRET.slice("whsec_".length)],
  ])("signs with Standard Webhooks headers (secret %s)", async (_label, secret) => {
    const { context, requests } = postContext({ signingSecret: secret });

    await webhookPostAction.execute(context);

    const request = requests[0];
    const rawBody = String(request?.body);
    const headers = headersOf(request);
    expect(headers.get("webhook-id")).toBe(ACTION_RUN_ID);
    expect(headers.get("webhook-timestamp")).toBe(String(NOW_SECONDS));
    expect(headers.get("webhook-signature")).toMatch(SIGNATURE_V1_RE);
    expect(
      verifyStandardWebhook(rawBody, headers, SIGNING_SECRET, NOW_SECONDS)
    ).toEqual({
      ok: true,
    });
    expect(postedBodySchema.parse(JSON.parse(rawBody)).run.id).toBe(
      context.run.id
    );
  });

  it("keeps the webhook-id across retries and reports the attempt", async () => {
    const first = postContext({ signingSecret: SIGNING_SECRET });
    const retry = postContext({ signingSecret: SIGNING_SECRET, attempt: 3 });

    await webhookPostAction.execute(first.context);
    await webhookPostAction.execute(retry.context);

    const firstHeaders = headersOf(first.requests[0]);
    const retryHeaders = headersOf(retry.requests[0]);
    expect(retryHeaders.get("webhook-id")).toBe(firstHeaders.get("webhook-id"));
    expect(firstHeaders.get(WEBHOOK_ATTEMPT_HEADER)).toBe("1");
    expect(retryHeaders.get(WEBHOOK_ATTEMPT_HEADER)).toBe("3");
    expect(
      verifyStandardWebhook(
        String(retry.requests[0]?.body),
        retryHeaders,
        SIGNING_SECRET,
        NOW_SECONDS
      )
    ).toEqual({ ok: true });
  });

  it("works as a pre action on run.triggered, before any document exists", async () => {
    const { context, requests } = postContext({
      config: { url: ACTION_URL, useSourceCallback: false },
      run: makePreActionRunSnapshot(),
    });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "200",
      detail: "Delivered to the action URL (HTTP 200).",
    });
    const posted = preActionBodySchema.parse(
      JSON.parse(String(requests[0]?.body))
    );
    expect(posted.type).toBe(WorkflowRunEvent.Triggered);
    expect(posted.run.event).toBe(WorkflowRunEvent.Triggered);
    expect(posted.run.status).toBe(WorkflowRunStatus.PreActions);
    expect(posted.run.summaryMarkdown).toContain("is about to start working");
  });

  it("produces a signature that fails verification with another secret", async () => {
    const { context, requests } = postContext({
      signingSecret: SIGNING_SECRET,
    });

    await webhookPostAction.execute(context);

    const otherSecret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    expect(
      verifyStandardWebhook(
        String(requests[0]?.body),
        headersOf(requests[0]),
        otherSecret,
        NOW_SECONDS
      ).ok
    ).toBe(false);
  });

  it("treats an empty signing secret as unsigned", async () => {
    const { context, requests } = postContext({ signingSecret: "" });

    await webhookPostAction.execute(context);

    expect(headersOf(requests[0]).has("webhook-signature")).toBe(false);
  });

  it.each([
    [503, true],
    [429, true],
    [404, false],
    [400, false],
  ])("maps HTTP %i to failed with retryable=%s", async (status, retryable) => {
    const { context } = postContext({ response: httpResponse({ status }) });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: `The connection's callback URL answered HTTP ${status}.`,
      retryable,
    });
  });

  it("redacts URLs from transport errors", async () => {
    const { context } = postContext({
      config: { url: "https://hooks.example.com/x?token=SECRET-TOKEN" },
      response: httpResponse({
        status: 0,
        error:
          "request to https://hooks.example.com/x?token=SECRET-TOKEN failed",
        retryable: true,
      }),
    });

    const result = await webhookPostAction.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "The action URL could not be reached (network error or timeout): request to [url] failed.",
      retryable: true,
    });
  });
});
