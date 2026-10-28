import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  claudeCodeVersionSchema,
  modelProviderEnvSchema,
} from "@repo/api/src/types/compute-target-model-provider";
import {
  WORKFLOW_DECISION_ANSWER_MAX,
  WORKFLOW_DECISION_ERROR_MAX,
  WORKFLOW_DECISION_GATEWAY_PATH,
  WORKFLOW_DECISION_TIMEOUT_MS,
  type WorkflowDecisionRequest,
  type WorkflowDecisionResult,
  workflowDecisionRequestSchema,
} from "@repo/api/src/types/workflow-decision";
import { z } from "zod";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ClaudeCodeShellEnvProvider } from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed } from "../security.js";
import { resolveLoopHarnessBinary } from "./claude-code-version-pin.js";
import { parseBody } from "./parse-body.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

/**
 * Decisions of a workflow (docs/workflows.md "PRD or Issue"): the API asks
 * this computer to answer one question with Claude Code, today whether a
 * run's source item is a PRD. The model gets the prompt and nothing else:
 * its tools are denied, no MCP server is loaded (an empty
 * `--strict-mcp-config`, so not even this computer's own configuration), no
 * plugin, and its working directory is the decision's own folder
 * (`<allowed dir>/.agentflow-ai/decisions/<id>`), which also keeps the prompt
 * and the transcript.
 *
 * The answer is an ndjson stream, like an instruction's: a `status` line at
 * once, then the `result` line and `done`.
 */

export const DECISIONS_DIR = path.join(".agentflow-ai", "decisions");

/**
 * Denied even if a settings file on the computer allows them: deny rules win
 * over every allow rule and permission mode.
 */
export const DECISION_DISALLOWED_TOOLS = [
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

/** A decision is one answer; a model that keeps trying tools stops here. */
export const DECISION_MAX_TURNS = 3;
export const DECISION_MCP_CONFIG_FILE = "mcp-config.json";

const PROMPT_FILE = "prompt.md";
const OUTPUT_FILE = "claude-output.jsonl";
const RESULT_FILE = "result.json";
const KILL_GRACE_MS = 5000;
const STDERR_TAIL_MAX = 1000;

export type WorkflowDecisionDeps = {
  processManager: ProcessManager;
  getAllowedDirectories: () => string[];
  getClaudeShellEnv: ClaudeCodeShellEnvProvider;
  timeoutMs?: number;
};

export function registerWorkflowDecisionRoutes(
  dispatcher: OperationDispatcher,
  deps: WorkflowDecisionDeps
): void {
  dispatcher.register(
    "POST",
    WORKFLOW_DECISION_GATEWAY_PATH,
    async (context) => {
      context.response.statusCode = 200;
      context.response.setHeader("Content-Type", "application/x-ndjson");
      context.response.setHeader("Cache-Control", "no-cache");
      context.response.flushHeaders();
      writeLine(context.response, { type: "status", status: "running" });
      const parsed = parseDecisionBody(parseBody(context));
      const result = parsed.ok
        ? await runDecision(parsed.request, deps, (stop) =>
            context.request.once("close", stop)
          ).catch((error: unknown) =>
            failure(`The decision could not run: ${errorText(error)}`)
          )
        : failure(parsed.error);
      writeLine(context.response, result);
      writeLine(context.response, { type: "done" });
      context.response.end();
    }
  );
}

/** The decision's own folder on this computer. */
export function resolveDecisionFolder(
  decisionId: string,
  allowedDirs: readonly string[]
): string {
  const parent = allowedDirs[0];
  if (!parent) {
    throw new Error("no allowed directories configured");
  }
  const folder = path.join(expandHome(parent), DECISIONS_DIR, decisionId);
  assertPathAllowed(folder, [...allowedDirs]);
  return folder;
}

/** The model's answer, or why there is none, from its stream-json lines. */
export function readDecisionAnswer(
  resultLine: DecisionResultLine | null,
  exit: { code: number | null; stderr: string; timedOut: boolean }
): WorkflowDecisionResult {
  if (exit.timedOut) {
    return failure(
      `The decision did not finish within ${Math.round(
        WORKFLOW_DECISION_TIMEOUT_MS / 60_000
      )} minutes.`
    );
  }
  if (!resultLine) {
    const detail = exit.stderr.trim().slice(-STDERR_TAIL_MAX);
    return failure(
      `Claude Code ended without an answer (exit code ${exit.code ?? "none"})${detail ? `: ${detail}` : ""}`
    );
  }
  if (resultLine.is_error) {
    return failure(
      `Claude Code failed: ${resultLine.result ?? resultLine.subtype ?? "unknown error"}`
    );
  }
  return {
    type: "result",
    ok: true,
    answer: (resultLine.result ?? "").slice(0, WORKFLOW_DECISION_ANSWER_MAX),
    costUsd: resultLine.total_cost_usd ?? null,
  };
}

/** What Claude Code writes as the last line of a `-p` stream-json run. */
const decisionResultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
});
export type DecisionResultLine = z.infer<typeof decisionResultLineSchema>;

