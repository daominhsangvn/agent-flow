import type { JsonValue } from "@repo/api/src/types/common";
import pLimit from "p-limit";
import { z } from "zod";
import {
  HttpMethod,
  type InboundEvent,
  type IntegrationAccount,
  type PollResult,
} from "../../types";
import {
  ADO_API_VERSION,
  type AdoContext,
  AdoErrorKind,
  adoRequest,
} from "./client";
import { AdoField } from "./constants";
import {
  type AdoWorkItemState,
  adoWorkItemState,
  eventsFromWorkItemUpdate,
  parseAdoDate,
  splitAdoTags,
} from "./events";
import { isAdoBotIdentity } from "./identity";
import {
  type AdoWorkItem,
  type AdoWorkItemFields,
  type AdoWorkItemUpdate,
  adoWiqlResultSchema,
  adoWorkItemBatchSchema,
  adoWorkItemUpdatesSchema,
  readWorkItemFields,
} from "./schemas";

/**
 * Poll mode: finds work items assigned to the bot (`@Me` = the PAT owner)
 * that changed since the cursor, then reads their recent updates to emit the
 * same events, with the same dedupKeys, as the service hooks would:
 *   - an update whose System.AssignedTo became the bot -> work_item_assigned
 *   - an update that added tags                        -> work_item_tagged
 *   - either, or a comment mentioning the bot           -> work_item_conditions,
 *     with the assignee and tags right after that update, replayed back from
 *     the current work item through the updates' old values
 * Tag triggers therefore only see items assigned to the bot in poll mode.
 *
 * Cursor: `{since}`. Each poll queries `[System.ChangedDate] >= since - 2 min`
 * (ADO search lags slightly behind writes; the overlap is absorbed by the
 * dedupKeys) and advances `since` to max(latest change seen, now - 1 min).
 * When the result is capped, `since` only advances to the latest change seen,
 * so the next poll continues where this one stopped.
 */

export const ADO_POLL_MAX_ITEMS = 50;

export async function pollAzureDevOps(
  ctx: AdoContext,
  cursor: JsonValue | null
): Promise<PollResult> {
  const account = ctx.connection.account;
  if (!account) {
    throw new Error(
      "The connection has no verified Azure DevOps account. Test the connection, then try again."
    );
  }
  const now = ctx.now();
  const since =
    readCursorSince(cursor) ?? new Date(now.getTime() - FIRST_POLL_LOOKBACK_MS);
  const windowStart = new Date(since.getTime() - QUERY_OVERLAP_MS);

  const ids = await queryChangedWorkItemIds(ctx, windowStart);
  for (const id of await queryMentionedWorkItemIds(ctx, windowStart)) {
    if (!ids.includes(id) && ids.length < ADO_POLL_MAX_ITEMS) {
      ids.push(id);
    }
  }
  const items = await fetchWorkItems(ctx, ids);
  const limit = pLimit(UPDATE_FETCH_CONCURRENCY);
  const perItem = await Promise.all(
    items.map((item) =>
      limit(() => collectItemEvents(ctx, item, account, windowStart))
    )
  );

  const latestChange = latestChangedDate(items);
  const capped = ids.length >= ADO_POLL_MAX_ITEMS;
  const floor = capped ? null : new Date(now.getTime() - CURSOR_FLOOR_MS);
  return {
    events: perItem.flat(),
    cursor: {
      since: (maxDate([since, latestChange, floor]) ?? since).toISOString(),
    },
  };
}

const FIRST_POLL_LOOKBACK_MS = 5 * 60_000;
const QUERY_OVERLAP_MS = 2 * 60_000;
const CURSOR_FLOOR_MS = 60_000;
const UPDATE_FETCH_CONCURRENCY = 4;
/** Only the latest revisions of an item are inspected (assignments are recent by construction). */
const REVISION_WINDOW = 200;
const UPDATES_PAGE_SIZE = 200;
const MAX_UPDATE_PAGES = 5;
const SUMMARY_FIELDS = [
  AdoField.Title,
  AdoField.TeamProject,
  AdoField.WorkItemType,
  AdoField.AreaPath,
  AdoField.State,
  AdoField.Tags,
  AdoField.AssignedTo,
  AdoField.ChangedDate,
].join(",");

