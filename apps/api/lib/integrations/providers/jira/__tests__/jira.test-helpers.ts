import type { JsonValue } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { vi } from "vitest";
import { isRetryableStatus } from "../../../http";
import type {
  ActionContext,
  IntegrationAccount,
  ProviderContext,
  ProviderHttp,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderLogger,
  WorkflowRunSnapshot,
} from "../../../types";
import { JiraDeployment } from "../constants";
import { JiraAccountDetail } from "../identity";
import type { JiraConnectionConfig, JiraSecrets } from "../schemas";

export const CLOUD_SITE_URL = "https://acme.atlassian.net";
export const DC_SITE_URL = "https://jira.example.com/jira";
export const BOT_ACCOUNT_ID = "712020:3f1c2b9e-5d4a-4c1e-9f0b-b07b07b07b07";
export const BOT_EMAIL = "agentflow-bot@acme.com";
export const BOT_DC_KEY = "JIRAUSER10100";
export const BOT_DC_NAME = "agentflow-bot";
export const HUMAN_ACCOUNT_ID = "5b10a2844c20165700ede21g";
export const API_TOKEN = "ATATT3xFfGF0-secret-api-token-value";
export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const ACTION_RUN_ID = "0199b000-0000-7000-8000-00000000f010";

export const CLOUD_BOT_ACCOUNT: IntegrationAccount = {
  externalAccountId: BOT_ACCOUNT_ID,
  displayName: "AgentFlow Bot",
  aliases: [BOT_EMAIL],
  details: {
    [JiraAccountDetail.Deployment]: JiraDeployment.Cloud,
    [JiraAccountDetail.TimeZone]: "Europe/Berlin",
  },
};

export const DC_BOT_ACCOUNT: IntegrationAccount = {
  externalAccountId: BOT_DC_KEY,
  displayName: "AgentFlow Bot",
  aliases: [BOT_EMAIL, BOT_DC_NAME],
  details: {
    [JiraAccountDetail.Deployment]: JiraDeployment.DataCenter,
    [JiraAccountDetail.UserName]: BOT_DC_NAME,
  },
};

export type JiraTestContext = ProviderContext<
  JiraConnectionConfig,
  JiraSecrets
>;

export type HttpHandler = (
  request: ProviderHttpRequest
) => ProviderHttpResponse;

export type HttpRoute = {
  method: ProviderHttpRequest["method"];
  /** URL pathname (no query) the route answers. */
  path: string;
  respond: ProviderHttpResponse | HttpHandler;
};

export type FakeHttp = { http: ProviderHttp; requests: ProviderHttpRequest[] };

/** Answers by method + pathname; anything unrouted gets a Jira-style 404. */
export function routedHttp(routes: HttpRoute[]): FakeHttp {
  const requests: ProviderHttpRequest[] = [];
  return {
    requests,
    http: {
      request: (request) => {
        requests.push(request);
        const pathname = new URL(request.url).pathname;
        const route = routes.find(
          (candidate) =>
            candidate.method === request.method && candidate.path === pathname
        );
        if (!route) {
          return Promise.resolve(
            jsonResponse(404, {
              errorMessages: [`No route for ${request.method} ${pathname}`],
            })
          );
        }
        const response =
          typeof route.respond === "function"
            ? route.respond(request)
            : route.respond;
        return Promise.resolve(response);
      },
    },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): ProviderHttpResponse {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    headers: new Headers({
      "content-type": "application/json;charset=UTF-8",
      ...headers,
    }),
    text: JSON.stringify(body),
    json: body,
    error: ok ? null : `HTTP ${status}`,
    retryable: !ok && isRetryableStatus(status),
  };
}

export function emptyResponse(status: number): ProviderHttpResponse {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    headers: new Headers(),
    text: "",
    json: undefined,
    error: ok ? null : `HTTP ${status}`,
    retryable: !ok && isRetryableStatus(status),
  };
}

