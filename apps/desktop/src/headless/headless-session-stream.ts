/**
 * @file headless-session-stream.ts
 * @description Folds a loop's Claude Code stream (`claude-output.jsonl`, the
 * `--output-format stream-json` output the loop harness writes) into the
 * agent-session shape AgentFlow's Sessions and Agents pages read. Pure: the
 * reporter (headless-session-reporter.ts) feeds it new lines as the loop
 * runs and builds the sync payload from it.
 *
 * The desktop app reaches the same pages through its local session database;
 * a headless runner has none, so it reports each loop it runs from that
 * loop's own stream.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  SyncedAgentSession,
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DIFF_STATS_TOOL_NAMES } from "@repo/lib/harness/claude/diff-stats-tool-handlers";
import {
  accumulateSidecarDiffStatsEntry,
  createSidecarDiffStatsPass,
  type SidecarDiffStatsPass,
} from "../main/collectors/claude/sidecar-diff-stats.js";
import { UNKNOWN_COST_BASIS } from "../main/cost/token-usage.js";

/** Most recent tool events kept per session (the cloud stores metadata only). */
export const SESSION_EVENTS_MAX = 300;
/** Subagents kept per session. */
export const SESSION_SUBAGENTS_MAX = 200;
export const RUNNER_HARNESS = "claude";
const MAIN_AGENT_NAME = "claude";
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const SKILL_TOOL = "Skill";
const SLASH_COMMAND_TOOL = "SlashCommand";
const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const COMPONENT_KEY_SEPARATOR = "\u0000";
/** The loop commits its work on the branch (the finalizer pushes it). */
const WORK_BRANCH_METHOD = "git_commit";
const COMMAND_NAME_RE = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/g;
/**
 * Directories beside the code that a loop never commits (the finalizer resets
 * them, execute-push-finalization.ts): AgentFlow's work files (plan, log,
 * release notes) and Claude's own. Editing them is not a code change.
 */
const UNCOMMITTED_DIRS: ReadonlySet<string> = new Set([
  ".agentflow-ai",
  ".claude",
]);
/**
 * `task_type` of a background task that is not a subagent: a shell command run
 * in the background reports `task_started` too (its description is the command).
 */
const BACKGROUND_SHELL_TASK_TYPE = "local_bash";

export const StreamAgentStatus = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
} as const;
export type StreamAgentStatus =
  (typeof StreamAgentStatus)[keyof typeof StreamAgentStatus];

type TokenTotals = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type SubagentRecord = {
  taskId: string;
  name: string;
  subagentType: string | null;
  status: StreamAgentStatus;
  startedAt: string | null;
  endedAt: string | null;
};

type ComponentRecord = {
  kind: string;
  key: string;
  invocations: number;
  errorCount: number;
  firstInvokedAt: string;
  lastInvokedAt: string;
};

export type LoopSessionStream = {
  /**
   * The Claude session the stream starts with (null until its `init`). A
   * loop retries an iteration in a fresh Claude session, so later `init`
   * events carry new ids; all of them fold into the loop's one session.
   */
  sessionId: string | null;
  /** Every Claude session id the stream started, in order. */
  harnessSessionIds: string[];
  cwd: string | null;
  model: string | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  lastTool: string | null;
  toolInvocations: number;
  toolErrors: number;
  /** Token usage per assistant message id (a message repeats on every block). */
  usageByMessage: Map<string, TokenTotals>;
  events: SyncedAgentSessionEvent[];
  subagents: Map<string, SubagentRecord>;
  components: Map<string, ComponentRecord>;
  /** tool_use id -> component map key, to count failed invocations. */
  componentByToolUse: Map<string, string>;
  /**
   * The latest `result` of each Claude session per model (subagents
   * included), keyed by Claude session id. A session writes a `result` each
   * time its main agent stops (while background subagents still run, and
   * again once they report back), every one CUMULATIVE for the session, so
   * the latest replaces the earlier ones. Assistant events carry the input
   * side only, so sessions with a result count these instead.
   */
  resultUsage: Map<string, Map<string, ResultModelUsage>>;
  /** Assistant message ids since the last `result`: the session in flight. */
  openMessageIds: Set<string>;
  resultIsError: boolean | null;
  /**
   * The lines the agents (the main one and its subagents) changed with Edit,
   * Write and MultiEdit, by the desktop's transcript formula. Edits of
   * UNCOMMITTED_DIRS are left out.
   */
  diffStats: SidecarDiffStatsPass;
};

