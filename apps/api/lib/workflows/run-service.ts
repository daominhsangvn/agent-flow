import {
  IntegrationConnectionStatus,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import type { ToolCallDecision } from "@repo/api/src/types/integration-tools";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type StartWorkflowRunInput,
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowRunDetail,
  type WorkflowRunDocumentRef,
  type WorkflowRunError,
  type WorkflowRunPullRequest,
  WorkflowRunRetryMode,
  type WorkflowRunSourceDocumentRef,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowRunsResponse,
  workflowInstructionRunDetailSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { type Prisma, withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { integrationToolCallService } from "@/app/integration-tools/integration-tool-call-service";
import {
  createProviderContext,
  type LoadedConnection,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import {
  itemScopeKey,
  loadProjectConnectionRuntime,
  projectScopeKeys,
} from "@/lib/integrations/project-connections";
import { findTriggerDefinition } from "@/lib/integrations/registry";
import { waitUntil } from "@/lib/wait-until";
import { drainActionRuns } from "./engine/actions";
import {
  CancelRunFailure,
  cancelRun,
  RetryRunFailure,
  retryRun,
} from "./engine/advance";
import { scrubProviderError } from "./engine/errors";
import {
  IngestDecision,
  ingestEvents,
  toDeliveryPayload,
} from "./engine/ingest";
import { findRetryableStep, toRetryStep } from "./engine/retry-step";
import {
  readRunError,
  readRunRepositories,
  readRunSource,
  readRunStatus,
} from "./engine/run-data";
import { listRunLoops } from "./engine/run-loops";
import { buildRunProcessView } from "./engine/run-process-view";
import { toSourceClassificationView } from "./engine/source-classification-record";
import { toSourceDocumentType } from "./engine/source-document";
import { listRunDocuments } from "./engine/step-documents";
import { listRunSessions } from "./run-sessions";
import { readActionStage } from "./workflow-validation";

/**
 * Workflow run queries and admin operations (run history, run detail,
 * cancel, action-run retry, manual start). Status changes go through the
 * engine (advance.ts); this module never writes a run status itself.
 */

export type RunServiceError = { status: StatusCode; message: string };

export type RunListOptions = {
  workflowId?: string;
  status?: WorkflowRunStatus;
  cursor?: string | null;
  limit?: number;
};

export const RUN_LIST_DEFAULT_LIMIT = 25;
export const RUN_LIST_MAX_LIMIT = 100;

export const workflowRunService = {
  /** Newest first, cursor-paginated by (createdAt, id). */
  async list(
    organizationId: string,
    options: RunListOptions = {}
  ): Promise<Result<WorkflowRunsResponse, RunServiceError>> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !cursor) {
      return badRequest("Invalid cursor");
    }
    if (options.workflowId) {
      const exists = await workflowExists(organizationId, options.workflowId);
      if (!exists) {
        return notFound("Workflow not found");
      }
    }
    const limit = clampLimit(options.limit);
    const rows = await withDb((db) =>
      db.workflowRun.findMany({
        where: {
          organizationId,
          ...(options.workflowId ? { workflowId: options.workflowId } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(cursor ? cursorFilter(cursor) : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: RUN_SUMMARY_SELECT,
      })
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Result.ok({
      runs: page.map(toRunSummary),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    });
  },

  async get(
    organizationId: string,
    runId: string
  ): Promise<WorkflowRunDetail | null> {
    if (!isUuid(runId)) {
      return null;
    }
    const run = await withDb((db) =>
      db.workflowRun.findFirst({
        where: { id: runId, organizationId },
        select: RUN_DETAIL_SELECT,
      })
    );
    if (!run) {
      return null;
    }
    const loops = await listRunLoops(run.id);
    const [sessions, actionRuns, documents, toolCalls] = await Promise.all([
      listRunSessions(organizationId, loops),
      withDb((db) =>
        db.workflowActionRun.findMany({
          where: { runId: run.id, organizationId },
          include: { action: { select: { position: true } } },
          orderBy: { createdAt: "asc" },
        })
      ),
      listRunDocuments({
        id: run.id,
        organizationId,
        featureDocumentId: run.featureDocument?.id ?? null,
      }),
      integrationToolCallService.listForRun(organizationId, run.id),
    ]);
    return {
      ...toRunSummary(run),
      feature: toSourceDocumentRef(run.featureDocument),
      sourceClassification: toSourceClassificationView(
        run.sourceClassification
      ),
      plan: toDocumentRef(run.planDocument),
      documents,
      branchName: run.branchName,
      loops: loops.map((loop) => ({
        loopId: loop.loopId,
        command: loop.command,
        status: loop.status,
        adopted: loop.adopted,
        stepId: loop.stepId,
        prUrl: loop.prUrl,
        startedAt: loop.startedAt,
        completedAt: loop.completedAt,
      })),
      sessions,
      actionRuns: [...actionRuns]
        .sort(compareActionRuns)
        .flatMap(toActionRunDto),
      process: buildRunProcessView(run, loops),
      toolCalls,
      retryStep: await toRetryStep(run.id, findRetryableStep(run)),
    };
  },

  /**
   * Runs the step a run failed or was cancelled in again (engine/retry-step.ts):
   * restarted, or its failed agent session resumed in a fork.
   */
  async retry(
    organizationId: string,
    runId: string,
    mode: WorkflowRunRetryMode = WorkflowRunRetryMode.Restart
  ): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    if (!isUuid(runId)) {
      return notFound("Workflow run not found");
    }
    const retried = await retryRun(organizationId, runId, mode);
    if (!retried.ok) {
      return Result.err(retryFailure(retried.error));
    }
    return await loadDetail(organizationId, runId);
  },

  async cancel(
    organizationId: string,
    runId: string
  ): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    if (!isUuid(runId)) {
      return notFound("Workflow run not found");
    }
    const cancelled = await cancelRun(organizationId, runId);
    if (!cancelled.ok) {
      return Result.err(cancelFailure(cancelled.error));
    }
    return await loadDetail(organizationId, runId);
  },

  /**
   * A person approves (carries out) or rejects an agent's integration tool
   * call whose grant requires approval.
   */
  async decideToolCall(input: {
    organizationId: string;
    runId: string;
    callId: string;
    decision: ToolCallDecision;
    userId: string;
  }): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    if (!(isUuid(input.runId) && isUuid(input.callId))) {
      return notFound("Tool call not found");
    }
    const decided = await integrationToolCallService.decide(input);
    if (!decided.ok) {
      return Result.err(decided.error);
    }
    return await loadDetail(input.organizationId, input.runId);
  },

  /**
   * Post actions only: failed/skipped -> pending with fresh attempts, drained
   * in the background. Pre actions belong to the run's start (they ran
   * before the agent team) and are not retried on their own.
   */
  async retryActionRun(
    organizationId: string,
    runId: string,
    actionRunId: string
  ): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    if (!(isUuid(runId) && isUuid(actionRunId))) {
      return notFound("Action run not found");
    }
    const updated = await withDb((db) =>
      db.workflowActionRun.updateMany({
        where: {
          id: actionRunId,
          runId,
          organizationId,
          stage: WorkflowActionStage.Post,
          status: {
            in: [
              WorkflowActionRunStatus.Failed,
              WorkflowActionRunStatus.Skipped,
            ],
          },
        },
        data: {
          status: WorkflowActionRunStatus.Pending,
          attempts: 0,
          nextAttemptAt: new Date(),
          completedAt: null,
        },
      })
    );
    if (updated.count === 0) {
      const existing = await withDb((db) =>
        db.workflowActionRun.findFirst({
          where: { id: actionRunId, runId, organizationId },
          select: { id: true, stage: true },
        })
      );
      return retryRefusal(existing);
    }
    waitUntil(drainActionRuns({ runId }));
    return await loadDetail(organizationId, runId);
  },

  /**
   * Starts a run by hand for one trigger from user input (an issue key, a
   * work item id, a JSON body). Trigger filters are not applied.
   */
  async startManualRun(
    organizationId: string,
    workflowId: string,
    input: StartWorkflowRunInput
  ): Promise<Result<WorkflowRunSummary, RunServiceError>> {
    const target = await loadManualTarget(organizationId, workflowId, input);
    if (!target.ok) {
      return target;
    }
    const { loaded, trigger } = target.value;
    const resolveManual = loaded.provider.source?.resolveManual;
    if (!resolveManual) {
      return badRequest("This trigger does not support manual runs.");
    }

    let event: Awaited<ReturnType<typeof resolveManual>>;
    try {
      event = await resolveManual(
        createProviderContext(loaded.runtime, LOG_PREFIX),
        input.input,
        trigger.type
      );
    } catch (error) {
      return badRequest(scrubProviderError(error, loaded.runtime.secrets));
    }
    if (!isClaimed(target.value.scopes, loaded, event.item.container)) {
      return badRequest(
        `${event.item.key} is not in the settings of the trigger's project connection, so this workflow cannot run on it.`
      );
    }

    const result = await ingestEvents({
      connection: loaded,
      source: IntegrationDeliverySource.Manual,
      deliveryId: `${MANUAL_DELIVERY_PREFIX}${uuidv7()}`,
      eventType: trigger.type,
      events: [{ ...event, triggerType: trigger.type }],
      payload: toDeliveryPayload(input.input),
      manualTriggerId: trigger.id,
    });
    const decision = result.decisions[0];
    if (!decision) {
      return conflict("The run could not be started.");
    }
    if (decision.decision === IngestDecision.Active) {
      return conflict(
        `${event.item.key} already has an active run in this workflow.`
      );
    }
    const summary = await loadSummary(organizationId, decision.runId);
    return summary ? Result.ok(summary) : notFound("Workflow run not found");
  },
};

const LOG_PREFIX = "[workflows/manual-run]";
const MANUAL_DELIVERY_PREFIX = "manual:";

const RUN_SUMMARY_SELECT = {
  id: true,
  workflowId: true,
  triggerId: true,
  status: true,
  source: true,
  sourceKey: true,
  prUrl: true,
  branchName: true,
  repository: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  workflow: { select: { name: true } },
  trigger: { select: { type: true } },
} as const satisfies Prisma.WorkflowRunSelect;

const RUN_DETAIL_SELECT = {
  ...RUN_SUMMARY_SELECT,
  process: true,
  stepId: true,
  stepState: true,
  sourceClassification: true,
  featureDocument: {
    select: { id: true, slug: true, name: true, subtype: true },
  },
  planDocument: { select: { id: true, slug: true, name: true } },
} as const satisfies Prisma.WorkflowRunSelect;

type RunSummaryRow = Prisma.WorkflowRunGetPayload<{
  select: typeof RUN_SUMMARY_SELECT;
}>;

type RunCursor = { createdAt: Date; id: string };

const uuidSchema = z.uuid();
const cursorSchema = z.object({ c: z.iso.datetime(), i: z.uuid() });
const actionRunStatusSchema = z.enum(WorkflowActionRunStatus);

function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

async function workflowExists(
  organizationId: string,
  workflowId: string
): Promise<boolean> {
  if (!isUuid(workflowId)) {
    return false;
  }
  const workflow = await withDb((db) =>
    db.workflow.findFirst({
      where: { id: workflowId, organizationId },
      select: { id: true },
    })
  );
  return workflow !== null;
}

type ManualRunTarget = {
  loaded: LoadedConnection;
  trigger: { id: string; type: string; connectionId: string };
  /** Scopes of the trigger's project connection; null for the built-in HTTP endpoint. */
  scopes: string[] | null;
};

async function loadManualTarget(
  organizationId: string,
  workflowId: string,
  input: StartWorkflowRunInput
): Promise<Result<ManualRunTarget, RunServiceError>> {
  if (!isUuid(workflowId)) {
    return notFound("Workflow not found");
  }
  const workflow = await withDb((db) =>
    db.workflow.findFirst({
      where: { id: workflowId, organizationId },
      select: { id: true, enabled: true },
    })
  );
  if (!workflow) {
    return notFound("Workflow not found");
  }
  if (!workflow.enabled) {
    return badRequest("The workflow is disabled. Enable it to start runs.");
  }
  const trigger = await withDb((db) =>
    db.workflowTrigger.findFirst({
      where: { id: input.triggerId, workflowId, organizationId },
      select: {
        id: true,
        type: true,
        connectionId: true,
        projectConnectionId: true,
      },
    })
  );
  if (!trigger) {
    return badRequest("The trigger does not belong to this workflow.");
  }
  const source = await loadTriggerConnection(organizationId, trigger);
  const loaded = source?.loaded ?? null;
  if (!loaded) {
    return badRequest(
      "The trigger's integration connection is unavailable. Check its credentials."
    );
  }
  if (loaded.record.status === IntegrationConnectionStatus.Disabled) {
    return badRequest(`The connection "${loaded.record.name}" is disabled.`);
  }
  if (!findTriggerDefinition(loaded.provider.key, trigger.type)?.manualRun) {
    return badRequest("This trigger does not support manual runs.");
  }
  return Result.ok({ loaded, trigger, scopes: source?.scopes ?? null });
}

/**
 * The trigger's connection with its effective runtime (the project
 * connection's own account when it has one) and the scopes it claims.
 */
async function loadTriggerConnection(
  organizationId: string,
  trigger: { connectionId: string; projectConnectionId: string | null }
): Promise<{ loaded: LoadedConnection; scopes: string[] | null } | null> {
  if (!trigger.projectConnectionId) {
    const loaded = await loadConnectionRuntime(
      organizationId,
      trigger.connectionId
    );
    return loaded ? { loaded, scopes: null } : null;
  }
  const projectConnection = await loadProjectConnectionRuntime(
    organizationId,
    trigger.projectConnectionId
  );
  if (!projectConnection) {
    return null;
  }
  const { connection, settings } = projectConnection;
  return {
    loaded: connection,
    scopes: projectScopeKeys(
      connection.provider,
      connection.runtime.config,
      settings
    ),
  };
}

/** A manual item must be one the trigger's project connection claims. */
function isClaimed(
  scopes: string[] | null,
  loaded: LoadedConnection,
  container: string | null
): boolean {
  if (scopes === null) {
    return true;
  }
  const scope = itemScopeKey(loaded.provider, loaded.runtime.config, container);
  return scope !== null && scopes.includes(scope);
}

async function loadSummary(
  organizationId: string,
  runId: string
): Promise<WorkflowRunSummary | null> {
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: runId, organizationId },
      select: RUN_SUMMARY_SELECT,
    })
  );
  return run ? toRunSummary(run) : null;
}