export function networkFailure(): ProviderHttpResponse {
  return {
    ok: false,
    status: 0,
    headers: new Headers(),
    text: "",
    json: undefined,
    error: "fetch failed",
    retryable: true,
  };
}

export function silentLog(): ProviderLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function cloudConfig(): JiraConnectionConfig {
  return {
    deployment: JiraDeployment.Cloud,
    siteUrl: CLOUD_SITE_URL,
    email: BOT_EMAIL,
  };
}

export function dataCenterConfig(): JiraConnectionConfig {
  return {
    deployment: JiraDeployment.DataCenter,
    siteUrl: DC_SITE_URL,
    email: null,
  };
}

export function makeJiraContext(options: {
  http: ProviderHttp;
  config?: JiraConnectionConfig;
  account?: IntegrationAccount | null;
  now?: Date;
  log?: ProviderLogger;
}): JiraTestContext {
  return {
    connection: {
      id: "0199b000-0000-7000-8000-00000000c010",
      organizationId: "0199b000-0000-7000-8000-00000000a001",
      provider: IntegrationProviderKey.Jira,
      name: "Acme Jira",
      config: options.config ?? cloudConfig(),
      secrets: { apiToken: API_TOKEN },
      account:
        options.account === undefined ? CLOUD_BOT_ACCOUNT : options.account,
    },
    http: options.http,
    log: options.log ?? silentLog(),
    now: () => options.now ?? NOW,
  };
}

export function makeActionContext<TConfig>(options: {
  http: ProviderHttp;
  config: TConfig;
  run?: WorkflowRunSnapshot;
  connectionConfig?: JiraConnectionConfig;
  attempt?: number;
}): ActionContext<TConfig, JiraConnectionConfig, JiraSecrets> {
  const run = options.run ?? makeRunSnapshot();
  return {
    ...makeJiraContext({
      http: options.http,
      config: options.connectionConfig,
    }),
    config: options.config,
    run,
    actionRunId: ACTION_RUN_ID,
    attempt: options.attempt ?? 1,
    render: renderer(run),
  };
}

export function makeRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  return {
    id: "0199b000-0000-7000-8000-00000000e001",
    url: "https://app.example.com/acme/workflows/wf-1/runs/run-1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "wf-1", name: "Jira intake" },
    trigger: null,
    source: {
      provider: IntegrationProviderKey.Jira,
      externalId: "10042",
      key: "PROJ-123",
      url: `${CLOUD_SITE_URL}/browse/PROJ-123`,
      title: "Add CSV export",
      container: "PROJ",
    },
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: {
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      branch: "feature/proj-123",
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
    summaryMarkdown:
      "✅ **PROJ-123** is done. Pull request: [#42](https://github.com/acme/repo/pull/42) (branch `feature/proj-123`).",
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

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Minimal {{variable}} renderer over the snapshot, standing in for the engine's template renderer. */
export function renderer(
  run: WorkflowRunSnapshot
): (template: string) => string {
  const values = new Map<string, string>([
    ["summary", run.summaryMarkdown],
    ["workflow.name", run.workflow.name],
    ["source.key", run.source.key],
    ["source.title", run.source.title ?? ""],
    ["run.url", run.url],
    ["pr.url", run.pullRequest?.url ?? ""],
  ]);
  return (template) =>
    template.replaceAll(
      TEMPLATE_RE,
      (_placeholder, name: string) => values.get(name) ?? ""
    );
}

/** Body of a recorded request, as the JSON the provider sent (null for a multipart upload). */
export function requestBody(
  request: ProviderHttpRequest | undefined
): JsonValue {
  const body = request?.body;
  return body === undefined || body instanceof FormData ? null : body;
}

export function requestQuery(
  request: ProviderHttpRequest | undefined
): URLSearchParams {
  return request ? new URL(request.url).searchParams : new URLSearchParams();
}