export function createLoopSessionStream(): LoopSessionStream {
  return {
    sessionId: null,
    harnessSessionIds: [],
    cwd: null,
    model: null,
    firstEventAt: null,
    lastEventAt: null,
    lastTool: null,
    toolInvocations: 0,
    toolErrors: 0,
    usageByMessage: new Map(),
    events: [],
    subagents: new Map(),
    components: new Map(),
    componentByToolUse: new Map(),
    resultUsage: new Map(),
    openMessageIds: new Set(),
    resultIsError: null,
    diffStats: createSidecarDiffStatsPass(new Set()),
  };
}

type StreamLine = {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  model?: unknown;
  timestamp?: unknown;
  parent_tool_use_id?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
  task_id?: unknown;
  task_type?: unknown;
  description?: unknown;
  subagent_type?: unknown;
  status?: unknown;
  is_error?: unknown;
  modelUsage?: Record<string, Record<string, unknown>>;
};

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: Record<string, unknown>;
  tool_use_id?: unknown;
  is_error?: unknown;
};

/** Folds one stream line; malformed lines are ignored. */
export function foldStreamLine(
  stream: LoopSessionStream,
  rawLine: string,
  fallbackAt: string
): void {
  const line = parseLine(rawLine);
  if (!line) {
    return;
  }
  const at = asString(line.timestamp) ?? stream.lastEventAt ?? fallbackAt;
  if (asString(line.timestamp)) {
    stream.firstEventAt ??= at;
    stream.lastEventAt = at;
  }
  if (line.type === "system") {
    foldSystemLine(stream, line, at);
    return;
  }
  if (line.type === "assistant") {
    foldAssistantLine(stream, line, at);
    foldDiffStats(stream, line);
    return;
  }
  if (line.type === "user") {
    foldToolResults(stream, line);
    foldPromptCommands(stream, line, at);
    foldDiffStats(stream, line);
    return;
  }
  if (line.type === "result") {
    foldResultLine(stream, line);
  }
}

/**
 * The Claude session's totals so far, replacing its earlier `result` (see
 * `resultUsage`); a `result` without `session_id` belongs to the latest
 * `init`. The CLI prices models it does not know at a guessed rate
 * (`costBasis: "unknown"`, e.g. an Anthropic-compatible provider such as
 * DeepSeek); such a cost is left out rather than reported as real.
 */
function foldResultLine(stream: LoopSessionStream, line: StreamLine): void {
  stream.resultIsError = line.is_error === true;
  const entries = Object.entries(line.modelUsage ?? {});
  if (entries.length === 0) {
    return;
  }
  stream.openMessageIds.clear();
  const models = new Map<string, ResultModelUsage>();
  for (const [model, usage] of entries) {
    models.set(model, {
      model,
      inputTokens: maxOf(0, usage.inputTokens),
      outputTokens: maxOf(0, usage.outputTokens),
      cacheReadTokens: maxOf(0, usage.cacheReadInputTokens),
      cacheWriteTokens: maxOf(0, usage.cacheCreationInputTokens),
      costUsd:
        usage.costBasis === UNKNOWN_COST_BASIS ? null : asNumber(usage.costUSD),
    });
  }
  const harnessSessionId =
    asString(line.session_id) ??
    stream.harnessSessionIds.at(-1) ??
    `result-${stream.resultUsage.size}`;
  stream.resultUsage.set(harnessSessionId, models);
}

/** Status of the loop as an agent session. */
export function sessionStatusFor(input: {
  running: boolean;
  failed: boolean;
}): string {
  if (input.running) {
    return SESSION_STATUS.ACTIVE;
  }
  return input.failed ? SESSION_STATUS.ERROR : SESSION_STATUS.INACTIVE;
}

export type LoopSessionContext = {
  loopId: string;
  name: string;
  running: boolean;
  failed: boolean;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  repositoryFullName: string | null;
  worktreePath: string | null;
  sourceArtifactId: string | null;
  baseBranch: string | null;
  /** The branch the loop works on, read from its worktree. */
  workBranch: string | null;
  /**
   * The work branch's diff against its base, for a loop that committed to it
   * (headless-branch-diff.ts); null or omitted otherwise.
   */
  branchDiffStats?: SyncedAgentSession["branchDiffStats"];
  runnerName: string;
  command: string;
};

