import {
  OrchestratorMessageKind,
  OrchestratorTaskStatus,
  OrchestratorToolName,
  OrchestratorTurnEnd,
} from "@repo/api/src/types/orchestrator";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorToolService } from "@/app/orchestrator-tools/service";
import { hashOrchestratorToken } from "@/app/orchestrator-tools/token";

/**
 * The orchestrator's tools for one turn (docs/orchestrator.md): the token is
 * the authorization, replies go out through the conversation's provider and
 * come back as anchors, and the turn's end is what its tools set.
 */

const TOKEN = "ost_abcdefghijklmnopqrstuvwxyz0123456789";
const TASK_ID = "0199a5f0-0000-7000-8000-0000000000f9";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  turn: null as Row | null,
  turnUpdates: [] as Row[],
  caseUpdates: [] as Row[],
  messages: [] as Row[],
  anchors: [] as Row[],
  replyOnItem: vi.fn(),
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  createWait: vi.fn(),
  evaluateWaits: vi.fn(),
  taskCount: 0,
  editOnItem: vi.fn(),
  anchor: null as Row | null,
  anchorUpdates: [] as Row[],
  requestDecision: vi.fn(),
  decide: vi.fn(),
  messageQueries: [] as Row[],
  latestMessage: { externalRef: "500", payload: null } as Row | null,
  attachFile: vi.fn(),
  findCaseTaskFiles: vi.fn(),
  getLoopAttachment: vi.fn(),
  hasAttachFile: true,
  taskRow: null as Row | null,
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorTurn: {
      findFirst: (args: { where: { tokenHash: string } }) =>
        Promise.resolve(
          mocks.turn && args.where.tokenHash === mocks.turn.tokenHash
            ? mocks.turn
            : null
        ),
      updateMany: (args: { data: Row }) => {
        mocks.turnUpdates.push(args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    orchestratorCase: {
      update: (args: { data: Row }) => {
        mocks.caseUpdates.push(args.data);
        return Promise.resolve({});
      },
    },
    orchestratorMessage: {
      create: (args: { data: Row }) => {
        mocks.messages.push(args.data);
        return Promise.resolve(args.data);
      },
      findFirst: (args: { where: Row }) => {
        mocks.messageQueries.push(args.where);
        return Promise.resolve(mocks.latestMessage);
      },
    },
    orchestratorTask: {
      count: () => Promise.resolve(mocks.taskCount),
      findFirst: () => Promise.resolve(mocks.taskRow),
    },
    organization: {
      findUnique: () => Promise.resolve({ slug: "agentflow" }),
    },
    orchestratorAnchor: {
      findFirst: () => Promise.resolve(mocks.anchor),
      update: (args: { data: Row }) => {
        mocks.anchorUpdates.push(args.data);
        return Promise.resolve({});
      },
      create: (args: { data: Row }) => {
        mocks.anchors.push(args.data);
        return Promise.resolve(args.data);
      },
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});
vi.mock("@/lib/integrations/project-connections", () => ({
  loadProjectConnectionRuntime: () =>
    Promise.resolve({
      connection: {
        provider: {
          replyOnItem: mocks.replyOnItem,
          editOnItem: mocks.editOnItem,
          source: mocks.hasAttachFile
            ? { attachFile: mocks.attachFile }
            : undefined,
        },
        runtime: { secrets: {} },
      },
    }),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: () => ({}),
}));
vi.mock("@/lib/orchestrator/task-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestrator/task-files")>()),
  findCaseTaskFiles: mocks.findCaseTaskFiles,
}));
vi.mock("@/lib/loops/loop-state", () => ({
  getLoopAttachment: mocks.getLoopAttachment,
}));
vi.mock("@/lib/orchestrator/case-render", () => ({
  renderCase: () => Promise.resolve("# LD-7"),
}));
vi.mock("@/lib/orchestrator/tasks", () => ({ startTask: mocks.startTask }));
vi.mock("@/lib/orchestrator/task-cancel", () => ({
  cancelTask: mocks.cancelTask,
}));
vi.mock("@/lib/orchestrator/decisions", () => ({
  requestDecision: mocks.requestDecision,
  decide: mocks.decide,
}));
vi.mock("@/lib/orchestrator/waits", () => ({
  createWait: mocks.createWait,
  evaluateWaits: mocks.evaluateWaits,
}));
vi.mock("@/app/compute-targets/capabilities-service", () => ({
  computeTargetCapabilitiesService: {
    listForProject: () => Promise.resolve([]),
  },
}));

