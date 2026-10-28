import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import {
  OrchestratorConversationStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTurnEnd,
  OrchestratorTurnStatus,
} from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrchestratorDbFake,
  ORG_ID,
  type OrchestratorDbFake,
  PROJECT_CONNECTION_ID,
  PROJECT_ID,
  RUNNER_ID,
} from "@/__tests__/support/orchestrator/orchestrator-db.test-fake";
import {
  advanceConversation,
  advanceDueConversations,
} from "@/lib/orchestrator/advance";
import { turnSuperseded } from "@/lib/orchestrator/supersede";

/**
 * A conversation's turns (docs/orchestrator.md): one at a time, started once
 * the thread is quiet with every message no turn took, run on the
 * orchestrator's runner and settled from the command's result.
 */

const mocks = vi.hoisted(() => ({
  fake: null as OrchestratorDbFake | null,
  dispatch: vi.fn(),
  command: null as null | {
    commandId: string;
    computeTargetId: string;
    status: string;
    error?: string;
  },
  events: [] as Array<{ eventType: string; data: unknown }>,
  markExpired: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb };
});
vi.mock("@/lib/loops/loop-desktop", () => ({
  dispatchOrchestratorTurn: mocks.dispatch,
  dispatchOrchestratorTurnCancel: mocks.cancel,
}));
vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: () => Promise.resolve(mocks.command),
    getCommandEvents: () => Promise.resolve(mocks.events),
    markCommandExpired: mocks.markExpired,
  },
}));
vi.mock("@/lib/orchestrator/case-render", () => ({
  renderCase: () => Promise.resolve("# LD-7: Half-day leave"),
}));
vi.mock("@/app/compute-targets/capabilities-service", () => ({
  computeTargetCapabilitiesService: {
    listForProject: () => Promise.resolve([]),
  },
}));
vi.mock("@/lib/orchestrator/tasks", () => ({
  advanceTasks: () =>
    Promise.resolve({ launched: 0, settledConversationIds: [] }),
}));
vi.mock("@/lib/orchestrator/waits", () => ({
  evaluateWaits: () => Promise.resolve(false),
  fireDueDeadlines: () => Promise.resolve(0),
}));
vi.mock("@/lib/db-fanout", () => ({
  mapWithDbConcurrency: <T>(items: T[], fn: (item: T) => Promise<unknown>) =>
    Promise.all(items.map((item) => fn(item))),
}));

const WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f1";
const NOW = new Date("2026-10-23T08:01:00.000Z");
const LATER = new Date("2026-10-23T08:03:00.000Z");

let fake: OrchestratorDbFake;
let conversationId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  fake = createOrchestratorDbFake();
  mocks.fake = fake;
  mocks.command = null;
  mocks.events = [];
  mocks.dispatch.mockResolvedValue("cmd-1");
  fake.addWorkflow(WORKFLOW_ID, "Questions on tickets");
  const found = await fake.db.orchestratorCase.upsert({
    where: {
      workflowId_sourceKey: { workflowId: WORKFLOW_ID, sourceKey: "jira:LD-7" },
    },
    create: {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      sourceKey: "jira:LD-7",
      title: "LD-7",
    },
    update: {},
  });
  const conversation = await fake.db.orchestratorConversation.create({
    data: {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      caseId: found?.id,
      channelKey: "jira:LD-7:item",
      projectConnectionId: PROJECT_CONNECTION_ID,
      channel: {
        item: {
          provider: "jira",
          externalId: "10001",
          key: "LD-7",
          url: null,
          title: "Half-day leave",
          container: "LD",
        },
        parentId: null,
        extras: null,
      },
      nextWakeAt: new Date("2026-10-23T08:00:20.000Z"),
    },
  });
  conversationId = conversation?.id as string;
  await addMessage("500", "@bot what does the policy say?");
});

async function openCase(): Promise<string> {
  const found = await fake.db.orchestratorCase.upsert({
    where: {
      workflowId_sourceKey: { workflowId: WORKFLOW_ID, sourceKey: "jira:LD-9" },
    },
    create: {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      sourceKey: "jira:LD-9",
      title: "LD-9",
    },
    update: {},
  });
  return found?.id as string;
}

