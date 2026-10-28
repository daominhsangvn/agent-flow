import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
} from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrchestratorDbFake,
  ORG_ID,
  type OrchestratorDbFake,
  PROJECT_CONNECTION_ID,
  PROJECT_ID,
} from "@/__tests__/support/orchestrator/orchestrator-db.test-fake";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import type { InboundEvent } from "@/lib/integrations/types";
import { routeToOrchestrator } from "@/lib/orchestrator/inbound";

/**
 * External requests reach an orchestrated workflow's orchestrator by a matching trigger of
 * an orchestrated workflow, or by replying to a message it posted; the
 * conversation is found without a model (docs/orchestrator.md).
 */

const mocks = vi.hoisted(() => ({
  fake: null as OrchestratorDbFake | null,
  advance: vi.fn(() => Promise.resolve()),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb };
});
vi.mock("@/lib/orchestrator/advance", () => ({
  advanceConversation: mocks.advance,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f1";

let fake: OrchestratorDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createOrchestratorDbFake();
  mocks.fake = fake;
  fake.addWorkflow(WORKFLOW_ID, "Questions on tickets");
});

function connection(answerReply?: (event: InboundEvent) => string | null) {
  return {
    record: { id: "conn-1", organizationId: ORG_ID },
    provider: { answerReply },
  } as unknown as LoadedConnection;
}

function mention(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    triggerType: "jira.issue_mentioned",
    dedupKey: "LD-7:mention:comment-500",
    occurredAt: new Date("2026-10-23T08:00:00.000Z"),
    actor: { id: "u-1", displayName: "An" },
    item: {
      provider: IntegrationProviderKey.Jira,
      externalId: "10001",
      key: "LD-7",
      url: "https://acme.atlassian.net/browse/LD-7",
      title: "Half-day leave",
      container: "LD",
    },
    attributes: {},
    message: {
      id: "500",
      parentId: null,
      text: "@bot what does the policy say?",
    },
    ...overrides,
  };
}

const WORKFLOWS = [{ workflowId: WORKFLOW_ID, projectId: PROJECT_ID }];

