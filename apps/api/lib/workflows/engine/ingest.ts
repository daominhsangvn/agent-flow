import type { JsonValue } from "@repo/api/src/types/common";
import {
  IntegrationDeliveryOutcome,
  type IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_RUN_ACTIVE_STATUSES,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { getPrismaErrorCode } from "@/lib/db-utils";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import { findTriggerDefinition } from "@/lib/integrations/registry";
import type { InboundEvent } from "@/lib/integrations/types";
import { jsonValueSchema } from "@/lib/json-schema";
import { waitUntil } from "@/lib/wait-until";
import { enqueueRunEvents, hasEnabledPreActions } from "./actions";
import { advanceRun } from "./advance";
import { buildRunSource, toJsonObject } from "./run-data";

/**
 * Inbound events -> workflow runs (docs/workflows.md "Ingest"). Webhook,
 * poll and manual deliveries all go through `ingestEvents`.
 *
 * 1. The delivery is recorded once per (connection, deliveryId); a provider
 *    retry is reported as `duplicate` and does nothing.
 * 2. Each event is matched against the enabled triggers of the connection
 *    (manual runs skip the filters of the chosen trigger).
 * 3. Per matching trigger, under an advisory lock on (workflow, source item):
 *    an occurrence already seen (a run's dedupKey or one of the occurrence
 *    keys that resumed it) does nothing, an active run for the same item is
 *    resumed when it waits for input (otherwise left alone), else a new run
 *    is created.
 * 4. Created and resumed runs are advanced in the background. Ingest only
 *    reads from the source system: every write there is a pre or post action.
 */

export const DELIVERY_PAYLOAD_MAX_CHARS = 32_768;
const DEDUP_KEY_MAX_LENGTH = 255;
const DELIVERY_ID_MAX_LENGTH = 255;
const EVENT_TYPE_MAX_LENGTH = 128;
const DETAIL_MAX_LENGTH = 1000;
const PRISMA_UNIQUE_VIOLATION = "P2002";
const LOG_PREFIX = "[workflows/ingest]";

export const IngestDecision = {
  /** A new run was created. */
  Created: "created",
  /** A needs_input run for the same item was resumed. */
  Resumed: "resumed",
  /** The workflow already has a run for this occurrence (dedupKey or occurrence key). */
  Duplicate: "duplicate",
  /** Another run for the same item is still active. */
  Active: "active",
} as const;
export type IngestDecision =
  (typeof IngestDecision)[keyof typeof IngestDecision];

export type IngestEventsInput = {
  connection: LoadedConnection;
  source: IntegrationDeliverySource;
  /** Provider delivery id, unique per connection. */
  deliveryId: string;
  eventType: string | null;
  events: InboundEvent[];
  /** Troubleshooting copy of the request body (never headers); see toDeliveryPayload. */
  payload: JsonValue | null;
  /** Why the provider produced no events (logged on the delivery). */
  ignoredReason?: string;
  /** Manual run: only this trigger, filters not applied, dedupKey made unique. */
  manualTriggerId?: string;
};

export type IngestRunDecision = {
  triggerId: string;
  workflowId: string;
  decision: IngestDecision;
  runId: string;
};

export type IngestResult = {
  outcome: IntegrationDeliveryOutcome;
  /** Runs created or resumed. */
  runCount: number;
  /** Id of the integration_deliveries row; null for a duplicate delivery. */
  deliveryRowId: string | null;
  decisions: IngestRunDecision[];
  detail: string | null;
};

export async function ingestEvents(
  input: IngestEventsInput
): Promise<IngestResult> {
  const deliveryRowId = uuidv7();
  const inserted = await insertDelivery(input, deliveryRowId);
  if (!inserted) {
    return {
      outcome: IntegrationDeliveryOutcome.Duplicate,
      runCount: 0,
      deliveryRowId: null,
      decisions: [],
      detail: "Delivery already received",
    };
  }

  let decisions: IngestRunDecision[];
  try {
    decisions = await decideRuns(input, deliveryRowId);
  } catch (error) {
    // Forget the delivery so the provider's retry is processed again.
    await discardDelivery(deliveryRowId);
    throw error;
  }

  const summary = summarizeDecisions(input, decisions);
  await finishDelivery(input, deliveryRowId, summary);
  for (const decision of decisions) {
    if (startsWork(decision.decision)) {
      waitUntil(advanceRun(decision.runId));
    }
  }
  return { ...summary, deliveryRowId, decisions };
}

/**
 * Troubleshooting copy of an inbound body for the delivery row: the parsed
 * JSON when it fits in DELIVERY_PAYLOAD_MAX_CHARS, else a truncated preview.
 * Callers pass the body only, never request headers.
 */
export function toDeliveryPayload(value: unknown): JsonValue | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  const serialized =
    typeof parsed === "string" ? parsed : (JSON.stringify(parsed) ?? "");
  if (serialized.length > DELIVERY_PAYLOAD_MAX_CHARS) {
    return {
      truncated: true,
      preview: serialized.slice(0, DELIVERY_PAYLOAD_MAX_CHARS),
    };
  }
  const json = jsonValueSchema.safeParse(
    typeof parsed === "string" ? parsed : JSON.parse(serialized)
  );
  return json.success ? json.data : { preview: serialized };
}

