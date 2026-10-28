import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  claudeCodeVersionSchema,
  modelProviderEnvSchema,
} from "@repo/api/src/types/compute-target-model-provider";
import {
  ORCHESTRATOR_MCP_SERVER_NAME,
  ORCHESTRATOR_TURN_ANSWER_MAX,
  ORCHESTRATOR_TURN_CANCEL_GATEWAY_PATH,
  ORCHESTRATOR_TURN_ERROR_MAX,
  ORCHESTRATOR_TURN_GATEWAY_PATH,
  ORCHESTRATOR_TURN_STOPPED_ERROR,
  type OrchestratorTurnRequest,
  type OrchestratorTurnResult,
  orchestratorTurnCancelRequestSchema,
  orchestratorTurnRequestSchema,
} from "@repo/api/src/types/orchestrator";
import { z } from "zod";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ClaudeCodeShellEnvProvider } from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed } from "../security.js";
import { resolveLoopHarnessBinary } from "./claude-code-version-pin.js";
import {
  integrationToolEnv,
  type OpenOrchestratorSession,
  orchestratorMcpConfig,
} from "./integration-session-client.js";
import { parseBody } from "./parse-body.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

/**
 * One turn of a project orchestrator's conversation (docs/orchestrator.md):
 * Claude Code with the orchestrator's tools and nothing else (no files, no
 * shell, no web), in a folder per project so a conversation's session can be
 * resumed in its next turn. The tools reach AgentFlow through the MCP server
 * with the turn's token, which this computer exchanges for the turn and hands
 * to the agent in its environment alone. A session this computer no longer
 * has (another runner ran the last turn, a cleaned home) starts over: the
 * prompt carries the case, so nothing is lost.
 *
 * The answer is an ndjson stream: a `status` line at once, then the `result`
 * line and `done`.
 */

export const ORCHESTRATOR_DIR = path.join(".agentflow-ai", "orchestrator");

export const ORCHESTRATOR_ALLOWED_TOOLS = `mcp__${ORCHESTRATOR_MCP_SERVER_NAME}`;

/** Denied even if a settings file on the computer allows them. */
export const ORCHESTRATOR_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
].join(",");

const TURNS_DIR = "turns";
const MCP_CONFIG_FILE = "mcp-config.json";
const OUTPUT_FILE = "claude-output.jsonl";
const RESULT_FILE = "result.json";
const KILL_GRACE_MS = 5000;
const STDERR_TAIL_MAX = 1000;
const MISSING_SESSION_RE = /no conversation found/i;

export type OrchestratorTurnDeps = {
  processManager: ProcessManager;
  getAllowedDirectories: () => string[];
  getClaudeShellEnv: ClaudeCodeShellEnvProvider;
  /** Absent when this computer has no AgentFlow API key. */
  openOrchestratorSession?: OpenOrchestratorSession;
};

export function registerOrchestratorTurnRoutes(
  dispatcher: OperationDispatcher,
  deps: OrchestratorTurnDeps
): void {
  dispatcher.register(
    "POST",
    ORCHESTRATOR_TURN_GATEWAY_PATH,
    async (context) => {
      context.response.statusCode = 200;
      context.response.setHeader("Content-Type", "application/x-ndjson");
      context.response.setHeader("Cache-Control", "no-cache");
      context.response.flushHeaders();
      writeLine(context.response, { type: "status", status: "running" });
      const parsed = parseTurnBody(parseBody(context));
      const result = parsed.ok
        ? await runTurn(parsed.request, deps, (stop) =>
            context.request.once("close", stop)
          )
        : failure(parsed.error, false, null);
      writeLine(context.response, result);
      writeLine(context.response, { type: "done" });
      context.response.end();
    }
  );
  dispatcher.register(
    "POST",
    ORCHESTRATOR_TURN_CANCEL_GATEWAY_PATH,
    (context) => {
      const parsed = orchestratorTurnCancelRequestSchema.safeParse(
        parseBody(context) ?? undefined
      );
      const stopped = parsed.success && stopRunningTurn(parsed.data.turnId);
      context.response.statusCode = parsed.success ? 200 : 400;
      context.response.setHeader("Content-Type", "application/json");
      context.response.end(JSON.stringify({ stopped }));
      return Promise.resolve();
    }
  );
}

/**
 * The turns running on this computer, by turn id: a newer message on the
 * same conversation stops its turn (concurrency `supersede`).
 */
const runningTurns = new Map<string, () => void>();
const stoppedTurns = new Set<string>();

/** Stops a running turn; false when it is not running here. */
export function stopRunningTurn(turnId: string): boolean {
  const stop = runningTurns.get(turnId);
  if (!stop) {
    return false;
  }
  stoppedTurns.add(turnId);
  stop();
  return true;
}

