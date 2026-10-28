import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import type { ConnectionGrants } from "@repo/api/src/types/connection-grants";
import { IntegrationToolCallStatus } from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowInstructionOperationResult,
  WorkflowInstructionOperationStatus,
  type WorkflowInstructionRunDetail,
} from "@repo/api/src/types/workflow";
import {
  WORKFLOW_INSTRUCTION_PROMPT_MAX,
  WORKFLOW_INSTRUCTION_TIMEOUT_MS,
  type WorkflowInstructionResult,
  workflowInstructionResultSchema,
} from "@repo/api/src/types/workflow-instruction";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { integrationToolSessionService } from "@/app/integration-tools/integration-tool-session-service";
import {
  findRepositoryCheckout,
  listProjectRepositoryCheckouts,
} from "@/app/projects/project-repository-checkouts";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  buildAgentTools,
  describeAgentToolSession,
} from "@/lib/integrations/agent-tools/catalog";
import { loadAgentToolSession } from "@/lib/integrations/agent-tools/session-input";
import type {
  ActionResult,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import { dispatchWorkflowInstruction } from "@/lib/loops/loop-desktop";
import {
  prependUntrustedLoopInputPreamble,
  wrapUntrustedLoopArtifactContent,
} from "@/lib/loops/untrusted-loop-input";
import { RUNNER_WITHOUT_TOOLS, trimMessage } from "./errors";
import { resolveProjectComputeTarget } from "./launch";
import { readAgentConfig, toJsonObject } from "./run-data";

/**
 * Instruction actions (docs/workflows.md "Actions"): `on: <event>` plus an
 * instruction in plain language. The run's computer runs an agent read-only
 * in the run's workspace (the folder the run's loops share, with the PRD,
 * the plan, the execution result and the repositories). The agent reads the
 * run's source item and writes only through the AgentFlow integration tools
 * (docs/workflows.md "Integration tools"): the tools of its session are
 * exactly what the instruction's `connections:` grant allows, the API checks
 * and carries out every call with the connection's credentials (they never
 * reach the computer) and records it. The agent's final answer is a note.
 *
 * An action run of an instruction goes pending -> running (dispatch, the
 * attempt's tool session opened) -> waiting (the agent works and calls
 * tools) -> running (its calls summarized) -> final, through actions.ts.
 * Retrying an attempt starts a new agent and a new session; once a write
 * succeeded the action is never retried, so nothing is written twice.
 */

export type InstructionStart =
  | { kind: "dispatched"; commandId: string }
  | { kind: "skip"; reason: string }
  | { kind: "failed"; error: string; retryable: boolean };

/** Where an instruction's agent stands. */
export type InstructionProgress =
  | { kind: "running" }
  | { kind: "answered"; result: WorkflowInstructionResult };

export type InstructionOutcome = {
  result: ActionResult;
  detail: WorkflowInstructionRunDetail;
};

/** Longest a run waits for the computer's answer, queueing included. */
export const INSTRUCTION_MAX_WAIT_MS =
  WORKFLOW_INSTRUCTION_TIMEOUT_MS + 10 * 60_000;

/**
 * Opens the attempt's integration tool session and asks the run's computer
 * to run the instruction's agent.
 */
export async function startInstruction(input: {
  actionRunId: string;
  attempt: number;
  organizationId: string;
  runId: string;
  instruction: string;
  grants: ConnectionGrants | undefined;
  snapshot: WorkflowRunSnapshot;
}): Promise<InstructionStart> {
  const workspace = await resolveRunWorkspace(
    input.runId,
    input.organizationId
  );
  if (!workspace.ok) {
    return { kind: "skip", reason: workspace.error };
  }
  const tools = await loadAgentToolSession({
    agent: "an instruction",
    organizationId: input.organizationId,
    runId: input.runId,
    grants: input.grants,
    snapshot: input.snapshot,
  });
  if (!tools) {
    return { kind: "skip", reason: "The run no longer exists." };
  }
  const prompt = buildInstructionPrompt({
    instruction: input.instruction,
    snapshot: input.snapshot,
    tools: describeAgentToolSession(tools.input, buildAgentTools(tools.input)),
  });
  try {
    await integrationToolSessionService.openForInstruction({
      organizationId: input.organizationId,
      runId: input.runId,
      actionRunId: input.actionRunId,
      attempt: input.attempt,
      computeTargetId: workspace.value.computeTargetId,
      expiresAt: new Date(Date.now() + INSTRUCTION_MAX_WAIT_MS),
    });
    const commandId = await dispatchWorkflowInstruction({
      computeTargetId: workspace.value.computeTargetId,
      request: {
        actionRunId: input.actionRunId,
        workspaceKey: workspace.value.workspaceKey,
        repository: workspace.value.repository,
        prompt,
      },
    });
    return { kind: "dispatched", commandId };
  } catch (error) {
    return {
      kind: "failed",
      error: `The run's computer could not be asked to run the instruction: ${parseError(error)}`,
      retryable: true,
    };
  }
}

/**
 * The agent's answer once the computer finished, else `running`. A command
 * that is gone, failed, or overdue (INSTRUCTION_MAX_WAIT_MS since the row
 * started waiting) answers as a retryable failure; an overdue one is expired
 * so a reconnecting computer does not run it later.
 */
export async function readInstructionProgress(
  row: { commandId: string | null; updatedAt: Date },
  now: Date
): Promise<InstructionProgress> {
  const command = row.commandId
    ? await desktopCommandStore.getCommandById(row.commandId)
    : null;
  if (!command) {
    return answered(
      "The instruction's command on the run's computer no longer exists."
    );
  }
  if (command.status === DesktopCommandStatus.Done) {
    return { kind: "answered", result: await readCommandAnswer(command) };
  }
  if (FAILED_COMMAND_STATUSES.has(command.status)) {
    const detail = command.error ? `: ${command.error}` : "";
    return answered(
      `The run's computer did not run the instruction (${command.status}${detail}).`
    );
  }
  if (now.getTime() - row.updatedAt.getTime() <= INSTRUCTION_MAX_WAIT_MS) {
    return { kind: "running" };
  }
  await desktopCommandStore.markCommandExpired(
    command.commandId,
    "workflow_instruction_wait_exceeded",
    { commandId: command.commandId, computeTargetId: command.computeTargetId }
  );
  return answered(
    `The run's computer did not answer within ${Math.round(INSTRUCTION_MAX_WAIT_MS / 60_000)} minutes.`
  );
}

/**
 * Settles an answered attempt from the integration tool calls its agent
 * made. A failed (or unfinished) write fails the action, retried only when
 * no write of the attempt succeeded; refused calls never reached the
 * provider and are listed only.
 */
export async function summarizeInstruction(input: {
  actionRunId: string;
  attempt: number;
  answer: Extract<WorkflowInstructionResult, { ok: true }>;
}): Promise<InstructionOutcome> {
  const session = await withDb((db) =>
    db.integrationToolSession.findFirst({
      where: { actionRunId: input.actionRunId, attempt: input.attempt },
      select: { issuedAt: true },
    })
  );
  const calls = await withDb((db) =>
    db.integrationToolCall.findMany({
      where: {
        actionRunId: input.actionRunId,
        session: { attempt: input.attempt },
      },
      orderBy: { createdAt: "asc" },
      take: DETAIL_CALLS_MAX,
      select: {
        tool: true,
        operationType: true,
        connectionKey: true,
        input: true,
        status: true,
        externalRef: true,
        error: true,
      },
    })
  );
  const detail: WorkflowInstructionRunDetail = {
    note: input.answer.answer.trim().slice(0, NOTE_MAX) || null,
    operations: calls.map(toOperationResult),
    costUsd: input.answer.costUsd,
    inputTokens: input.answer.inputTokens,
    outputTokens: input.answer.outputTokens,
  };
  if (!session?.issuedAt) {
    // A runner from before integration tools runs the agent without them.
    return {
      result: {
        status: "failed",
        error: RUNNER_WITHOUT_TOOLS,
        retryable: false,
      },
      detail,
    };
  }
  const writes = calls.filter((call) => call.operationType !== null);
  const succeeded = writes.filter(
    (call) => call.status === IntegrationToolCallStatus.Succeeded
  );
  const failedWrite = writes.find(
    (call) =>
      call.status === IntegrationToolCallStatus.Failed ||
      call.status === IntegrationToolCallStatus.Running
  );
  if (failedWrite) {
    return {
      result: {
        status: "failed",
        error: trimMessage(
          `${failedWrite.tool} failed: ${failedWrite.error ?? "it did not finish"}`
        ),
        retryable: succeeded.length === 0,
      },
      detail,
    };
  }
  const externalRef = succeeded.find((call) => call.externalRef)?.externalRef;
  return {
    result: { status: "succeeded", ...(externalRef ? { externalRef } : {}) },
    detail,
  };
}

const FAILED_COMMAND_STATUSES: ReadonlySet<string> = new Set<string>([
  DesktopCommandStatus.Failed,
  DesktopCommandStatus.Cancelled,
  DesktopCommandStatus.Expired,
]);

const NOTE_MAX = 2000;

const RUN_FACTS_MAX = 60_000;
const DETAIL_CALLS_MAX = 50;

type RunWorkspace = {
  computeTargetId: string;
  workspaceKey: string;
  repository: { fullName: string; cloneUrl: string };
};

const WORKSPACE_GUIDE = `Your working directory is the run's workspace: the folder the run's agents work in, on the computer that runs them. What is there depends on how far the run got:
- \`.agentflow-ai/work/prd.md\`, \`.agentflow-ai/work/plan.md\` and \`.agentflow-ai/work/plan.json\`: the requirements and the implementation plan;
- \`.agentflow-ai/work/execution-result.json\`: what the implementation did, once it ran;
- one folder per repository on the run's branch: \`git log\` and \`git diff <base branch>...HEAD\` there show the changes.

You can read files and git history: you cannot change files, run other commands or use the web.`;

const ANSWER_CONTRACT =
  "Do what the instruction asks through the integration tools above, then answer with one or two sentences in plain text: what you did and why, or why nothing was needed. Your answer is only a note on the run page: AgentFlow carries out nothing from it, only your tool calls change anything.";

function answered(error: string): InstructionProgress {
  return {
    kind: "answered",
    result: { type: "result", ok: false, error, retryable: true },
  };
}

async function readCommandAnswer(command: {
  commandId: string;
  computeTargetId: string;
}): Promise<WorkflowInstructionResult> {
  const events =
    (await desktopCommandStore.getCommandEvents(
      command.computeTargetId,
      command.commandId
    )) ?? [];
  for (const event of [...events].reverse()) {
    if (event.eventType !== "result") {
      continue;
    }
    const parsed = workflowInstructionResultSchema.safeParse(event.data);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return {
    type: "result",
    ok: false,
    error: "The run's computer finished the instruction without an answer.",
    retryable: true,
  };
}

/**
 * The computer, workspace key and primary repository of the run's loops: the
 * computer of its latest loop (else the one its first loop would get), the
 * slug of its plan document (else its Issue), the workflow's repository
 * among the project's (else the project's primary).
 */
async function resolveRunWorkspace(
  runId: string,
  organizationId: string
): Promise<Result<RunWorkspace, string>> {
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: runId, organizationId },
      select: {
        agentConfig: true,
        runAsUserId: true,
        planDocumentId: true,
        featureDocumentId: true,
        planDocument: { select: { slug: true } },
        featureDocument: { select: { slug: true } },
        projectId: true,
        loops: {
          where: { loop: { computeTargetId: { not: null } } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { loop: { select: { computeTargetId: true } } },
        },
      },
    })
  );
  const workspaceKey = run?.planDocument?.slug ?? run?.featureDocument?.slug;
  const documentId = run?.planDocumentId ?? run?.featureDocumentId;
  if (!(run && workspaceKey && documentId && run.projectId)) {
    return Result.err(
      "The run has no workspace yet (it stopped before its documents were created), so the instruction has nothing to work in."
    );
  }
  const agent = readAgentConfig(run.agentConfig);
  const checkouts = await listProjectRepositoryCheckouts(
    organizationId,
    run.projectId
  );
  const primary =
    findRepositoryCheckout(checkouts, agent?.repository?.fullName) ??
    checkouts[0];
  if (!(agent && primary)) {
    return Result.err(
      "The project has no repositories, so the run has no workspace for the instruction."
    );
  }
  const computeTargetId = await resolveWorkspaceComputer({
    latest: run.loops[0]?.loop.computeTargetId ?? null,
    organizationId,
    userId: run.runAsUserId,
    documentId,
    preferred: agent.computeTargetId,
  });
  if (!computeTargetId.ok) {
    return computeTargetId;
  }
  return Result.ok({
    computeTargetId: computeTargetId.value,
    workspaceKey,
    repository: { fullName: primary.fullName, cloneUrl: primary.cloneUrl },
  });
}

