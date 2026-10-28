import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  caseSourceKey,
  channelKeyFor,
  readChannel,
  withLatestExtras,
} from "@/lib/orchestrator/channel";

const JIRA_ITEM = {
  provider: IntegrationProviderKey.Jira,
  externalId: "10001",
  key: "LD-7",
  url: "https://acme.atlassian.net/browse/LD-7",
  title: "Half-day leave",
  container: "LD",
};

const TEAMS_ITEM = {
  provider: IntegrationProviderKey.MicrosoftTeams,
  externalId: "team|channel|root|msg",
  key: "teams-abc123",
  url: null,
  title: "Can part-timers take half a day?",
  container: "channel",
};

describe("conversation channels", () => {
  it("puts every message about one item in one case", () => {
    expect(caseSourceKey(JIRA_ITEM)).toBe("jira:LD-7");
  });

  it("keeps a Jira comment thread apart from the issue's top level", () => {
    expect(channelKeyFor(JIRA_ITEM, null)).toBe("jira:LD-7:item");
    expect(channelKeyFor(JIRA_ITEM, "20017")).toBe("jira:LD-7:comment:20017");
  });

  it("makes a Teams thread one conversation, replies included", () => {
    expect(channelKeyFor(TEAMS_ITEM, null)).toBe(
      "microsoft_teams:teams-abc123"
    );
    expect(channelKeyFor(TEAMS_ITEM, "root")).toBe(
      "microsoft_teams:teams-abc123"
    );
  });

  it("keeps the newest extras so answers mention whoever asked last", () => {
    const channel = { item: TEAMS_ITEM, parentId: null, extras: { a: 1 } };
    expect(withLatestExtras(channel, { a: 2 }).extras).toEqual({ a: 2 });
    expect(withLatestExtras(channel, undefined).extras).toEqual({ a: 1 });
  });

  it("reads a stored channel, or null when it no longer parses", () => {
    expect(
      readChannel({ item: JIRA_ITEM, parentId: null, extras: null })
    ).toEqual({ item: JIRA_ITEM, parentId: null, extras: null });
    expect(readChannel({ item: "LD-7" })).toBeNull();
  });
});
