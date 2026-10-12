import { describe, expect, it } from "vitest";
import {
  AdoField,
  AdoServiceHookEventType,
  AzureDevOpsTriggerType,
} from "@/lib/integrations/providers/azure-devops/constants";
import {
  eventsFromCommentedWorkItem,
  eventsFromWorkItemUpdate,
  mentionsAdoBot,
} from "@/lib/integrations/providers/azure-devops/events";
import { buildMentionedWorkItemsQuery } from "@/lib/integrations/providers/azure-devops/poll";
import { readWorkItemFields } from "@/lib/integrations/providers/azure-devops/schemas";
import {
  BOT,
  botAccount,
  HUMAN,
  identityRef,
  TEST_NOW,
  TEST_ORG_URL,
  TEST_PROJECT,
  TEST_WORK_ITEM_ID,
} from "./azure-devops.test-fixtures";

function mentionHtml(id: string, name = "AgentFlow Bot"): string {
  return `<div><a href="#" data-vss-mention="version:2.0,${id}">@${name}</a> please take this one</div>`;
}

const rawFields = {
  [AdoField.Title]: "Export orders as CSV",
  [AdoField.TeamProject]: TEST_PROJECT,
  [AdoField.WorkItemType]: "User Story",
};
const fields = readWorkItemFields(rawFields);

describe("mentionsAdoBot", () => {
  it("matches the bot's identity id in a mention, case-insensitively", () => {
    expect(mentionsAdoBot(mentionHtml(BOT.id.toUpperCase()), botAccount)).toBe(
      true
    );
    expect(mentionsAdoBot(mentionHtml(HUMAN.id), botAccount)).toBe(false);
    expect(mentionsAdoBot("@AgentFlow Bot", botAccount)).toBe(false);
    expect(mentionsAdoBot(undefined, botAccount)).toBe(false);
  });
});

describe("work item mentioned events", () => {
  it("emits one event for an update whose comment mentions the bot", () => {
    const result = eventsFromWorkItemUpdate({
      organizationUrl: TEST_ORG_URL,
      workItemId: TEST_WORK_ITEM_ID,
      update: {
        id: 9,
        workItemId: TEST_WORK_ITEM_ID,
        rev: 7,
        revisedBy: identityRef(HUMAN),
        fields: {
          [AdoField.History]: { newValue: mentionHtml(BOT.id) },
          [AdoField.ChangedDate]: { newValue: TEST_NOW.toISOString() },
        },
      },
      fields,
      projectFallback: null,
      account: botAccount,
      occurredAtFallback: TEST_NOW,
    });

    expect(result.ignoredReason).toBeNull();
    expect(result.events).toMatchObject([
      {
        triggerType: AzureDevOpsTriggerType.WorkItemMentioned,
        dedupKey: `${TEST_WORK_ITEM_ID}:mention:7`,
        item: { key: `#${TEST_WORK_ITEM_ID}` },
      },
    ]);
  });

  it("reads a workitem.commented resource and ignores the bot's own comments", () => {
    const workItem = {
      id: TEST_WORK_ITEM_ID,
      rev: 8,
      fields: {
        ...rawFields,
        [AdoField.History]: mentionHtml(BOT.id),
        [AdoField.ChangedBy]: identityRef(HUMAN),
      },
    };
    const common = {
      organizationUrl: TEST_ORG_URL,
      projectFallback: null,
      account: botAccount,
      occurredAtFallback: TEST_NOW,
    };

    const fromHuman = eventsFromCommentedWorkItem({ ...common, workItem });
    const fromBot = eventsFromCommentedWorkItem({
      ...common,
      workItem: {
        ...workItem,
        fields: { ...workItem.fields, [AdoField.ChangedBy]: identityRef(BOT) },
      },
    });

    expect(fromHuman.events.map((event) => event.dedupKey)).toEqual([
      `${TEST_WORK_ITEM_ID}:mention:8`,
    ]);
    expect(fromBot.events).toEqual([]);
    expect(AdoServiceHookEventType.WorkItemCommented).toBe(
      "workitem.commented"
    );
  });

  it("polls mentions with the @RecentMentions macro", () => {
    expect(
      buildMentionedWorkItemsQuery(new Date("2026-10-05T10:00:00.000Z"))
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (@RecentMentions) AND [System.ChangedDate] >= '2026-10-05T10:00:00.000Z' ORDER BY [System.ChangedDate] ASC"
    );
  });
});