async function addMessage(id: string, text: string) {
  await fake.db.orchestratorMessage.create({
    data: {
      organizationId: ORG_ID,
      conversationId,
      origin: OrchestratorMessageOrigin.External,
      kind: OrchestratorMessageKind.Message,
      actor: "An",
      text,
      externalRef: id,
      dedupKey: `message:${id}`,
    },
  });
}

function finish(result: unknown, status: string = DesktopCommandStatus.Done) {
  mocks.command = { commandId: "cmd-1", computeTargetId: RUNNER_ID, status };
  mocks.events = [{ eventType: "result", data: result }];
}

const OK_RESULT = {
  type: "result",
  ok: true,
  answer: "Answered from the policy.",
  sessionId: "session-1",
  costUsd: 0.02,
  inputTokens: 1200,
  outputTokens: 300,
};

describe("advanceConversation", () => {
  it("starts a turn with every message no turn took, once the thread is quiet", async () => {
    await advanceConversation(conversationId, NOW);

    expect(mocks.dispatch).toHaveBeenCalledWith({
      computeTargetId: RUNNER_ID,
      request: expect.objectContaining({
        projectId: PROJECT_ID,
        sessionId: null,
        timeoutMs: 10 * 60_000,
        prompt: expect.stringContaining("@bot what does the policy say?"),
      }),
    });
    expect(fake.turns).toMatchObject([
      {
        status: OrchestratorTurnStatus.Running,
        commandId: "cmd-1",
        computeTargetId: RUNNER_ID,
      },
    ]);
    expect(fake.messages[0]?.turnId).toBe(fake.turns[0]?.id);
    expect(fake.conversations[0]).toMatchObject({
      status: OrchestratorConversationStatus.Turn,
      nextWakeAt: null,
      leaseUntil: null,
    });
  });

  it("waits while the thread is not quiet yet", async () => {
    await advanceConversation(
      conversationId,
      new Date("2026-10-23T08:00:10.000Z")
    );

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("leaves a running turn alone, and a newer message for the next turn", async () => {
    await advanceConversation(conversationId, NOW);
    mocks.command = {
      commandId: "cmd-1",
      computeTargetId: RUNNER_ID,
      status: DesktopCommandStatus.Running,
    };
    await addMessage("501", "and part-timers?");

    await advanceConversation(conversationId, NOW);

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.messages[1]?.turnId).toBeNull();
  });

  it("settles a finished turn: the session for the next one, waiting for people by default", async () => {
    await advanceConversation(conversationId, NOW);
    finish(OK_RESULT);

    await advanceConversation(conversationId, LATER);

    expect(fake.turns[0]).toMatchObject({
      status: OrchestratorTurnStatus.Succeeded,
      ended: OrchestratorTurnEnd.WaitHuman,
      sessionId: "session-1",
      summary: "Answered from the policy.",
      usage: { costUsd: 0.02, inputTokens: 1200, outputTokens: 300 },
      tokenHash: null,
    });
    expect(fake.conversations[0]).toMatchObject({
      status: OrchestratorConversationStatus.Waiting,
      sessionId: "session-1",
    });
  });

  it("closes the conversation when the turn closed the case", async () => {
    await advanceConversation(conversationId, NOW);
    await fake.db.orchestratorTurn.updateMany({
      where: { id: fake.turns[0]?.id },
      data: { ended: OrchestratorTurnEnd.Close },
    });
    finish(OK_RESULT);

    await advanceConversation(conversationId, LATER);

    expect(fake.conversations[0]?.status).toBe(
      OrchestratorConversationStatus.Closed
    );
  });

  it("starts the next turn right after settling when messages wait, resuming the session", async () => {
    await advanceConversation(conversationId, NOW);
    await addMessage("501", "and part-timers?");
    finish(OK_RESULT);
    mocks.dispatch.mockResolvedValue("cmd-2");

    await advanceConversation(conversationId, LATER);

    expect(mocks.dispatch).toHaveBeenLastCalledWith({
      computeTargetId: RUNNER_ID,
      request: expect.objectContaining({
        sessionId: "session-1",
        prompt: expect.stringContaining("and part-timers?"),
      }),
    });
    expect(fake.turns).toHaveLength(2);
  });

  it("gives a failed turn's messages to a later turn", async () => {
    await advanceConversation(conversationId, NOW);
    finish({
      type: "result",
      ok: false,
      error: "Claude crashed",
      retryable: true,
      sessionId: null,
    });

    await advanceConversation(conversationId, LATER);

    expect(fake.turns[0]).toMatchObject({
      status: OrchestratorTurnStatus.Failed,
      error: "Claude crashed",
    });
    expect(fake.messages[0]?.turnId).toBeNull();
    expect(fake.conversations[0]?.nextWakeAt).toEqual(
      new Date(LATER.getTime() + 2 * 60_000)
    );
  });

  it("stops giving the messages again after three failed turns in a row", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const at = new Date(NOW.getTime() + attempt * 10 * 60_000);
      mocks.command = null;
      await fake.db.orchestratorConversation.updateMany({
        where: { id: conversationId },
        data: { nextWakeAt: at },
      });
      await advanceConversation(conversationId, at);
      finish({
        type: "result",
        ok: false,
        error: "boom",
        retryable: true,
        sessionId: null,
      });
      await advanceConversation(
        conversationId,
        new Date(at.getTime() + 60_000)
      );
    }

    expect(fake.turns.map((turn) => turn.status)).toEqual([
      OrchestratorTurnStatus.Failed,
      OrchestratorTurnStatus.Failed,
      OrchestratorTurnStatus.Failed,
    ]);
    expect(fake.messages[0]?.turnId).toBe(fake.turns[2]?.id);
  });

  it("fails the turn when its command cannot be sent, and tries again later", async () => {
    mocks.dispatch.mockRejectedValue(new Error("runner offline"));

    await advanceConversation(conversationId, NOW);

    expect(fake.turns[0]).toMatchObject({
      status: OrchestratorTurnStatus.Failed,
      error: expect.stringContaining("runner offline"),
    });
    expect(fake.messages[0]?.turnId).toBeNull();
  });

  it("does not start turns while the project's orchestrator is disabled", async () => {
    fake = createOrchestratorDbFake();
    mocks.fake = fake;
    fake.addWorkflow(WORKFLOW_ID, "Questions on tickets", { enabled: false });
    const conversation = await fake.db.orchestratorConversation.create({
      data: {
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        caseId: await openCase(),
        channelKey: "k",
        channel: {},
      },
    });
    conversationId = conversation?.id as string;
    await addMessage("600", "hello");

    await advanceConversation(conversationId, NOW);

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(fake.conversations[0]?.nextWakeAt).toEqual(
      new Date(NOW.getTime() + 5 * 60_000)
    );
  });

  it("takes the runner and the timeout from the workflow", async () => {
    const otherRunner = "0199a5f0-0000-7000-8000-0000000000c9";
    fake = createOrchestratorDbFake();
    mocks.fake = fake;
    fake.addWorkflow(WORKFLOW_ID, "Questions on tickets", {
      agentConfig: {
        computeTargetId: otherRunner,
        orchestrator: { turnTimeoutMinutes: 3 },
      },
    });
    const conversation = await fake.db.orchestratorConversation.create({
      data: {
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        caseId: await openCase(),
        channelKey: "k",
        channel: {},
      },
    });
    conversationId = conversation?.id as string;
    await addMessage("700", "hello");

    await advanceConversation(conversationId, NOW);

    expect(mocks.dispatch).toHaveBeenCalledWith({
      computeTargetId: otherRunner,
      request: expect.objectContaining({ timeoutMs: 3 * 60_000 }),
    });
  });

  it("is skipped while another worker holds the conversation", async () => {
    await fake.db.orchestratorConversation.updateMany({
      where: { id: conversationId },
      data: { leaseUntil: new Date(NOW.getTime() + 60_000) },
    });

    await advanceConversation(conversationId, NOW);

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("advanceDueConversations", () => {
  it("advances the conversations whose turn is due", async () => {
    const result = await advanceDueConversations(NOW);

    expect(result.advanced).toBe(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency", () => {
  async function startTurnThenWrite(concurrency: string) {
    fake = createOrchestratorDbFake();
    mocks.fake = fake;
    fake.addWorkflow(WORKFLOW_ID, "Questions on tickets", {
      agentConfig: { orchestrator: { concurrency } },
    });
    const conversation = await fake.db.orchestratorConversation.create({
      data: {
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        caseId: await openCase(),
        channelKey: "jira:LD-7:item",
        channel: {},
        nextWakeAt: NOW,
      },
    });
    conversationId = conversation?.id as string;
    await addMessage("500", "@bot what does the policy say?");
    await advanceConversation(conversationId, NOW);
    mocks.command = {
      commandId: "cmd-1",
      computeTargetId: RUNNER_ID,
      status: DesktopCommandStatus.Running,
    };
    await addMessage("501", "sorry, I meant for part-timers");
    await fake.db.orchestratorConversation.updateMany({
      where: { id: conversationId },
      data: { nextWakeAt: NOW },
    });
  }

  it("supersede: a message arriving mid-turn makes the turn's writes refused", async () => {
    await startTurnThenWrite("supersede");

    expect(
      await turnSuperseded({
        turnId: fake.turns[0]?.id as string,
        organizationId: ORG_ID,
        conversationId,
      })
    ).toBe(true);
  });

  it("queue: a message arriving mid-turn does not refuse the turn's writes", async () => {
    await startTurnThenWrite("queue");

    expect(
      await turnSuperseded({
        turnId: fake.turns[0]?.id as string,
        organizationId: ORG_ID,
        conversationId,
      })
    ).toBe(false);
  });

  it("supersede: writes are allowed while nothing newer waits", async () => {
    await startTurnThenWrite("supersede");
    const newer = fake.messages.find(
      (message) => message.externalRef === "501"
    );
    await fake.db.orchestratorMessage.updateMany({
      where: { id: newer?.id as string },
      data: { turnId: fake.turns[0]?.id as string },
    });

    expect(
      await turnSuperseded({
        turnId: fake.turns[0]?.id as string,
        organizationId: ORG_ID,
        conversationId,
      })
    ).toBe(false);
  });

  it("supersede: a newer message stops the running turn, once", async () => {
    await startTurnThenWrite("supersede");

    await advanceConversation(conversationId, LATER);
    await advanceConversation(conversationId, LATER);

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith({
      computeTargetId: RUNNER_ID,
      turnId: fake.turns[0]?.id,
    });
  });

  it("supersede: the stopped turn's messages and the new one go to the next turn", async () => {
    await startTurnThenWrite("supersede");
    await advanceConversation(conversationId, LATER);
    finish({
      type: "result",
      ok: false,
      error: "The turn was stopped for a newer message.",
      retryable: false,
      sessionId: "session-1",
    });
    mocks.dispatch.mockResolvedValue("cmd-2");

    await advanceConversation(conversationId, LATER);

    expect(fake.turns[0]).toMatchObject({
      status: OrchestratorTurnStatus.Superseded,
    });
    expect(fake.turns).toHaveLength(2);
    const prompt = mocks.dispatch.mock.calls.at(-1)?.[0].request
      .prompt as string;
    expect(prompt).toContain("@bot what does the policy say?");
    expect(prompt).toContain("sorry, I meant for part-timers");
    expect(mocks.dispatch.mock.calls.at(-1)?.[0].request.sessionId).toBe(
      "session-1"
    );
  });

  it("queue: the running turn finishes; the new message waits for the next", async () => {
    await startTurnThenWrite("queue");

    await advanceConversation(conversationId, LATER);

    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(fake.messages[1]?.turnId).toBeNull();
  });

  it("an admin's stop fails the turn with their name and does not retry its messages", async () => {
    await startTurnThenWrite("queue");
    const turn = fake.turns[0];
    await fake.db.orchestratorTurn.update({
      where: { id: turn?.id as string },
      data: {
        usage: {
          timeoutMs: 60_000,
          cancelRequestedAt: NOW.toISOString(),
          cancelledBy: "Ann Admin",
        },
      },
    });
    finish({
      type: "result",
      ok: false,
      error: "The turn was stopped.",
      retryable: false,
      sessionId: "session-1",
    });

    await advanceConversation(conversationId, LATER);

    expect(fake.turns[0]).toMatchObject({
      status: OrchestratorTurnStatus.Failed,
      error: "Stopped by Ann Admin.",
    });
    expect(fake.messages[0]?.turnId).toBe(turn?.id);
  });
});