async function resolveWorkspaceComputer(input: {
  latest: string | null;
  organizationId: string;
  userId: string | null;
  documentId: string;
  preferred: string;
}): Promise<Result<string, string>> {
  if (input.latest) {
    return Result.ok(input.latest);
  }
  if (!input.userId) {
    return Result.err("The run has no run-as user to choose its computer.");
  }
  const target = await resolveProjectComputeTarget({
    organizationId: input.organizationId,
    userId: input.userId,
    documentId: input.documentId,
    computeTargetId: input.preferred,
  });
  return target.ok ? target : Result.err(target.error.message);
}

function buildInstructionPrompt(input: {
  instruction: string;
  snapshot: WorkflowRunSnapshot;
  tools: string;
}): string {
  const { snapshot } = input;
  const prompt = [
    "# Workflow instruction",
    `You carry out one instruction of the AgentFlow workflow "${snapshot.workflow.name}" for one of its runs, with the AgentFlow integration tools.`,
    "## Instruction",
    input.instruction.trim(),
    "## When",
    `The run event \`${snapshot.event}\` just happened.`,
    "## The run",
    wrapUntrustedLoopArtifactContent(describeRun(snapshot), {
      artifactType: "Run",
      title: snapshot.source.title,
    }),
    "## The run's workspace",
    WORKSPACE_GUIDE,
    "## Integration tools",
    input.tools,
    "## Your answer",
    ANSWER_CONTRACT,
  ].join("\n\n");
  return prependUntrustedLoopInputPreamble(prompt).slice(
    0,
    WORKFLOW_INSTRUCTION_PROMPT_MAX
  );
}