type TriggerRow = {
  id: string;
  type: string;
  config: unknown;
  workflowId: string;
  workflow: { agentConfig: unknown; runAsUserId: string | null };
};

type DecisionSummary = {
  outcome: IntegrationDeliveryOutcome;
  detail: string | null;
  runCount: number;
};

const TRIGGER_SELECT = {
  id: true,
  type: true,
  config: true,
  workflowId: true,
  workflow: { select: { agentConfig: true, runAsUserId: true } },
} as const;

async function insertDelivery(
  input: IngestEventsInput,
  deliveryRowId: string
): Promise<boolean> {
  const result = await withDb((db) =>
    db.integrationDelivery.createMany({
      data: [
        {
          id: deliveryRowId,
          organizationId: input.connection.record.organizationId,
          connectionId: input.connection.record.id,
          deliveryId: input.deliveryId.slice(0, DELIVERY_ID_MAX_LENGTH),
          source: input.source,
          eventType: input.eventType?.slice(0, EVENT_TYPE_MAX_LENGTH) ?? null,
          // Overwritten once processing finishes; stays if the process dies.
          outcome: IntegrationDeliveryOutcome.Error,
          detail: "Processing did not complete",
          payload: input.payload ?? Prisma.DbNull,
        },
      ],
      skipDuplicates: true,
    })
  );
  return result.count === 1;
}

async function decideRuns(
  input: IngestEventsInput,
  deliveryRowId: string
): Promise<IngestRunDecision[]> {
  if (input.events.length === 0) {
    return [];
  }
  const triggers = await loadTriggers(input);
  const decisions: IngestRunDecision[] = [];
  for (const event of input.events) {
    const matching = triggers.filter(
      (trigger) =>
        trigger.type === event.triggerType &&
        triggerMatches(input, trigger, event)
    );
    for (const trigger of matching) {
      decisions.push(await decideRun(input, event, trigger, deliveryRowId));
    }
  }
  return decisions;
}

async function loadTriggers(input: IngestEventsInput): Promise<TriggerRow[]> {
  const organizationId = input.connection.record.organizationId;
  const connectionId = input.connection.record.id;
  if (input.manualTriggerId) {
    const manualTriggerId = input.manualTriggerId;
    return await withDb((db) =>
      db.workflowTrigger.findMany({
        where: { id: manualTriggerId, organizationId, connectionId },
        select: TRIGGER_SELECT,
      })
    );
  }
  const types = [...new Set(input.events.map((event) => event.triggerType))];
  return await withDb((db) =>
    db.workflowTrigger.findMany({
      where: {
        organizationId,
        connectionId,
        enabled: true,
        type: { in: types },
        workflow: { enabled: true },
      },
      select: TRIGGER_SELECT,
      orderBy: { createdAt: "asc" },
    })
  );
}

/** Registry lookup + config parse + provider filter. Never throws. */
function triggerMatches(
  input: IngestEventsInput,
  trigger: TriggerRow,
  event: InboundEvent
): boolean {
  if (input.manualTriggerId) {
    return true;
  }
  const { provider, runtime } = input.connection;
  const definition = findTriggerDefinition(provider.key, trigger.type);
  if (!definition) {
    log.warn(`${LOG_PREFIX} Trigger type is not registered`, {
      triggerId: trigger.id,
      triggerType: trigger.type,
      provider: provider.key,
    });
    return false;
  }
  const config = definition.configSchema.safeParse(trigger.config);
  if (!config.success) {
    log.warn(`${LOG_PREFIX} Trigger config no longer parses; skipped`, {
      triggerId: trigger.id,
      triggerType: trigger.type,
    });
    return false;
  }
  try {
    return definition.matches(event, config.data, runtime);
  } catch (error) {
    log.warn(`${LOG_PREFIX} Trigger filter failed; treated as no match`, {
      triggerId: trigger.id,
      triggerType: trigger.type,
      error,
    });
    return false;
  }
}

