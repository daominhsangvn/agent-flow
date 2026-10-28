import { LOOP_STEP_INPUTS_MAX } from "@agentflow-ai/loops-api/loop-step";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type {
  IntegrationToolCallResponse,
  IntegrationToolSessionDescriptor,
} from "@repo/api/src/types/integration-tools";
import {
  OrchestratorCaseStatus,
  OrchestratorDecisionVia,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorToolName,
  OrchestratorTurnEnd,
  OrchestratorTurnStatus,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { RunnerCommandMode } from "@repo/api/src/types/runner-capabilities";
import { withDb } from "@repo/database";
import { z } from "zod";
import { computeTargetCapabilitiesService } from "@/app/compute-targets/capabilities-service";
import { toItemOutput } from "@/app/integration-tools/service/execute";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { createProviderContext } from "@/lib/integrations/connection-service";
import { loadProjectConnectionRuntime } from "@/lib/integrations/project-connections";
import {
  RetryableSourceError,
  type SourceItemFile,
} from "@/lib/integrations/types";
import { jsonValueSchema } from "@/lib/json-schema";
import { renderCase } from "@/lib/orchestrator/case-render";
import {
  type ConversationChannel,
  readChannel,
} from "@/lib/orchestrator/channel";
import { decide, requestDecision } from "@/lib/orchestrator/decisions";
import {
  TURN_SUPERSEDED_ERROR,
  turnSuperseded,
} from "@/lib/orchestrator/supersede";
import { cancelTask } from "@/lib/orchestrator/task-cancel";
import {
  type TaskFileRef,
  taskFileRefSchema,
} from "@/lib/orchestrator/task-files";
import { readTaskResult } from "@/lib/orchestrator/task-result";
import { startTask } from "@/lib/orchestrator/tasks";
import { createWait, evaluateWaits } from "@/lib/orchestrator/waits";
import { scrubProviderError } from "@/lib/workflows/engine/errors";
import { orchestratorCaseUrl } from "@/lib/workflows/engine/links";
import { REPLY_ATTACHMENTS_MAX, uploadReplyFiles } from "./service/attachments";
import { recordRefusedCall } from "./service/audit";
import {
  NOTES_MAX,
  REPLY_MAX,
  TASK_PROMPT_MAX,
  WAIT_TASKS_MAX,
  WAIT_TIMEOUT_MAX_MINUTES,
} from "./service/limits";
import { latestMessageRef, messageThread } from "./service/threads";
import { INSTRUCTIONS, TOOLS } from "./service/tools";
import { hashOrchestratorToken } from "./token";

/**
 * The project orchestrator's tools (docs/orchestrator.md), served to its
 * agent through apps/mcp for the `ost_…` token of one running turn. The token
 * is the whole authorization: it names the turn, hence the conversation, its
 * case and its project; every call is checked against that turn as it is now.
 */

const RUNNER_FILE_MAX = 20_000;
const PRISMA_UNIQUE_VIOLATION = "P2002";
const LOG_PREFIX = "[orchestrator-tools]";

type TurnContext = {
  turnId: string;
  organizationId: string;
  conversationId: string;
  projectId: string;
  caseId: string;
  projectConnectionId: string | null;
  channel: ConversationChannel | null;
};

type ToolOutcome = IntegrationToolCallResponse;

const notesInputSchema = z.object({ notes: z.string().max(NOTES_MAX) });
const replyInputSchema = z.object({
  text: z.string().trim().min(1).max(REPLY_MAX),
  replyTo: z.string().trim().min(1).max(255).optional(),
  attachments: z
    .array(taskFileRefSchema)
    .max(REPLY_ATTACHMENTS_MAX)
    .default([]),
});
const closeInputSchema = z.object({
  summary: z.string().trim().max(2000).optional(),
});
const emptyInputSchema = z.object({});
const COMMAND_RE = /^\/[\w:.-]{1,100}$/;
const taskRunInputSchema = z.object({
  runner: z.string().trim().min(1).max(120),
  command: z.string().trim().regex(COMMAND_RE),
  args: z.string().max(2000).default(""),
  prompt: z.string().max(TASK_PROMPT_MAX).default(""),
  mode: z.enum(RunnerCommandMode).optional(),
  resumeTaskId: z.uuid().optional(),
  fork: z.boolean().default(false),
  files: z.array(taskFileRefSchema).max(LOOP_STEP_INPUTS_MAX).default([]),
  replyTo: z.string().trim().min(1).max(255).optional(),
});
const taskGetInputSchema = z.object({ taskId: z.uuid() });
const taskCancelInputSchema = z.object({
  taskId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
const requestDecisionInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
});
const recordDecisionInputSchema = z.object({
  decisionId: z.uuid(),
  approved: z.boolean(),
  decidedBy: z.string().trim().min(1).max(255),
  comment: z.string().trim().max(4000).optional(),
});
const editReplyInputSchema = z.object({
  reference: z.string().trim().min(1).max(255),
  text: z.string().trim().min(1).max(REPLY_MAX),
  version: z.number().int().positive().optional(),
});
const waitForInputSchema = z.object({
  taskIds: z.array(z.uuid()).min(1).max(WAIT_TASKS_MAX),
  kind: z.enum(OrchestratorWaitKind).default(OrchestratorWaitKind.All),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(WAIT_TIMEOUT_MAX_MINUTES)
    .optional(),
  wakeOnFailure: z.boolean().default(true),
});

export const orchestratorToolService = {
  async describe(
    token: string | null
  ): Promise<Result<IntegrationToolSessionDescriptor, StatusCode>> {
    const context = await authenticate(token);
    if (!context) {
      return Result.err(Status.Unauthorized);
    }
    return Result.ok({ instructions: INSTRUCTIONS, tools: TOOLS });
  },

  async call(
    token: string | null,
    tool: string,
    input: Record<string, JsonValue>
  ): Promise<Result<ToolOutcome, StatusCode>> {
    const context = await authenticate(token);
    if (!context) {
      return Result.err(Status.Unauthorized);
    }
    const outcome = await runTool(context, tool, input);
    if (!(outcome.ok || outcome.retryable)) {
      await recordRefusedCall(
        {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
        },
        tool,
        outcome.error
      );
    }
    return Result.ok(outcome);
  },
};

async function runTool(
  context: TurnContext,
  tool: string,
  input: Record<string, JsonValue>
): Promise<ToolOutcome> {
  const handler = HANDLERS[tool];
  if (!handler) {
    return refused(`There is no tool ${tool}.`);
  }
  if (SUPERSEDABLE_TOOLS.has(tool) && (await turnSuperseded(context))) {
    return refused(TURN_SUPERSEDED_ERROR);
  }
  return handler(context, input);
}

async function authenticate(token: string | null): Promise<TurnContext | null> {
  if (!token) {
    return null;
  }
  const turn = await withDb((db) =>
    db.orchestratorTurn.findFirst({
      where: {
        tokenHash: hashOrchestratorToken(token),
        status: OrchestratorTurnStatus.Running,
        tokenExpiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        organizationId: true,
        conversation: {
          select: {
            id: true,
            projectId: true,
            caseId: true,
            projectConnectionId: true,
            channel: true,
          },
        },
      },
    })
  );
  if (!turn) {
    return null;
  }
  return {
    turnId: turn.id,
    organizationId: turn.organizationId,
    conversationId: turn.conversation.id,
    projectId: turn.conversation.projectId,
    caseId: turn.conversation.caseId,
    projectConnectionId: turn.conversation.projectConnectionId,
    channel: readChannel(turn.conversation.channel),
  };
}

type Handler = (
  context: TurnContext,
  input: Record<string, JsonValue>
) => Promise<ToolOutcome>;

const HANDLERS: Record<string, Handler> = {
  [OrchestratorToolName.CaseGet]: async (context) => ({
    ok: true,
    output: await renderCase(context.caseId),
  }),

  [OrchestratorToolName.CaseUpdateNotes]: async (context, input) => {
    const parsed = notesInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "notes: the case's notes as text (they replace the old ones)."
      );
    }
    await withDb((db) =>
      db.orchestratorCase.update({
        where: { id: context.caseId },
        data: { notes: parsed.data.notes },
      })
    );
    return { ok: true, output: "The case's notes are saved." };
  },

  [OrchestratorToolName.RunnersList]: async (context) => {
    const files = await computeTargetCapabilitiesService.listForProject(
      context.organizationId,
      context.projectId
    );
    // The commands' optional fields are dropped by the JSON round trip.
    const output = files.map((file) => ({
      runner: file.runnerName,
      online: file.isOnline,
      role: file.capabilities?.runner ?? null,
      commands: file.capabilities?.commands ?? [],
      skills: file.capabilities?.skills.map((skill) => skill.name) ?? [],
      problems: file.problems,
      file: file.content.slice(0, RUNNER_FILE_MAX),
    }));
    return {
      ok: true,
      output: jsonValueSchema.parse(JSON.parse(JSON.stringify(output))),
    };
  },

  [OrchestratorToolName.SourceItemGet]: async (context) => {
    const connection = await loadConversationConnection(context);
    const fetchItem = connection?.provider.source?.fetchItem;
    if (!(connection && fetchItem && context.channel)) {
      return refused("This conversation's item cannot be read.");
    }
    try {
      const item = await fetchItem(
        createProviderContext(connection.runtime, LOG_PREFIX),
        context.channel.item
      );
      return { ok: true, output: toItemOutput(item) };
    } catch (error) {
      return {
        ok: false,
        error: scrubProviderError(error, connection.runtime.secrets),
        retryable: error instanceof RetryableSourceError,
      };
    }
  },

  [OrchestratorToolName.Reply]: async (context, input) => {
    const parsed = replyInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused("text: the message to post, in markdown.");
    }
    return await reply(
      context,
      parsed.data.text,
      parsed.data.attachments,
      parsed.data.replyTo
    );
  },

  [OrchestratorToolName.WaitHuman]: async (context, input) => {
    if (!emptyInputSchema.safeParse(input).success) {
      return refused("wait_human takes no arguments.");
    }
    await endTurn(context, OrchestratorTurnEnd.WaitHuman);
    return {
      ok: true,
      output:
        "The conversation waits for people. Finish the turn with a one-line note.",
    };
  },

  [OrchestratorToolName.CloseCase]: async (context, input) => {
    const parsed = closeInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused("summary: optional, one line on how the case ended.");
    }
    await endTurn(context, OrchestratorTurnEnd.Close);
    await withDb((db) =>
      db.orchestratorCase.update({
        where: { id: context.caseId },
        data: { status: OrchestratorCaseStatus.Closed },
      })
    );
    return {
      ok: true,
      output:
        "The case is closed; a new message reopens it. Finish the turn with a one-line note.",
    };
  },

  [OrchestratorToolName.TaskRun]: async (context, input) => {
    const parsed = taskRunInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "runner (its name), command (a slash command it declares), args, prompt (what you want and the context it needs), optional mode, resumeTaskId, fork, optional files ([{taskId, name}] of earlier tasks of this case), optional replyTo (the <message> ref the task answers)."
      );
    }
    const { replyTo } = parsed.data;
    if (replyTo !== undefined) {
      const thread = await messageThread(context.conversationId, replyTo);
      if (thread === null) {
        return refused(
          `replyTo: ${replyTo} is not a message of this conversation (use the ref of the <message> the task answers).`
        );
      }
    }
    const started = await startTask({
      organizationId: context.organizationId,
      projectId: context.projectId,
      caseId: context.caseId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runner: parsed.data.runner,
      command: parsed.data.command,
      args: parsed.data.args,
      prompt: parsed.data.prompt,
      mode: parsed.data.mode ?? null,
      resumeTaskId: parsed.data.resumeTaskId ?? null,
      fork: parsed.data.fork,
      files: parsed.data.files,
      replyTo: replyTo ?? null,
    });
    if (!started.ok) {
      return refused(started.error);
    }
    return {
      ok: true,
      output: {
        taskId: started.value.taskId,
        runner: started.value.runner,
        status: started.value.status,
        error: started.value.error,
        waiting: started.value.waiting,
        replyTo: replyTo ?? null,
        next: taskRunNext(started.value),
      },
    };
  },

  [OrchestratorToolName.RequestDecision]: async (context, input) => {
    const parsed = requestDecisionInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused("question: what people must approve or reject.");
    }
    const decisionId = await requestDecision({
      organizationId: context.organizationId,
      caseId: context.caseId,
      conversationId: context.conversationId,
      question: parsed.data.question,
    });
    const link = await caseLink(context);
    const posted = await reply(
      context,
      `${parsed.data.question}\n\nApprove or reject${link ? ` in AgentFlow (${link})` : " in AgentFlow"}, or answer here.`
    );
    return {
      ok: true,
      output: {
        decisionId,
        posted: posted.ok,
        next: "End the turn with wait_human: the decision wakes you.",
      },
    };
  },

  [OrchestratorToolName.RecordDecision]: async (context, input) => {
    const parsed = recordDecisionInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "decisionId, approved (true or false), decidedBy (who said it, as written), optional comment (what they said)."
      );
    }
    const decided = await decide({
      organizationId: context.organizationId,
      decisionId: parsed.data.decisionId,
      approved: parsed.data.approved,
      comment: parsed.data.comment ?? null,
      via: OrchestratorDecisionVia.Message,
      decidedBy: parsed.data.decidedBy,
      decidedById: null,
      caseId: context.caseId,
      notify: false,
    });
    return decided.ok
      ? { ok: true, output: "The decision is recorded." }
      : refused("No pending decision of this case has that id.");
  },

  [OrchestratorToolName.EditReply]: async (context, input) => {
    const parsed = editReplyInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "reference (what reply returned), text, optional version."
      );
    }
    return await editReply(context, parsed.data);
  },

  [OrchestratorToolName.TaskGet]: async (context, input) => {
    const parsed = taskGetInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused("taskId: the id task_run returned.");
    }
    const task = await withDb((db) =>
      db.orchestratorTask.findFirst({
        where: { id: parsed.data.taskId, caseId: context.caseId },
        select: {
          id: true,
          command: true,
          args: true,
          mode: true,
          status: true,
          result: true,
          computeTarget: { select: { machineName: true } },
        },
      })
    );
    if (!task) {
      return refused("No task of this case has that id.");
    }
    const result = readTaskResult(task.result);
    return {
      ok: true,
      output: jsonValueSchema.parse(
        JSON.parse(
          JSON.stringify({
            taskId: task.id,
            command: [task.command, task.args].filter(Boolean).join(" "),
            runner: task.computeTarget?.machineName ?? null,
            mode: task.mode,
            status: task.status,
            answer: result?.reply ?? null,
            questions: result?.questions ?? [],
            error: result?.error ?? null,
            waiting: result?.waiting ?? null,
            cancelled: result?.cancelled ?? null,
            replyTo: result?.replyTo ?? null,
            files: (result?.files ?? []).map(({ name, size, skipped }) => ({
              name,
              size,
              skipped,
            })),
            filesOmitted: result?.filesOmitted ?? 0,
            inputs: (result?.inputs ?? []).map(({ taskId, name }) => ({
              taskId,
              name,
            })),
          })
        )
      ),
    };
  },

  [OrchestratorToolName.TaskCancel]: async (context, input) => {
    const parsed = taskCancelInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "taskId and reason (e.g. the status the ticket moved to, the label removed)."
      );
    }
    const cancelled = await cancelTask({
      organizationId: context.organizationId,
      caseId: context.caseId,
      turnId: context.turnId,
      taskId: parsed.data.taskId,
      reason: parsed.data.reason,
    });
    if (!cancelled.ok) {
      return refused(cancelled.error);
    }
    return {
      ok: true,
      output: {
        taskId: cancelled.value.taskId,
        cancelled: true,
        was: cancelled.value.previous,
        loopStopped: cancelled.value.loopStopped,
        alreadyCancelled: cancelled.value.alreadyCancelled,
        next: "Tell the thread what was stopped and why; a wait on it wakes with the cancel.",
      },
    };
  },

  [OrchestratorToolName.WaitFor]: async (context, input) => {
    const parsed = waitForInputSchema.safeParse(input);
    if (!parsed.success) {
      return refused(
        "taskIds (1 to 20 ids from task_run), optional kind (all | any), timeoutMinutes and wakeOnFailure."
      );
    }
    const taskIds = [...new Set(parsed.data.taskIds)];
    const owned = await withDb((db) =>
      db.orchestratorTask.count({
        where: { id: { in: taskIds }, caseId: context.caseId },
      })
    );
    if (owned !== taskIds.length) {
      return refused(
        "Wait only for tasks of this case (the ids task_run returned)."
      );
    }
    const now = new Date();
    await createWait(
      {
        organizationId: context.organizationId,
        conversationId: context.conversationId,
        kind: parsed.data.kind,
        taskIds,
        timeoutMinutes: parsed.data.timeoutMinutes ?? null,
        wakeOnFailure: parsed.data.wakeOnFailure,
      },
      now
    );
    await endTurn(context, OrchestratorTurnEnd.WaitTasks);
    // Tasks that already finished fire the wait now: the next turn follows this one.
    await evaluateWaits(context.conversationId, now);
    return {
      ok: true,
      output: `The conversation waits for ${parsed.data.kind === OrchestratorWaitKind.Any ? "the first of" : "all of"} ${taskIds.length} task(s); AgentFlow wakes you with their results. Finish the turn with a one-line note.`,
    };
  },
};