async function loadDetail(
  organizationId: string,
  runId: string
): Promise<Result<WorkflowRunDetail, RunServiceError>> {
  const detail = await workflowRunService.get(organizationId, runId);
  return detail ? Result.ok(detail) : notFound("Workflow run not found");
}

function toRunSummary(run: RunSummaryRow): WorkflowRunSummary {
  const item = readRunSource(run.source)?.item;
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflow.name,
    triggerId: run.triggerId,
    triggerType: run.trigger?.type ?? null,
    status: readRunStatus(run.status),
    source: item
      ? {
          provider: item.provider,
          externalId: item.externalId,
          key: item.key,
          title: item.title,
          url: item.url,
        }
      : fallbackSource(run.sourceKey),
    pullRequests: toRunPullRequests(run),
    error: readRunError(run.error),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function fallbackSource(sourceKey: string): WorkflowRunSummary["source"] {
  const separator = sourceKey.indexOf(":");
  const key = separator > 0 ? sourceKey.slice(separator + 1) : sourceKey;
  return {
    provider: separator > 0 ? sourceKey.slice(0, separator) : "",
    externalId: key,
    key,
    title: null,
    url: null,
  };
}

function toDocumentRef(
  document: { id: string; slug: string | null; name: string } | null
): WorkflowRunDocumentRef | null {
  return document
    ? { id: document.id, slug: document.slug, title: document.name }
    : null;
}

function toSourceDocumentRef(
  document: {
    id: string;
    slug: string | null;
    name: string;
    subtype: string | null;
  } | null
): WorkflowRunSourceDocumentRef | null {
  return document
    ? {
        id: document.id,
        slug: document.slug,
        title: document.name,
        type: toSourceDocumentType(document.subtype),
      }
    : null;
}

type ActionRunRow = {
  id: string;
  actionId: string | null;
  actionType: string;
  stage: string;
  event: string;
  cycle: number;
  status: string;
  attempts: number;
  lastError: string | null;
  externalRef: string | null;
  detail: unknown;
  completedAt: Date | null;
  createdAt: Date;
  action: { position: number } | null;
};

function toActionRunDto(row: ActionRunRow): WorkflowActionRun[] {
  const event = workflowRunEventSchema.safeParse(row.event);
  if (!event.success) {
    return [];
  }
  const status = actionRunStatusSchema.safeParse(row.status);
  const instruction = workflowInstructionRunDetailSchema.safeParse(row.detail);
  return [
    {
      id: row.id,
      actionId: row.actionId,
      actionType: row.actionType,
      stage: readActionStage(row.stage),
      event: event.data,
      cycle: row.cycle,
      status: status.success ? status.data : WorkflowActionRunStatus.Failed,
      attempts: row.attempts,
      lastError: row.lastError,
      externalRef: row.externalRef,
      instruction: instruction.success ? instruction.data : null,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    },
  ];
}

/**
 * Run cycle, then stage (pre actions first, they run first), then action
 * position (rows of removed actions last), then creation time.
 */
function compareActionRuns(left: ActionRunRow, right: ActionRunRow): number {
  return (
    left.cycle - right.cycle ||
    stageRank(left.stage) - stageRank(right.stage) ||
    actionPosition(left) - actionPosition(right) ||
    left.createdAt.getTime() - right.createdAt.getTime()
  );
}

function stageRank(stage: string): number {
  return readActionStage(stage) === WorkflowActionStage.Pre ? 0 : 1;
}

function actionPosition(row: ActionRunRow): number {
  return row.action?.position ?? Number.MAX_SAFE_INTEGER;
}

function retryRefusal(
  existing: { id: string; stage: string } | null
): Result<never, RunServiceError> {
  if (!existing) {
    return notFound("Action run not found");
  }
  if (readActionStage(existing.stage) === WorkflowActionStage.Pre) {
    return conflict(
      "Pre actions run when the run starts and cannot be retried on their own. Start a new run instead."
    );
  }
  return conflict("Only failed or skipped action runs can be retried.");
}

function cursorFilter(cursor: RunCursor): Prisma.WorkflowRunWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function encodeCursor(run: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ c: run.createdAt.toISOString(), i: run.id }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(cursor: string): RunCursor | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    const parsed = cursorSchema.safeParse(decoded);
    return parsed.success
      ? { createdAt: new Date(parsed.data.c), id: parsed.data.i }
      : null;
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return RUN_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(limit)), RUN_LIST_MAX_LIMIT);
}

