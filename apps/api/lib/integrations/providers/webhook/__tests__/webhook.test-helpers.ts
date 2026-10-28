import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { vi } from "vitest";
import { isRetryableStatus } from "../../../http";
import type {
  InboundRequest,
  ProviderContext,
  ProviderHttp,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderLogger,
  WorkflowRunSnapshot,
} from "../../../types";
import type {
  WebhookConnectionConfig,
  WebhookConnectionSecrets,
} from "../connection";
import { WebhookTriggerType } from "../inbound-event";

/** whsec_ + base64 of 32 bytes. */
export const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
export const INBOUND_URL =
  "https://agentflow.example.com/webhooks/integrations/inb_abc123";
export const ACTION_RUN_ID = "0199b000-0000-7000-8000-00000000f002";

export type FakeHttp = { http: ProviderHttp; requests: ProviderHttpRequest[] };

export function httpResponse(
  overrides: Partial<ProviderHttpResponse> = {}
): ProviderHttpResponse {
  const status = overrides.status ?? 200;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    headers: new Headers(),
    text: "",
    json: undefined,
    error: ok ? null : `HTTP ${status}`,
    retryable: !ok && (status === 0 || isRetryableStatus(status)),
    ...overrides,
  };
}

export function fakeHttp(
  response: ProviderHttpResponse = httpResponse()
): FakeHttp {
  const requests: ProviderHttpRequest[] = [];
  return {
    requests,
    http: {
      request: (request) => {
        requests.push(request);
        return Promise.resolve(response);
      },
    },
  };
}

export function silentLog(): ProviderLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function makeWebhookContext(
  options: {
    http?: ProviderHttp;
    config?: WebhookConnectionConfig;
    secrets?: WebhookConnectionSecrets;
  } = {}
): ProviderContext<WebhookConnectionConfig, WebhookConnectionSecrets> {
  return {
    connection: {
      id: "0199b000-0000-7000-8000-00000000c002",
      organizationId: "0199b000-0000-7000-8000-00000000a001",
      provider: IntegrationProviderKey.Webhook,
      name: "Requirements intake",
      config: options.config ?? { allowedCallbackHosts: [] },
      secrets: options.secrets ?? {},
      account: null,
    },
    http: options.http ?? fakeHttp().http,
    log: silentLog(),
    now: () => NOW,
  };
}

export function inboundRequest(
  rawBody: string,
  headers: Record<string, string> = {}
): InboundRequest {
  return { rawBody, headers: new Headers(headers), url: new URL(INBOUND_URL) };
}

export function makeRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  return {
    id: "0199b000-0000-7000-8000-00000000r002",
    url: "https://app.example.com/acme/workflows/wf-2/runs/run-2",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "wf-2", name: "HTTPS intake" },
    trigger: {
      id: "tr-2",
      type: WebhookTriggerType.Request,
      connectionId: "0199b000-0000-7000-8000-00000000c002",
    },
    source: {
      provider: IntegrationProviderKey.Webhook,
      externalId: "evt-1",
      key: "REQ-7",
      url: "https://tracker.example.com/REQ-7",
      title: "Add CSV export",
      container: null,
    },
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: {
      url: "https://github.com/acme/repo/pull/43",
      number: 43,
      branch: "feature/req-7",
    },
    pullRequests: [],
    repositories: [],
    repository: null,
    error: null,
    step: null,
    reply: null,
    documents: [],
    releaseNotes: null,
    stepReplies: {},
    summaryMarkdown: "✅ **REQ-7** is done.",
    startedAt: "2026-10-04T10:00:00.000Z",
    completedAt: "2026-10-04T11:00:00.000Z",
    ...overrides,
  };
}

/** What a pre action sees: run.triggered, pre_actions, no documents or pull request yet. */
export function makePreActionRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  const base = makeRunSnapshot();
  return makeRunSnapshot({
    status: WorkflowRunStatus.PreActions,
    event: WorkflowRunEvent.Triggered,
    feature: null,
    plan: null,
    pullRequest: null,
    step: null,
    reply: null,
    documents: [],
    stepReplies: {},
    summaryMarkdown: `🤖 AgentFlow received **${base.source.key}** (${base.source.title}) and is about to start working on it. Follow the run: ${base.url}`,
    completedAt: null,
    ...overrides,
  });
}
