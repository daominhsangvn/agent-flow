import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import type { AdoContext } from "@/lib/integrations/providers/azure-devops/client";
import {
  AdoField,
  AdoServiceHookEventType,
} from "@/lib/integrations/providers/azure-devops/constants";
import type {
  AdoConnectionConfig,
  AdoSecrets,
} from "@/lib/integrations/providers/azure-devops/schemas";
import {
  type ActionContext,
  HttpMethod,
  type IntegrationAccount,
  type WorkflowRunSnapshot,
} from "@/lib/integrations/types";

/**
 * Realistic Azure DevOps payloads (shapes taken from the service hook and
 * REST 7.1 documentation samples) and a routed fetch double that records
 * requests, so tests exercise the real ProviderHttp response handling.
 */

export const TEST_ORG_URL = "https://dev.azure.com/contoso";
export const TEST_PAT = "ado-test-pat-0123456789";
export const TEST_PROJECT = "Fabrikam Web";
export const TEST_PROJECT_ID = "be9b3917-87e6-42a4-a549-2bc06a7a878f";
export const TEST_WORK_ITEM_ID = 4321;
export const TEST_NOW = new Date("2026-10-04T12:00:00.000Z");
export const TEST_EVENT_ID = "27646e0e-b520-4d2b-9411-bba7524947cd";
export const TEST_ACTION_RUN_ID = "6c1e0f2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

export const BOT = {
  id: "0f6f9a1e-7d5c-4b8e-9a51-6c2d1c7f0b11",
  displayName: "AgentFlow Bot",
  uniqueName: "agentflow-bot@contoso.com",
  descriptor: "aad.MGY2ZjlhMWUtN2Q1Yy03YjhlLTlhNTE",
} as const;

export const HUMAN = {
  id: "d291b0c4-a05c-4ea6-8df1-4b41d5f39eff",
  displayName: "Jamal Hartnett",
  uniqueName: "jamal@contoso.com",
  descriptor: "aad.YTkzODFkODYtNTYxYS03ZDdiLWJjM2QtZDUzMjllMjM5OTAz",
} as const;

type Person = typeof BOT | typeof HUMAN;

export const botAccount: IntegrationAccount = {
  externalAccountId: BOT.id,
  displayName: BOT.displayName,
  aliases: [BOT.uniqueName, BOT.descriptor],
  details: { organization: "contoso", organizationUrl: TEST_ORG_URL },
};

/** IdentityRef as REST 7.1 returns it. */
export function identityRef(person: Person): JsonObject {
  return {
    displayName: person.displayName,
    url: `https://vssps.dev.azure.com/contoso/_apis/Identities/${person.id}`,
    id: person.id,
    uniqueName: person.uniqueName,
    imageUrl: `https://dev.azure.com/contoso/_api/_common/identityImage?id=${person.id}`,
    descriptor: person.descriptor,
  };
}

/** Service hook `revisedBy`: IdentityRef plus "Name <email>". */
export function revisedBy(person: Person): JsonObject {
  return {
    ...identityRef(person),
    name: `${person.displayName} <${person.uniqueName}>`,
  };
}

/** "Display Name <email>" as older payloads carry identity fields. */
export function identityString(person: Person): string {
  return `${person.displayName} <${person.uniqueName}>`;
}

export function snapshotFields(overrides: JsonObject = {}): JsonObject {
  return {
    "System.AreaPath": "Fabrikam Web\\Checkout",
    [AdoField.TeamProject]: TEST_PROJECT,
    "System.IterationPath": "Fabrikam Web\\Sprint 42",
    [AdoField.WorkItemType]: "User Story",
    [AdoField.State]: "New",
    "System.Reason": "New",
    [AdoField.CreatedDate]: "2026-10-04T11:40:00.000Z",
    [AdoField.CreatedBy]: identityString(HUMAN),
    [AdoField.ChangedDate]: "2026-10-04T11:58:12.345Z",
    [AdoField.ChangedBy]: identityString(HUMAN),
    [AdoField.Title]: "Export orders as CSV",
    [AdoField.Tags]: "Checkout; Backend",
    ...overrides,
  };
}

