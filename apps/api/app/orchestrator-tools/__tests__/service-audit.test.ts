import {
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorToolName,
} from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorToolService } from "@/app/orchestrator-tools/service";
import { hashOrchestratorToken } from "@/app/orchestrator-tools/token";
import { TURN_SUPERSEDED_ERROR } from "@/lib/orchestrator/supersede";

/** Every refused tool call is recorded on the conversation (F10). */

const TOKEN = "ost_abcdefghijklmnopqrstuvwxyz0123456789";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  messages: [] as Row[],
  turnSuperseded: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorTurn: {
      findFirst: () =>
        Promise.resolve({
          id: "turn-1",
          organizationId: "org-1",
          tokenHash: hashOrchestratorToken(TOKEN),
          conversation: {
            id: "conversation-1",
            projectId: "project-1",
            caseId: "case-1",
            projectConnectionId: "0199a5f0-0000-7000-8000-0000000000e1",
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
          },
        }),
    },
    orchestratorCase: { update: () => Promise.resolve({}) },
    orchestratorMessage: {
      create: (args: { data: Row }) => {
        mocks.messages.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    organization: { findUnique: () => Promise.resolve({ slug: "agentflow" }) },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});
vi.mock("@/lib/orchestrator/supersede", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestrator/supersede")>()),
  turnSuperseded: mocks.turnSuperseded,
}));
vi.mock("@/lib/orchestrator/case-render", () => ({
  renderCase: () => Promise.resolve("# LD-7"),
}));
vi.mock("@/lib/orchestrator/tasks", () => ({ startTask: vi.fn() }));
vi.mock("@/lib/orchestrator/task-cancel", () => ({ cancelTask: vi.fn() }));
vi.mock("@/lib/orchestrator/decisions", () => ({
  requestDecision: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("@/lib/orchestrator/waits", () => ({
  createWait: vi.fn(),
  evaluateWaits: vi.fn(),
}));
vi.mock("@/lib/integrations/project-connections", () => ({
  loadProjectConnectionRuntime: vi.fn(),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: () => ({}),
}));
vi.mock("@/app/compute-targets/capabilities-service", () => ({
  computeTargetCapabilitiesService: {
    listForProject: () => Promise.resolve([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messages = [];
  mocks.turnSuperseded.mockResolvedValue(false);
});

describe("refused call audit", () => {
  it("records an unknown tool", async () => {
    const result = await orchestratorToolService.call(TOKEN, "nope", {});
    expect(result).toMatchObject({ ok: true, value: { ok: false } });
    expect(mocks.messages).toHaveLength(1);
    expect(mocks.messages[0]).toMatchObject({
      kind: OrchestratorMessageKind.ToolRefused,
      origin: OrchestratorMessageOrigin.Internal,
      turnId: "turn-1",
      payload: { tool: "nope" },
    });
    expect(String(mocks.messages[0]?.text)).toContain("nope refused:");
  });

  it("records a bad input", async () => {
    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.CaseUpdateNotes,
      { notes: 5 }
    );
    expect(result).toMatchObject({ ok: true, value: { ok: false } });
    expect(mocks.messages).toMatchObject([
      { kind: OrchestratorMessageKind.ToolRefused },
    ]);
  });

  it("records a superseded write", async () => {
    mocks.turnSuperseded.mockResolvedValue(true);
    await orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
      text: "hi",
    });
    expect(String(mocks.messages[0]?.text)).toContain(TURN_SUPERSEDED_ERROR);
  });

  it("records nothing for a call that works", async () => {
    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.CaseGet,
      {}
    );
    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(mocks.messages).toEqual([]);
  });
});