/** The project's orchestrator folder: where its sessions resume. */
export function resolveOrchestratorFolder(
  projectId: string,
  allowedDirs: readonly string[]
): string {
  const parent = allowedDirs[0];
  if (!parent) {
    throw new Error("no allowed directories configured");
  }
  const folder = path.join(expandHome(parent), ORCHESTRATOR_DIR, projectId);
  assertPathAllowed(folder, [...allowedDirs]);
  return folder;
}

/** The Claude Code arguments of a turn (exported for tests). */
export function orchestratorTurnArgs(
  mcpConfigFile: string,
  sessionId: string | null
): string[] {
  return [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    // Ask-mode: in -p nothing can approve a tool outside the allow list.
    "--permission-mode",
    "default",
    `--allowedTools=${ORCHESTRATOR_ALLOWED_TOOLS}`,
    `--disallowedTools=${ORCHESTRATOR_DISALLOWED_TOOLS}`,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
}

/** The turn's result from its stream-json lines and how the process ended. */
export function readTurnResult(
  stream: { resultLine: ClaudeResultLine | null; sessionId: string | null },
  exit: {
    code: number | null;
    stderr: string;
    timedOut: boolean;
    timeoutMs: number;
  }
): OrchestratorTurnResult {
  const { resultLine, sessionId } = stream;
  if (exit.timedOut) {
    return failure(
      `The orchestrator's turn did not finish within ${Math.round(exit.timeoutMs / 60_000)} minutes.`,
      true,
      sessionId
    );
  }
  if (!resultLine) {
    const detail = exit.stderr.trim().slice(-STDERR_TAIL_MAX);
    return failure(
      `The orchestrator's turn ended without an answer (exit code ${exit.code ?? "none"})${detail ? `: ${detail}` : ""}`,
      true,
      sessionId
    );
  }
  if (resultLine.is_error) {
    return failure(
      `The orchestrator's turn failed: ${resultLine.result ?? resultLine.subtype ?? "unknown error"}`,
      true,
      resultLine.session_id ?? sessionId
    );
  }
  const usage = resultLine.usage ?? {};
  return {
    type: "result",
    ok: true,
    answer: (resultLine.result ?? "").slice(0, ORCHESTRATOR_TURN_ANSWER_MAX),
    sessionId: resultLine.session_id ?? sessionId,
    costUsd: resultLine.total_cost_usd ?? null,
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

type ParsedRequest = OrchestratorTurnRequest & {
  claudeEnv: Record<string, string>;
  claudeCodeVersion?: string;
};

/** The request plus the computer's Claude settings the API adds to every body. */
const turnBodySchema = orchestratorTurnRequestSchema.extend({
  claudeEnv: modelProviderEnvSchema.optional(),
  claudeCodeVersion: claudeCodeVersionSchema.optional(),
});

const claudeResultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().max(100).optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
      cache_read_input_tokens: z.number().nonnegative().optional(),
      cache_creation_input_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type ClaudeResultLine = z.infer<typeof claudeResultLineSchema>;

const sessionLineSchema = z.object({ session_id: z.string().min(1).max(100) });

function parseTurnBody(
  body: Record<string, unknown> | null
): { ok: true; request: ParsedRequest } | { ok: false; error: string } {
  const parsed = turnBodySchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid orchestrator turn: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    };
  }
  return {
    ok: true,
    request: { ...parsed.data, claudeEnv: parsed.data.claudeEnv ?? {} },
  };
}

async function runTurn(
  request: ParsedRequest,
  deps: OrchestratorTurnDeps,
  onCancel: (stop: () => void) => void
): Promise<OrchestratorTurnResult> {
  let folder: string;
  try {
    folder = resolveOrchestratorFolder(
      request.projectId,
      deps.getAllowedDirectories()
    );
  } catch (error) {
    return failure(
      `No folder for the orchestrator: ${errorText(error)}`,
      false,
      null
    );
  }
  const turnFolder = path.join(folder, TURNS_DIR, request.turnId);
  await mkdir(turnFolder, { recursive: true });
  const binary = await resolveLoopHarnessBinary({
    adapter: { harness: LoopHarness.Claude, binaryName: "claude" },
    claudeCodeVersion: request.claudeCodeVersion,
    override: getOverrideBinaryPaths()?.claude,
  });
  if (binary.error) {
    return failure(binary.error, true, null);
  }
  if (!deps.openOrchestratorSession) {
    return failure(
      "This computer has no AgentFlow API key, so the orchestrator cannot get its tools.",
      false,
      null
    );
  }
  let grant: Awaited<ReturnType<OpenOrchestratorSession>>;
  try {
    grant = await deps.openOrchestratorSession(request.turnId);
  } catch (error) {
    return failure(
      `The orchestrator's tools could not be opened: ${errorText(error)}`,
      true,
      null
    );
  }
  const mcpConfigFile = path.join(turnFolder, MCP_CONFIG_FILE);
  await writeFile(
    mcpConfigFile,
    `${JSON.stringify(orchestratorMcpConfig(grant.mcpUrl), null, 2)}\n`,
    "utf8"
  );
  const shellEnv = await deps.getClaudeShellEnv(request.claudeEnv);
  // The token lives only in the agent's environment, never in a file.
  const env = { ...shellEnv, ...integrationToolEnv(grant, null) };
  const spawn = (sessionId: string | null) =>
    spawnAgent({
      deps,
      command: binary.resolved.path,
      cwd: folder,
      args: orchestratorTurnArgs(mcpConfigFile, sessionId),
      outputFile: path.join(turnFolder, OUTPUT_FILE),
      prompt: request.prompt,
      env,
      timeoutMs: request.timeoutMs,
      onCancel: (stop) => {
        onCancel(stop);
        runningTurns.set(request.turnId, stop);
      },
    });
  let outcome = await spawn(request.sessionId);
  if (
    request.sessionId &&
    outcome.missingSession &&
    !stoppedTurns.has(request.turnId)
  ) {
    outcome = await spawn(null);
  }
  runningTurns.delete(request.turnId);
  if (stoppedTurns.delete(request.turnId)) {
    outcome = {
      ...outcome,
      result: failure(
        ORCHESTRATOR_TURN_STOPPED_ERROR,
        false,
        outcome.result.sessionId
      ),
    };
  }
  await writeFile(
    path.join(turnFolder, RESULT_FILE),
    `${JSON.stringify(outcome.result, null, 2)}\n`,
    "utf8"
  );
  return outcome.result;
}

/** Runs the agent and waits for its result. */
function spawnAgent(input: {
  deps: OrchestratorTurnDeps;
  command: string;
  cwd: string;
  args: string[];
  outputFile: string;
  prompt: string;
  env: Record<string, string>;
  timeoutMs: number;
  onCancel: (stop: () => void) => void;
}): Promise<{ result: OrchestratorTurnResult; missingSession: boolean }> {
  const { deps } = input;
  return new Promise((resolve) => {
    let resultLine: ClaudeResultLine | null = null;
    let sessionId: string | null = null;
    let stderr = "";
    let timedOut = false;
    let pid = 0;
    let writes = Promise.resolve();
    const stop = () => {
      deps.processManager
        .killProcessGroup(pid, KILL_GRACE_MS)
        .catch(() => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    deps.processManager
      .spawnStreaming({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        input: input.prompt,
        onLine: (line) => {
          writes = writes.then(() =>
            appendFile(input.outputFile, `${line}\n`, "utf8")
          );
          const parsed = parseLine(line);
          resultLine = parsed.result ?? resultLine;
          sessionId = parsed.sessionId ?? sessionId;
        },
        onError: (error) => {
          stderr = `${stderr}${error.message}`.slice(-STDERR_TAIL_MAX * 4);
        },
        onExit: (code) => {
          clearTimeout(timer);
          const settle = () =>
            resolve({
              result: readTurnResult(
                { resultLine, sessionId },
                { code, stderr, timedOut, timeoutMs: input.timeoutMs }
              ),
              missingSession: !resultLine && MISSING_SESSION_RE.test(stderr),
            });
          writes.then(settle, settle);
        },
      })
      .then((handle) => {
        pid = handle.pid;
        input.onCancel(stop);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        resolve({
          result: failure(
            `The orchestrator's turn could not start: ${errorText(error)}`,
            true,
            null
          ),
          missingSession: false,
        });
      });
  });
}

function parseLine(line: string): {
  result: ClaudeResultLine | null;
  sessionId: string | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { result: null, sessionId: null };
  }
  const result = claudeResultLineSchema.safeParse(value);
  const session = sessionLineSchema.safeParse(value);
  return {
    result: result.success ? result.data : null,
    sessionId: session.success ? session.data.session_id : null,
  };
}

function failure(
  error: string,
  retryable: boolean,
  sessionId: string | null
): OrchestratorTurnResult {
  return {
    type: "result",
    ok: false,
    error: error.slice(0, ORCHESTRATOR_TURN_ERROR_MAX),
    retryable,
    sessionId,
  };
}

function writeLine(response: ServerResponse, payload: object): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
