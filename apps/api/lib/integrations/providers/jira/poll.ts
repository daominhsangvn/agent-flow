import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import {
  HttpMethod,
  type InboundEvent,
  type IntegrationAccount,
  type PollResult,
} from "../../types";
import {
  type JiraContext,
  type JiraError,
  jiraIssuePath,
  jiraRequest,
} from "./client";
import { JiraDeployment } from "./constants";
import { parseJiraDate } from "./dates";
import { isJiraBotUser, jiraUserActor } from "./identity";
import {
  assignsFromBot,
  assignsToBot,
  isAssignedToBot,
  isAssigneeChange,
  type JiraIssueOccurrence,
  jiraAssignedEvent,
} from "./issue-events";
import {
  type JiraHistory,
  type JiraIssue,
  type JiraSearchResult,
  jiraChangelogPageSchema,
  jiraIssueSchema,
  jiraPollCursorSchema,
  jiraSearchResultSchema,
} from "./schemas";

/**
 * Poll mode: every scheduler tick (per the connection's poll interval) asks
 * Jira, as the bot, for issues assigned to it that changed recently, and
 * emits `jira.issue_assigned` events for assignments that happened in the
 * window. dedupKeys match the webhook path ("{key}:assignee:{historyId}",
 * "{key}:created"), so overlapping windows and mode switches never duplicate
 * runs.
 *
 * - The JQL window is relative (`updated >= "-Nm"`), so it does not depend
 *   on the bot's time zone; events are then filtered by exact timestamps.
 * - Windows overlap by two minutes, and the cursor stays one minute behind
 *   now, to absorb clock skew and search index lag.
 * - At most 50 issues per poll (oldest change first); when more match, the
 *   cursor advances to the newest issue seen and the next poll continues.
 * - `jira.issue_labeled` is not polled: Jira search cannot tell when a label
 *   was added (labels are not supported by `CHANGED`), and polling every
 *   labeled issue on the site would flood the delivery log.
 */

export const JIRA_POLL_MAX_ISSUES = 50;

const MINUTE_MS = 60_000;
/** First poll (null cursor): no backlog older than this. */
const FIRST_POLL_LOOKBACK_MS = 5 * MINUTE_MS;
/** A cursor older than this (polling was off for a long time) is clamped: no flood of stale runs. */
const MAX_LOOKBACK_MS = 24 * 60 * MINUTE_MS;
const WINDOW_OVERLAP_MS = 2 * MINUTE_MS;
const INDEX_LAG_MS = MINUTE_MS;
/** Minimum cursor progress when a full page did not move past the cursor. */
const MIN_PROGRESS_MS = MINUTE_MS;
/** Cloud `GET /issue/{id}/changelog` page size. */
const CHANGELOG_PAGE_SIZE = 100;

const POLL_FIELDS = [
  "summary",
  "issuetype",
  "labels",
  "status",
  "assignee",
  "reporter",
  "creator",
  "project",
  "created",
  "updated",
].join(",");

export const JIRA_POLL_BOT_UNKNOWN_ERROR =
  "The bot account of this Jira connection is unknown. Test the connection to look it up.";

export async function pollJira(
  ctx: JiraContext,
  cursor: JsonValue | null
): Promise<PollResult> {
  const account = ctx.connection.account;
  if (!account) {
    throw new Error(JIRA_POLL_BOT_UNKNOWN_ERROR);
  }
  const now = ctx.now();
  const since = resolveSince(cursor, now);
  const windowStart = new Date(since.getTime() - WINDOW_OVERLAP_MS);
  const page = await searchAssignedIssues(ctx, windowStart, now);
  if (!page.ok) {
    throw new Error(`Jira search failed: ${page.error.message}`);
  }
  const events: InboundEvent[] = [];
  for (const issue of page.value.issues) {
    const histories = await loadHistories(ctx, issue);
    if (!histories.ok) {
      throw new Error(
        `Could not read the changelog of ${issue.key}: ${histories.error.message}`
      );
    }
    events.push(
      ...issueAssignmentEvents({
        siteUrl: ctx.connection.config.siteUrl,
        issue,
        histories: histories.value,
        windowStart,
        account,
      })
    );
  }
  if (page.value.truncated) {
    ctx.log.warn("Jira poll returned a full page; continuing next poll", {
      connectionId: ctx.connection.id,
      issues: page.value.issues.length,
    });
  }
  const next = nextSince({
    since,
    now,
    issues: page.value.issues,
    truncated: page.value.truncated,
  });
  return { events, cursor: { since: next.toISOString() } };
}

