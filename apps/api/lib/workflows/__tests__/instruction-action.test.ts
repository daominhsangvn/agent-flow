import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import {
  type ConnectionGrants,
  normalizeConnectionGrants,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationToolCallStatus } from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowInstructionOperationStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkflowRunSnapshot } from "@/lib/integrations/types";
import {
  INSTRUCTION_MAX_WAIT_MS,
  readInstructionProgress,
  startInstruction,
  summarizeInstruction,
} from "@/lib/workflows/engine/instruction-action";

/**
 * Instruction actions: the attempt's tool session and the agent's request to
 * the run's computer, reading its answer back from the desktop command, and
 * settling the action from the integration tool calls the agent made.
 */

const mocks = vi.hoisted(() => ({
  run: null as Record<string, unknown> | null,
  checkouts: [] as Record<string, unknown>[],
  calls: [] as Record<string, unknown>[],
  findCalls: vi.fn(),
  findSession: vi.fn(),
  dispatch: vi.fn(),
  openSession: vi.fn(),
  loadToolSession: vi.fn(),
  resolveProjectComputeTarget: vi.fn(),
  getCommandById: vi.fn(),
  getCommandEvents: vi.fn(),
  markCommandExpired: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      workflowRun: { findFirst: () => Promise.resolve(mocks.run) },
      integrationToolCall: { findMany: mocks.findCalls },
      integrationToolSession: { findFirst: mocks.findSession },
    }),
}));
vi.mock(
  "@/app/projects/project-repository-checkouts",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/projects/project-repository-checkouts")
      >();
    return {
      ...original,
      listProjectRepositoryCheckouts: () => Promise.resolve(mocks.checkouts),
    };
  }
);
vi.mock("@/app/integration-tools/integration-tool-session-service", () => ({
  integrationToolSessionService: { openForInstruction: mocks.openSession },
}));
vi.mock("@/lib/integrations/agent-tools/session-input", () => ({
  loadAgentToolSession: mocks.loadToolSession,
}));
vi.mock("@/lib/loops/loop-desktop", () => ({
  dispatchWorkflowInstruction: mocks.dispatch,
}));
vi.mock("@/lib/workflows/engine/launch", () => ({
  resolveProjectComputeTarget: mocks.resolveProjectComputeTarget,
}));
vi.mock("@/lib/workflows/engine/run-data", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-data")>();
  return { ...original, readAgentConfig: (value: unknown) => value };
});
vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: mocks.getCommandById,
    getCommandEvents: mocks.getCommandEvents,
    markCommandExpired: mocks.markCommandExpired,
  },
}));
vi.mock("@/lib/integrations/registry", () => ({
  findActionDefinition: (provider: string, type: string) =>
    provider === "jira"
      ? (JIRA_ACTIONS.find((action) => action.key === type) ?? null)
      : null,
  getIntegrationProvider: (provider: string) =>
    provider === "jira"
      ? { key: "jira", displayName: "Jira", actions: JIRA_ACTIONS }
      : null,
}));

const ACTION_RUN_ID = "0199a5f0-0000-7000-8000-0000000000a1";
const SOURCE_WRITES: ConnectionGrants = {
  source: [SourceOperation.Comment, SourceOperation.Transition],
};
const COMMENT = "jira.add_comment";
const TRANSITION = "jira.transition_issue";
const NOW = new Date("2026-10-13T08:00:00.000Z");
const WAITING_SINCE = new Date("2026-10-13T07:55:00.000Z");

const JIRA_ACTIONS = [
  {
    key: COMMENT,
    displayName: "Add comment",
    description: "Posts a comment on the issue.",
    configSchema: z.object({ body: z.string().min(1) }),
    sourceOperation: SourceOperation.Comment,
    configFields: [
      { key: "body", label: "Comment", kind: "textarea", required: true },
    ],
    execute: vi.fn(),
  },
  {
    key: TRANSITION,
    displayName: "Transition issue",
    description: "Moves the issue to another status.",
    configSchema: z.object({ status: z.string().min(1) }),
    sourceOperation: SourceOperation.Transition,
    configFields: [
      { key: "status", label: "Target status", kind: "text", required: true },
    ],
    execute: vi.fn(),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run = {
    agentConfig: {
      computeTargetId: "ct-workflow",
      repository: { fullName: "acme/api" },
    },
    runAsUserId: "user-1",
    planDocumentId: "plan-1",
    featureDocumentId: "issue-1",
    planDocument: { slug: "PLN-5" },
    featureDocument: { slug: "ISS-9" },
    projectId: "project-1",
    loops: [{ loop: { computeTargetId: "ct-runner" } }],
  };
  mocks.checkouts = [
    checkout("acme/web", "https://git.test/acme/web.git"),
    checkout("acme/api", "https://git.test/acme/api.git"),
  ];
  mocks.calls = [];
  mocks.findCalls.mockImplementation(() => Promise.resolve(mocks.calls));
  mocks.findSession.mockResolvedValue({ issuedAt: NOW });
  mocks.dispatch.mockResolvedValue("command-1");
  mocks.openSession.mockResolvedValue(undefined);
  mocks.loadToolSession.mockImplementation(
    (input: { grants: ConnectionGrants | undefined }) =>
      Promise.resolve({
        sourceConnection: null,
        input: {
          agent: "an instruction",
          workflowName: "Jira to PR",
          runUrl: "https://app.test/acme/workflows/w/runs/run-1",
          source: {
            ref: snapshot().source,
            provider: "jira",
            key: "jira-shop",
          },
          grants: normalizeConnectionGrants(input.grants),
          connections: [],
        },
      })
  );
});