function describeRun(snapshot: WorkflowRunSnapshot): string {
  const lines = [
    `- Source: ${snapshot.source.provider} ${snapshot.source.key}${snapshot.source.url ? ` (${snapshot.source.url})` : ""}`,
    `- Run: ${snapshot.url} (status ${snapshot.status})`,
    snapshot.feature
      ? `- Issue document: ${snapshot.feature.title} (${snapshot.feature.url})`
      : null,
    snapshot.plan
      ? `- Plan document: ${snapshot.plan.title} (${snapshot.plan.url})`
      : null,
    ...snapshot.pullRequests.map(
      (pr) => `- Pull request in ${pr.repository}: ${pr.url}`
    ),
    ...snapshot.repositories.map(
      (repo) =>
        `- Repository ${repo.fullName}: base ${repo.baseBranch}${repo.branch ? `, pushed to ${repo.branch}` : ""}`
    ),
    snapshot.error ? `- Error: ${snapshot.error.message}` : null,
    snapshot.step ? `- Current step: ${snapshot.step.name}` : null,
    ...(snapshot.plan?.openQuestions ?? []).map(
      (question) => `- Open question: ${question}`
    ),
  ].filter((line): line is string => line !== null);
  const replies = Object.entries(snapshot.stepReplies).map(
    ([stepId, reply]) => `### Reply of step ${stepId}\n\n${reply}`
  );
  return [
    lines.join("\n"),
    "### Summary of the event",
    snapshot.summaryMarkdown,
    ...replies,
  ]
    .join("\n\n")
    .slice(0, RUN_FACTS_MAX);
}