async function reply(
  context: TurnContext,
  text: string,
  attachments: TaskFileRef[] = [],
  replyTo?: string
): Promise<ToolOutcome> {
  const channel = context.channel;
  const connection = await loadConversationConnection(context);
  const replyOnItem = connection?.provider.replyOnItem;
  if (!(channel && connection && replyOnItem)) {
    return refused("This conversation has no thread AgentFlow can post in.");
  }
  const answered = replyTo
    ? await messageThread(context.conversationId, replyTo)
    : undefined;
  if (answered === null) {
    return refused(
      `replyTo: ${replyTo} is not a message of this conversation (use the ref of a <message> you were given).`
    );
  }
  let files: SourceItemFile[] = [];
  if (attachments.length > 0) {
    const uploaded = await uploadReplyFiles({
      caseId: context.caseId,
      refs: attachments,
      connection,
      item: channel.item,
    });
    if (!uploaded.ok) {
      return { ok: false, ...uploaded.error };
    }
    files = uploaded.value;
  }
  const parentId =
    channel.parentId ??
    answered ??
    (await latestMessageRef(context.conversationId));
  const posted = await replyOnItem(
    createProviderContext(connection.runtime, LOG_PREFIX),
    {
      item: channel.item,
      parentId,
      text,
      extras: channel.extras,
      ...(files.length > 0 ? { files } : {}),
    }
  );
  if (!posted.ok) {
    const attachedNote =
      files.length > 0
        ? ` Attached before it: ${files.map((file) => file.name).join(", ")}.`
        : "";
    return {
      ok: false,
      error: `${scrubProviderError(posted.error, connection.runtime.secrets)}${attachedNote}`,
      retryable: posted.retryable,
    };
  }
  await recordReply(context, text, posted.externalRef);
  return {
    ok: true,
    output: {
      posted: true,
      reference: posted.externalRef,
      ...(files.length > 0 ? { attached: files.map((file) => file.name) } : {}),
    } as JsonObject,
  };
}