/** The agent session of one loop, as POST /desktop/agent-sessions/sync takes it. */
export function buildSyncedSession(
  stream: LoopSessionStream,
  context: LoopSessionContext
): SyncedAgentSession {
  // Keyed by the loop, not a Claude session id: a loop can retry in fresh
  // Claude sessions, and a STEP loop can resume the session of the loop
  // before it, so Claude ids are neither stable nor unique per loop.
  const sessionId = context.loopId;
  const status = sessionStatusFor(context);
  const updatedAt = latest(context.updatedAt, stream.lastEventAt);
  const usage = tokenUsageByModel(stream);
  const totals = sumUsage(usage);
  const costUsd = sessionCostUsd(stream);
  const runtimeMs = runtimeOf(context.startedAt, context.endedAt ?? updatedAt);
  return {
    externalSessionId: sessionId,
    name: context.name,
    status,
    billingMode: "api",
    harness: RUNNER_HARNESS,
    cwd: stream.cwd ?? context.worktreePath,
    model: stream.model,
    startedAt: context.startedAt,
    updatedAt,
    lastActivityAt: stream.lastEventAt ?? updatedAt,
    endedAt: context.running ? null : (context.endedAt ?? updatedAt),
    endsWithError: context.running ? null : context.failed,
    metadata: {
      source: "agentflow-runner",
      runner: context.runnerName,
      loopId: context.loopId,
      command: context.command,
      harnessSessionIds: [...stream.harnessSessionIds],
    },
    attribution: {
      repositoryFullName: context.repositoryFullName,
      worktreePath: context.worktreePath,
      sourceArtifactId: context.sourceArtifactId,
      sourceLoopId: context.loopId,
      baseBranch: context.baseBranch,
    },
    turns: stream.usageByMessage.size,
    ...transcriptDiffStats(stream),
    ...(context.branchDiffStats
      ? { branchDiffStats: context.branchDiffStats }
      : {}),
    branch: context.workBranch ?? context.baseBranch,
    // A loop runs unattended: no human turn steers it.
    steeringEpisodes: 0,
    autonomy: 100,
    ...branchRefs(context),
    agents: buildAgents(stream, sessionId, status, context, updatedAt),
    events: [...stream.events],
    tokenUsageByModel: usage,
    sessionAnalytics: {
      isHuman: false,
      humanTurns: 0,
      agentTurns: stream.usageByMessage.size,
      eventCount: stream.toolInvocations,
      toolInvocations: stream.toolInvocations,
      errorEvents: stream.toolErrors,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      ...(costUsd === null ? {} : { estimatedCostUsd: costUsd }),
      runtimeMs,
    },
    components: componentUsage(stream),
  };
}

function foldSystemLine(
  stream: LoopSessionStream,
  line: StreamLine,
  at: string
): void {
  if (line.subtype === "init") {
    const harnessSessionId = asString(line.session_id);
    if (
      harnessSessionId &&
      !stream.harnessSessionIds.includes(harnessSessionId)
    ) {
      stream.harnessSessionIds.push(harnessSessionId);
    }
    stream.sessionId ??= harnessSessionId;
    stream.cwd = asString(line.cwd) ?? stream.cwd;
    stream.model = asString(line.model) ?? stream.model;
    return;
  }
  const taskId = asString(line.task_id);
  if (!taskId || line.task_type === BACKGROUND_SHELL_TASK_TYPE) {
    return;
  }
  if (line.subtype === "task_started") {
    if (
      !stream.subagents.has(taskId) &&
      stream.subagents.size >= SESSION_SUBAGENTS_MAX
    ) {
      return;
    }
    stream.subagents.set(taskId, {
      taskId,
      name: asString(line.description) ?? "subagent",
      subagentType: asString(line.subagent_type),
      status: StreamAgentStatus.Running,
      startedAt: at,
      endedAt: null,
    });
    return;
  }
  if (line.subtype === "task_notification") {
    const subagent = stream.subagents.get(taskId);
    if (subagent) {
      subagent.status =
        line.status === "completed"
          ? StreamAgentStatus.Completed
          : StreamAgentStatus.Failed;
      subagent.endedAt = at;
    }
  }
}

