/**
 * Smoke test of the event-driven workflow engine (docs/workflows.md):
 * generic HTTPS ("webhook") trigger -> pre action -> run -> post action, end
 * to end against the real API and its in-process scheduler
 * (apps/api/server.ts).
 *
 * The run targets a registered compute target with no desktop app behind
 * it, so launching PLAN fails and the run ends in `failed`. That is the point:
 * it exercises inbound verification, delivery de-duplication, ingest, the
 * pre actions, the run state machine and the post-action outbox without a
 * desktop runner. The same `webhook.post` action type is configured twice:
 * as a pre action (run.triggered, before the agent team) and as a post action
 * (run.started / run.failed), both delivering to a local HTTP sink.
 */

import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_RUN_FINAL_STATUSES,
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
  WorkflowRunStatus,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { z } from "zod";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import {
  deleteComputeTarget,
  registerComputeTarget,
} from "./helpers/compute-targets";
import { createProject, deleteProject } from "./helpers/create-project";
import { createTeam, deleteTeam } from "./helpers/create-team";
import { deleteDocument } from "./helpers/documents";
import {
  type HttpSink,
  type SinkRequest,
  startHttpSink,
} from "./helpers/http-sink";
import {
  createIntegrationConnection,
  deleteIntegrationConnection,
  getIntegrationInboundDetails,
  toLocalInboundUrl,
} from "./helpers/integrations";
import { buildStandardWebhookHeaders } from "./helpers/standard-webhooks";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  waitForWorkflowRunStatus,
} from "./helpers/workflows";
import { expect, test } from "./test";

/** Trigger and action keys of the built-in webhook provider. */
const WebhookIntegrationKey = {
  RequestTrigger: "webhook.request",
  PostAction: "webhook.post",
} as const;

const ITEM_TITLE = "E2E workflow item";
const ITEM_DESCRIPTION =
  "Created by e2e/workflows.spec.ts. The run is expected to fail because the compute target has no desktop app.";
const SINK_PATH = "/workflow-events";
const HttpStatus = { Ok: 200, Unauthorized: 401 } as const;
const TEST_TIMEOUT_MS = 240_000;
const RUN_FAILURE_TIMEOUT_MS = 90_000;
const SINK_DELIVERY_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 30_000;
const ADMIN_REQUIRED_MESSAGE =
  "Workflow and integration changes require an org admin or owner. Run against a fresh database " +
  "(the first sign-up owns the org) or set E2E_USER_EMAIL/E2E_USER_PASSWORD to an admin account.";