export type UpdatedPayloadOptions = {
  fields?: JsonObject;
  /** Omit System.ChangedDate from the changed fields. */
  withoutChangedDate?: boolean;
  revisedBy?: JsonObject | null;
  snapshot?: JsonObject;
  workItemId?: number;
  envelope?: JsonObject;
  /** Merged over the resource (the WorkItemUpdate). */
  resource?: JsonObject;
};

/** `workitem.updated` service hook delivery (resourceVersion 1.0). */
export function workItemUpdatedPayload(
  options: UpdatedPayloadOptions = {}
): JsonObject {
  return {
    subscriptionId: "00ca946b-2fe9-4f2a-ae2f-40d5c48001bc",
    notificationId: 7,
    id: TEST_EVENT_ID,
    eventType: AdoServiceHookEventType.WorkItemUpdated,
    publisherId: "tfs",
    message: {
      text: `User Story #${TEST_WORK_ITEM_ID} (Export orders as CSV) updated by Jamal Hartnett.`,
    },
    resource: {
      id: 12,
      workItemId: options.workItemId ?? TEST_WORK_ITEM_ID,
      rev: 7,
      revisedBy:
        options.revisedBy === undefined ? revisedBy(HUMAN) : options.revisedBy,
      revisedDate: "9999-01-01T00:00:00Z",
      fields: {
        "System.Rev": { oldValue: 6, newValue: 7 },
        "System.AuthorizedDate": {
          oldValue: "2026-10-04T11:40:00.000Z",
          newValue: "2026-10-04T11:58:12.345Z",
        },
        "System.RevisedDate": {
          oldValue: "2026-10-04T11:58:12.345Z",
          newValue: "9999-01-01T00:00:00Z",
        },
        ...(options.withoutChangedDate
          ? {}
          : {
              [AdoField.ChangedDate]: {
                oldValue: "2026-10-04T11:40:00.000Z",
                newValue: "2026-10-04T11:58:12.345Z",
              },
            }),
        ...options.fields,
      },
      _links: {
        parent: {
          href: `https://dev.azure.com/contoso/_apis/wit/workItems/${TEST_WORK_ITEM_ID}`,
        },
      },
      url: `https://dev.azure.com/contoso/_apis/wit/workItems/${TEST_WORK_ITEM_ID}/updates/12`,
      revision: {
        id: TEST_WORK_ITEM_ID,
        rev: 7,
        fields: options.snapshot ?? snapshotFields(),
        url: `https://dev.azure.com/contoso/_apis/wit/workItems/${TEST_WORK_ITEM_ID}/revisions/7`,
      },
      ...options.resource,
    },
    resourceVersion: "1.0",
    resourceContainers: {
      collection: { id: "c12d0eb8-e382-443b-9f9c-c52cba5014c2" },
      account: { id: "f844ec47-a9db-4511-8281-8b63f4eaf94e" },
      project: { id: TEST_PROJECT_ID },
    },
    createdDate: "2026-10-04T11:58:13.0000000Z",
    ...options.envelope,
  };
}

/** `workitem.created` service hook delivery: the resource is the full work item. */
export function workItemCreatedPayload(
  fields: JsonObject = {},
  resource: JsonObject = {}
): JsonObject {
  return {
    subscriptionId: "4c2f3c4e-9d8a-4a5f-9b1e-2c0d7f6a8e11",
    notificationId: 3,
    id: "a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e1",
    eventType: AdoServiceHookEventType.WorkItemCreated,
    publisherId: "tfs",
    resource: {
      id: TEST_WORK_ITEM_ID,
      rev: 1,
      fields: snapshotFields({
        [AdoField.ChangedDate]: "2026-10-04T11:40:00.000Z",
        ...fields,
      }),
      url: `https://dev.azure.com/contoso/_apis/wit/workItems/${TEST_WORK_ITEM_ID}`,
      ...resource,
    },
    resourceVersion: "1.0",
    resourceContainers: { project: { id: TEST_PROJECT_ID } },
    createdDate: "2026-10-04T11:40:01.0000000Z",
  };
}

