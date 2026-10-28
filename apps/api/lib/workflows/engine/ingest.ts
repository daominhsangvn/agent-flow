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
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { getPrismaErrorCode } from "@/lib/db-utils";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import { itemScopeKey } from "@/lib/integrations/project-connections";
import { findTriggerDefinition } from "@/lib/integrations/registry";
import type { InboundEvent } from "@/lib/integrations/types";
import { jsonValueSchema } from "@/lib/json-schema";
import { routeToOrchestrator } from "@/lib/orchestrator/inbound";
import { waitUntil } from "@/lib/wait-until";
import { enqueueRunEvents, hasEnabledPreActions } from "./actions";
import { advanceRun } from "./advance";
import { findRepliedRuns, type RepliedRun } from "./answer-replies";
import { routeReviewSignals } from "./review-signals";
import { buildRunSource, toJsonObject } from "./run-data";

/**
 * Inbound events -> workflow runs (docs/workflows.md "Ingest"). Webhook,
 * poll and manual deliveries all go through `ingestEvents`.
 *
 * 1. The delivery is recorded once per (connection, deliveryId); a provider
 *    retry is reported as `duplicate` and does nothing.
 * 2. Each event is routed to the project connection of this connection that
 *    claims its item (ProjectConnectionScope: the Jira project key or Azure
 *    DevOps project on the connection's site). Project connections of one
 *    project may claim the same item through different connections (one Jira
 *    bot each); each hears it on its own connection, with its own bot. An
 *    item nobody claims through this connection is ignored.
 *    The event is then matched against that project connection's enabled
 *    triggers (manual runs skip the filters of the chosen trigger).
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
  /** A run waiting on the item took the event as a review or approval signal. */
  Signaled: "signaled",
} as const;
export type IngestDecision =
  (typeof IngestDecision)[keyof typeof IngestDecision];