/** Replaces a message this conversation posted; its anchor keeps the reference. */
async function editReply(
  context: TurnContext,
  input: { reference: string; text: string; version?: number }
): Promise<ToolOutcome> {
  const channel = context.channel;
  const anchor = await withDb((db) =>
    db.orchestratorAnchor.findFirst({
      where: {
        organizationId: context.organizationId,
        conversationId: context.conversationId,
        externalRef: input.reference,
      },
      select: { id: true },
    })
  );
  if (!(anchor && channel)) {
    return refused(
      "Edit only a message this conversation posted (the reference reply returned)."
    );
  }
  const connection = await loadConversationConnection(context);
  const editOnItem = connection?.provider.editOnItem;
  if (!(connection && editOnItem)) {
    return refused("Messages of this conversation's thread cannot be edited.");
  }
  const edited = await editOnItem(
    createProviderContext(connection.runtime, LOG_PREFIX),
    {
      item: channel.item,
      externalRef: input.reference,
      text: input.text,
      extras: channel.extras,
    }
  );
  if (!edited.ok) {
    return {
      ok: false,
      error: scrubProviderError(edited.error, connection.runtime.secrets),
      retryable: edited.retryable,
    };
  }
  if (input.version) {
    await withDb((db) =>
      db.orchestratorAnchor.update({
        where: { id: anchor.id },
        data: { version: input.version },
      })
    );
  }
  return { ok: true, output: { edited: true, reference: input.reference } };
}