const pollCursorSchema = z.object({ since: z.iso.datetime({ offset: true }) });

function readCursorSince(cursor: JsonValue | null): Date | null {
  const parsed = pollCursorSchema.safeParse(cursor);
  return parsed.success ? new Date(parsed.data.since) : null;
}

async function queryChangedWorkItemIds(
  ctx: AdoContext,
  windowStart: Date
): Promise<number[]> {
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: "_apis/wit/wiql",
      query: {
        "api-version": ADO_API_VERSION,
        $top: ADO_POLL_MAX_ITEMS,
        timePrecision: true,
      },
      body: { query: buildChangedWorkItemsQuery(windowStart) },
    },
    adoWiqlResultSchema
  );
  if (!result.ok) {
    throw new Error(
      `Azure DevOps work item query failed: ${result.error.message}`
    );
  }
  return (result.value.workItems ?? [])
    .map((workItem) => workItem.id)
    .slice(0, ADO_POLL_MAX_ITEMS);
}

/**
 * Items whose comments mentioned the bot (`@RecentMentions`, last 30 days)
 * and that changed in the window. Best effort: an organization whose WIQL
 * does not support the macro still polls assignments and tags.
 */
async function queryMentionedWorkItemIds(
  ctx: AdoContext,
  windowStart: Date
): Promise<number[]> {
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: "_apis/wit/wiql",
      query: {
        "api-version": ADO_API_VERSION,
        $top: ADO_POLL_MAX_ITEMS,
        timePrecision: true,
      },
      body: { query: buildMentionedWorkItemsQuery(windowStart) },
    },
    adoWiqlResultSchema
  );
  if (!result.ok) {
    ctx.log.warn("Azure DevOps mention query failed; skipping mentions", {
      error: result.error.message,
    });
    return [];
  }
  return (result.value.workItems ?? []).map((workItem) => workItem.id);
}

/** WIQL for items that mentioned the PAT owner and changed at or after `windowStart`. */
export function buildMentionedWorkItemsQuery(windowStart: Date): string {
  return [
    "SELECT [System.Id] FROM WorkItems",
    "WHERE [System.Id] IN (@RecentMentions)",
    `AND [System.ChangedDate] >= '${windowStart.toISOString()}'`,
    "ORDER BY [System.ChangedDate] ASC",
  ].join(" ");
}

/** WIQL for items assigned to the PAT owner that changed at or after `windowStart` (UTC ISO 8601). */
export function buildChangedWorkItemsQuery(windowStart: Date): string {
  return [
    "SELECT [System.Id] FROM WorkItems",
    "WHERE [System.AssignedTo] = @Me",
    `AND [System.ChangedDate] >= '${windowStart.toISOString()}'`,
    "ORDER BY [System.ChangedDate] ASC",
  ].join(" ");
}

/** Current rev and filter fields of the candidate items in one request. */
async function fetchWorkItems(
  ctx: AdoContext,
  ids: number[]
): Promise<AdoWorkItem[]> {
  if (ids.length === 0) {
    return [];
  }
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: "_apis/wit/workitems",
      query: {
        ids: ids.join(","),
        fields: SUMMARY_FIELDS,
        errorPolicy: "omit",
        "api-version": ADO_API_VERSION,
      },
    },
    adoWorkItemBatchSchema
  );
  if (!result.ok) {
    throw new Error(
      `Azure DevOps work item fetch failed: ${result.error.message}`
    );
  }
  return result.value.value.filter(
    (item): item is AdoWorkItem => item !== null
  );
}

async function collectItemEvents(
  ctx: AdoContext,
  item: AdoWorkItem,
  account: IntegrationAccount,
  windowStart: Date
): Promise<InboundEvent[]> {
  const updates = await listRecentUpdates(ctx, item);
  const fields = readWorkItemFields(item.fields);
  const states = replayWorkItemStates(
    updates,
    adoWorkItemState(fields, account),
    account
  );
  const events: InboundEvent[] = [];
  updates.forEach((update, index) => {
    events.push(
      ...eventsForUpdate(ctx, {
        workItemId: item.id,
        update,
        fields,
        state: states[index],
        account,
        windowStart,
      })
    );
  });
  return events;
}

