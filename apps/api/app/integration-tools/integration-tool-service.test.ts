import {
  ConnectionAccess,
  type ConnectionGrants,
  GrantApproval,
  normalizeConnectionGrants,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  IntegrationToolCallStatus,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result, Status } from "@repo/api/src/types/result";
import { WORKFLOW_INSTRUCTION_OPERATIONS_MAX } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentToolSessionInput,
  buildAgentTools,
} from "@/lib/integrations/agent-tools/catalog";
import { JiraActionType } from "@/lib/integrations/providers/jira/constants";
import { integrationToolService } from "./integration-tool-service";

/**
 * Tool calls: every request re-authenticates and recomputes the session's
 * tools, so an unknown tool or arguments outside the grant are refused and
 * recorded without reaching the provider; a write is recorded before it runs
 * and an identical repeat answers with the first result.
 */

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  loadContext: vi.fn(),
  startWriteCall: vi.fn(),
  recordSettledCall: vi.fn(),
  finishCall: vi.fn(),
  writeBudgetSpent: vi.fn(),
  executeWrite: vi.fn(),
  readSourceItem: vi.fn(),
  readSourceAttachment: vi.fn(),
  readConnectionItem: vi.fn(),
}));

vi.mock("./integration-tool-session-service", () => ({
  integrationToolSessionService: { authenticate: mocks.authenticate },
}));
vi.mock("./service/session-context", () => ({
  loadToolSessionContext: mocks.loadContext,
}));
vi.mock("./service/call-records", () => ({
  startWriteCall: mocks.startWriteCall,
  recordSettledCall: mocks.recordSettledCall,
  finishCall: mocks.finishCall,
  writeBudgetSpent: mocks.writeBudgetSpent,
}));
vi.mock("./service/execute", () => ({
  executeWrite: mocks.executeWrite,
  readSourceItem: mocks.readSourceItem,
  readSourceAttachment: mocks.readSourceAttachment,
  readConnectionItem: mocks.readConnectionItem,
}));

const TOKEN = "ist_abcdefghijklmnopqrstuvwxyz";
const SESSION = {
  id: "session-1",
  organizationId: "org-1",
  runId: "run-1",
  subject: {
    kind: "instruction" as const,
    actionRunId: "ar-1",
    attempt: 1,
    actionId: "action-1",
    event: "execute.completed",
  },
};
const WRITE_BUDGET = 5;
const JIRA_INTERNAL = {
  key: "jira-internal",
  name: "Internal Jira",
  provider: IntegrationProviderKey.Jira,
  projectConnectionId: "0199a5f0-0000-7000-8000-0000000000c3",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue(SESSION);
  mocks.loadContext.mockResolvedValue(context());
  mocks.writeBudgetSpent.mockResolvedValue(false);
  mocks.startWriteCall.mockResolvedValue(Result.ok({ id: "call-1" }));
  mocks.executeWrite.mockResolvedValue({
    ok: true,
    output: { done: true, reference: "In Progress" },
    externalRef: "In Progress",
  });
});

function context(grants: ConnectionGrants = SOURCE_TRANSITION) {
  const input: AgentToolSessionInput = {
    agent: "an instruction",
    workflowName: "Support tickets",
    runUrl: "https://app.test/runs/run-1",
    source: {
      ref: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10007",
        key: "JB-7",
        url: null,
        title: "Login fails",
        container: "JB",
      },
      provider: IntegrationProviderKey.Jira,
      key: "jira-customer",
    },
    grants: normalizeConnectionGrants(grants),
    // Only granted keys are connections of the session.
    connections: grants[JIRA_INTERNAL.key] ? [JIRA_INTERNAL] : [],
    pullRequests: [],
  };
  return {
    session: SESSION,
    snapshot: {},
    sourceConnection: null,
    input,
    tools: buildAgentTools(input),
    writeBudget: WRITE_BUDGET,
  };
}