type SearchPage = { issues: JiraIssue[]; truncated: boolean };

async function searchAssignedIssues(
  ctx: JiraContext,
  windowStart: Date,
  now: Date
): Promise<Result<SearchPage, JiraError>> {
  const minutes = Math.max(
    1,
    Math.ceil((now.getTime() - windowStart.getTime()) / MINUTE_MS) + 1
  );
  const result = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path:
        ctx.connection.config.deployment === JiraDeployment.Cloud
          ? "search/jql"
          : "search",
      query: {
        jql: `assignee = currentUser() AND updated >= "-${minutes}m" ORDER BY updated ASC`,
        fields: POLL_FIELDS,
        expand: "changelog",
        maxResults: JIRA_POLL_MAX_ISSUES,
      },
    },
    jiraSearchResultSchema
  );
  if (!result.ok) {
    return result;
  }
  const issues = result.value.issues ?? [];
  return Result.ok({
    issues: issues.slice(0, JIRA_POLL_MAX_ISSUES),
    truncated:
      issues.length > JIRA_POLL_MAX_ISSUES || hasMoreResults(result.value),
  });
}

/**
 * The changelog that came with the search result; fetched separately when
 * the search did not include it, and (Cloud) completed with the newest page
 * when Jira returned only part of a long history.
 */
async function loadHistories(
  ctx: JiraContext,
  issue: JiraIssue
): Promise<Result<JiraHistory[], JiraError>> {
  let changelog = issue.changelog;
  if (!changelog?.histories) {
    const fetched = await jiraRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: jiraIssuePath(issue.id),
        query: { fields: "assignee", expand: "changelog" },
      },
      jiraIssueSchema
    );
    if (!fetched.ok) {
      return fetched;
    }
    changelog = fetched.value.changelog;
  }
  const histories = changelog?.histories ?? [];
  const total = changelog?.total ?? histories.length;
  if (
    total <= histories.length ||
    ctx.connection.config.deployment !== JiraDeployment.Cloud
  ) {
    return Result.ok(histories);
  }
  return await loadNewestHistories(ctx, issue, histories, total);
}

async function loadNewestHistories(
  ctx: JiraContext,
  issue: JiraIssue,
  partial: JiraHistory[],
  total: number
): Promise<Result<JiraHistory[], JiraError>> {
  const page = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(issue.id, "changelog"),
      query: {
        startAt: Math.max(0, total - CHANGELOG_PAGE_SIZE),
        maxResults: CHANGELOG_PAGE_SIZE,
      },
    },
    jiraChangelogPageSchema
  );
  if (!page.ok) {
    return page;
  }
  const byId = new Map(partial.map((history) => [history.id, history]));
  for (const history of page.value.values ?? []) {
    byId.set(history.id, history);
  }
  return Result.ok([...byId.values()]);
}

type IssueEventsInput = {
  siteUrl: string;
  issue: JiraIssue;
  histories: JiraHistory[];
  windowStart: Date;
  account: IntegrationAccount;
};

/** Assignments to the bot inside the window, oldest first. Changes made by the bot are skipped. */
export function issueAssignmentEvents(input: IssueEventsInput): InboundEvent[] {
  const histories = sortByCreated(input.histories);
  const events = histories
    .filter((history) => isRecentAssignmentToBot(history, input))
    .map((history) =>
      jiraAssignedEvent(
        occurrence(input, parseJiraDate(history.created), history.author),
        history.id
      )
    );
  const created = createdAssignedEvent(input, histories);
  return created ? [created, ...events] : events;
}

