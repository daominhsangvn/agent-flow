/**
 * Jira timestamps: REST and changelog dates look like
 * `2026-10-04T10:15:30.123+0000` (offset without a colon); webhook
 * `timestamp` is epoch milliseconds (a number, or a numeric string in some
 * Automation bodies), and so are issue `created` / `updated` in Automation
 * "Issue data (Jira format)" bodies.
 */

const COLONLESS_OFFSET_RE = /([+-]\d{2})(\d{2})$/;
const DIGITS_RE = /^\d+$/;

export function parseJiraDate(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const offset = COLONLESS_OFFSET_RE.exec(trimmed);
  const normalized = offset
    ? `${trimmed.slice(0, offset.index)}${offset[1]}:${offset[2]}`
    : trimmed;
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : new Date(time);
}

export function parseEpochMillis(
  value: number | string | null | undefined
): Date | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  const trimmed = value?.trim();
  if (!(trimmed && DIGITS_RE.test(trimmed))) {
    return null;
  }
  return new Date(Number(trimmed));
}

/** ISO string of a Jira date, or the raw value when it does not parse. */
export function toIsoDate(value: string | null | undefined): string | null {
  return parseJiraDate(value)?.toISOString() ?? value ?? null;
}

/** ISO string of an epoch-milliseconds value, or null when it is not a valid date. */
export function epochMillisToIso(value: number): string | null {
  const date = parseEpochMillis(value);
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}