function eventsForUpdate(
  ctx: AdoContext,
  input: {
    workItemId: number;
    update: AdoWorkItemUpdate;
    fields: AdoWorkItemFields;
    state: AdoWorkItemState | undefined;
    account: IntegrationAccount;
    windowStart: Date;
  }
): InboundEvent[] {
  const changedAt = parseAdoDate(
    input.update.fields?.[AdoField.ChangedDate]?.newValue
  );
  if (!changedAt || changedAt < input.windowStart) {
    return [];
  }
  return eventsFromWorkItemUpdate({
    organizationUrl: ctx.connection.config.organizationUrl,
    workItemId: input.workItemId,
    update: input.update,
    fields: input.fields,
    projectFallback: null,
    account: input.account,
    occurredAtFallback: changedAt,
    state: input.state,
  }).events;
}

/**
 * Updates of the latest REVISION_WINDOW revisions. Every revision has at
 * least one update (link-only updates share a rev), so skipping `rev -
 * window` updates never skips a recent revision.
 */
async function listRecentUpdates(
  ctx: AdoContext,
  item: AdoWorkItem
): Promise<AdoWorkItemUpdate[]> {
  const updates: AdoWorkItemUpdate[] = [];
  let skip = Math.max(0, (item.rev ?? 0) - REVISION_WINDOW);
  for (let page = 0; page < MAX_UPDATE_PAGES; page += 1) {
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: `_apis/wit/workItems/${item.id}/updates`,
        query: {
          $top: UPDATES_PAGE_SIZE,
          $skip: skip,
          "api-version": ADO_API_VERSION,
        },
      },
      adoWorkItemUpdatesSchema
    );
    if (!result.ok) {
      // Deleted since the query: nothing left to report.
      if (result.error.kind === AdoErrorKind.NotFound) {
        return [];
      }
      throw new Error(
        `Azure DevOps update history of work item #${item.id} failed: ${result.error.message}`
      );
    }
    updates.push(...result.value.value);
    if (result.value.value.length < UPDATES_PAGE_SIZE) {
      return updates;
    }
    skip += UPDATES_PAGE_SIZE;
  }
  ctx.log.warn("Azure DevOps update history truncated", {
    workItemId: item.id,
    inspected: updates.length,
  });
  return updates;
}

function latestChangedDate(items: AdoWorkItem[]): Date | null {
  return maxDate(
    items.map((item) =>
      parseAdoDate(readWorkItemFields(item.fields)[AdoField.ChangedDate])
    )
  );
}

function maxDate(dates: Array<Date | null>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (date && (!latest || date > latest)) {
      latest = date;
    }
  }
  return latest;
}

/**
 * The assignee and tags right after each update (same order as `updates`,
 * oldest first), walked back from the current state: undoing an update
 * restores the old values of the fields it changed.
 */
function replayWorkItemStates(
  updates: readonly AdoWorkItemUpdate[],
  current: AdoWorkItemState,
  account: IntegrationAccount
): AdoWorkItemState[] {
  const after: AdoWorkItemState[] = [];
  let state = current;
  for (let index = updates.length - 1; index >= 0; index--) {
    after[index] = state;
    state = undoUpdate(state, updates[index], account);
  }
  return after;
}

function undoUpdate(
  state: AdoWorkItemState,
  update: AdoWorkItemUpdate | undefined,
  account: IntegrationAccount
): AdoWorkItemState {
  const assignedTo = update?.fields?.[AdoField.AssignedTo];
  const tags = update?.fields?.[AdoField.Tags];
  return {
    assignedToBot: assignedTo
      ? isAdoBotIdentity(assignedTo.oldValue, account)
      : state.assignedToBot,
    tags: tags ? splitAdoTags(tags.oldValue) : state.tags,
  };
}