async function decideRun(
  input: IngestEventsInput,
  event: InboundEvent,
  trigger: TriggerRow,
  deliveryRowId: string
): Promise<IngestRunDecision> {
  const dedupKey = buildDedupKey(
    event.dedupKey,
    input.manualTriggerId ? deliveryRowId : null
  );
  const sourceKey = `${event.item.provider}:${event.item.key}`.slice(
    0,
    DEDUP_KEY_MAX_LENGTH
  );
  const base = { triggerId: trigger.id, workflowId: trigger.workflowId };
  try {
    const decided = await withDb.tx(async (tx) => {
      const lockKey = `workflow-run:${trigger.workflowId}:${sourceKey}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
      return await decideRunLocked(input, event, trigger, {
        dedupKey,
        sourceKey,
        deliveryRowId,
      });
    });
    return { ...base, ...decided };
  } catch (error) {
    if (getPrismaErrorCode(error) !== PRISMA_UNIQUE_VIOLATION) {
      throw error;
    }
    // A concurrent insert of the same occurrence won: treat it as existing.
    const existing = await findRunByOccurrence(trigger.workflowId, {
      dedupKey,
      sourceKey,
    });
    if (!existing) {
      throw error;
    }
    return { ...base, decision: IngestDecision.Duplicate, runId: existing.id };
  }
}

/** Runs inside the advisory-locked transaction. */
async function decideRunLocked(
  input: IngestEventsInput,
  event: InboundEvent,
  trigger: TriggerRow,
  keys: { dedupKey: string; sourceKey: string; deliveryRowId: string }
): Promise<{ decision: IngestDecision; runId: string }> {
  const existing = await findRunByOccurrence(trigger.workflowId, keys);
  if (existing) {
    return { decision: IngestDecision.Duplicate, runId: existing.id };
  }
  const active = await withDb((db) =>
    db.workflowRun.findFirst({
      where: {
        workflowId: trigger.workflowId,
        sourceKey: keys.sourceKey,
        status: { in: [...WORKFLOW_RUN_ACTIVE_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, cycle: true },
    })
  );
  const now = new Date();
  if (active) {
    const resumed =
      active.status === WorkflowRunStatus.NeedsInput &&
      (await resumeRun({
        run: {
          ...active,
          organizationId: input.connection.record.organizationId,
        },
        workflowId: trigger.workflowId,
        event,
        dedupKey: keys.dedupKey,
        now,
      }));
    return {
      decision: resumed ? IngestDecision.Resumed : IngestDecision.Active,
      runId: active.id,
    };
  }
  const run = await withDb((db) =>
    db.workflowRun.create({
      data: {
        organizationId: input.connection.record.organizationId,
        workflowId: trigger.workflowId,
        triggerId: trigger.id,
        connectionId: input.connection.record.id,
        deliveryId: keys.deliveryRowId,
        runAsUserId: trigger.workflow.runAsUserId,
        dedupKey: keys.dedupKey,
        sourceKey: keys.sourceKey,
        status: WorkflowRunStatus.Received,
        source: buildRunSource(event),
        agentConfig: toJsonObject(trigger.workflow.agentConfig),
        phaseStartedAt: now,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.workflow.updateMany({
      where: { id: trigger.workflowId },
      data: { lastRunAt: now },
    })
  );
  return { decision: IngestDecision.Created, runId: run.id };
}

/**
 * needs_input -> next cycle: pre_actions (with this cycle's run.triggered
 * rows, in the caller's transaction) when the workflow has enabled pre
 * actions, else ingesting (Issue refreshed, PLAN again). The occurrence key is
 * remembered so a replay of it never starts a new run.
 */
async function resumeRun(input: {
  run: { id: string; organizationId: string; cycle: number };
  workflowId: string;
  event: InboundEvent;
  dedupKey: string;
  now: Date;
}): Promise<boolean> {
  const { run, workflowId } = input;
  const preActions = await hasEnabledPreActions({
    organizationId: run.organizationId,
    workflowId,
  });
  const cycle = run.cycle + 1;
  const updated = await withDb((db) =>
    db.workflowRun.updateMany({
      where: {
        id: run.id,
        status: WorkflowRunStatus.NeedsInput,
        cycle: run.cycle,
      },
      data: {
        status: preActions
          ? WorkflowRunStatus.PreActions
          : WorkflowRunStatus.Ingesting,
        cycle,
        occurrenceKeys: { push: input.dedupKey },
        source: buildRunSource(input.event),
        phaseStartedAt: input.now,
        stepAttempts: 0,
        nextStepAt: null,
        error: Prisma.DbNull,
      },
    })
  );
  if (updated.count !== 1) {
    return false;
  }
  if (preActions) {
    await enqueueRunEvents(
      {
        id: run.id,
        organizationId: run.organizationId,
        workflowId,
        cycle,
      },
      [WorkflowRunEvent.Triggered]
    );
  }
  return true;
}

/**
 * The run that started with, or was resumed by, this occurrence. Resumed
 * occurrences belong to the same source item, so that lookup stays on the
 * (workflowId, sourceKey) index.
 */
async function findRunByOccurrence(
  workflowId: string,
  keys: { dedupKey: string; sourceKey: string }
): Promise<{ id: string } | null> {
  return await withDb((db) =>
    db.workflowRun.findFirst({
      where: {
        workflowId,
        OR: [
          { dedupKey: keys.dedupKey },
          {
            sourceKey: keys.sourceKey,
            occurrenceKeys: { has: keys.dedupKey },
          },
        ],
      },
      select: { id: true },
    })
  );
}

async function finishDelivery(
  input: IngestEventsInput,
  deliveryRowId: string,
  summary: DecisionSummary
): Promise<void> {
  const now = new Date();
  await withDb((db) =>
    db.integrationDelivery.updateMany({
      where: { id: deliveryRowId },
      data: {
        outcome: summary.outcome,
        detail: summary.detail?.slice(0, DETAIL_MAX_LENGTH) ?? null,
        runCount: summary.runCount,
      },
    })
  );
  await withDb((db) =>
    db.integrationConnection.updateMany({
      where: { id: input.connection.record.id },
      data: { lastDeliveryAt: now },
    })
  );
}

/** Best effort: if this fails the row keeps its "did not complete" outcome. */
async function discardDelivery(deliveryRowId: string): Promise<void> {
  try {
    await withDb((db) =>
      db.integrationDelivery.deleteMany({ where: { id: deliveryRowId } })
    );
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not discard a failed delivery`, {
      deliveryRowId,
      error,
    });
  }
}

function summarizeDecisions(
  input: IngestEventsInput,
  decisions: IngestRunDecision[]
): DecisionSummary {
  const created = countDecisions(decisions, IngestDecision.Created);
  const resumed = countDecisions(decisions, IngestDecision.Resumed);
  if (created + resumed > 0) {
    return {
      outcome: IntegrationDeliveryOutcome.Accepted,
      detail: acceptedDetail(created, resumed),
      runCount: created + resumed,
    };
  }
  return {
    outcome: IntegrationDeliveryOutcome.Ignored,
    detail: ignoredDetail(input, decisions),
    runCount: 0,
  };
}

function acceptedDetail(created: number, resumed: number): string {
  const parts: string[] = [];
  if (created > 0) {
    parts.push(`${created} run${created === 1 ? "" : "s"} started`);
  }
  if (resumed > 0) {
    parts.push(`${resumed} run${resumed === 1 ? "" : "s"} resumed`);
  }
  return parts.join(", ");
}

function ignoredDetail(
  input: IngestEventsInput,
  decisions: IngestRunDecision[]
): string {
  if (input.events.length === 0) {
    return input.ignoredReason ?? "The delivery contained no supported event";
  }
  if (decisions.length === 0) {
    return "No enabled trigger matched";
  }
  if (decisions.some((entry) => entry.decision === IngestDecision.Active)) {
    return "Run already active";
  }
  return "Occurrence already handled";
}

function countDecisions(
  decisions: IngestRunDecision[],
  decision: IngestDecision
): number {
  return decisions.filter((entry) => entry.decision === decision).length;
}

function startsWork(decision: IngestDecision): boolean {
  return (
    decision === IngestDecision.Created || decision === IngestDecision.Resumed
  );
}

/** Manual runs append ":manual:<deliveryRowId>" so they always start a run. */
function buildDedupKey(dedupKey: string, manualDeliveryId: string | null) {
  if (!manualDeliveryId) {
    return dedupKey.slice(0, DEDUP_KEY_MAX_LENGTH);
  }
  const suffix = `:manual:${manualDeliveryId}`;
  return `${dedupKey.slice(0, DEDUP_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