function foldAssistantLine(
  stream: LoopSessionStream,
  line: StreamLine,
  at: string
): void {
  const message = line.message;
  if (!message) {
    return;
  }
  const model = asString(message.model) ?? stream.model ?? "unknown";
  stream.model ??= model;
  const messageId = asString(message.id);
  if (messageId && message.usage) {
    const usage = message.usage;
    const previous = stream.usageByMessage.get(messageId);
    stream.openMessageIds.add(messageId);
    stream.usageByMessage.set(messageId, {
      model,
      inputTokens: maxOf(previous?.inputTokens, usage.input_tokens),
      outputTokens: maxOf(previous?.outputTokens, usage.output_tokens),
      cacheReadTokens: maxOf(
        previous?.cacheReadTokens,
        usage.cache_read_input_tokens
      ),
      cacheWriteTokens: maxOf(
        previous?.cacheWriteTokens,
        usage.cache_creation_input_tokens
      ),
    });
  }
  const agentId = asString(line.parent_tool_use_id);
  for (const block of contentBlocks(message.content)) {
    if (block.type === "tool_use") {
      foldToolUse(stream, block, agentId, at);
    }
  }
}

function foldToolUse(
  stream: LoopSessionStream,
  block: ContentBlock,
  agentId: string | null,
  at: string
): void {
  const toolName = asString(block.name) ?? "unknown";
  const toolUseId = asString(block.id);
  stream.toolInvocations += 1;
  stream.lastTool = toolName;
  stream.events.push({
    externalEventId: toolUseId ?? `tool-${stream.toolInvocations}`,
    providerToolUseId: toolUseId,
    agentExternalId: agentId,
    eventType: "tool_use",
    toolName,
    createdAt: at,
  });
  if (stream.events.length > SESSION_EVENTS_MAX) {
    stream.events.splice(0, stream.events.length - SESSION_EVENTS_MAX);
  }
  const component = componentOf(toolName, block.input ?? {});
  if (!component) {
    return;
  }
  const mapKey = countComponent(stream, component, at);
  if (toolUseId) {
    stream.componentByToolUse.set(toolUseId, mapKey);
  }
}

/** Counts one invocation of a component; returns its map key. */
function countComponent(
  stream: LoopSessionStream,
  component: { kind: string; key: string },
  at: string
): string {
  const mapKey = `${component.kind}${COMPONENT_KEY_SEPARATOR}${component.key}`;
  const record = stream.components.get(mapKey);
  if (record) {
    record.invocations += 1;
    record.lastInvokedAt = at;
  } else {
    stream.components.set(mapKey, {
      ...component,
      invocations: 1,
      errorCount: 0,
      firstInvokedAt: at,
      lastInvokedAt: at,
    });
  }
  return mapKey;
}

function foldToolResults(stream: LoopSessionStream, line: StreamLine): void {
  for (const block of contentBlocks(line.message?.content)) {
    if (block.type !== "tool_result" || block.is_error !== true) {
      continue;
    }
    stream.toolErrors += 1;
    const mapKey = stream.componentByToolUse.get(
      asString(block.tool_use_id) ?? ""
    );
    const record = mapKey ? stream.components.get(mapKey) : undefined;
    if (record) {
      record.errorCount += 1;
    }
  }
}

/**
 * A slash command in the prompt (a process step such as `/speckit.specify`)
 * reaches the stream as a `<command-name>` tag in the user's own message, not
 * as a tool call. Tool results are not read: a file that mentions the tag is
 * not an invocation.
 */
function foldPromptCommands(
  stream: LoopSessionStream,
  line: StreamLine,
  at: string
): void {
  const content = line.message?.content;
  const texts =
    typeof content === "string"
      ? [content]
      : contentBlocks(content)
          .filter((block) => block.type === "text")
          .map((block) => asString((block as { text?: unknown }).text) ?? "");
  for (const text of texts) {
    for (const match of text.matchAll(COMMAND_NAME_RE)) {
      if (match[1]) {
        countComponent(
          stream,
          { kind: AgentComponentKind.Command, key: match[1] },
          at
        );
      }
    }
  }
}

