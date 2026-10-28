import { JiraWebhookEvent } from "../constants";
import {
  BOT_ACCOUNT_ID,
  BOT_DC_KEY,
  BOT_DC_NAME,
  BOT_EMAIL,
  CLOUD_SITE_URL,
  HUMAN_ACCOUNT_ID,
} from "./jira.test-helpers";

/**
 * Realistic Jira payloads (shapes from the Atlassian webhook docs, the REST
 * v2/v3 OpenAPI specs and captured deliveries), trimmed to what matters.
 */

/** 2026-10-04T11:59:00.000Z */
export const WEBHOOK_TIMESTAMP = Date.UTC(2026, 9, 4, 11, 59, 0);

export const HUMAN_USER = {
  self: `${CLOUD_SITE_URL}/rest/api/2/user?accountId=${HUMAN_ACCOUNT_ID}`,
  accountId: HUMAN_ACCOUNT_ID,
  avatarUrls: {},
  displayName: "Bea Analyst",
  active: true,
  timeZone: "Europe/Berlin",
  accountType: "atlassian",
};

export const BOT_USER = {
  self: `${CLOUD_SITE_URL}/rest/api/2/user?accountId=${BOT_ACCOUNT_ID}`,
  accountId: BOT_ACCOUNT_ID,
  displayName: "AgentFlow Bot",
  active: true,
  timeZone: "Europe/Berlin",
  accountType: "atlassian",
};

export function webhookIssue(
  overrides: { assignee?: unknown; labels?: string[]; key?: string } = {}
) {
  const key = overrides.key ?? "PROJ-123";
  return {
    id: "10042",
    self: `${CLOUD_SITE_URL}/rest/api/2/10042`,
    key,
    fields: {
      summary: "Add CSV export to the reports page",
      issuetype: {
        id: "10001",
        name: "Story",
        subtask: false,
      },
      project: {
        id: "10000",
        key: "PROJ",
        name: "Project",
        projectTypeKey: "software",
      },
      labels: overrides.labels ?? ["ai-ready", "reports"],
      status: {
        name: "To Do",
        statusCategory: { key: "new" },
      },
      priority: { id: "3", name: "Medium" },
      assignee:
        overrides.assignee === undefined ? BOT_USER : overrides.assignee,
      reporter: HUMAN_USER,
      creator: HUMAN_USER,
      description:
        "h2. Goal\nUsers can export the report as *CSV*.\n\n* one\n* two",
      created: "2026-10-04T11:58:12.345+0000",
      updated: "2026-10-04T11:59:00.000+0000",
    },
  };
}

/** Admin webhook: issue assigned to the bot (Cloud; account ids in tmp*AccountId). */
export function assignedToBotWebhook(
  overrides: { user?: unknown; to?: string | null; changelogId?: string } = {}
) {
  const to = overrides.to === undefined ? BOT_ACCOUNT_ID : overrides.to;
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: JiraWebhookEvent.IssueUpdated,
    issue_event_type_name: "issue_assigned",
    user: overrides.user ?? HUMAN_USER,
    issue: webhookIssue(),
    changelog: {
      id: overrides.changelogId ?? "10234",
      items: [
        {
          field: "assignee",
          fieldtype: "jira",
          fieldId: "assignee",
          from: null,
          fromString: null,
          to,
          toString: to === BOT_ACCOUNT_ID ? "AgentFlow Bot" : "Someone Else",
          tmpFromAccountId: null,
          tmpToAccountId: to,
        },
      ],
    },
  };
}

/** Admin webhook: labels changed ("reports" -> "reports ai-ready"). */
export function labelsAddedWebhook() {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: JiraWebhookEvent.IssueUpdated,
    issue_event_type_name: "issue_updated",
    user: HUMAN_USER,
    issue: webhookIssue({ assignee: null }),
    changelog: {
      id: "10301",
      items: [
        {
          field: "labels",
          fieldtype: "jira",
          fieldId: "labels",
          from: null,
          fromString: "reports",
          to: null,
          toString: "ai-ready reports",
        },
      ],
    },
  };
}