function cancelFailure(failure: CancelRunFailure): RunServiceError {
  switch (failure) {
    case CancelRunFailure.NotFound:
      return { status: Status.NotFound, message: "Workflow run not found" };
    case CancelRunFailure.AlreadyFinished:
      return { status: Status.Conflict, message: "The run already finished." };
    default:
      return {
        status: Status.Conflict,
        message: "The run is being updated right now. Try again in a moment.",
      };
  }
}

function retryFailure(failure: {
  failure: RetryRunFailure;
  error?: WorkflowRunError;
}): RunServiceError {
  switch (failure.failure) {
    case RetryRunFailure.NotFound:
      return { status: Status.NotFound, message: "Workflow run not found" };
    case RetryRunFailure.NotRetryable:
      return {
        status: Status.Conflict,
        message:
          "Only a run that failed or was cancelled in a plan, implement or agent step can be retried.",
      };
    case RetryRunFailure.NotResumable:
      return {
        status: Status.Conflict,
        message:
          "The step has no agent session to resume. Restart the step instead.",
      };
    case RetryRunFailure.StartFailed:
      return {
        status: Status.Conflict,
        message: `The step could not be started: ${failure.error?.message ?? "unknown error"}`,
      };
    default:
      return {
        status: Status.Conflict,
        message: "The run is being updated right now. Try again in a moment.",
      };
  }
}

function badRequest<T>(message: string): Result<T, RunServiceError> {
  return Result.err({ status: Status.BadRequest, message });
}

function notFound<T>(message: string): Result<T, RunServiceError> {
  return Result.err({ status: Status.NotFound, message });
}

function conflict<T>(message: string): Result<T, RunServiceError> {
  return Result.err({ status: Status.Conflict, message });
}

/**
 * The pull request recorded on each of the run's repositories; a run recorded
 * before repositories carried their pull request falls back to its single
 * prUrl.
 */
function toRunPullRequests(
  run: Pick<RunSummaryRow, "prUrl" | "branchName" | "repository">
): WorkflowRunPullRequest[] {
  const { repositories } = readRunRepositories(run.repository);
  const recorded = repositories.flatMap((repository) =>
    repository.pullRequest
      ? [
          {
            url: repository.pullRequest.url,
            number: repository.pullRequest.number,
            repository: repository.fullName,
            branch: repository.branch,
          },
        ]
      : []
  );
  if (recorded.length > 0 || !run.prUrl) {
    return recorded;
  }
  return [
    {
      url: run.prUrl,
      number: null,
      repository: repositories[0]?.fullName ?? null,
      branch: run.branchName,
    },
  ];
}