/** The agent component a tool call invokes: a subagent, a skill or a command. */
function componentOf(
  toolName: string,
  input: Record<string, unknown>
): { kind: string; key: string } | null {
  if (SUBAGENT_TOOLS.has(toolName)) {
    return {
      kind: AgentComponentKind.Subagent,
      key: asString(input.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
    };
  }
  if (toolName === SKILL_TOOL) {
    const skill = asString(input.skill) ?? asString(input.command);
    return skill ? { kind: AgentComponentKind.Skill, key: skill } : null;
  }
  if (toolName === SLASH_COMMAND_TOOL) {
    const command = asString(input.command)?.split(" ")[0];
    return command
      ? { kind: AgentComponentKind.Command, key: withLeadingSlash(command) }
      : null;
  }
  return null;
}

function buildAgents(
  stream: LoopSessionStream,
  sessionId: string,
  status: string,
  context: LoopSessionContext,
  updatedAt: string
): SyncedAgentSessionAgent[] {
  const main: SyncedAgentSessionAgent = {
    externalAgentId: sessionId,
    name: MAIN_AGENT_NAME,
    type: "main",
    subagentType: null,
    status: context.running
      ? StreamAgentStatus.Running
      : finishedAgentStatus(context.failed),
    task: context.name,
    currentTool: context.running ? stream.lastTool : null,
    startedAt: context.startedAt,
    updatedAt,
    endedAt: context.running ? null : (context.endedAt ?? updatedAt),
    parentExternalAgentId: null,
    metadata: { sessionStatus: status },
  };
  const subagents = [...stream.subagents.values()].map(
    (subagent): SyncedAgentSessionAgent => ({
      externalAgentId: subagent.taskId,
      name: subagent.name,
      type: "subagent",
      subagentType: subagent.subagentType,
      // A subagent still running when its loop ended went with it.
      status:
        subagent.status === StreamAgentStatus.Running && !context.running
          ? finishedAgentStatus(context.failed)
          : subagent.status,
      task: subagent.name,
      currentTool: null,
      startedAt: subagent.startedAt,
      updatedAt: subagent.endedAt ?? updatedAt,
      endedAt: subagent.endedAt,
      parentExternalAgentId: sessionId,
    })
  );
  return [main, ...subagents];
}

function finishedAgentStatus(failed: boolean): StreamAgentStatus {
  return failed ? StreamAgentStatus.Failed : StreamAgentStatus.Completed;
}

/**
 * Tokens per model: the latest `result` of every Claude session (see
 * `resultUsage`), plus the assistant events of the session still in flight.
 * A model's cost sums its results; it is left out when one of them did not
 * know the price, and the session in flight adds tokens only (its cost
 * arrives with its `result`).
 */
function tokenUsageByModel(
  stream: LoopSessionStream
): SyncedAgentSessionTokenUsage[] {
  const byModel = new Map<string, TokenTotals>();
  const costByModel = new Map<string, number | null>();
  for (const models of stream.resultUsage.values()) {
    for (const usage of models.values()) {
      addTokens(byModel, usage);
      const cost = costByModel.has(usage.model)
        ? (costByModel.get(usage.model) ?? null)
        : 0;
      costByModel.set(usage.model, addKnownCost(cost, usage.costUsd));
    }
  }
  // The Claude session in flight has no result yet: its assistant events
  // stand in (every message, when no session has ended).
  const open =
    stream.resultUsage.size > 0
      ? [...stream.openMessageIds].map((id) => stream.usageByMessage.get(id))
      : [...stream.usageByMessage.values()];
  for (const usage of open) {
    if (usage) {
      addTokens(byModel, usage);
    }
  }
  return [...byModel.values()].map((usage) => {
    const cost = costByModel.get(usage.model);
    return cost === undefined || cost === null
      ? usage
      : { ...usage, estimatedCostUsd: cost };
  });
}

function sumUsage(usage: SyncedAgentSessionTokenUsage[]): TokenTotals {
  return usage.reduce(
    (sum, entry) => ({
      model: sum.model,
      inputTokens: sum.inputTokens + entry.inputTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + entry.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + entry.cacheWriteTokens,
    }),
    {
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  );
}

function componentUsage(stream: LoopSessionStream): SyncedComponentUsage[] {
  return [...stream.components.values()].map((record) => ({
    componentKind: record.kind,
    componentKey: record.key,
    harness: RUNNER_HARNESS,
    invocations: record.invocations,
    errorCount: record.errorCount,
    firstInvokedAt: record.firstInvokedAt,
    lastInvokedAt: record.lastInvokedAt,
  }));
}

function parseLine(rawLine: string): StreamLine | null {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as StreamLine)
      : null;
  } catch {
    return null;
  }
}

function contentBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content)
    ? content.filter(
        (block): block is ContentBlock =>
          block !== null && typeof block === "object"
      )
    : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function maxOf(previous: number | undefined, value: unknown): number {
  const next =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  return Math.max(previous ?? 0, next);
}

function latest(left: string, right: string | null): string {
  if (!right) {
    return left;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function runtimeOf(startedAt: string, endedAt: string): number | null {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function withLeadingSlash(command: string): string {
  return command.startsWith("/") ? command : `/${command}`;
}

function emptyTotals(model: string): TokenTotals {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * The loop's work branch as a session→branch link. The cloud keeps it only
 * for a repository it has authority over (a GitHub App installation); for
 * others it is recorded as unresolved and `branch` carries the name.
 */
function branchRefs(
  context: LoopSessionContext
): Pick<SyncedAgentSession, "artifactRefs"> | Record<string, never> {
  if (
    !(context.workBranch && context.repositoryFullName) ||
    context.workBranch === context.baseBranch
  ) {
    return {};
  }
  return {
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: context.repositoryFullName,
        branchName: context.workBranch,
        method: WORK_BRANCH_METHOD,
        relation: ArtifactRefRelation.Created,
        branchParticipation: BranchParticipationKind.Wrote,
        observedAt: context.startedAt,
      },
    ],
  };
}

/** The session's cost: its results summed; null if none, or one was unpriced. */
function sessionCostUsd(stream: LoopSessionStream): number | null {
  let total: number | null = null;
  for (const models of stream.resultUsage.values()) {
    for (const usage of models.values()) {
      if (usage.costUsd === null) {
        return null;
      }
      total = (total ?? 0) + usage.costUsd;
    }
  }
  return total;
}

function addTokens(
  byModel: Map<string, TokenTotals>,
  usage: TokenTotals
): void {
  const total = byModel.get(usage.model) ?? emptyTotals(usage.model);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  byModel.set(usage.model, total);
}

function addKnownCost(
  total: number | null,
  cost: number | null
): number | null {
  return total === null || cost === null ? null : total + cost;
}

/** One model of a `result`; its cost is null when the CLI did not know it. */
type ResultModelUsage = TokenTotals & { costUsd: number | null };

/**
 * Folds the edits of one line (tool uses, and Read results for a later Write
 * to diff against) into the session's diff stats.
 */
function foldDiffStats(stream: LoopSessionStream, line: StreamLine): void {
  const blocks = contentBlocks(line.message?.content);
  if (blocks.length === 0) {
    return;
  }
  accumulateSidecarDiffStatsEntry(stream.diffStats, {
    message: { content: blocks.filter((block) => !isUncommittedEdit(block)) },
  });
}

function isUncommittedEdit(block: ContentBlock): boolean {
  if (
    block.type !== "tool_use" ||
    !DIFF_STATS_TOOL_NAMES.has(asString(block.name) ?? "")
  ) {
    return false;
  }
  const segments = asString(block.input?.file_path)?.split("/") ?? [];
  return segments.some((segment) => UNCOMMITTED_DIRS.has(segment));
}

/**
 * The session's own edits. None when it edited no file: like the desktop, a
 * session without edits leaves the lines unknown rather than zero.
 */
function transcriptDiffStats(
  stream: LoopSessionStream
): Pick<SyncedAgentSession, "linesAdded" | "linesRemoved" | "filesChanged"> {
  const { acc } = stream.diffStats;
  if (acc.diffFiles.size === 0) {
    return {};
  }
  return {
    linesAdded: Math.min(acc.totalAdded, PR_INT_MAX),
    linesRemoved: Math.min(acc.totalRemoved, PR_INT_MAX),
    filesChanged: Math.min(acc.diffFiles.size, PR_INT_MAX),
  };
}