export function issueCreatedWebhook(
  overrides: { assignee?: unknown; labels?: string[] } = {}
) {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: JiraWebhookEvent.IssueCreated,
    issue_event_type_name: "issue_created",
    user: HUMAN_USER,
    issue: webhookIssue(overrides),
  };
}

/** Jira Automation "Send web request" with "Work item data (Jira format)". */
export function automationBody(overrides: { assignee?: unknown } = {}) {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    user: HUMAN_USER,
    issue: webhookIssue(overrides),
  };
}

/** Data Center admin webhook: users identified by name/key, no account ids. */
export function dataCenterAssignedWebhook() {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: JiraWebhookEvent.IssueUpdated,
    issue_event_type_name: "issue_assigned",
    user: {
      self: "https://jira.example.com/jira/rest/api/2/user?username=bea",
      name: "bea",
      key: "JIRAUSER10001",
      emailAddress: "bea@acme.com",
      displayName: "Bea Analyst",
    },
    issue: webhookIssue({
      assignee: {
        name: BOT_DC_NAME,
        key: BOT_DC_KEY,
        emailAddress: BOT_EMAIL,
        displayName: "AgentFlow Bot",
      },
    }),
    changelog: {
      id: "20410",
      items: [
        {
          field: "assignee",
          fieldtype: "jira",
          from: "bea",
          fromString: "Bea Analyst",
          to: BOT_DC_NAME,
          toString: "AgentFlow Bot",
        },
      ],
    },
  };
}

/** GET /rest/api/3/myself */
export const CLOUD_MYSELF = {
  self: `${CLOUD_SITE_URL}/rest/api/3/user?accountId=${BOT_ACCOUNT_ID}`,
  accountId: BOT_ACCOUNT_ID,
  accountType: "atlassian",
  emailAddress: BOT_EMAIL,
  displayName: "AgentFlow Bot",
  active: true,
  timeZone: "Europe/Berlin",
  locale: "en_US",
};

/** GET /rest/api/2/myself (Data Center) */
export const DC_MYSELF = {
  self: "https://jira.example.com/jira/rest/api/2/user?username=agentflow-bot",
  key: BOT_DC_KEY,
  name: BOT_DC_NAME,
  emailAddress: BOT_EMAIL,
  displayName: "AgentFlow Bot",
  active: true,
  timeZone: "America/New_York",
};

/** GET /rest/api/3/issue/10042?fields=*all,-comment&expand=renderedFields,names */
export function restIssue() {
  return {
    expand: "renderedFields,names,schema,operations",
    id: "10042",
    self: `${CLOUD_SITE_URL}/rest/api/3/issue/10042`,
    key: "PROJ-123",
    fields: {
      summary: "Add CSV export to the reports page",
      issuetype: { id: "10001", name: "Story" },
      project: { id: "10000", key: "PROJ", name: "Project" },
      labels: ["ai-ready", "reports"],
      status: { name: "To Do" },
      priority: { name: "High" },
      assignee: { accountId: BOT_ACCOUNT_ID, displayName: "AgentFlow Bot" },
      reporter: { accountId: HUMAN_ACCOUNT_ID, displayName: "Bea Analyst" },
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Users can export the report." }],
          },
        ],
      },
      customfield_10050: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Given a report" }],
          },
        ],
      },
      customfield_10051: null,
      attachment: [
        {
          self: `${CLOUD_SITE_URL}/rest/api/3/attachment/10500`,
          id: "10500",
          filename: "mockup.png",
          author: { accountId: HUMAN_ACCOUNT_ID },
          created: "2026-10-04T11:50:00.000+0000",
          size: 48_213,
          mimeType: "image/png",
          content: `${CLOUD_SITE_URL}/rest/api/3/attachment/content/10500`,
        },
      ],
    },
    renderedFields: {
      summary: null,
      description:
        '<h2>Goal</h2><p>Users can export the report as <b>CSV</b>.</p><ul><li>one</li><li>two</li></ul><script>alert("x")</script>',
      customfield_10050:
        "<ul><li>Given a report, when I click Export, then a CSV downloads</li></ul>",
      customfield_10051: null,
      attachment: [],
    },
    names: {
      summary: "Summary",
      description: "Description",
      customfield_10050: "Acceptance Criteria",
      customfield_10051: "Acceptance criteria (legacy)",
      attachment: "Attachment",
    },
  };
}

