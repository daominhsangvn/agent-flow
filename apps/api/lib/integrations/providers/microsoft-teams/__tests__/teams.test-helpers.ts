import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { vi } from "vitest";
import { isRetryableStatus } from "../../../http";
import type {
  ProviderContext,
  ProviderHttp,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderLogger,
  WorkflowRunSnapshot,
} from "../../../types";
import type {
  TeamsConnectionConfig,
  TeamsConnectionSecrets,
} from "../connection";

export const TEAMS_WEBHOOK_URL =
  "https://default0123.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc123/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SECRET-SIGNATURE";

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export const ACTION_RUN_ID = "0199b000-0000-7000-8000-00000000f001";

export type FakeHttp = { http: ProviderHttp; requests: ProviderHttpRequest[] };

export function httpResponse(
  overrides: Partial<ProviderHttpResponse> = {}
): ProviderHttpResponse {
  const status = overrides.status ?? 202;
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

export function makeTeamsContext(options: {
  http: ProviderHttp;
  webhookUrl?: string;
  log?: ProviderLogger;
}): ProviderContext<TeamsConnectionConfig, TeamsConnectionSecrets> {
  return {
    connection: {
      id: "0199b000-0000-7000-8000-00000000c001",
      organizationId: "0199b000-0000-7000-8000-00000000a001",
      provider: IntegrationProviderKey.MicrosoftTeams,
      name: "Delivery channel",
      config: {},
      secrets: { webhookUrl: options.webhookUrl ?? TEAMS_WEBHOOK_URL },
      account: null,
    },
    http: options.http,
    log: options.log ?? silentLog(),
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  };
}

export function makeRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  return {
    id: "0199b000-0000-7000-8000-00000000r001",
    url: "https://app.example.com/acme/workflows/wf-1/runs/run-1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "wf-1", name: "Jira intake" },
    trigger: null,
    source: {
      provider: IntegrationProviderKey.Jira,
      externalId: "10001",
      key: "PROJ-123",
      url: "https://acme.atlassian.net/browse/PROJ-123",
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
    stepReplies: {},
    summaryMarkdown:
      "✅ **PROJ-123** is done. Pull request: https://github.com/acme/repo/pull/42 (branch feature/proj-123).",
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

/** Minimal {{variable}} renderer over the snapshot, standing in for the engine's template renderer. */
export function renderer(
  run: WorkflowRunSnapshot
): (template: string) => string {
  const values: Record<string, string> = {
    summary: run.summaryMarkdown,
    "workflow.name": run.workflow.name,
    "source.key": run.source.key,
    "source.title": run.source.title ?? "",
    "run.url": run.url,
    "pr.url": run.pullRequest?.url ?? "",
  };
  return (template) =>
    template.replaceAll(
      TEMPLATE_RE,
      (_placeholder, name: string) => values[name] ?? ""
    );
}