const SOURCE_TRANSITION: ConnectionGrants = {
  source: [SourceOperation.Transition],
};

function call(tool: string, input: Record<string, unknown> = {}) {
  return integrationToolService.call(TOKEN, {
    tool,
    input: input as Record<string, never>,
  });
}

describe("integrationToolService.describe", () => {
  it("lists the session's tools with its instructions", async () => {
    const result = await integrationToolService.describe(TOKEN);

    expect(result.ok && result.value.tools.map((tool) => tool.name)).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
      IntegrationToolName.SourceItemTransition,
    ]);
    expect(result.ok && result.value.instructions).toContain(
      "You may write only through: source_item_transition"
    );
  });

  it("rejects a token without a live session", async () => {
    mocks.authenticate.mockResolvedValue(null);

    expect(await integrationToolService.describe(TOKEN)).toEqual({
      ok: false,
      error: Status.Unauthorized,
    });
  });
});

describe("integrationToolService.call", () => {
  it("moves the source item and records the write", async () => {
    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "In Progress",
    });

    expect(result).toEqual({
      ok: true,
      value: { ok: true, output: { done: true, reference: "In Progress" } },
    });
    expect(mocks.startWriteCall).toHaveBeenCalledWith(
      {
        session: SESSION,
        tool: IntegrationToolName.SourceItemTransition,
        operationType: JiraActionType.TransitionIssue,
        connectionKey: "jira-customer",
        input: { transitionName: "In Progress" },
      },
      { pendingApproval: false }
    );
    expect(mocks.executeWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        connection: null,
        config: { transitionName: "In Progress" },
      }),
      "call-1"
    );
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Succeeded,
      externalRef: "In Progress",
      error: null,
    });
  });

  it("refuses a write the grant does not allow, without reaching the provider", async () => {
    const result = await call(IntegrationToolName.SourceItemComment, {
      message: "Hi",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ok: false,
        error: expect.stringContaining(
          'Not allowed: There is no tool "source_item_comment" in this session.'
        ),
        retryable: false,
      },
    });
    expect(mocks.recordSettledCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: IntegrationToolName.SourceItemComment }),
      expect.objectContaining({ status: IntegrationToolCallStatus.Refused })
    );
    expect(mocks.executeWrite).not.toHaveBeenCalled();
  });

  it("refuses arguments the operation rejects", async () => {
    const result = await call(IntegrationToolName.SourceItemTransition, {});

    expect(result.ok && result.value).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(mocks.startWriteCall).not.toHaveBeenCalled();
  });

  it("answers an identical repeat with the first result", async () => {
    mocks.startWriteCall.mockResolvedValue(
      Result.err({ kind: "succeeded", externalRef: "In Progress" })
    );

    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "In Progress",
    });

    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: { done: true, reference: "In Progress" },
    });
    expect(mocks.executeWrite).not.toHaveBeenCalled();
  });

  it("stops writing once the session's budget is spent", async () => {
    mocks.writeBudgetSpent.mockResolvedValue(true);

    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "Done",
    });

    expect(result.ok && result.value).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        `already carried out its ${WORKFLOW_INSTRUCTION_OPERATIONS_MAX} writes`
      ),
    });
    expect(mocks.executeWrite).not.toHaveBeenCalled();
  });

  it("records a provider failure and hands it to the agent", async () => {
    mocks.executeWrite.mockResolvedValue({
      ok: false,
      error: 'No transition "Shipped". Available: In Progress, Done',
      retryable: false,
    });

    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "Shipped",
    });

    expect(result.ok && result.value).toEqual({
      ok: false,
      error: 'No transition "Shipped". Available: In Progress, Done',
      retryable: false,
    });
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Failed,
      externalRef: null,
      error: 'No transition "Shipped". Available: In Progress, Done',
    });
  });

  it("reads the source item", async () => {
    mocks.readSourceItem.mockResolvedValue({
      ok: true,
      output: { key: "JB-7" },
      externalRef: null,
    });

    const result = await call(IntegrationToolName.SourceItemGet);

    expect(result.ok && result.value).toEqual({
      ok: true,
      output: { key: "JB-7" },
    });
    expect(mocks.recordSettledCall).toHaveBeenCalledWith(
      expect.objectContaining({ operationType: null }),
      { status: IntegrationToolCallStatus.Succeeded, error: undefined }
    );
  });

  it("reads a file attached to the source item by its name, without a grant", async () => {
    mocks.readSourceAttachment.mockResolvedValue({
      ok: true,
      output: { name: "PRD-JB-7.md", text: "# PRD" },
      externalRef: null,
    });

    const result = await call(IntegrationToolName.SourceItemAttachmentRead, {
      name: " PRD-JB-7.md ",
    });

    expect(result.ok && result.value).toEqual({
      ok: true,
      output: { name: "PRD-JB-7.md", text: "# PRD" },
    });
    expect(mocks.readSourceAttachment).toHaveBeenCalledWith(expect.anything(), {
      kind: "read_source_attachment",
      name: "PRD-JB-7.md",
    });
  });

  it("refuses an attachment read without a file name", async () => {
    const result = await call(IntegrationToolName.SourceItemAttachmentRead, {});

    expect(result.ok && result.value.ok).toBe(false);
    expect(mocks.readSourceAttachment).not.toHaveBeenCalled();
  });

  it("queues a write that needs approval without carrying it out", async () => {
    mocks.loadContext.mockResolvedValue(
      context({
        source: {
          allow: [SourceOperation.Transition],
          approval: GrantApproval.Required,
        },
      })
    );

    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "Done",
    });

    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: { status: IntegrationToolCallStatus.PendingApproval },
    });
    expect(mocks.startWriteCall).toHaveBeenCalledWith(expect.anything(), {
      pendingApproval: true,
    });
    expect(mocks.executeWrite).not.toHaveBeenCalled();
  });

  it("tells the agent an identical call was rejected", async () => {
    mocks.startWriteCall.mockResolvedValue(Result.err({ kind: "rejected" }));

    const result = await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "Done",
    });

    expect(result.ok && result.value).toMatchObject({
      ok: false,
      error: expect.stringContaining("A person rejected"),
      retryable: false,
    });
  });

  it("checks the write budget the session has", async () => {
    await call(IntegrationToolName.SourceItemTransition, {
      transitionName: "Done",
    });

    expect(mocks.writeBudgetSpent).toHaveBeenCalledWith(
      SESSION.id,
      WRITE_BUDGET
    );
  });

  it("reads an item of a granted connection and records its key", async () => {
    mocks.loadContext.mockResolvedValue(
      context({ "jira-internal": ConnectionAccess.Read })
    );
    mocks.readConnectionItem.mockResolvedValue({
      ok: true,
      output: { key: "OPS-12" },
      externalRef: null,
    });

    const result = await call(IntegrationToolName.ConnectionGetItem, {
      connection: "jira-internal",
      item: "OPS-12",
    });

    expect(result.ok && result.value).toEqual({
      ok: true,
      output: { key: "OPS-12" },
    });
    expect(mocks.readConnectionItem).toHaveBeenCalledWith(expect.anything(), {
      kind: "read_item",
      connection: JIRA_INTERNAL,
      item: "OPS-12",
    });
    expect(mocks.recordSettledCall).toHaveBeenCalledWith(
      expect.objectContaining({ connectionKey: "jira-internal" }),
      { status: IntegrationToolCallStatus.Succeeded, error: undefined }
    );
  });

  it("rejects a call once the session is gone", async () => {
    mocks.loadContext.mockResolvedValue(null);

    expect(await call(IntegrationToolName.Overview)).toEqual({
      ok: false,
      error: Status.NotFound,
    });
  });
});
