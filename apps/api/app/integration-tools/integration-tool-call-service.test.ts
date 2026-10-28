import { normalizeConnectionGrants } from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  IntegrationToolCallStatus,
  ToolCallDecision,
} from "@repo/api/src/types/integration-tools";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentToolSessionInput,
  buildAgentTools,
} from "@/lib/integrations/agent-tools/catalog";
import { TeamsActionType } from "@/lib/integrations/providers/microsoft-teams/post-message-action";
import { integrationToolCallService } from "./integration-tool-call-service";

/**
 * A person's decision on a write whose grant requires approval: approving
 * carries it out through the tools its session has now, rejecting records
 * it; a call decided once is not decided again.
 */

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  findCall: vi.fn(),
  findCalls: vi.fn(),
  findUsers: vi.fn(),
  findSession: vi.fn(),
  loadContext: vi.fn(),
  executeWrite: vi.fn(),
  finishCall: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      integrationToolCall: {
        updateManyAndReturn: mocks.claim,
        findFirst: mocks.findCall,
        findMany: mocks.findCalls,
      },
      user: { findMany: mocks.findUsers },
    }),
}));
vi.mock("./integration-tool-session-service", () => ({
  integrationToolSessionService: { find: mocks.findSession },
}));
vi.mock("./service/session-context", () => ({
  loadToolSessionContext: mocks.loadContext,
}));
vi.mock("./service/execute", () => ({ executeWrite: mocks.executeWrite }));
vi.mock("./service/call-records", () => ({ finishCall: mocks.finishCall }));

const CALL = {
  id: "call-1",
  sessionId: "session-1",
  tool: "microsoft_teams_post_message",
  request: { connection: "teams-release", message: "Shipped." },
};
const INPUT = {
  organizationId: "org-1",
  runId: "run-1",
  callId: "call-1",
  userId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue([CALL]);
  mocks.findSession.mockResolvedValue({ id: "session-1" });
  mocks.loadContext.mockResolvedValue(context());
  mocks.executeWrite.mockResolvedValue({
    ok: true,
    output: { done: true },
    externalRef: "msg-1",
  });
});

function context() {
  const input: AgentToolSessionInput = {
    agent: "an instruction",
    workflowName: "Release",
    runUrl: "https://app.test/runs/run-1",
    source: {
      ref: {
        provider: IntegrationProviderKey.Jira,
        externalId: "1",
        key: "JB-7",
        url: null,
        title: null,
        container: null,
      },
      provider: IntegrationProviderKey.Jira,
      key: "jira-customer",
    },
    grants: normalizeConnectionGrants({
      "teams-release": {
        allow: [TeamsActionType.PostMessage],
        approval: "required",
      },
    }),
    connections: [
      {
        key: "teams-release",
        name: "Release channel",
        provider: IntegrationProviderKey.MicrosoftTeams,
        projectConnectionId: "pc-1",
      },
    ],
    pullRequests: [],
  };
  return { input, tools: buildAgentTools(input) };
}

describe("integrationToolCallService.decide", () => {
  it("carries out an approved call with its stored arguments", async () => {
    const result = await integrationToolCallService.decide({
      ...INPUT,
      decision: ToolCallDecision.Approve,
    });

    expect(result.ok).toBe(true);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "call-1",
          runId: "run-1",
          status: IntegrationToolCallStatus.PendingApproval,
        }),
        data: expect.objectContaining({
          status: IntegrationToolCallStatus.Running,
          decidedById: "user-1",
        }),
      })
    );
    expect(mocks.executeWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "write",
        config: expect.objectContaining({ message: "Shipped." }),
      }),
      "call-1"
    );
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Succeeded,
      externalRef: "msg-1",
      error: null,
    });
  });

  it("records a rejection without carrying anything out", async () => {
    const result = await integrationToolCallService.decide({
      ...INPUT,
      decision: ToolCallDecision.Reject,
    });

    expect(result.ok).toBe(true);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: IntegrationToolCallStatus.Rejected,
        }),
      })
    );
    expect(mocks.executeWrite).not.toHaveBeenCalled();
  });

  it("fails an approved call whose grant was removed since", async () => {
    mocks.loadContext.mockResolvedValue({
      ...context(),
      tools: buildAgentTools({ ...context().input, grants: [] }),
    });

    await integrationToolCallService.decide({
      ...INPUT,
      decision: ToolCallDecision.Approve,
    });

    expect(mocks.executeWrite).not.toHaveBeenCalled();
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Failed,
      error: "microsoft_teams_post_message is no longer granted to this agent.",
    });
  });

  it("answers a call decided already with a conflict", async () => {
    mocks.claim.mockResolvedValue([]);
    mocks.findCall.mockResolvedValue({ id: "call-1" });

    expect(
      await integrationToolCallService.decide({
        ...INPUT,
        decision: ToolCallDecision.Approve,
      })
    ).toMatchObject({ ok: false, error: { status: Status.Conflict } });
  });

  it("answers another run's call with not found", async () => {
    mocks.claim.mockResolvedValue([]);
    mocks.findCall.mockResolvedValue(null);

    expect(
      await integrationToolCallService.decide({
        ...INPUT,
        decision: ToolCallDecision.Reject,
      })
    ).toMatchObject({ ok: false, error: { status: Status.NotFound } });
  });
});

describe("integrationToolCallService.listForRun", () => {
  it("lists the run's calls with their step and who decided", async () => {
    mocks.findCalls.mockResolvedValue([
      {
        id: "call-1",
        tool: "source_item_comment",
        operationType: "jira.add_comment",
        connectionKey: "jira-customer",
        input: { message: "Done." },
        status: IntegrationToolCallStatus.Rejected,
        externalRef: null,
        error: null,
        actionRunId: null,
        decidedById: "user-1",
        decidedAt: new Date("2026-10-13T10:05:00.000Z"),
        createdAt: new Date("2026-10-13T10:00:00.000Z"),
        session: { stepId: "investigate" },
      },
    ]);
    mocks.findUsers.mockResolvedValue([
      { id: "user-1", email: "ada@acme.dev", firstName: "Ada", lastName: null },
    ]);

    expect(
      await integrationToolCallService.listForRun("org-1", "run-1")
    ).toEqual([
      expect.objectContaining({
        id: "call-1",
        status: IntegrationToolCallStatus.Rejected,
        stepId: "investigate",
        decidedBy: "Ada",
        decidedAt: new Date("2026-10-13T10:05:00.000Z"),
      }),
    ]);
    expect(mocks.findCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: "run-1", organizationId: "org-1" },
      })
    );
  });
});