function isRecentAssignmentToBot(
  history: JiraHistory,
  input: IssueEventsInput
): boolean {
  const created = parseJiraDate(history.created);
  if (!created || created < input.windowStart) {
    return false;
  }
  if (isJiraBotUser(input.account, history.author)) {
    return false;
  }
  return (history.items ?? []).some((item) =>
    assignsToBot(item, input.account)
  );
}

/** An issue created in the window with the bot as its first assignee. */
function createdAssignedEvent(
  input: IssueEventsInput,
  sortedHistories: JiraHistory[]
): InboundEvent | null {
  const fields = input.issue.fields;
  const createdAt = parseJiraDate(fields.created);
  if (!createdAt || createdAt < input.windowStart) {
    return null;
  }
  if (isJiraBotUser(input.account, fields.creator)) {
    return null;
  }
  const firstAssigneeChange = sortedHistories
    .flatMap((history) => history.items ?? [])
    .find(isAssigneeChange);
  const createdWithBot = firstAssigneeChange
    ? assignsFromBot(firstAssigneeChange, input.account)
    : isAssignedToBot(input.issue, input.account);
  if (!createdWithBot) {
    return null;
  }
  return jiraAssignedEvent(
    occurrence(input, createdAt, fields.creator ?? fields.reporter),
    null
  );
}

function occurrence(
  input: IssueEventsInput,
  occurredAt: Date | null,
  actor: JiraHistory["author"]
): JiraIssueOccurrence {
  return {
    siteUrl: input.siteUrl,
    issue: input.issue,
    occurredAt: occurredAt ?? input.windowStart,
    actor: jiraUserActor(actor),
  };
}

function resolveSince(cursor: JsonValue | null, now: Date): Date {
  const oldest = new Date(now.getTime() - MAX_LOOKBACK_MS);
  const parsed = jiraPollCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    return new Date(now.getTime() - FIRST_POLL_LOOKBACK_MS);
  }
  const since = new Date(parsed.data.since);
  if (since < oldest) {
    return oldest;
  }
  // A cursor ahead of this clock (Jira's clock is ahead) never skips the present.
  return since > now ? now : since;
}

type NextSinceInput = {
  since: Date;
  now: Date;
  issues: JiraIssue[];
  truncated: boolean;
};

/**
 * Complete page: everything up to one minute ago is covered (or up to the
 * newest change seen). Truncated page: continue from the newest change seen,
 * moving at least a minute forward so a burst of simultaneous changes cannot
 * stall polling.
 */
function nextSince(input: NextSinceInput): Date {
  const newestUpdate = latestDate(
    input.issues.map((issue) => parseJiraDate(issue.fields.updated))
  );
  const floor = input.truncated
    ? new Date(input.since.getTime() + MIN_PROGRESS_MS)
    : new Date(input.now.getTime() - INDEX_LAG_MS);
  return latestDate([newestUpdate, floor, input.since]) ?? floor;
}

function hasMoreResults(result: JiraSearchResult): boolean {
  if (result.nextPageToken || result.isLast === false) {
    return true;
  }
  if (typeof result.total !== "number") {
    return false;
  }
  return (result.startAt ?? 0) + (result.issues?.length ?? 0) < result.total;
}

function sortByCreated(histories: JiraHistory[]): JiraHistory[] {
  return [...histories].sort(
    (left, right) =>
      (parseJiraDate(left.created)?.getTime() ?? 0) -
      (parseJiraDate(right.created)?.getTime() ?? 0)
  );
}

function latestDate(dates: ReadonlyArray<Date | null>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (date && (!latest || date > latest)) {
      latest = date;
    }
  }
  return latest;
}
