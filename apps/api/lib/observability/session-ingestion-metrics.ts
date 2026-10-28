import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

// ---------------------------------------------------------------------------
// session.ingestion.* metric emitter module (ISS-4543)
//
// Single import point for cloud session-ingestion health observability.
// Follows the emitHeartbeatLag / emitZombieDetector pattern from
// apps/api/lib/observability/loop-runner-metrics.ts: one payload `type` per
// metric so the shape is enforced at compile time, and one thin wrapper each
// delegating to `emitTelemetryMetric` so the `_telemetryMetric: true` marker
// contract lives in exactly one place.
//
// WHY THIS FAMILY EXISTS. ISS-4537 froze cloud session ingestion for an entire
// org for ~2 days and was found only by manual inspection: nothing measured
// "is session data still arriving?". staleness / stalled_orgs / active_orgs,
// sampled by the `/cron/sample-session-ingestion-health` cron, make that class
// of stall observable (broken ingest route, dead desktop fleet, sync queue
// wedged), at the cost of taking the stall threshold to fire. Session ingestion
// itself is always on: no org policy or flag denies it.
//
// Emitting these does NOT create a queryable Datadog metric on its own: each
// needs a paired `datadog_logs_metric` generator plus a `datadog_monitor` in
// `agentflow-ai/af-tofu-aws-live` (PRD-159). See packages/observability/README.md.
// ---------------------------------------------------------------------------

type SessionIngestionStalenessMetric = {
  metric: typeof FilterToken.SessionIngestionStaleness;
  orgId: string;
  value: number;
};

// `value:` (gauge), NOT `count:` (additive counter). Both are org populations
// sampled fresh every run — "this is the current state", not "this many things
// happened". packages/observability/README.md is explicit that the field choice
// drives the downstream aggregation: a gauge emitted under `count:` gets summed
// across the window, so four samples of "1 stalled org" would page as 4.
type SessionIngestionStalledOrgsMetric = {
  metric: typeof FilterToken.SessionIngestionStalledOrgs;
  value: number;
  thresholdHours: number;
};

type SessionIngestionActiveOrgsMetric = {
  metric: typeof FilterToken.SessionIngestionActiveOrgs;
  value: number;
  windowHours: number;
  /**
   * ISS-4829: how many orgs are QUIET (past the freshness window with no ingest
   * attempt) in the same sample. Additive plain FIELD, not a metric tag — it
   * needs no `datadog_logs_metric`/monitor change in `af-tofu-aws-live` to be
   * emitted, and it gives an operator reading a zero-active alert the population
   * that explains it without re-deriving it from `stalled_orgs`.
   */
  quietOrgCount: number;
};

/**
 * Milliseconds since this org last ingested any session data. Gauge — emitted
 * only for orgs that have ingested at least once, because an org with no
 * ingest history has no baseline to be stale against.
 *
 * ISS-4830 — WHO IS IN THIS EMISSION. Only ACTIVE and STALLED orgs. The payload
 * carries no classification (adding one as a metric LABEL requires a paired
 * `datadog_logs_metric` + monitor change in `agentflow-ai/af-tofu-aws-live`,
 * PRD-159, which cannot be made from this repo), so a quiet org and a stalled
 * org emitted an identical shape and an operator drilling into a `stalled_orgs`
 * page could not tell them apart. The caller narrows the population instead: an
 * org named here is one the page is about. Quiet and dormant orgs stay visible
 * through `SessionIngestionHealthSummary` and the cron's log line.
 */
export function emitSessionIngestionStaleness(
  orgId: string,
  stalenessMs: number
): void {
  emitTelemetryMetric<SessionIngestionStalenessMetric>({
    metric: FilterToken.SessionIngestionStaleness,
    orgId,
    value: stalenessMs,
  });
}

/**
 * How many previously-ingesting orgs have gone silent past the stall
 * threshold. Gauge — this is the primary "ingestion is frozen somewhere" page.
 */
export function emitSessionIngestionStalledOrgs(
  stalledOrgCount: number,
  thresholdHours: number
): void {
  emitTelemetryMetric<SessionIngestionStalledOrgsMetric>({
    metric: FilterToken.SessionIngestionStalledOrgs,
    value: stalledOrgCount,
    thresholdHours,
  });
}

/**
 * How many orgs ingested session data inside the freshness window. Gauge — a
 * platform-wide `0` is the "nothing is ingesting anywhere" page, which no
 * per-org signal can express.
 *
 * ISS-4829: the caller WITHHOLDS this emission for a run in which the whole
 * platform is quiet — no org active, none stalled, at least one quiet, and the
 * fleet still checking in. A `0` there is a weekend/overnight lull, and pushing
 * it would page on ordinary inactivity exactly the way `stalled_orgs` did before
 * ISS-4678. `quietOrgCount` rides along on the runs that DO emit so the quiet
 * population is legible from the alert itself.
 */
export function emitSessionIngestionActiveOrgs(
  activeOrgCount: number,
  windowHours: number,
  quietOrgCount: number
): void {
  emitTelemetryMetric<SessionIngestionActiveOrgsMetric>({
    metric: FilterToken.SessionIngestionActiveOrgs,
    value: activeOrgCount,
    windowHours,
    quietOrgCount,
  });
}