function toOperationResult(call: {
  tool: string;
  operationType: string | null;
  connectionKey: string | null;
  input: unknown;
  status: string;
  externalRef: string | null;
  error: string | null;
}): WorkflowInstructionOperationResult {
  return {
    type: call.operationType ?? call.tool,
    connection: call.connectionKey,
    config: toJsonObject(call.input),
    status:
      OPERATION_STATUS[call.status] ??
      WorkflowInstructionOperationStatus.Failed,
    externalRef: call.externalRef,
    error: call.error,
  };
}

/** Tool call status -> operation status on the run page. */
const OPERATION_STATUS: Record<string, WorkflowInstructionOperationStatus> = {
  [IntegrationToolCallStatus.Succeeded]:
    WorkflowInstructionOperationStatus.Succeeded,
  [IntegrationToolCallStatus.Failed]: WorkflowInstructionOperationStatus.Failed,
  [IntegrationToolCallStatus.Refused]:
    WorkflowInstructionOperationStatus.Skipped,
  [IntegrationToolCallStatus.Running]:
    WorkflowInstructionOperationStatus.NotRun,
  [IntegrationToolCallStatus.PendingApproval]:
    WorkflowInstructionOperationStatus.PendingApproval,
  [IntegrationToolCallStatus.Rejected]:
    WorkflowInstructionOperationStatus.Skipped,
};