describe("routeToOrchestrator", () => {
  it("opens a case and a conversation for a mention on the issue", async () => {
    const [routed] = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(routed?.created).toBe(true);
    expect(fake.cases).toMatchObject([
      {
        projectId: PROJECT_ID,
        sourceKey: "jira:LD-7",
        title: "LD-7: Half-day leave",
      },
    ]);
    expect(fake.conversations).toMatchObject([
      {
        channelKey: "jira:LD-7:item",
        projectConnectionId: PROJECT_CONNECTION_ID,
        channel: { parentId: null },
      },
    ]);
    expect(fake.messages).toMatchObject([
      {
        conversationId: routed?.conversationId,
        actor: "An",
        text: "@bot what does the policy say?",
        externalRef: "500",
        dedupKey: "message:500",
        turnId: null,
        payload: { workflows: ["Questions on tickets"], parentId: null },
      },
    ]);
    // The thread must be quiet for the debounce before a turn takes it.
    expect(fake.conversations[0]?.nextWakeAt).toBeInstanceOf(Date);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("joins the case and conversation of an earlier message on the same item", async () => {
    const [first] = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });
    const [second] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        dedupKey: "LD-7:mention:comment-501",
        message: { id: "501", parentId: null, text: "and for part-timers?" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(second?.conversationId).toBe(first?.conversationId);
    expect(fake.cases).toHaveLength(1);
    expect(fake.messages).toHaveLength(2);
  });

  it("records one message for the several events of one comment", async () => {
    await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });
    const [again] = await routeToOrchestrator({
      connection: connection(),
      event: mention({ dedupKey: "LD-7:conditions:comment-500" }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(again?.created).toBe(false);
    expect(fake.messages).toHaveLength(1);
  });

  it("sends a reply to the orchestrator's comment to that comment's conversation, without a trigger", async () => {
    const [first] = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });
    fake.addAnchor(
      first?.conversationId ?? "",
      IntegrationProviderKey.Jira,
      "900"
    );

    const [reply] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        triggerType: "jira.comment_reply",
        dedupKey: "LD-7:reply:901",
        message: { id: "901", parentId: "900", text: "ok, change step 2" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [],
    });

    expect(reply?.conversationId).toBe(first?.conversationId);
    expect(fake.conversations).toHaveLength(1);
  });

  it("opens a conversation per comment thread replied to that is not its own", async () => {
    const [routed] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        message: { id: "502", parentId: "300", text: "@bot what about this?" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(routed?.created).toBe(true);
    expect(fake.conversations[0]).toMatchObject({
      channelKey: "jira:LD-7:comment:300",
      channel: { parentId: "300" },
    });
  });

  it("ignores an event no orchestrated trigger matched that replies to nothing it posted", async () => {
    const [routed] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        message: { id: "503", parentId: "777", text: "thanks" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [],
    });

    expect(routed).toBeUndefined();
    expect(fake.messages).toEqual([]);
  });

  it("takes nothing while the workflow is disabled", async () => {
    fake = createOrchestratorDbFake();
    mocks.fake = fake;
    fake.addWorkflow(WORKFLOW_ID, "Questions on tickets", { enabled: false });

    const routed = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(routed).toEqual([]);
    expect(fake.cases).toEqual([]);
  });

  it("starts the turn at once when the workflow waits for no quiet", async () => {
    fake = createOrchestratorDbFake();
    mocks.fake = fake;
    fake.addWorkflow(WORKFLOW_ID, "Questions on tickets", {
      agentConfig: { orchestrator: { debounceSeconds: 0 } },
    });

    await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("continues a Teams thread's conversation with a reply that mentions nobody", async () => {
    const thread = {
      item: {
        provider: IntegrationProviderKey.MicrosoftTeams,
        externalId: "team|channel|root|msg",
        key: "teams-abc123",
        url: null,
        title: "Can part-timers take half a day?",
        container: "channel",
      },
    };
    const [first] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        ...thread,
        triggerType: "microsoft_teams.bot_mentioned",
        message: {
          id: "m1",
          parentId: null,
          text: "@bot can part-timers take half a day?",
        },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });

    const [reply] = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        ...thread,
        triggerType: "microsoft_teams.thread_reply",
        dedupKey: "thread:reply:m2",
        message: { id: "m2", parentId: "m1", text: "and for interns?" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [],
    });

    expect(reply).toMatchObject({
      conversationId: first?.conversationId,
      created: true,
    });
    expect(fake.messages.map((message) => message.text)).toEqual([
      "@bot can part-timers take half a day?",
      "and for interns?",
    ]);
  });
  it("opens a case and a conversation per orchestrated workflow that matched", async () => {
    const other = "0199a5f0-0000-7000-8000-0000000000f2";
    fake.addWorkflow(other, "Second orchestrator");

    const routed = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [...WORKFLOWS, { workflowId: other, projectId: PROJECT_ID }],
    });

    expect(routed.map((result) => result.workflowId)).toEqual([
      WORKFLOW_ID,
      other,
    ]);
    expect(fake.cases).toHaveLength(2);
    expect(fake.conversations).toHaveLength(2);
    expect(fake.messages).toHaveLength(2);
    expect(fake.messages.map((message) => message.payload)).toMatchObject([
      { workflows: ["Questions on tickets"] },
      { workflows: ["Second orchestrator"] },
    ]);
  });

  it("sends a reply to an anchor to its workflow's conversation and to the other matched workflow", async () => {
    const other = "0199a5f0-0000-7000-8000-0000000000f2";
    fake.addWorkflow(other, "Second orchestrator");
    const [first] = await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: WORKFLOWS,
    });
    fake.addAnchor(
      first?.conversationId ?? "",
      IntegrationProviderKey.Jira,
      "900"
    );

    const routed = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        triggerType: "jira.comment_reply",
        dedupKey: "LD-7:reply:901",
        message: { id: "901", parentId: "900", text: "ok, change step 2" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [{ workflowId: other, projectId: PROJECT_ID }],
    });

    expect(routed.map((result) => result.workflowId)).toEqual([
      WORKFLOW_ID,
      other,
    ]);
    expect(routed[0]?.conversationId).toBe(first?.conversationId);
    expect(fake.conversations).toHaveLength(2);
  });

  it("continues every conversation on the channel for an unmatched thread reply", async () => {
    const other = "0199a5f0-0000-7000-8000-0000000000f2";
    fake.addWorkflow(other, "Second orchestrator");
    await routeToOrchestrator({
      connection: connection(),
      event: mention(),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [...WORKFLOWS, { workflowId: other, projectId: PROJECT_ID }],
    });

    const routed = await routeToOrchestrator({
      connection: connection(),
      event: mention({
        dedupKey: "LD-7:mention:comment-510",
        message: { id: "510", parentId: null, text: "thanks both" },
      }),
      projectConnectionId: PROJECT_CONNECTION_ID,
      workflows: [],
    });

    expect(routed).toHaveLength(2);
    expect(routed.every((result) => result.created)).toBe(true);
    expect(fake.messages).toHaveLength(4);
  });

  describe("ticket changes", () => {
    function change(
      itemChange: NonNullable<InboundEvent["itemChange"]>,
      overrides: Partial<InboundEvent> = {}
    ): InboundEvent {
      return mention({
        triggerType: "jira.issue_status_changed",
        dedupKey: "LD-7:status:1",
        actor: { id: "u-2", displayName: "Shawn" },
        message: undefined,
        itemChange,
        ...overrides,
      });
    }

    function route(event: InboundEvent) {
      return routeToOrchestrator({
        connection: connection(),
        event,
        projectConnectionId: PROJECT_CONNECTION_ID,
        workflows: WORKFLOWS,
      });
    }

    it("records a status change as a status_changed message", async () => {
      await route(
        change({ status: { from: "To Do", to: "Prepare Requirements" } })
      );

      expect(fake.conversations).toMatchObject([
        { channelKey: "jira:LD-7:item" },
      ]);
      expect(fake.messages).toMatchObject([
        {
          origin: OrchestratorMessageOrigin.External,
          kind: OrchestratorMessageKind.StatusChanged,
          text: "Status changed: To Do → Prepare Requirements (by Shawn)",
          payload: {
            from: "To Do",
            to: "Prepare Requirements",
            actor: "Shawn",
          },
        },
      ]);
    });

    it("records a removed label as a label_removed message", async () => {
      await route(
        change(
          { labels: { added: [], removed: ["create-prd"] } },
          { dedupKey: "LD-7:labels:2" }
        )
      );

      expect(fake.messages).toMatchObject([
        {
          kind: OrchestratorMessageKind.LabelRemoved,
          text: "Label removed: create-prd (by Shawn)",
        },
      ]);
    });

    it("records an added label as a label_added message", async () => {
      await route(
        change(
          { labels: { added: ["create-prd"], removed: [] } },
          { dedupKey: "LD-7:labels:3" }
        )
      );

      expect(fake.messages).toMatchObject([
        { kind: OrchestratorMessageKind.LabelAdded },
      ]);
    });

    it("keeps two status events of one window as two messages in one conversation", async () => {
      await route(change({ status: { from: "To Do", to: "PRD Review" } }));
      await route(
        change(
          { status: { from: "PRD Review", to: "Ready for Dev" } },
          { dedupKey: "LD-7:status:2" }
        )
      );

      expect(fake.messages).toHaveLength(2);
      expect(fake.conversations).toHaveLength(1);
    });

    it("opens another case for another ticket", async () => {
      await route(change({ status: { from: "To Do", to: "PRD Review" } }));
      await route(
        change(
          { status: { from: "To Do", to: "PRD Review" } },
          {
            dedupKey: "LD-8:status:1",
            item: { ...mention().item, key: "LD-8", externalId: "10002" },
          }
        )
      );

      expect(fake.cases).toHaveLength(2);
    });
  });
});