type ParsedRequest = WorkflowDecisionRequest & {
  claudeEnv: Record<string, string>;
  claudeCodeVersion?: string;
};

/** The request plus the computer's Claude settings the API adds to every body. */
const decisionBodySchema = workflowDecisionRequestSchema.extend({
  claudeEnv: modelProviderEnvSchema.optional(),
  claudeCodeVersion: claudeCodeVersionSchema.optional(),
});

function parseDecisionBody(
  body: Record<string, unknown> | null
): { ok: true; request: ParsedRequest } | { ok: false; error: string } {
  const parsed = decisionBodySchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid decision request: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    };
  }
  return {
    ok: true,
    request: { ...parsed.data, claudeEnv: parsed.data.claudeEnv ?? {} },
  };
}

async function runDecision(
  request: ParsedRequest,
  deps: WorkflowDecisionDeps,
  onCancel: (stop: () => void) => void
): Promise<WorkflowDecisionResult> {
  let folder: string;
  try {
    folder = resolveDecisionFolder(
      request.decisionId,
      deps.getAllowedDirectories()
    );
  } catch (error) {
    return failure(`No folder for the decision: ${errorText(error)}`);
  }
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, PROMPT_FILE), request.prompt, "utf8");
  const mcpConfigFile = path.join(folder, DECISION_MCP_CONFIG_FILE);
  await writeFile(
    mcpConfigFile,
    `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    "utf8"
  );

  const binary = await resolveLoopHarnessBinary({
    adapter: { harness: LoopHarness.Claude, binaryName: "claude" },
    claudeCodeVersion: request.claudeCodeVersion,
    override: getOverrideBinaryPaths()?.claude,
  });
  if (binary.error) {
    return failure(binary.error);
  }
  const result = await spawnModel({
    deps,
    command: binary.resolved.path,
    folder,
    mcpConfigFile,
    prompt: request.prompt,
    env: await deps.getClaudeShellEnv(request.claudeEnv),
    onCancel,
  });
  await writeFile(
    path.join(folder, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );
  return result;
}

/** Runs Claude Code without tools in the decision's folder for its answer. */
function spawnModel(input: {
  deps: WorkflowDecisionDeps;
  command: string;
  folder: string;
  mcpConfigFile: string;
  prompt: string;
  env: Record<string, string>;
  onCancel: (stop: () => void) => void;
}): Promise<WorkflowDecisionResult> {
  const { deps } = input;
  const outputFile = path.join(input.folder, OUTPUT_FILE);
  return new Promise((resolve) => {
    let resultLine: DecisionResultLine | null = null;
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
    }, deps.timeoutMs ?? WORKFLOW_DECISION_TIMEOUT_MS);
    deps.processManager
      .spawnStreaming({
        command: input.command,
        args: [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          // Ask-mode: in -p nothing can approve a tool, and the rest are denied.
          "--permission-mode",
          "default",
          `--disallowedTools=${DECISION_DISALLOWED_TOOLS}`,
          "--mcp-config",
          input.mcpConfigFile,
          "--strict-mcp-config",
          "--max-turns",
          String(DECISION_MAX_TURNS),
        ],
        cwd: input.folder,
        env: input.env,
        input: input.prompt,
        onLine: (line) => {
          writes = writes.then(() =>
            appendFile(outputFile, `${line}\n`, "utf8")
          );
          resultLine = parseResultLine(line) ?? resultLine;
        },
        onError: (error) => {
          stderr = `${stderr}${error.message}`.slice(-STDERR_TAIL_MAX * 4);
        },
        onExit: (code) => {
          clearTimeout(timer);
          // The transcript is best effort: the answer is settled either way.
          const settle = () =>
            resolve(readDecisionAnswer(resultLine, { code, stderr, timedOut }));
          writes.then(settle, settle);
        },
      })
      .then((handle) => {
        pid = handle.pid;
        input.onCancel(stop);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        resolve(failure(`Claude Code could not start: ${errorText(error)}`));
      });
  });
}

function parseResultLine(line: string): DecisionResultLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = decisionResultLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function failure(error: string): WorkflowDecisionResult {
  return {
    type: "result",
    ok: false,
    error: error.slice(0, WORKFLOW_DECISION_ERROR_MAX),
  };
}

function writeLine(response: ServerResponse, payload: object): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