function checkout(fullName: string, cloneUrl: string) {
  return {
    id: fullName,
    connectionId: "conn-git",
    provider: "local_git",
    externalId: fullName,
    fullName,
    name: fullName.split("/")[1],
    defaultBranch: "main",
    webUrl: cloneUrl,
    cloneUrl,
    isPrimary: fullName === "acme/web",
  };
}

function snapshot(): WorkflowRunSnapshot {
  return {
    id: "run-1",
    url: "https://app.test/acme/workflows/w/runs/run-1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.ExecuteCompleted,
    workflow: { id: "w", name: "Jira to PR" },
    trigger: null,
    source: {
      provider: "jira",
      externalId: "10007",
      key: "PROJ-7",
      url: "https://jira.test/browse/PROJ-7",
      title: "Add CSV export",
      container: null,
    },
    sourceExtras: {},
    feature: null,
    plan: {
      id: "plan-1",
      title: "CSV export plan",
      url: "https://app.test/plans/PLN-5",
      excerpt: null,
      openQuestions: [],
    },
    pullRequest: null,
    pullRequests: [
      {
        repository: "acme/api",
        url: "https://git.test/acme/api/pulls/3",
        number: 3,
        branch: "symphony/pln-5",
      },
    ],
    repositories: [],
    repository: null,
    error: null,
    step: null,
    reply: null,
    documents: [],
    releaseNotes: null,
    stepReplies: {},
    summaryMarkdown: "🛠️ AgentFlow finished implementing **PROJ-7**.",
    startedAt: NOW.toISOString(),
    completedAt: null,
  } as WorkflowRunSnapshot;
}

function start(
  instruction = "Summarize the work and comment on the issue.",
  grants: ConnectionGrants | null = SOURCE_WRITES
) {
  return startInstruction({
    actionRunId: ACTION_RUN_ID,
    attempt: 2,
    organizationId: "org-1",
    runId: "run-1",
    instruction,
    grants: grants ?? undefined,
    snapshot: snapshot(),
  });
}

function answer(text: string) {
  return {
    type: "result" as const,
    ok: true as const,
    answer: text,
    costUsd: 0.04,
    inputTokens: 1200,
    outputTokens: 80,
  };
}

function summarize(text = "Commented on PROJ-7 and moved it to Done.") {
  return summarizeInstruction({
    actionRunId: ACTION_RUN_ID,
    attempt: 2,
    answer: answer(text),
  });
}

function call(overrides: Record<string, unknown>) {
  return {
    tool: "source_item_comment",
    operationType: COMMENT,
    connectionKey: "jira-shop",
    input: { body: "Done." },
    status: IntegrationToolCallStatus.Succeeded,
    externalRef: null,
    error: null,
    ...overrides,
  };
}

function sentPrompt(): string {
  return (mocks.dispatch.mock.calls[0]?.[0] as { request: { prompt: string } })
    .request.prompt;
}