const ITEM = {
  provider: "jira",
  externalId: "10001",
  key: "LD-7",
  url: null,
  title: "Half-day leave",
  container: "LD",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.turnUpdates = [];
  mocks.caseUpdates = [];
  mocks.messages = [];
  mocks.anchors = [];
  mocks.turn = {
    id: "turn-1",
    organizationId: "org-1",
    tokenHash: hashOrchestratorToken(TOKEN),
    conversation: {
      id: "conversation-1",
      projectId: "project-1",
      caseId: "case-1",
      projectConnectionId: "0199a5f0-0000-7000-8000-0000000000e1",
      channel: { item: ITEM, parentId: null, extras: null },
    },
  };
  mocks.replyOnItem.mockResolvedValue({ ok: true, externalRef: "900" });
  mocks.taskCount = 0;
  mocks.hasAttachFile = true;
  mocks.taskRow = null;
  mocks.getLoopAttachment.mockResolvedValue(new Uint8Array([1]));
  mocks.anchor = null;
  mocks.anchorUpdates = [];
  mocks.messageQueries = [];
  mocks.latestMessage = { externalRef: "500", payload: null };
});

describe("orchestratorToolService", () => {
  it("refuses a token that names no running turn", async () => {
    expect(await orchestratorToolService.describe("ost_unknown")).toEqual({
      ok: false,
      error: Status.Unauthorized,
    });
    expect(await orchestratorToolService.describe(null)).toEqual({
      ok: false,
      error: Status.Unauthorized,
    });
  });

  it("lists the turn's tools", async () => {
    const described = await orchestratorToolService.describe(TOKEN);
    expect(
      described.ok && described.value.tools.map((tool) => tool.name)
    ).toEqual([
      OrchestratorToolName.CaseGet,
      OrchestratorToolName.CaseUpdateNotes,
      OrchestratorToolName.RunnersList,
      OrchestratorToolName.SourceItemGet,
      OrchestratorToolName.Reply,
      OrchestratorToolName.TaskRun,
      OrchestratorToolName.TaskGet,
      OrchestratorToolName.TaskCancel,
      OrchestratorToolName.WaitFor,
      OrchestratorToolName.RequestDecision,
      OrchestratorToolName.RecordDecision,
      OrchestratorToolName.EditReply,
      OrchestratorToolName.WaitHuman,
      OrchestratorToolName.CloseCase,
    ]);
  });

  it("replies in the thread of the message it answers and keeps the reply as an anchor", async () => {
    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.Reply,
      { text: "The policy allows half days from 2026." }
    );

    expect(result).toEqual({
      ok: true,
      value: { ok: true, output: { posted: true, reference: "900" } },
    });
    expect(mocks.replyOnItem).toHaveBeenCalledWith(expect.anything(), {
      item: ITEM,
      parentId: "500",
      text: "The policy allows half days from 2026.",
      extras: null,
    });
    expect(mocks.messages).toMatchObject([
      {
        kind: OrchestratorMessageKind.Reply,
        externalRef: "900",
        turnId: "turn-1",
      },
    ]);
    expect(mocks.anchors).toMatchObject([
      {
        conversationId: "conversation-1",
        provider: "jira",
        externalRef: "900",
      },
    ]);
  });

  it("returns the provider's refusal of a reply as a tool error", async () => {
    mocks.replyOnItem.mockResolvedValue({
      ok: false,
      error: "Jira is down",
      retryable: true,
    });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.Reply,
      { text: "Hello" }
    );

    expect(result.ok && result.value).toEqual({
      ok: false,
      error: "Jira is down",
      retryable: true,
    });
    expect(mocks.anchors).toEqual([]);
  });

  describe("task files", () => {
    const REFS = [
      { taskId: TASK_ID, name: "PRD-LD-7.md" },
      { taskId: TASK_ID, name: "evidence/a.png" },
    ];
    const FOUND = [
      { taskId: TASK_ID, name: "PRD-LD-7.md", size: 1, storageKey: "k1" },
      { taskId: TASK_ID, name: "evidence/a.png", size: 2, storageKey: "k2" },
    ];

    function replyWith(attachments: unknown) {
      return orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
        text: "PRD ready",
        attachments: attachments as never,
      });
    }

    it("uploads the attachments in order, then posts with the files", async () => {
      mocks.findCaseTaskFiles.mockResolvedValue({ ok: true, value: FOUND });
      mocks.attachFile
        .mockResolvedValueOnce({
          ok: true,
          value: { id: "1", name: "PRD-LD-7.md", contentType: "text/markdown" },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: { id: "2", name: "a.png", contentType: "image/png" },
        });

      const result = await replyWith(REFS);

      expect(mocks.attachFile.mock.calls.map((call) => call[2].name)).toEqual([
        "PRD-LD-7.md",
        "a.png",
      ]);
      expect(mocks.replyOnItem.mock.calls[0]?.[1].files).toHaveLength(2);
      expect(result.ok && result.value).toEqual({
        ok: true,
        output: {
          posted: true,
          reference: "900",
          attached: ["PRD-LD-7.md", "a.png"],
        },
      });
    });

    it("posts nothing when a later upload fails and names what was attached", async () => {
      mocks.findCaseTaskFiles.mockResolvedValue({ ok: true, value: FOUND });
      mocks.attachFile
        .mockResolvedValueOnce({
          ok: true,
          value: { id: "1", name: "PRD-LD-7.md", contentType: "text/markdown" },
        })
        .mockResolvedValueOnce({
          ok: false,
          error: { message: "Too large", retryable: false },
        });

      const result = await replyWith(REFS);

      expect(mocks.replyOnItem).not.toHaveBeenCalled();
      expect(result.ok && result.value).toMatchObject({
        ok: false,
        retryable: false,
      });
      expect(result.ok && !result.value.ok && result.value.error).toContain(
        "Attached before it: PRD-LD-7.md. Nothing was posted."
      );
    });

    it("refuses attachments where the thread takes no files", async () => {
      mocks.hasAttachFile = false;

      const result = await replyWith(REFS);

      expect(mocks.attachFile).not.toHaveBeenCalled();
      expect(mocks.replyOnItem).not.toHaveBeenCalled();
      expect(result.ok && !result.value.ok && result.value.error).toContain(
        "takes no files (jira)"
      );
    });

    it("refuses a file of another case's task", async () => {
      mocks.findCaseTaskFiles.mockResolvedValue({
        ok: false,
        error: `Task ${TASK_ID} is not a task of this case.`,
      });

      const result = await replyWith(REFS);

      expect(mocks.attachFile).not.toHaveBeenCalled();
      expect(mocks.replyOnItem).not.toHaveBeenCalled();
      expect(result.ok && !result.value.ok && result.value.error).toContain(
        "is not a task of this case"
      );
    });

    it("passes files of earlier tasks to task_run", async () => {
      mocks.startTask.mockResolvedValue({
        ok: true,
        value: {
          taskId: TASK_ID,
          status: "running",
          runner: "runner-qc",
          error: null,
          waiting: null,
        },
      });

      await orchestratorToolService.call(TOKEN, OrchestratorToolName.TaskRun, {
        runner: "runner-qc",
        command: "/qa-test",
        files: [REFS[0]],
      });

      expect(mocks.startTask.mock.calls[0]?.[0].files).toEqual([REFS[0]]);
    });

    it("returns a task's files without their storage keys", async () => {
      mocks.taskRow = {
        id: TASK_ID,
        command: "/ba-requirement",
        args: "LD-7",
        mode: "write",
        status: "succeeded",
        computeTarget: { machineName: "runner-1" },
        result: {
          reply: null,
          error: null,
          files: [
            { name: "PRD-LD-7.md", size: 10, storageKey: "k1", skipped: null },
          ],
          filesOmitted: 1,
        },
      };

      const result = await orchestratorToolService.call(
        TOKEN,
        OrchestratorToolName.TaskGet,
        { taskId: TASK_ID }
      );

      expect(result.ok && result.value).toMatchObject({
        ok: true,
        output: {
          files: [{ name: "PRD-LD-7.md", size: 10, skipped: null }],
          filesOmitted: 1,
        },
      });
      expect(JSON.stringify(result)).not.toContain("storageKey");
    });
  });

  it("ends the turn waiting for people", async () => {
    await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.WaitHuman,
      {}
    );
    expect(mocks.turnUpdates).toEqual([
      { ended: OrchestratorTurnEnd.WaitHuman },
    ]);
  });

  it("closes the case", async () => {
    await orchestratorToolService.call(TOKEN, OrchestratorToolName.CloseCase, {
      summary: "Answered.",
    });
    expect(mocks.turnUpdates).toEqual([{ ended: OrchestratorTurnEnd.Close }]);
    expect(mocks.caseUpdates).toEqual([{ status: "closed" }]);
  });

  it("saves the case's notes", async () => {
    await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.CaseUpdateNotes,
      {
        notes: "Asked BA about part-timers.",
      }
    );
    expect(mocks.caseUpdates).toEqual([
      { notes: "Asked BA about part-timers." },
    ]);
  });

  it("refuses bad input and unknown tools as tool errors", async () => {
    const empty = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.Reply,
      { text: "" }
    );
    const unknown = await orchestratorToolService.call(TOKEN, "merge_pr", {});
    expect(empty.ok && empty.value.ok).toBe(false);
    expect(unknown.ok && unknown.value).toEqual({
      ok: false,
      error: "There is no tool merge_pr.",
      retryable: false,
    });
  });

  it("starts a task on the turn's case and conversation", async () => {
    mocks.startTask.mockResolvedValue({
      ok: true,
      value: {
        taskId: TASK_ID,
        status: "running",
        runner: "runner-1",
        error: null,
        waiting: null,
      },
    });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskRun,
      {
        runner: "runner-1",
        command: "/ba-requirement",
        args: "LD-7",
        prompt: "Policy?",
      }
    );

    expect(mocks.startTask).toHaveBeenCalledWith({
      organizationId: "org-1",
      projectId: "project-1",
      caseId: "case-1",
      conversationId: "conversation-1",
      turnId: "turn-1",
      runner: "runner-1",
      command: "/ba-requirement",
      args: "LD-7",
      prompt: "Policy?",
      mode: null,
      resumeTaskId: null,
      fork: false,
      files: [],
    });
    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: { taskId: TASK_ID, status: "running" },
    });
  });

  it("tells the orchestrator why a task did not start", async () => {
    mocks.startTask.mockResolvedValue({
      ok: true,
      value: {
        taskId: TASK_ID,
        status: OrchestratorTaskStatus.Failed,
        runner: "runner-1",
        error: "Runner runner-1 is offline: the task was not started.",
        waiting: null,
      },
    });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskRun,
      { runner: "runner-1", command: "/ba-requirement", prompt: "Policy?" }
    );

    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: {
        status: OrchestratorTaskStatus.Failed,
        error: expect.stringContaining("offline"),
        next: expect.stringContaining("did not start"),
      },
    });
  });

  it("tells the orchestrator a queued task waits for its runner", async () => {
    mocks.startTask.mockResolvedValue({
      ok: true,
      value: {
        taskId: TASK_ID,
        status: OrchestratorTaskStatus.Queued,
        runner: "an-PRO-1",
        error: null,
        waiting: "Waiting for an-PRO-1: it runs one task at a time.",
      },
    });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskRun,
      { runner: "an-PRO-1", command: "/executing-plans", prompt: "Go" }
    );

    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: {
        status: OrchestratorTaskStatus.Queued,
        waiting: expect.stringContaining("one task at a time"),
        next: expect.stringContaining("waits for its runner"),
      },
    });
  });

  it("refuses a task that is not a slash command", async () => {
    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskRun,
      { runner: "runner-1", command: "rm -rf /" }
    );
    expect(result.ok && result.value.ok).toBe(false);
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it("ends the turn waiting for the case's tasks", async () => {
    mocks.taskCount = 1;

    await orchestratorToolService.call(TOKEN, OrchestratorToolName.WaitFor, {
      taskIds: [TASK_ID],
      timeoutMinutes: 30,
    });

    expect(mocks.createWait).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        conversationId: "conversation-1",
        kind: "all",
        taskIds: [TASK_ID],
        timeoutMinutes: 30,
        wakeOnFailure: true,
      },
      expect.any(Date)
    );
    expect(mocks.turnUpdates).toEqual([
      { ended: OrchestratorTurnEnd.WaitTasks },
    ]);
    expect(mocks.evaluateWaits).toHaveBeenCalledWith(
      "conversation-1",
      expect.any(Date)
    );
  });

  it("refuses to wait for a task of another case", async () => {
    mocks.taskCount = 0;

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.WaitFor,
      { taskIds: [TASK_ID] }
    );

    expect(result.ok && result.value.ok).toBe(false);
    expect(mocks.createWait).not.toHaveBeenCalled();
  });

  it("asks for a decision in the thread with the case's link", async () => {
    mocks.requestDecision.mockResolvedValue("decision-1");

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.RequestDecision,
      { question: "Approve plan v2 of LD-7?" }
    );

    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: { decisionId: "decision-1", posted: true },
    });
    expect(mocks.replyOnItem.mock.calls[0]?.[1].text).toContain(
      "/agentflow/orchestrator/cases/case-1"
    );
  });

  it("records a decision given in the thread, in this case, without waking the turn again", async () => {
    mocks.decide.mockResolvedValue({
      ok: true,
      value: { conversationId: "conversation-1" },
    });

    await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.RecordDecision,
      {
        decisionId: TASK_ID,
        approved: true,
        decidedBy: "An",
        comment: "ok, go",
      }
    );

    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: TASK_ID,
        approved: true,
        via: "message",
        decidedBy: "An",
        caseId: "case-1",
        notify: false,
      })
    );
  });

  it("edits only a message this conversation posted", async () => {
    const refused = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.EditReply,
      { reference: "123", text: "Plan v2" }
    );
    expect(refused.ok && refused.value.ok).toBe(false);
    expect(mocks.editOnItem).not.toHaveBeenCalled();

    mocks.anchor = { id: "anchor-1" };
    mocks.editOnItem.mockResolvedValue({ ok: true, externalRef: "900" });
    const edited = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.EditReply,
      { reference: "900", text: "Plan v2", version: 2 }
    );

    expect(edited.ok && edited.value.ok).toBe(true);
    expect(mocks.editOnItem).toHaveBeenCalledWith(expect.anything(), {
      item: ITEM,
      externalRef: "900",
      text: "Plan v2",
      extras: null,
    });
    expect(mocks.anchorUpdates).toEqual([{ version: 2 }]);
  });

  it("answers in the thread of the conversation's request even when task results woke the turn", async () => {
    await orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
      text: "Here is what BA and QC found.",
    });

    // The thread is found over the whole conversation, not the turn's own
    // messages: a turn woken by task results took no message from people.
    expect(mocks.messageQueries).toEqual([
      { conversationId: "conversation-1", origin: "external" },
    ]);
    expect(mocks.replyOnItem.mock.calls[0]?.[1].parentId).toBe("500");
  });

  it("answers a reply in its thread's first comment: comment threads have one level", async () => {
    mocks.latestMessage = {
      externalRef: "10141",
      payload: { triggerType: "jira.comment_reply", parentId: "10140" },
    };

    await orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
      text: "One morning off counts 0.5.",
    });

    expect(mocks.replyOnItem.mock.calls[0]?.[1].parentId).toBe("10140");
  });

  it("answers the comment replyTo names in its own thread, not the latest one", async () => {
    mocks.latestMessage = { externalRef: "10192", payload: { parentId: null } };

    await orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
      text: "No migration step: recreate the local database.",
      replyTo: "10192",
    });

    expect(mocks.messageQueries.at(-1)).toEqual({
      conversationId: "conversation-1",
      origin: "external",
      externalRef: "10192",
    });
    expect(mocks.replyOnItem.mock.calls[0]?.[1].parentId).toBe("10192");
  });

  it("refuses a replyTo that is no message of the conversation", async () => {
    mocks.latestMessage = null;

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.Reply,
      { text: "Hi", replyTo: "99999" }
    );

    expect(result.ok && result.value.ok).toBe(false);
    expect(mocks.replyOnItem).not.toHaveBeenCalled();
  });

  it("answers a ticket change with a new comment, not in an earlier thread", async () => {
    mocks.latestMessage = {
      externalRef: null,
      payload: { from: "PRD Review", to: "Ready for Dev", actor: "Shawn" },
    };

    await orchestratorToolService.call(TOKEN, OrchestratorToolName.Reply, {
      text: "PRD approved: Dev and QC started.",
    });

    expect(mocks.replyOnItem.mock.calls[0]?.[1].parentId).toBeNull();
  });

  it("cancels a task on the turn's case and passes the reason", async () => {
    mocks.cancelTask.mockResolvedValue({
      ok: true,
      value: {
        taskId: TASK_ID,
        previous: OrchestratorTaskStatus.Running,
        alreadyCancelled: false,
        loopStopped: true,
      },
    });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskCancel,
      { taskId: TASK_ID, reason: "Moved to Done" }
    );

    expect(mocks.cancelTask).toHaveBeenCalledWith({
      organizationId: "org-1",
      caseId: "case-1",
      turnId: "turn-1",
      taskId: TASK_ID,
      reason: "Moved to Done",
    });
    expect(result.ok && result.value).toMatchObject({
      ok: true,
      output: {
        taskId: TASK_ID,
        cancelled: true,
        was: OrchestratorTaskStatus.Running,
        loopStopped: true,
        alreadyCancelled: false,
      },
    });
  });

  it("refuses a cancel the guard refuses", async () => {
    mocks.cancelTask.mockResolvedValue({ ok: false, error: "cancelOn no" });

    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskCancel,
      { taskId: TASK_ID, reason: "x" }
    );

    expect(result.ok && result.value).toEqual({
      ok: false,
      error: "cancelOn no",
      retryable: false,
    });
  });

  it("refuses a cancel without a reason", async () => {
    const result = await orchestratorToolService.call(
      TOKEN,
      OrchestratorToolName.TaskCancel,
      { taskId: TASK_ID }
    );

    expect(mocks.cancelTask).not.toHaveBeenCalled();
    expect(result.ok && result.value).toMatchObject({ ok: false });
  });
});
