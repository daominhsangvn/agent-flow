import {
  OrchestratorDecisionStatus,
  OrchestratorDecisionVia,
  OrchestratorMessageKind,
} from "@repo/api/src/types/orchestrator";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decide, requestDecision } from "@/lib/orchestrator/decisions";

/**
 * Decisions (docs/orchestrator.md): taken once, by a button or a message;
 * a button's decision wakes the conversation that asked.
 */

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-23T10:00:00.000Z");

const mocks = vi.hoisted(() => ({
  decisions: [] as Row[],
  messages: [] as Row[],
  wakes: [] as Row[],
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorDecision: {
      create: (args: { data: Row }) => {
        const row = {
          id: `decision-${mocks.decisions.length + 1}`,
          status: OrchestratorDecisionStatus.Pending,
          ...args.data,
        };
        mocks.decisions.push(row);
        return Promise.resolve(row);
      },
      findFirst: (args: { where: Row }) =>
        Promise.resolve(
          mocks.decisions.find(
            (row) =>
              row.id === args.where.id &&
              row.status === args.where.status &&
              (args.where.caseId === undefined ||
                row.caseId === args.where.caseId)
          ) ?? null
        ),
      updateMany: (args: { where: Row; data: Row }) => {
        const row = mocks.decisions.find(
          (decision) =>
            decision.id === args.where.id &&
            decision.status === args.where.status
        );
        if (!row) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    orchestratorMessage: {
      create: (args: { data: Row }) => {
        mocks.messages.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    orchestratorConversation: {
      update: (args: { where: { id: string }; data: Row }) => {
        mocks.wakes.push({ id: args.where.id, ...args.data });
        return Promise.resolve({});
      },
    },
  };
  const withDb = (fn: (client: unknown) => unknown) => fn(db);
  withDb.tx = (fn: (client: unknown) => unknown) => fn(db);
  return { withDb };
});

beforeEach(() => {
  mocks.decisions = [];
  mocks.messages = [];
  mocks.wakes = [];
});

async function ask() {
  return await requestDecision({
    organizationId: "org-1",
    caseId: "case-1",
    conversationId: "conversation-1",
    question: "Approve plan v2 of LD-7?",
  });
}

describe("decide", () => {
  it("takes an admin's decision once and wakes the conversation that asked", async () => {
    const decisionId = await ask();
    const input = {
      organizationId: "org-1",
      decisionId,
      approved: true,
      comment: "Go.",
      via: OrchestratorDecisionVia.Button,
      decidedBy: "Ada Admin",
      decidedById: "user-1",
    };

    const first = await decide(input, NOW);
    const second = await decide({ ...input, approved: false }, NOW);

    expect(first).toEqual({
      ok: true,
      value: { conversationId: "conversation-1" },
    });
    expect(second).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.decisions[0]).toMatchObject({
      status: OrchestratorDecisionStatus.Approved,
      via: OrchestratorDecisionVia.Button,
      decidedBy: "Ada Admin",
      decidedById: "user-1",
      comment: "Go.",
      decidedAt: NOW,
    });
    expect(mocks.messages).toMatchObject([
      {
        kind: OrchestratorMessageKind.Decision,
        dedupKey: `decision:${decisionId}`,
        text: expect.stringContaining("approved by Ada Admin (button): Go."),
      },
    ]);
    expect(mocks.wakes).toEqual([{ id: "conversation-1", nextWakeAt: NOW }]);
  });

  it("records a decision the orchestrator was told without waking it again", async () => {
    const decisionId = await ask();

    await decide(
      {
        organizationId: "org-1",
        decisionId,
        approved: false,
        comment: "Not before the API is ready",
        via: OrchestratorDecisionVia.Message,
        decidedBy: "An",
        decidedById: null,
        caseId: "case-1",
        notify: false,
      },
      NOW
    );

    expect(mocks.decisions[0]?.status).toBe(
      OrchestratorDecisionStatus.Rejected
    );
    expect(mocks.messages).toEqual([]);
  });

  it("keeps the orchestrator to its own case's decisions", async () => {
    const decisionId = await ask();

    const result = await decide({
      organizationId: "org-1",
      decisionId,
      approved: true,
      comment: null,
      via: OrchestratorDecisionVia.Message,
      decidedBy: "An",
      decidedById: null,
      caseId: "case-2",
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });
});