/** Body the `webhook.post` action sends: `{type: event, run: WorkflowRunSnapshot}`. */
const runEventDeliverySchema = z.object({
  type: workflowRunEventSchema,
  run: z.object({
    id: z.string(),
    status: z.string(),
    source: z.object({
      key: z.string(),
      title: z.string().nullable(),
    }),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});

type WorkflowFixture = {
  teamId: string | null;
  projectId: string | null;
  computeTargetId: string | null;
  connectionId: string | null;
  workflowId: string | null;
  documentIds: string[];
};

test.describe("workflows", { tag: E2ETag.Smoke }, () => {
  test("a signed webhook starts one run: the pre action fires first, then the failure is posted", async ({
    apiToken: token,
    page,
    request,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const { orgRole, orgSlug } = requireOrgClaims(token);
    expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

    const sink = await startHttpSink();
    const fixture: WorkflowFixture = {
      teamId: null,
      projectId: null,
      computeTargetId: null,
      connectionId: null,
      workflowId: null,
      documentIds: [],
    };

    try {
      const team = await createTeam(request, {
        name: createUniqueName("e2e-workflow-team"),
        token,
      });
      fixture.teamId = team.id;
      const project = await createProject(request, {
        name: createUniqueName("e2e-workflow-project"),
        teamIds: [team.id],
        token,
      });
      fixture.projectId = project.id;
      // Registered but never connected: no desktop app will pick up the loop.
      const computeTarget = await registerComputeTarget(request, {
        machineName: createUniqueName("e2e-workflow-target"),
        token,
      });
      fixture.computeTargetId = computeTarget.id;

      const connection = await createIntegrationConnection(request, {
        input: {
          provider: IntegrationProviderKey.Webhook,
          name: createUniqueName("e2e-webhook"),
          deliveryMode: IntegrationDeliveryMode.Webhook,
          config: {},
          secrets: {},
        },
        token,
      });
      fixture.connectionId = connection.id;
      const inbound = await getIntegrationInboundDetails(
        request,
        connection.id,
        token
      );

      const workflowName = createUniqueName("e2e-workflow");
      const sinkConfig = {
        url: `${sink.url}${SINK_PATH}`,
        useSourceCallback: false,
      };
      const workflow = await createWorkflow(request, {
        input: {
          name: workflowName,
          projectId: project.id,
          agent: {
            mode: WorkflowAgentMode.PlanAndExecute,
            computeTargetId: computeTarget.id,
            stopOnOpenQuestions: true,
            repository: null,
            instructions: "",
          },
          triggers: [
            {
              connectionId: connection.id,
              type: WebhookIntegrationKey.RequestTrigger,
              config: {},
            },
          ],
          actions: [
            {
              connectionId: connection.id,
              type: WebhookIntegrationKey.PostAction,
              stage: WorkflowActionStage.Pre,
              config: sinkConfig,
              events: [],
              continueOnError: false,
            },
            {
              connectionId: connection.id,
              type: WebhookIntegrationKey.PostAction,
              stage: WorkflowActionStage.Post,
              config: sinkConfig,
              events: [WorkflowRunEvent.Started, WorkflowRunEvent.Failed],
            },
          ],
        },
        token,
      });
      fixture.workflowId = workflow.id;

      const delivery = buildDelivery(inbound.inboundSecret);
      const inboundUrl = toLocalInboundUrl(inbound.inboundUrl);

      const unsigned = await request.post(inboundUrl, {
        data: delivery.rawBody,
        headers: { "content-type": "application/json" },
      });
      expect(unsigned.status()).toBe(HttpStatus.Unauthorized);

      const signed = await postDelivery(request, inboundUrl, delivery);
      expect(signed.status()).toBe(HttpStatus.Ok);

      const failedRun = await waitForWorkflowRunStatus(request, {
        workflowId: workflow.id,
        status: WorkflowRunStatus.Failed,
        finalStatuses: WORKFLOW_RUN_FINAL_STATUSES,
        token,
        timeoutMs: RUN_FAILURE_TIMEOUT_MS,
      });
      test.info().annotations.push({
        type: "workflow-run-error",
        description: `${failedRun.error?.code}: ${failedRun.error?.message}`,
      });
      expect(failedRun.error?.code).toBeTruthy();
      expect(failedRun.source.title).toBe(ITEM_TITLE);
      fixture.documentIds = await collectRunDocumentIds(
        request,
        failedRun.id,
        token
      );

      // The same delivery again (same webhook-id and body) is absorbed.
      const replay = await postDelivery(request, inboundUrl, delivery);
      expect(replay.status()).toBe(HttpStatus.Ok);
      const runs = await listWorkflowRuns(request, workflow.id, token);
      expect(runs.map((run) => run.id)).toEqual([failedRun.id]);

      const triggeredEvent = await waitForRunEventAtSink(request, sink, {
        event: WorkflowRunEvent.Triggered,
        runId: failedRun.id,
        token,
      });
      const triggered = runEventDeliverySchema.parse(triggeredEvent.json);
      expect(triggeredEvent.path).toBe(SINK_PATH);
      expect(triggered.run.status).toBe(WorkflowRunStatus.PreActions);
      expect(triggered.run.source.title).toBe(ITEM_TITLE);
      expect(triggered.run.error).toBeNull();

      const failureEvent = await waitForRunEventAtSink(request, sink, {
        event: WorkflowRunEvent.Failed,
        runId: failedRun.id,
        token,
      });
      const posted = runEventDeliverySchema.parse(failureEvent.json);
      expect(failureEvent.path).toBe(SINK_PATH);
      expect(posted.run.source.key).toBe(failedRun.source.key);
      expect(posted.run.source.title).toBe(ITEM_TITLE);
      expect(posted.run.error?.code).toBe(failedRun.error?.code);

      // The pre action ran before the agent team, so its delivery came first.
      expect(
        arrivalIndex(sink, WorkflowRunEvent.Triggered, failedRun.id)
      ).toBeLessThan(arrivalIndex(sink, WorkflowRunEvent.Failed, failedRun.id));

      const detail = await getWorkflowRun(request, failedRun.id, token);
      expect(
        detail.actionRuns.filter(
          (actionRun) => actionRun.stage === WorkflowActionStage.Pre
        ),
        describeActionRuns(detail.actionRuns)
      ).toEqual([
        expect.objectContaining({
          actionType: WebhookIntegrationKey.PostAction,
          stage: WorkflowActionStage.Pre,
          event: WorkflowRunEvent.Triggered,
          status: WorkflowActionRunStatus.Succeeded,
        }),
      ]);

      await page.goto(`/${orgSlug}/workflows`);
      await expect(page.getByText(workflowName).first()).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });
    } finally {
      await cleanupFixture(request, fixture, token);
      await sink.close();
    }
  });
});

type SignedDelivery = {
  rawBody: string;
  headers: Record<string, string>;
};

function buildDelivery(inboundSecret: string): SignedDelivery {
  const rawBody = JSON.stringify({
    id: createUniqueName("e2e-item"),
    title: ITEM_TITLE,
    description: ITEM_DESCRIPTION,
  });
  return {
    rawBody,
    headers: buildStandardWebhookHeaders({
      id: `msg_${randomUUID()}`,
      rawBody,
      secret: inboundSecret,
    }),
  };
}

function postDelivery(
  request: APIRequestContext,
  inboundUrl: string,
  delivery: SignedDelivery
) {
  return request.post(inboundUrl, {
    data: delivery.rawBody,
    headers: delivery.headers,
  });
}

/**
 * Waits for the action's delivery of `event` at the sink. On timeout, the
 * error lists the run's action runs (status, attempts, last error), which
 * say why nothing arrived.
 */
async function waitForRunEventAtSink(
  request: APIRequestContext,
  sink: HttpSink,
  {
    event,
    runId,
    token,
  }: { event: WorkflowRunEvent; runId: string; token: string }
): Promise<SinkRequest> {
  try {
    return await sink.waitForRequest(
      (received) => isRunEvent(received, event, runId),
      {
        description: `a ${event} delivery for run ${runId}`,
        timeoutMs: SINK_DELIVERY_TIMEOUT_MS,
      }
    );
  } catch (error) {
    const actionRuns = await getWorkflowRun(request, runId, token)
      .then((detail) => describeActionRuns(detail.actionRuns))
      .catch(() => "unavailable");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Action runs: ${actionRuns}`,
      { cause: error }
    );
  }
}

function describeActionRuns(actionRuns: readonly WorkflowActionRun[]): string {
  if (actionRuns.length === 0) {
    return "none";
  }
  return actionRuns
    .map(
      (actionRun) =>
        `${actionRun.stage} ${actionRun.actionType} ${actionRun.event}=${actionRun.status} (attempts ${actionRun.attempts}, last error ${actionRun.lastError ?? "none"})`
    )
    .join("; ");
}

/** Position of the run's `event` delivery among everything the sink received (-1 when absent). */
function arrivalIndex(
  sink: HttpSink,
  event: WorkflowRunEvent,
  runId: string
): number {
  return sink
    .requests()
    .findIndex((received) => isRunEvent(received, event, runId));
}

function isRunEvent(
  received: SinkRequest,
  event: WorkflowRunEvent,
  runId: string
): boolean {
  const parsed = runEventDeliverySchema.safeParse(received.json);
  return (
    parsed.success && parsed.data.type === event && parsed.data.run.id === runId
  );
}

async function collectRunDocumentIds(
  request: APIRequestContext,
  runId: string,
  token: string
): Promise<string[]> {
  const detail = await getWorkflowRun(request, runId, token);
  return [detail.plan?.id, detail.feature?.id].filter((id): id is string =>
    Boolean(id)
  );
}

async function cleanupFixture(
  request: APIRequestContext,
  fixture: WorkflowFixture,
  token: string
): Promise<void> {
  // Dependents first: the connection answers 409 while a workflow uses it.
  await deleteWorkflow(request, fixture.workflowId, token);
  await deleteIntegrationConnection(request, fixture.connectionId, token);
  await deleteComputeTarget(request, fixture.computeTargetId, token);
  for (const documentId of fixture.documentIds) {
    await deleteDocument(request, documentId, token);
  }
  if (fixture.projectId) {
    await deleteProject(request, fixture.projectId, token);
  }
  if (fixture.teamId) {
    await deleteTeam(request, fixture.teamId, token);
  }
}