/** The case's page in AgentFlow, for people to decide there. */
async function caseLink(context: TurnContext): Promise<string | null> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: context.organizationId },
      select: { slug: true },
    })
  );
  return organization?.slug
    ? orchestratorCaseUrl(organization.slug, context.caseId)
    : null;
}

/** The orchestrator's message in the history, and an anchor for replies to it. */
async function recordReply(
  context: TurnContext,
  text: string,
  externalRef: string | null
): Promise<void> {
  const provider = context.channel?.item.provider ?? "agentflow";
  await withDb((db) =>
    db.orchestratorMessage.create({
      data: {
        organizationId: context.organizationId,
        conversationId: context.conversationId,
        origin: OrchestratorMessageOrigin.Internal,
        kind: OrchestratorMessageKind.Reply,
        actor: null,
        text,
        externalRef,
        dedupKey: `reply:${context.turnId}:${externalRef ?? Date.now()}`,
        turnId: context.turnId,
      },
    })
  );
  if (!externalRef) {
    return;
  }
  try {
    await withDb((db) =>
      db.orchestratorAnchor.create({
        data: {
          organizationId: context.organizationId,
          conversationId: context.conversationId,
          provider,
          externalRef,
        },
      })
    );
  } catch (error) {
    if (getPrismaErrorCode(error) !== PRISMA_UNIQUE_VIOLATION) {
      throw error;
    }
  }
}

