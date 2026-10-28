import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SCOPE_OPTIONS,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { z } from "zod";
import { canonicalizeTimeZone } from "@/lib/date-only";

// FEA-2745: the caller's IANA timezone used to label the daily buckets in the
// requester's local calendar (matching the desktop shell, which buckets in
// local time via localDay()). Unknown or malformed zones are silently dropped
// so the server falls back to UTC bucketing rather than 400-ing a chart
// request.
//
// FEA-2881 (review): `Intl` also accepts offset-style zones like `+01:00`, but
// PostgreSQL's `AT TIME ZONE 'text'` operator interprets bare offsets with an
// inverted sign, so an un-normalized offset buckets SQL rows onto the wrong
// local day (misaligned with the `Intl`-labeled response keys). Canonicalize
// here — the single seam every downstream consumer (SQL `date_trunc` bucketing
// and JS day-key labeling) reads from — so offsets become their equivalent
// `Etc/GMT±N` IANA name (which PG and `Intl` interpret identically) and any zone
// that can't be safely canonicalized falls back to UTC.
const timeZoneValidator = z
  .string()
  .optional()
  .transform((timeZone) =>
    timeZone ? (canonicalizeTimeZone(timeZone) ?? undefined) : undefined
  );

const rawInsightsQueryValidator = z
  .object({
    period: z.enum(INSIGHTS_PERIOD_OPTIONS).default(InsightsPeriod.Quarter),
    scope: z.enum(INSIGHTS_SCOPE_OPTIONS).default(InsightsScope.Me),
    timeZone: timeZoneValidator,
  })
  .strict();

export const insightsQueryValidator = rawInsightsQueryValidator;

export type InsightsQuery = z.infer<typeof insightsQueryValidator>;