export type IngestEventsInput = {
  /** The organization connection the delivery arrived on. */
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
  /** null for a review signal (review-signals.ts) or a reply (answer-replies.ts), which no trigger matched. */
  triggerId: string | null;
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

  let decided: DecidedRuns;
  try {
    decided = await decideRuns(input, deliveryRowId);
  } catch (error) {
    // Forget the delivery so the provider's retry is processed again.
    await discardDelivery(deliveryRowId);
    throw error;
  }

  const { decisions } = decided;
  const summary = summarizeDecisions(input, decided);
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
  projectId: string;
  projectConnectionId: string | null;
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
  projectId: true,
  projectConnectionId: true,
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

/** The decisions, and how many events no project connection takes. */
type DecidedRuns = {
  decisions: IngestRunDecision[];
  unrouted: number;
  /** New messages handed to project orchestrators. */
  orchestrated: number;
};

async function decideRuns(
  input: IngestEventsInput,
  deliveryRowId: string
): Promise<DecidedRuns> {
  if (input.events.length === 0) {
    return { decisions: [], unrouted: 0, orchestrated: 0 };
  }
  const triggers = await loadTriggers(input);
  const routes = await routeEvents(input, triggers);
  const decisions: IngestRunDecision[] = [];
  let unrouted = 0;
  let orchestrated = 0;
  for (const [index, event] of input.events.entries()) {
    const route = routes[index];
    if (route === undefined) {
      unrouted += 1;
      continue;
    }
    const replied =
      route && !input.manualTriggerId
        ? await findRepliedRuns({
            connection: input.connection,
            event,
            projectConnectionId: route,
            sourceKey: eventSourceKey(event),
          })
        : [];
    for (const run of replied) {
      decisions.push(await decideReply(input, event, run));
    }
    const signalled =
      route && !input.manualTriggerId
        ? await routeReviewSignals({
            connection: input.connection,
            event,
            projectConnectionId: route,
            sourceKey: eventSourceKey(event),
          })
        : [];
    for (const run of signalled) {
      decisions.push({
        triggerId: null,
        workflowId: run.workflowId,
        decision: IngestDecision.Signaled,
        runId: run.runId,
      });
    }
    // A workflow whose run took the signal does not see it as a trigger.
    const matching = triggers.filter(
      (trigger) =>
        trigger.type === event.triggerType &&
        trigger.projectConnectionId === route &&
        !signalled.some((run) => run.workflowId === trigger.workflowId) &&
        !isOrchestratedTrigger(trigger) &&
        triggerMatches(input, trigger, event)
    );
    for (const trigger of matching) {
      decisions.push(await decideRun(input, event, { trigger, deliveryRowId }));
    }
    if (route) {
      orchestrated += await routeOrchestrated(input, event, route, triggers);
    }
  }
  return { decisions, unrouted, orchestrated };
}

/**
 * Hands the event to each orchestrated workflow whose trigger matches it, or
 * whose orchestrator posted the message it replies to (docs/orchestrator.md).
 * Returns the number of new messages recorded across those workflows.
 */
async function routeOrchestrated(
  input: IngestEventsInput,
  event: InboundEvent,
  route: string,
  triggers: TriggerRow[]
): Promise<number> {
  const workflows = triggers
    .filter(
      (trigger) =>
        trigger.type === event.triggerType &&
        trigger.projectConnectionId === route &&
        isOrchestratedTrigger(trigger) &&
        triggerMatches(input, trigger, event)
    )
    .map((trigger) => ({
      workflowId: trigger.workflowId,
      projectId: trigger.projectId,
    }));
  const routed = await routeToOrchestrator({
    connection: input.connection,
    event,
    projectConnectionId: route,
    workflows,
  });
  return routed.filter((result) => result.created).length;
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
  target: { trigger: TriggerRow; deliveryRowId: string }
): Promise<IngestRunDecision> {
  const { trigger, deliveryRowId } = target;
  const dedupKey = buildDedupKey(
    event.dedupKey,
    input.manualTriggerId ? deliveryRowId : null
  );
  const sourceKey = eventSourceKey(event);
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
        projectId: trigger.projectId,
        projectConnectionId: trigger.projectConnectionId,
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
 * needs_input -> next cycle: pre_actions (with this cycle's workflow.triggered
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
  { decisions, unrouted, orchestrated }: DecidedRuns
): DecisionSummary {
  const created = countDecisions(decisions, IngestDecision.Created);
  const resumed =
    countDecisions(decisions, IngestDecision.Resumed) +
    countDecisions(decisions, IngestDecision.Signaled);
  if (created + resumed + orchestrated > 0) {
    return {
      outcome: IntegrationDeliveryOutcome.Accepted,
      detail: acceptedDetail(created, resumed, orchestrated),
      runCount: created + resumed,
    };
  }
  return {
    outcome: IntegrationDeliveryOutcome.Ignored,
    detail: ignoredDetail(input, decisions, unrouted),
    runCount: 0,
  };
}

function acceptedDetail(
  created: number,
  resumed: number,
  orchestrated: number
): string {
  const parts: string[] = [];
  if (orchestrated > 0) {
    parts.push(
      `${orchestrated} message${orchestrated === 1 ? "" : "s"} to the orchestrator`
    );
  }
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
  decisions: IngestRunDecision[],
  unrouted: number
): string {
  if (input.events.length === 0) {
    return input.ignoredReason ?? "The delivery contained no supported event";
  }
  if (unrouted === input.events.length) {
    return "No project connection of this connection takes the item (its project is in no project's settings)";
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
    decision === IngestDecision.Created ||
    decision === IngestDecision.Resumed ||
    decision === IngestDecision.Signaled
  );
}

/** The run's item, as runs store it (WorkflowRun.sourceKey). */
function eventSourceKey(event: InboundEvent): string {
  return `${event.item.provider}:${event.item.key}`.slice(
    0,
    DEDUP_KEY_MAX_LENGTH
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

/**
 * The project connection each event belongs to, by index: an id, null for
 * a connection without project settings (the workflow's built-in HTTP
 * endpoint), or undefined when the event is ignored.
 */
async function routeEvents(
  input: IngestEventsInput,
  triggers: readonly TriggerRow[]
): Promise<Array<string | null | undefined>> {
  if (input.manualTriggerId) {
    const route = triggers[0]?.projectConnectionId;
    return input.events.map(() => route);
  }
  const { provider, runtime } = input.connection;
  if (!provider.project) {
    return input.events.map(() => null);
  }
  const scopeKeys = input.events.map((event) =>
    itemScopeKey(provider, runtime.config, event.item.container)
  );
  const owners = await loadScopeOwners(
    input,
    scopeKeys.flatMap((key) => (key ? [key] : []))
  );
  return scopeKeys.map((key) => (key ? owners.get(key) : undefined));
}

/** The project connection of this connection claiming each scope. */
async function loadScopeOwners(
  input: IngestEventsInput,
  scopeKeys: readonly string[]
): Promise<Map<string, string>> {
  if (scopeKeys.length === 0) {
    return new Map();
  }
  const { organizationId, id: connectionId } = input.connection.record;
  const rows = await withDb((db) =>
    db.projectConnectionScope.findMany({
      where: {
        organizationId,
        scopeKey: { in: [...new Set(scopeKeys)] },
        projectConnection: { connectionId },
      },
      select: { scopeKey: true, projectConnectionId: true },
    })
  );
  return new Map(rows.map((row) => [row.scopeKey, row.projectConnectionId]));
}

/**
 * A reply to a comment of a run waiting for answers resumes it, like the
 * triggers do (answer-replies.ts), under the same lock; the reply is
 * remembered as an occurrence so a redelivery resumes nothing.
 */
async function decideReply(
  input: IngestEventsInput,
  event: InboundEvent,
  replied: RepliedRun
): Promise<IngestRunDecision> {
  const sourceKey = eventSourceKey(event);
  const dedupKey = buildDedupKey(event.dedupKey, null);
  const decision = await withDb.tx(async (tx) => {
    const lockKey = `workflow-run:${replied.workflowId}:${sourceKey}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
    const existing = await findRunByOccurrence(replied.workflowId, {
      dedupKey,
      sourceKey,
    });
    if (existing) {
      return IngestDecision.Duplicate;
    }
    // The item's latest active run, as decideRunLocked reads it: the replied
    // run resumes only while it is that run and still waits for answers.
    const active = await withDb((db) =>
      db.workflowRun.findFirst({
        where: {
          workflowId: replied.workflowId,
          sourceKey,
          status: { in: [...WORKFLOW_RUN_ACTIVE_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, cycle: true },
      })
    );
    const resumed =
      active?.id === replied.runId &&
      active.status === WorkflowRunStatus.NeedsInput &&
      (await resumeRun({
        run: {
          ...active,
          organizationId: input.connection.record.organizationId,
        },
        workflowId: replied.workflowId,
        event,
        dedupKey,
        now: new Date(),
      }));
    return resumed ? IngestDecision.Resumed : IngestDecision.Active;
  });
  return {
    triggerId: null,
    workflowId: replied.workflowId,
    decision,
    runId: replied.runId,
  };
}

const orchestratedAgentSchema = z.object({
  mode: z.literal(WorkflowAgentMode.Orchestrated),
});

/**
 * An orchestrated workflow starts no run: its requests go to the project's
 * orchestrator (docs/orchestrator.md) instead.
 */
function isOrchestratedTrigger(trigger: TriggerRow): boolean {
  return orchestratedAgentSchema.safeParse(trigger.workflow.agentConfig)
    .success;
}