/**
 * The comment to answer in the thread of: the conversation's newest message
 * from people, or the comment that message replies to when it is itself a
 * reply (comment threads have one level: an answer goes to the thread's
 * first comment). A turn woken by task results or a decision took no message
 * from people itself, and still answers in the thread of the request it
 * works on.
 */
async function loadConversationConnection(context: TurnContext) {
  if (!context.projectConnectionId) {
    return null;
  }
  const loaded = await loadProjectConnectionRuntime(
    context.organizationId,
    context.projectConnectionId
  );
  return loaded?.connection ?? null;
}

async function endTurn(
  context: TurnContext,
  ended: OrchestratorTurnEnd
): Promise<void> {
  await withDb((db) =>
    db.orchestratorTurn.updateMany({
      where: { id: context.turnId, status: OrchestratorTurnStatus.Running },
      data: { ended },
    })
  );
}

function refused(error: string): ToolOutcome {
  return { ok: false, error, retryable: false };
}

/** What the orchestrator should do after task_run, by how the task started. */
function taskRunNext(started: {
  status: string;
  waiting: string | null;
}): string {
  if (started.status === OrchestratorTaskStatus.Failed) {
    return "The task did not start: tell the thread why (error), then wait_human or try another runner.";
  }
  if (started.status === OrchestratorTaskStatus.Queued && started.waiting) {
    return "It waits for its runner: tell the thread, then wait_for it.";
  }
  return "Start the other tasks this request needs, then wait_for them.";
}

const SUPERSEDABLE_TOOLS: ReadonlySet<string> = new Set<string>([
  OrchestratorToolName.Reply,
  OrchestratorToolName.EditReply,
  OrchestratorToolName.TaskRun,
  OrchestratorToolName.TaskCancel,
  OrchestratorToolName.RequestDecision,
  OrchestratorToolName.RecordDecision,
  OrchestratorToolName.CloseCase,
]);