describe("startInstruction", () => {
  it("asks the computer of the run's latest loop to work in the plan's workspace", async () => {
    const started = await start();

    expect(started).toEqual({ kind: "dispatched", commandId: "command-1" });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      computeTargetId: "ct-runner",
      request: {
        actionRunId: ACTION_RUN_ID,
        workspaceKey: "PLN-5",
        repository: {
          fullName: "acme/api",
          cloneUrl: "https://git.test/acme/api.git",
        },
        prompt: expect.any(String),
      },
    });
    expect(mocks.resolveProjectComputeTarget).not.toHaveBeenCalled();
  });

  it("opens the attempt's tool session on that computer before dispatching", async () => {
    await start();

    expect(mocks.openSession).toHaveBeenCalledWith({
      organizationId: "org-1",
      runId: "run-1",
      actionRunId: ACTION_RUN_ID,
      attempt: 2,
      computeTargetId: "ct-runner",
      expiresAt: expect.any(Date),
    });
    expect(mocks.openSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatch.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("writes the instruction, the event, the run and the session's tools into the prompt", async () => {
    await start();

    const prompt = sentPrompt();
    expect(prompt).toContain("## Untrusted Input Handling");
    expect(prompt).toContain("Summarize the work and comment on the issue.");
    expect(prompt).toContain("`execute.completed`");
    expect(prompt).toContain("BEGIN UNTRUSTED RUN");
    expect(prompt).toContain(
      "Pull request in acme/api: https://git.test/acme/api/pulls/3"
    );
    expect(prompt).toContain("## Integration tools");
    expect(prompt).toContain(
      'The run started from Jira PROJ-7 "Add CSV export" via connection `jira-shop`'
    );
    expect(prompt).toContain("You may write only through: source_item_comment");
    expect(prompt).toContain("source_item_transition");
    expect(prompt).not.toContain('{"operations"');
  });

  it("tells an agent without a grant that it only reads", async () => {
    await start(undefined, null);

    const prompt = sentPrompt();
    expect(prompt).toContain("This session only reads");
    expect(prompt).not.toContain("source_item_comment");
  });

  it("uses the computer the run's first loop would get before any loop ran", async () => {
    mocks.run = { ...mocks.run, loops: [] };
    mocks.resolveProjectComputeTarget.mockResolvedValue(Result.ok("ct-first"));

    await start();

    expect(mocks.resolveProjectComputeTarget).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      documentId: "plan-1",
      computeTargetId: "ct-workflow",
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ computeTargetId: "ct-first" })
    );
  });

  it("works in the Issue's workspace when the run has no plan", async () => {
    mocks.run = { ...mocks.run, planDocument: null, planDocumentId: null };

    await start();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ workspaceKey: "ISS-9" }),
      })
    );
  });

  it("skips a run that stopped before its documents existed", async () => {
    mocks.run = {
      ...mocks.run,
      planDocument: null,
      featureDocument: null,
      planDocumentId: null,
      featureDocumentId: null,
    };

    const started = await start();

    expect(started).toMatchObject({ kind: "skip" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("fails, retryably, when the computer cannot be reached", async () => {
    mocks.dispatch.mockRejectedValue(new Error("target_offline"));

    const started = await start();

    expect(started).toEqual({
      kind: "failed",
      error: expect.stringContaining("target_offline"),
      retryable: true,
    });
  });
});

describe("readInstructionProgress", () => {
  const row = { commandId: "command-1", updatedAt: WAITING_SINCE };

  it("keeps waiting while the computer runs the agent", async () => {
    mocks.getCommandById.mockResolvedValue(
      command(DesktopCommandStatus.Running)
    );

    expect(await readInstructionProgress(row, NOW)).toEqual({
      kind: "running",
    });
    expect(mocks.markCommandExpired).not.toHaveBeenCalled();
  });

  it("reads the agent's answer from the command's result event", async () => {
    mocks.getCommandById.mockResolvedValue(command(DesktopCommandStatus.Done));
    mocks.getCommandEvents.mockResolvedValue([
      { eventType: "status", data: { type: "status", status: "running" } },
      { eventType: "result", data: answer('{"operations": [], "note": "ok"}') },
      { eventType: "done", data: { type: "done" } },
    ]);

    expect(await readInstructionProgress(row, NOW)).toEqual({
      kind: "answered",
      result: answer('{"operations": [], "note": "ok"}'),
    });
    expect(mocks.getCommandEvents).toHaveBeenCalledWith(
      "ct-runner",
      "command-1"
    );
  });

  it.each([
    DesktopCommandStatus.Failed,
    DesktopCommandStatus.Cancelled,
    DesktopCommandStatus.Expired,
  ])("answers a %s command with a retryable failure", async (status) => {
    mocks.getCommandById.mockResolvedValue(command(status));

    expect(await readInstructionProgress(row, NOW)).toEqual({
      kind: "answered",
      result: expect.objectContaining({ ok: false, retryable: true }),
    });
  });

  it("gives up on an overdue command and expires it", async () => {
    mocks.getCommandById.mockResolvedValue(
      command(DesktopCommandStatus.Queued)
    );
    const late = new Date(
      WAITING_SINCE.getTime() + INSTRUCTION_MAX_WAIT_MS + 1
    );

    const progress = await readInstructionProgress(row, late);

    expect(progress).toEqual({
      kind: "answered",
      result: expect.objectContaining({ ok: false, retryable: true }),
    });
    expect(mocks.markCommandExpired).toHaveBeenCalledWith(
      "command-1",
      "workflow_instruction_wait_exceeded",
      expect.objectContaining({ computeTargetId: "ct-runner" })
    );
  });

  it("answers a missing command with a retryable failure", async () => {
    mocks.getCommandById.mockResolvedValue(null);

    expect(await readInstructionProgress(row, NOW)).toMatchObject({
      kind: "answered",
      result: { ok: false, retryable: true },
    });
  });
});

describe("summarizeInstruction", () => {
  it("lists the attempt's calls and succeeds with the first write's reference", async () => {
    mocks.calls = [
      call({
        tool: "source_item_get",
        operationType: null,
        input: {},
      }),
      call({ externalRef: "comment-7" }),
      call({
        tool: "source_item_transition",
        operationType: TRANSITION,
        input: { status: "Done" },
        externalRef: "Done",
      }),
      call({
        tool: "microsoft_teams_post_message",
        operationType: null,
        connectionKey: "teams-release",
        status: IntegrationToolCallStatus.Refused,
        error: "There is no tool",
      }),
    ];

    const outcome = await summarize();

    expect(mocks.findCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actionRunId: ACTION_RUN_ID, session: { attempt: 2 } },
      })
    );
    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "comment-7",
    });
    expect(outcome.detail).toEqual({
      note: "Commented on PROJ-7 and moved it to Done.",
      operations: [
        expect.objectContaining({
          type: "source_item_get",
          status: WorkflowInstructionOperationStatus.Succeeded,
        }),
        expect.objectContaining({
          type: COMMENT,
          connection: "jira-shop",
          config: { body: "Done." },
          status: WorkflowInstructionOperationStatus.Succeeded,
          externalRef: "comment-7",
        }),
        expect.objectContaining({ type: TRANSITION, externalRef: "Done" }),
        expect.objectContaining({
          type: "microsoft_teams_post_message",
          connection: "teams-release",
          status: WorkflowInstructionOperationStatus.Skipped,
          error: "There is no tool",
        }),
      ],
      costUsd: 0.04,
      inputTokens: 1200,
      outputTokens: 80,
    });
  });

  it("succeeds without calls when the agent explains why", async () => {
    const outcome = await summarize("Nothing to report yet.");

    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
    });
    expect(outcome.detail.note).toBe("Nothing to report yet.");
    expect(outcome.detail.operations).toEqual([]);
  });

  it("fails, retryably, when a write failed and none succeeded", async () => {
    mocks.calls = [
      call({
        status: IntegrationToolCallStatus.Failed,
        error: "Jira answered 503",
      }),
    ];

    const outcome = await summarize();

    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "source_item_comment failed: Jira answered 503",
      retryable: true,
    });
  });

  it("is not retried once a write succeeded", async () => {
    mocks.calls = [
      call({ externalRef: "comment-7" }),
      call({
        tool: "source_item_transition",
        operationType: TRANSITION,
        status: IntegrationToolCallStatus.Failed,
        error: "No transition Done",
      }),
    ];

    const outcome = await summarize();

    expect(outcome.result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
    });
  });

  it("fails on a write that never finished", async () => {
    mocks.calls = [call({ status: IntegrationToolCallStatus.Running })];

    const outcome = await summarize();

    expect(outcome.result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      error: "source_item_comment failed: it did not finish",
    });
    expect(outcome.detail.operations[0]?.status).toBe(
      WorkflowInstructionOperationStatus.NotRun
    );
  });

  it("fails, finally, when the runner never opened the tools", async () => {
    mocks.findSession.mockResolvedValue({ issuedAt: null });

    const outcome = await summarize();

    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: expect.stringContaining(
        "The runner did not open the agent's integration tools"
      ),
      retryable: false,
    });
  });

  it("succeeds with a write waiting for approval", async () => {
    mocks.calls = [call({ status: IntegrationToolCallStatus.PendingApproval })];

    const outcome = await summarize();

    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
    });
    expect(outcome.detail.operations[0]?.status).toBe(
      WorkflowInstructionOperationStatus.PendingApproval
    );
  });

  it("does not fail on a failed read or a refused call", async () => {
    mocks.calls = [
      call({
        tool: "source_item_get",
        operationType: null,
        status: IntegrationToolCallStatus.Failed,
        error: "timeout",
      }),
      call({ status: IntegrationToolCallStatus.Refused, error: "no grant" }),
    ];

    const outcome = await summarize();

    expect(outcome.result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
    });
  });
});

function command(status: DesktopCommandStatus) {
  return {
    commandId: "command-1",
    computeTargetId: "ct-runner",
    operationId: "workflow_instruction",
    status,
    createdAt: WAITING_SINCE.toISOString(),
    lastSequenceAcked: 0,
  };
}