/** `GET _apis/connectionData` for the bot. */
export function connectionDataResponse(id: string = BOT.id): JsonObject {
  return {
    authenticatedUser: {
      id,
      descriptor: `Microsoft.IdentityModel.Claims.ClaimsIdentity;contoso\\${BOT.uniqueName}`,
      subjectDescriptor: BOT.descriptor,
      providerDisplayName: BOT.displayName,
      isActive: true,
      properties: {
        Account: { $type: "System.String", $value: BOT.uniqueName },
      },
      resourceVersion: 2,
      metaTypeId: 0,
    },
    authorizedUser: { id, providerDisplayName: BOT.displayName },
    instanceId: "e4e4e4e4-ffff-aaaa-bbbb-c5c5c5c5c5c5",
    deploymentType: "hosted",
  };
}

/** `GET _apis/wit/workitems/{id}?$expand=all` (REST 7.1). */
export function restWorkItem(
  overrides: {
    fields?: JsonObject;
    multilineFieldsFormat?: JsonObject;
    rev?: number;
  } = {}
): JsonObject {
  return {
    id: TEST_WORK_ITEM_ID,
    rev: overrides.rev ?? 9,
    fields: {
      ...snapshotFields({
        [AdoField.CreatedBy]: identityRef(HUMAN),
        [AdoField.ChangedBy]: identityRef(HUMAN),
        [AdoField.AssignedTo]: identityRef(BOT),
        [AdoField.ChangedDate]: "2026-10-04T11:59:30.000Z",
      }),
      [AdoField.Description]:
        "<div><b>As a</b> shop manager I want to export orders.</div><div><br></div><ul><li>CSV with one row per order</li></ul>",
      [AdoField.AcceptanceCriteria]:
        "<ol><li>Columns: id, date, total</li><li>UTF-8 with BOM</li></ol>",
      [AdoField.Priority]: 2,
      ...overrides.fields,
    },
    relations: [
      {
        rel: "AttachedFile",
        url: "https://dev.azure.com/contoso/_apis/wit/attachments/1b2c3d4e-0000-4000-8000-000000000001",
        attributes: {
          authorizedDate: "2026-10-04T11:41:00.000Z",
          id: 501,
          resourceCreatedDate: "2026-10-04T11:41:00.000Z",
          resourceModifiedDate: "2026-10-04T11:41:00.000Z",
          revisedDate: "9999-01-01T00:00:00Z",
          resourceSize: 2048,
          name: "orders-spec.pdf",
        },
      },
      {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/4000",
        attributes: { isLocked: false, name: "Parent" },
      },
    ],
    ...(overrides.multilineFieldsFormat
      ? { multilineFieldsFormat: overrides.multilineFieldsFormat }
      : {}),
    url: `https://dev.azure.com/contoso/_apis/wit/workItems/${TEST_WORK_ITEM_ID}`,
  };
}

/** `GET .../comments?order=desc&$expand=renderedText`: newest first. */
export function commentsResponse(): JsonObject {
  return {
    totalCount: 3,
    count: 3,
    comments: [
      {
        workItemId: TEST_WORK_ITEM_ID,
        id: 3,
        version: 1,
        text: "Please keep **totals** in EUR.",
        renderedText: "<p>Please keep <strong>totals</strong> in EUR.</p>",
        format: "markdown",
        createdBy: identityRef(HUMAN),
        createdDate: "2026-10-04T11:50:00.000Z",
        isDeleted: false,
      },
      {
        workItemId: TEST_WORK_ITEM_ID,
        id: 2,
        version: 1,
        text: "",
        isDeleted: true,
        format: "html",
        createdBy: identityRef(HUMAN),
        createdDate: "2026-10-04T11:45:00.000Z",
      },
      {
        workItemId: TEST_WORK_ITEM_ID,
        id: 1,
        version: 1,
        text: "<div>Talked to <b>finance</b>.</div>",
        renderedText: "<div>Talked to <b>finance</b>.</div>",
        format: "html",
        createdBy: identityRef(HUMAN),
        createdDate: "2026-10-04T11:42:00.000Z",
        isDeleted: false,
      },
    ],
  };
}

export type FakeRoute = {
  method: HttpMethod;
  /** Exact pathname, or a pattern tested against the pathname. */
  path: string | RegExp;
  /** Query parameters that must be present with these values. */
  query?: Record<string, string>;
  status?: number;
  json?: unknown;
  /** Raw body instead of json (e.g. an HTML sign-in page). */
  text?: string;
  contentType?: string;
  /** Throw like a network failure. */
  networkError?: boolean;
};

export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
};

export type FakeAdo = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  requestsTo(method: HttpMethod, path: string | RegExp): RecordedRequest[];
};