/** GET /rest/api/3/issue/10042/comment?orderBy=-created&expand=renderedBody (newest first) */
export function restCommentsNewestFirst() {
  return {
    startAt: 0,
    maxResults: 20,
    total: 2,
    comments: [
      {
        id: "20002",
        parentId: 20_001,
        author: { accountId: HUMAN_ACCOUNT_ID, displayName: "Bea Analyst" },
        body: { type: "doc", version: 1, content: [] },
        renderedBody: "<p>Please also support <i>semicolons</i>.</p>",
        created: "2026-10-04T11:55:00.000+0000",
      },
      {
        id: "20001",
        author: { accountId: HUMAN_ACCOUNT_ID, displayName: "Bea Analyst" },
        body: { type: "doc", version: 1, content: [] },
        renderedBody: "<p>First comment</p>",
        created: "2026-10-04T11:40:00.000+0000",
      },
    ],
  };
}

/** GET /rest/api/3/issue/10042/transitions */
export const TRANSITIONS = {
  expand: "transitions",
  transitions: [
    { id: "11", name: "Start progress", to: { id: "3", name: "In Progress" } },
    {
      id: "21",
      name: "Request review",
      to: { id: "10010", name: "In Review" },
    },
    { id: "31", name: "Done", to: { id: "10011", name: "Done" } },
  ],
};

type HistoryOptions = {
  id: string;
  created: string;
  author?: unknown;
  items: unknown[];
};

export function history(options: HistoryOptions) {
  return {
    id: options.id,
    author: options.author ?? HUMAN_USER,
    created: options.created,
    items: options.items,
  };
}

/** REST changelog item for an assignee change (Cloud: account ids in from/to). */
export function assigneeItem(from: string | null, to: string | null) {
  return {
    field: "assignee",
    fieldtype: "jira",
    fieldId: "assignee",
    from,
    fromString: from ? "Previous Assignee" : null,
    to,
    toString: to ? "New Assignee" : null,
  };
}

/** REST changelog item for a labels change (space-separated label lists). */
export function labelsItem(from: string, to: string) {
  return {
    field: "labels",
    fieldtype: "jira",
    fieldId: "labels",
    from: null,
    fromString: from,
    to: null,
    toString: to,
  };
}

export function statusItem(from: string, to: string) {
  return {
    field: "status",
    fieldtype: "jira",
    fieldId: "status",
    from: "10000",
    fromString: from,
    to: "10001",
    toString: to,
  };
}

export function statusChangedWebhook(options: {
  from: string;
  to: string;
  user?: unknown;
}) {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: JiraWebhookEvent.IssueUpdated,
    issue_event_type_name: "issue_generic",
    user: options.user ?? HUMAN_USER,
    issue: webhookIssue({ assignee: null }),
    changelog: {
      id: "10401",
      items: [statusItem(options.from, options.to)],
    },
  };
}

export function searchIssue(options: {
  id: string;
  key: string;
  created: string;
  updated: string;
  assignee?: unknown;
  histories?: unknown[];
  creator?: unknown;
  withChangelog?: boolean;
  changelogTotal?: number;
  labels?: string[];
}) {
  const histories = options.histories ?? [];
  return {
    id: options.id,
    key: options.key,
    fields: {
      summary: `Issue ${options.key}`,
      issuetype: { name: "Story" },
      project: { key: options.key.split("-")[0] },
      labels: options.labels ?? [],
      status: { name: "To Do" },
      assignee: options.assignee === undefined ? BOT_USER : options.assignee,
      creator: options.creator ?? HUMAN_USER,
      reporter: HUMAN_USER,
      created: options.created,
      updated: options.updated,
    },
    ...(options.withChangelog === false
      ? {}
      : {
          changelog: {
            startAt: 0,
            maxResults: histories.length,
            total: options.changelogTotal ?? histories.length,
            histories,
          },
        }),
  };
}
