import {
  LOOP_STEP_INPUTS_DIR,
  LOOP_STEP_WORK_DIR,
  type LoopStepConfig,
  LoopStepFinish,
  type LoopStepInputFile,
} from "@agentflow-ai/loops-api/loop-step";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import {
  LoopCommand,
  LoopStatus,
  MAX_ADDITIONAL_REPOS,
} from "@repo/api/src/types/loop";
import {
  ORCHESTRATOR_TASK_REPLY_FILE,
  ORCHESTRATOR_TASK_REPLY_MAX,
  OrchestratorTaskStatus,
} from "@repo/api/src/types/orchestrator";
import { Result } from "@repo/api/src/types/result";
import {
  type ComputeTargetCapabilities,
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { WorkflowRunErrorCode } from "@repo/api/src/types/workflow";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { computeTargetCapabilitiesService } from "@/app/compute-targets/capabilities-service";
import { documentService } from "@/app/documents/document-service";
import { loopsService } from "@/app/loops/service";
import {
  findRepositoryCheckout,
  listProjectRepositoryCheckouts,
  toLoopRepositorySelection,
} from "@/app/projects/project-repository-checkouts";
import { resolveLaunchHarness } from "@/lib/loops/launch-harness";
import {
  LOOP_STEP_METADATA_KEY,
  readStepResult,
} from "@/lib/loops/loop-commands/step-handler";
import { dispatchAndClassify } from "@/lib/loops/loop-dispatch-utils";
import {
  forkUnsupportedMessage,
  runnerForksSession,
} from "@/lib/runner-fork-session";
import {
  cancelBlockedLoop,
  checkCommandSigning,
  mapLoopCreateError,
} from "@/lib/workflows/engine/launch";
import { personalRunnerBusy } from "@/lib/workflows/engine/personal-runner-queue";
import { isLoopSettled } from "@/lib/workflows/engine/run-loops";
import { renderCase } from "./case-render";
import { taskCancelledMessage } from "./task-cancel";
import {
  loadTaskInputs,
  resolveTaskInputs,
  type TaskFileRef,
  taskFilesFromStep,
} from "./task-files";
import { readTaskResult, type TaskResult } from "./task-result";

/**
 * The orchestrator's tasks (docs/orchestrator.md): one command of one runner,
 * run as a STEP loop on that runner. A task works on its case's Issue (made
 * with the case's first task), which carries the project, its repositories and
 * the workspace: every task of one case on one runner shares that workspace,
 * so a later task can resume an earlier one's session (`resumeTaskId`, in a
 * copy with `fork`). A personal runner that runs one task at a time takes the
 * tasks in turn (`queued`). The agent leaves its answer in
 * ORCHESTRATOR_TASK_REPLY_FILE; questions it writes come back with the result.
 * A task that task_cancel closed stays cancelled: it is never resumed, and no
 * later write here overwrites that status.
 */

const LOG_PREFIX = "[orchestrator/tasks]";
const TASK_NAME_MAX = 80;
const ERROR_MAX = 2000;

export type StartTaskInput = {
  organizationId: string;
  projectId: string;
  caseId: string;
  conversationId: string;
  turnId: string;
  /** The runner's name (as AGENTFLOW.md lists it) or id. */
  runner: string;
  command: string;
  args: string;
  prompt: string;
  /** Null: the mode its AGENTFLOW.md declares (write when undeclared). */
  mode: RunnerCommandMode | null;
  resumeTaskId: string | null;
  fork: boolean;
  /** Files of earlier tasks of the case, written to the task's `inputs/`. */
  files: TaskFileRef[];
};

export async function startTask(input: StartTaskInput): Promise<
  Result<
    {
      taskId: string;
      status: string;
      runner: string;
      error: string | null;
      waiting: string | null;
    },
    string
  >
> {
  const files = await computeTargetCapabilitiesService.listForProject(
    input.organizationId,
    input.projectId
  );
  const runner = findRunner(files, input.runner);
  if (!runner) {
    return Result.err(
      `No runner "${input.runner}" declared commands for this project: ${files.map((file) => file.runnerName).join(", ") || "none did"}.`
    );
  }
  const declared = runner.capabilities?.commands.find(
    (command) => command.name === input.command
  );
  if (input.resumeTaskId) {
    const resumed = await withDb((db) =>
      db.orchestratorTask.findFirst({
        where: { id: input.resumeTaskId ?? "", caseId: input.caseId },
        select: {
          computeTargetId: true,
          loopId: true,
          status: true,
          result: true,
        },
      })
    );
    if (resumed?.status === OrchestratorTaskStatus.Cancelled) {
      return Result.err(
        taskCancelledMessage(readTaskResult(resumed.result)) ??
          "The task to resume was cancelled."
      );
    }
    if (!resumed?.loopId) {
      return Result.err(
        "The task to resume is not one of this case's started tasks."
      );
    }
    if (resumed.computeTargetId !== runner.computeTargetId) {
      return Result.err(
        "A task resumes on the runner of the task it continues: its session is there."
      );
    }
  }
  const inputs =
    input.files.length > 0
      ? await resolveTaskInputs(input.caseId, input.files)
      : null;
  if (inputs && !inputs.ok) {
    return Result.err(inputs.error);
  }
  const task = await withDb((db) =>
    db.orchestratorTask.create({
      data: {
        organizationId: input.organizationId,
        caseId: input.caseId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        computeTargetId: runner.computeTargetId,
        command: input.command,
        args: input.args,
        prompt: input.prompt,
        mode: input.mode ?? declared?.mode ?? RunnerCommandMode.Write,
        resumeTaskId: input.resumeTaskId,
        fork: input.fork,
        status: OrchestratorTaskStatus.Queued,
        ...(inputs?.ok
          ? {
              result: {
                reply: null,
                questions: [],
                error: null,
                inputs: inputs.value,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: { id: true },
    })
  );
  const status = await launchTask(task.id);
  const stored = await withDb((db) =>
    db.orchestratorTask.findUnique({
      where: { id: task.id },
      select: { result: true },
    })
  );
  const result = readTaskResult(stored?.result);
  return Result.ok({
    taskId: task.id,
    status,
    runner: runner.runnerName,
    error: result?.error ?? null,
    waiting: result?.waiting ?? null,
  });
}

/** The tick's stage: queued tasks try their runner again, running ones settle. */
export async function advanceTasks(now: Date): Promise<{
  launched: number;
  /** Conversations whose tasks finished: their waits are evaluated next. */
  settledConversationIds: string[];
}> {
  const queued = await withDb((db) =>
    db.orchestratorTask.findMany({
      where: { status: OrchestratorTaskStatus.Queued },
      orderBy: { createdAt: "asc" },
      take: TICK_LIMIT,
      select: { id: true, conversationId: true },
    })
  );
  let launched = 0;
  const settled = new Set<string>();
  for (const task of queued) {
    const status = await launchTask(task.id);
    if (status === OrchestratorTaskStatus.Running) {
      launched += 1;
    }
    // A queued task that fails now will never run: its wait must hear of it.
    if (status === OrchestratorTaskStatus.Failed) {
      settled.add(task.conversationId);
    }
  }
  const running = await withDb((db) =>
    db.orchestratorTask.findMany({
      where: { status: OrchestratorTaskStatus.Running },
      take: TICK_LIMIT,
      select: { id: true, conversationId: true, loopId: true },
    })
  );
  for (const task of running) {
    if (task.loopId && (await settleTask(task.id, task.loopId, now))) {
      settled.add(task.conversationId);
    }
  }
  return { launched, settledConversationIds: [...settled] };
}

const TICK_LIMIT = 50;

type TaskRow = Prisma.OrchestratorTaskGetPayload<{
  include: {
    case: { select: { projectId: true; title: true } };
    computeTarget: {
      select: {
        userId: true;
        machineName: true;
        capabilities: true;
        isOnline: true;
      };
    };
  };
}>;

/** Starts a queued task's loop; the status it is in afterwards. */
async function launchTask(taskId: string): Promise<string> {
  const task = await withDb((db) =>
    db.orchestratorTask.findUnique({
      where: { id: taskId },
      include: {
        case: { select: { projectId: true, title: true } },
        computeTarget: {
          select: {
            userId: true,
            machineName: true,
            capabilities: true,
            isOnline: true,
          },
        },
      },
    })
  );
  if (!task || task.status !== OrchestratorTaskStatus.Queued) {
    return task?.status ?? OrchestratorTaskStatus.Failed;
  }
  const launched = await launchLoop(task);
  if (launched.ok) {
    return launched.value;
  }
  await failTask(task.id, launched.error);
  return OrchestratorTaskStatus.Failed;
}

async function launchLoop(task: TaskRow): Promise<Result<string, string>> {
  const computeTargetId = task.computeTargetId;
  const owner = await findRunnerOwner(task);
  if (!(computeTargetId && owner)) {
    return Result.err(
      "The task's runner no longer exists, or its owner left the organization."
    );
  }
  const blocked = unsupportedFork(task) ?? offlineMessage(task);
  if (blocked) {
    return Result.err(blocked);
  }
  const busy = await personalRunnerBusy({
    organizationId: task.organizationId,
    computeTargetId,
  });
  if (busy) {
    return queueWaiting(task, busy.message);
  }
  const signing = await checkCommandSigning(computeTargetId, owner);
  if (!signing.ok) {
    return Result.err(signing.error.message);
  }
  const checkouts = await listProjectRepositoryCheckouts(
    task.organizationId,
    task.case.projectId
  );
  const repositories = toLoopRepositorySelection(checkouts);
  if (!repositories) {
    return Result.err(
      "The project has no repositories: a task works in them. Add them from an integration connection."
    );
  }
  const documentId = await ensureTaskDocument(task, owner.id);
  if (!documentId) {
    return Result.err("The case's Issue could not be created in the project.");
  }
  const resumed = task.resumeTaskId
    ? await withDb((db) =>
        db.orchestratorTask.findUnique({
          where: { id: task.resumeTaskId ?? "" },
          select: { loopId: true, status: true },
        })
      )
    : null;
  if (resumed?.status === OrchestratorTaskStatus.Cancelled) {
    return Result.err(
      "It resumes a task that was cancelled when the ticket changed."
    );
  }
  const built = await prepareStep(task, checkouts);
  if (!built.ok) {
    return Result.err(built.error);
  }
  const { step, attach, inputs } = built.value;
  let created: Awaited<ReturnType<typeof loopsService.create>>;
  try {
    created = await loopsService.create(task.organizationId, owner.id, {
      command: LoopCommand.Step,
      harness: await resolveLaunchHarness(
        computeTargetId,
        task.organizationId,
        {
          clerkUserId: owner.clerkId,
          userId: owner.id,
        }
      ),
      documentId,
      parentLoopId: resumed?.loopId ?? undefined,
      computeTargetId,
      prompt: buildTaskPrompt(task, {
        attach,
        inputs: inputs.map((file) => file.name),
      }),
      repo: repositories.primary,
      additionalRepos: repositories.additional.slice(0, MAX_ADDITIONAL_REPOS),
      metadata: {
        orchestratorTaskId: task.id,
        [LOOP_STEP_METADATA_KEY]: step,
      },
    });
  } catch (error) {
    return await loopCreateFailure(task, error);
  }
  if (created.status === LoopStatus.Blocked) {
    await cancelBlockedLoop(created.loopId, task.organizationId);
    return Result.err(
      "The case's Issue is blocked by another document, so the task was not started."
    );
  }
  // Another task or run took the runner at the same moment: the earlier wins.
  const raced = await personalRunnerBusy({
    organizationId: task.organizationId,
    computeTargetId,
    ownLoopId: created.loopId,
  });
  if (raced) {
    await cancelBlockedLoop(created.loopId, task.organizationId);
    return queueWaiting(task, raced.message);
  }
  if (!(await markStarted(task, created.loopId))) {
    // task_cancel closed the task meanwhile: its loop never runs.
    await cancelBlockedLoop(created.loopId, task.organizationId);
    return Result.ok(OrchestratorTaskStatus.Cancelled);
  }
  const dispatch = await dispatchAndClassify(
    created.loopId,
    task.organizationId,
    LOG_PREFIX,
    { orchestratorTaskId: task.id }
  );
  if (!dispatch.ok) {
    await failTask(
      task.id,
      `The task's loop could not be sent to ${task.computeTarget?.machineName ?? "the runner"} (${dispatch.error}): the runner may be offline.`
    );
    return Result.ok(OrchestratorTaskStatus.Failed);
  }
  return Result.ok(OrchestratorTaskStatus.Running);
}

/** The step's settings, with the earlier tasks' files as inputs; refused when the toolkit is not a project repository. */
async function prepareStep(
  task: TaskRow,
  checkouts: Awaited<ReturnType<typeof listProjectRepositoryCheckouts>>
): Promise<
  Result<
    { step: LoopStepConfig; attach: string[]; inputs: LoopStepInputFile[] },
    string
  >
> {
  const inputs = await loadTaskInputs(
    readTaskResult(task.result)?.inputs ?? []
  );
  if (!inputs.ok) {
    return Result.err(inputs.error);
  }
  const { step, attach } = await buildStep(task, inputs.value);
  if (
    step.toolkit &&
    !findRepositoryCheckout(checkouts, step.toolkit.repository)
  ) {
    return Result.err(
      `The runner's toolkit ${step.toolkit.repository} (its AGENTFLOW.md) is not one of the project's repositories.`
    );
  }
  return Result.ok({ step, attach, inputs: inputs.value });
}

/** The task starts: it no longer waits. False when it is no longer queued. */
async function markStarted(
  task: { id: string; result: unknown },
  loopId: string
): Promise<boolean> {
  const taskId = task.id;
  const inputs = readTaskResult(task.result)?.inputs;
  const started: TaskResult = {
    reply: null,
    questions: [],
    error: null,
    waiting: null,
    ...(inputs ? { inputs } : {}),
  };
  const updated = await withDb((db) =>
    db.orchestratorTask.updateMany({
      where: { id: taskId, status: OrchestratorTaskStatus.Queued },
      data: {
        loopId,
        status: OrchestratorTaskStatus.Running,
        result: started as Prisma.InputJsonValue,
      },
    })
  );
  return updated.count === 1;
}

/** The loop's step settings: the task's command, on the case's workspace. */
async function buildStep(
  task: TaskRow,
  inputs: LoopStepInputFile[]
): Promise<{ step: LoopStepConfig; attach: string[] }> {
  const earlier = await withDb((db) =>
    db.orchestratorTask.count({
      where: {
        caseId: task.caseId,
        computeTargetId: task.computeTargetId,
        loopId: { not: null },
        id: { not: task.id },
      },
    })
  );
  const capabilities = await computeTargetCapabilitiesService.listForProject(
    task.organizationId,
    task.case.projectId
  );
  const file = capabilities.find(
    (candidate) => candidate.computeTargetId === task.computeTargetId
  );
  const declared = file?.capabilities?.commands.find(
    (command) => command.name === task.command
  );
  // A personal runner's own commands commit and push; AgentFlow pushes for
  // an auto runner's command that declares it.
  const personal = file?.source === RunnerCapabilitiesSource.Personal;
  const pushes =
    declared?.push === true &&
    !personal &&
    task.mode !== RunnerCommandMode.Read;
  // An auto runner's commands come from its toolkit; a personal runner has
  // its own in its folder.
  const toolkit = personal ? null : (file?.capabilities?.toolkit ?? null);
  const attach = declared?.attach ?? [];
  const step: LoopStepConfig = {
    // A personal runner keeps one work directory per case.
    runId: task.caseId,
    stepId: task.id,
    name: (task.command || "Task").slice(0, TASK_NAME_MAX),
    fresh: earlier === 0,
    askQuestions: declared?.asks === true,
    artifacts: [ORCHESTRATOR_TASK_REPLY_FILE],
    finish: pushes ? LoopStepFinish.Push : LoopStepFinish.None,
    toolkit: toolkit
      ? {
          repository: toolkit.repository,
          mounts: toolkit.mounts,
          instructions: toolkit.instructions ?? "",
        }
      : null,
    ...(task.mode === RunnerCommandMode.Read ? { readOnly: true } : {}),
    ...(task.fork ? { forkSession: true } : {}),
    ...(attach.length > 0
      ? { attach: attach.map((glob) => `${LOOP_STEP_WORK_DIR}/${glob}`) }
      : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
  };
  return { step, attach };
}

/** The command and its arguments first (a slash command is expanded), then the request. */
export function buildTaskPrompt(
  task: {
    command: string;
    args: string;
    prompt: string;
    mode: string;
  },
  files: { attach: string[]; inputs: string[] } = { attach: [], inputs: [] }
): string {
  const head = [task.command, task.args].filter(Boolean).join(" ");
  const readOnly =
    task.mode === RunnerCommandMode.Read
      ? " This task only reads: change no file of the project, commit nothing."
      : "";
  return [
    head,
    task.prompt.trim(),
    `---\nYou run as a task of the project's orchestrator in AgentFlow. When you are done, write your answer for the orchestrator to \`${ORCHESTRATOR_TASK_REPLY_FILE}\` (on a personal runner: \`$AGENTFLOW_WORKDIR/orchestrator-reply.md\`): what you found or did, concise, with file paths and links where they help.${readOnly}${attachNote(files.attach)}${inputsNote(files.inputs)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function attachNote(attach: string[]): string {
  if (attach.length === 0) {
    return "";
  }
  return ` Leave the files your command writes for the ticket (${attach.join(", ")}) in \`${LOOP_STEP_WORK_DIR}/\` (on a personal runner: \`$AGENTFLOW_WORKDIR\`): AgentFlow collects them when you finish and the orchestrator attaches them to the ticket.`;
}

function inputsNote(inputs: string[]): string {
  if (inputs.length === 0) {
    return "";
  }
  return ` Files from earlier tasks of this case are in \`${LOOP_STEP_WORK_DIR}/${LOOP_STEP_INPUTS_DIR}/\` (on a personal runner: \`$AGENTFLOW_WORKDIR/${LOOP_STEP_INPUTS_DIR}/\`): ${inputs.join(", ")}.`;
}

/**
 * The case's Issue on the task's runner: the one an earlier task of the case
 * there used, else a new one (the case as it stands, CASE.md).
 */
async function ensureTaskDocument(
  task: TaskRow,
  userId: string
): Promise<string | null> {
  if (task.documentId) {
    return task.documentId;
  }
  const earlier = await withDb((db) =>
    db.orchestratorTask.findFirst({
      where: {
        caseId: task.caseId,
        computeTargetId: task.computeTargetId,
        documentId: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { documentId: true },
    })
  );
  let documentId = earlier?.documentId ?? null;
  if (!documentId) {
    const document = await documentService.create(task.organizationId, userId, {
      type: DocumentType.Feature,
      title:
        `${task.case.title} · ${task.computeTarget?.machineName ?? "runner"}`.slice(
          0,
          DOCUMENT_TITLE_MAX
        ),
      content: await renderCase(task.caseId),
      projectId: task.case.projectId,
      status: IssueStatus.InProgress,
    });
    documentId = document?.id ?? null;
  }
  if (documentId) {
    await withDb((db) =>
      db.orchestratorTask.update({
        where: { id: task.id },
        data: { documentId },
      })
    );
  }
  return documentId;
}

const DOCUMENT_TITLE_MAX = 255;

/** Settles a running task whose loop ended; true when it did. */
async function settleTask(
  taskId: string,
  loopId: string,
  now: Date
): Promise<boolean> {
  const loop = await withDb((db) =>
    db.loop.findUnique({
      where: { id: loopId },
      select: {
        status: true,
        completedAt: true,
        revivalCount: true,
        uploadedArtifacts: true,
        error: true,
      },
    })
  );
  if (!loop) {
    await failTask(taskId, "The task's loop no longer exists.");
    return true;
  }
  const settled = await isLoopSettled(
    {
      loopId,
      status: loop.status as LoopStatus,
      completedAt: loop.completedAt,
      revivalCount: loop.revivalCount,
    },
    now
  );
  if (!settled) {
    return false;
  }
  const outputs = readStepResult(loop.uploadedArtifacts);
  const reply =
    outputs?.files
      .find((file) => file.path === ORCHESTRATOR_TASK_REPLY_FILE)
      ?.content.slice(0, ORCHESTRATOR_TASK_REPLY_MAX) ?? null;
  const succeeded = loop.status === LoopStatus.Completed;
  const { files, filesOmitted } = taskFilesFromStep(outputs);
  const result: TaskResult = {
    reply,
    questions: outputs?.questions ?? [],
    error: succeeded ? null : loopErrorText(loop.status, loop.error),
    ...(files.length > 0 ? { files } : {}),
    ...(filesOmitted > 0 ? { filesOmitted } : {}),
  };
  const updated = await withDb((db) =>
    db.orchestratorTask.updateMany({
      where: { id: taskId, status: OrchestratorTaskStatus.Running },
      data: {
        status: succeeded
          ? OrchestratorTaskStatus.Succeeded
          : OrchestratorTaskStatus.Failed,
        result: result as Prisma.InputJsonValue,
        finishedAt: now,
      },
    })
  );
  return updated.count === 1;
}

async function failTask(taskId: string, error: string): Promise<void> {
  log.warn(`${LOG_PREFIX} task failed`, { taskId, error });
  const result: TaskResult = {
    reply: null,
    questions: [],
    error: error.slice(0, ERROR_MAX),
  };
  await withDb((db) =>
    db.orchestratorTask.updateMany({
      where: {
        id: taskId,
        status: {
          in: [OrchestratorTaskStatus.Queued, OrchestratorTaskStatus.Running],
        },
      },
      data: {
        status: OrchestratorTaskStatus.Failed,
        result: result as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    })
  );
}

const loopErrorSchema = z.object({ message: z.string() });

function loopErrorText(status: string, error: unknown): string {
  const parsed = loopErrorSchema.safeParse(error);
  return parsed.success
    ? `The task's loop ended ${status}: ${parsed.data.message}`.slice(
        0,
        ERROR_MAX
      )
    : `The task's loop ended ${status}.`;
}

function findRunner(
  files: ComputeTargetCapabilities[],
  runner: string
): ComputeTargetCapabilities | undefined {
  const wanted = runner.trim().toLowerCase();
  return files.find(
    (file) =>
      file.computeTargetId === runner ||
      file.runnerName.toLowerCase() === wanted ||
      file.capabilities?.runner?.toLowerCase() === wanted
  );
}

/** Why the task's runner cannot fork the session it resumes, or null. */
function unsupportedFork(task: TaskRow): string | null {
  if (!task.fork || runnerForksSession(task.computeTarget?.capabilities)) {
    return null;
  }
  return forkUnsupportedMessage({
    machineName: task.computeTarget?.machineName,
    session: "the earlier task's session",
    advice: "Update the runner, or resume without fork.",
  });
}

/** Keeps the task queued and records why it has not started. */
async function queueWaiting(
  task: { id: string; result: unknown },
  waiting: string
): Promise<Result<string, string>> {
  const taskId = task.id;
  const inputs = readTaskResult(task.result)?.inputs;
  const result: TaskResult = {
    reply: null,
    questions: [],
    error: null,
    waiting: waiting.slice(0, ERROR_MAX),
    ...(inputs ? { inputs } : {}),
  };
  await withDb((db) =>
    db.orchestratorTask.updateMany({
      where: { id: taskId, status: OrchestratorTaskStatus.Queued },
      data: { result: result as Prisma.InputJsonValue },
    })
  );
  return Result.ok(OrchestratorTaskStatus.Queued);
}

/** Why an offline runner cannot take the task, or null when it is online. */
function offlineMessage(task: TaskRow): string | null {
  if (task.computeTarget?.isOnline) {
    return null;
  }
  const name = task.computeTarget?.machineName;
  return `${name ? `Runner ${name}` : "The runner"} is offline: the task was not started. Tell the thread, and run it again when the runner is back.`;
}

function findRunnerOwner(
  task: TaskRow
): Promise<{ id: string; clerkId: string } | null> {
  const userId = task.computeTarget?.userId;
  if (!userId) {
    return Promise.resolve(null);
  }
  return withDb((db) =>
    db.user.findFirst({
      where: { id: userId, organizationId: task.organizationId, active: true },
      select: { id: true, clerkId: true },
    })
  );
}

/** A loop create that threw: the task waits its turn, fails, or the error is unexpected. */
async function loopCreateFailure(
  task: TaskRow,
  error: unknown
): Promise<Result<string, string>> {
  const mapped = mapLoopCreateError(error);
  // The runner works on another task of the case (one loop per Issue):
  // this one goes next.
  if (mapped?.code === WorkflowRunErrorCode.LoopAlreadyActive) {
    return await queueWaiting(
      task,
      `Waiting for the case's other task on ${task.computeTarget?.machineName ?? "the runner"} to finish (one task per Issue on a runner).`
    );
  }
  if (mapped) {
    return Result.err(mapped.message);
  }
  throw error;
}