/** Routed fetch double. Routes are matched in order; unmatched requests answer 500. */
export function createFakeAdo(routes: FakeRoute[]): FakeAdo {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? HttpMethod.Get;
    requests.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = routes.find((candidate) =>
      routeMatches(candidate, method, url)
    );
    if (!route) {
      return Promise.resolve(
        jsonResponse(500, {
          message: `Unexpected request ${method} ${url.pathname}`,
        })
      );
    }
    if (route.networkError) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(routeResponse(route));
  };
  return {
    fetch: fetchImpl as typeof fetch,
    requests,
    requestsTo: (method, path) =>
      requests.filter(
        (request) =>
          request.method === method && pathMatches(path, request.url.pathname)
      ),
  };
}

export function createAdoContext(
  fake: FakeAdo,
  options: {
    account?: IntegrationAccount | null;
    organizationUrl?: string;
  } = {}
): AdoContext {
  return {
    connection: {
      id: "5b0f9e1c-7c38-4d2c-9f61-1d9e0f3a2b7c",
      organizationId: "8e3c2b1a-5d4f-4e6a-9b7c-0d1e2f3a4b5c",
      provider: IntegrationProviderKey.AzureDevOps,
      name: "Contoso Azure DevOps",
      config: { organizationUrl: options.organizationUrl ?? TEST_ORG_URL },
      secrets: { pat: TEST_PAT },
      account: options.account === undefined ? botAccount : options.account,
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => TEST_NOW,
  };
}

export function createActionContext<TConfig>(
  fake: FakeAdo,
  config: TConfig,
  run: WorkflowRunSnapshot
): ActionContext<TConfig, AdoConnectionConfig, AdoSecrets> {
  return {
    ...createAdoContext(fake),
    config,
    run,
    actionRunId: TEST_ACTION_RUN_ID,
    attempt: 1,
    render: (template) =>
      template
        .replaceAll("{{summary}}", run.summaryMarkdown)
        .replaceAll("{{pr.url}}", run.pullRequest?.url ?? ""),
  };
}

export function runSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  return {
    id: "3f1d2c4b-6a5e-4f7d-8c9b-0a1b2c3d4e5f",
    url: "https://agentflow.example.com/contoso/workflows/w1/runs/r1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "w1", name: "BA requirements" },
    trigger: null,
    source: {
      provider: IntegrationProviderKey.AzureDevOps,
      externalId: String(TEST_WORK_ITEM_ID),
      key: `#${TEST_WORK_ITEM_ID}`,
      url: `${TEST_ORG_URL}/Fabrikam%20Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
      title: "Export orders as CSV",
      container: TEST_PROJECT,
    },
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: {
      url: "https://github.com/contoso/shop/pull/42",
      number: 42,
      branch: "feat/csv-export",
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
      "✅ **#4321** is done. Pull request: https://github.com/contoso/shop/pull/42",
    startedAt: "2026-10-04T11:58:20.000Z",
    completedAt: "2026-10-04T12:30:00.000Z",
    ...overrides,
  };
}

/** What a pre action sees: run.triggered, pre_actions, no documents or pull request yet. */
export function preActionRunSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  const base = runSnapshot();
  return runSnapshot({
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

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** What ADO serves for a rejected PAT without X-TFS-FedAuthRedirect: an HTML sign-in page. */
export const SIGN_IN_PAGE_HTML =
  "<!DOCTYPE html><html><head><title>Azure DevOps Services | Sign In</title></head><body>Sign in</body></html>";

function routeResponse(route: FakeRoute): Response {
  const status = route.status ?? 200;
  if (route.text !== undefined) {
    return new Response(route.text, {
      status,
      headers: {
        "content-type": route.contentType ?? "text/html; charset=utf-8",
      },
    });
  }
  return jsonResponse(status, route.json ?? {});
}

function routeMatches(route: FakeRoute, method: string, url: URL): boolean {
  return (
    route.method === method &&
    pathMatches(route.path, url.pathname) &&
    Object.entries(route.query ?? {}).every(
      ([key, value]) => url.searchParams.get(key) === value
    )
  );
}

function pathMatches(path: string | RegExp, pathname: string): boolean {
  return typeof path === "string" ? pathname === path : path.test(pathname);
}
