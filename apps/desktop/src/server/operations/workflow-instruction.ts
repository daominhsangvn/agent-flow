import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  claudeCodeVersionSchema,
  modelProviderEnvSchema,
} from "@repo/api/src/types/compute-target-model-provider";
import { INTEGRATION_MCP_SERVER_NAME } from "@repo/api/src/types/integration-tools";
import {
  WORKFLOW_INSTRUCTION_ANSWER_MAX,
  WORKFLOW_INSTRUCTION_ERROR_MAX,
  WORKFLOW_INSTRUCTION_GATEWAY_PATH,
  WORKFLOW_INSTRUCTION_TIMEOUT_MS,
  type WorkflowInstructionRequest,
  type WorkflowInstructionResult,
  workflowInstructionRequestSchema,
} from "@repo/api/src/types/workflow-instruction";
import { z } from "zod";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ClaudeCodeShellEnvProvider } from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed } from "../security.js";
import { pluginDirArgs } from "./bundled-plugins.js";
import { resolveLoopHarnessBinary } from "./claude-code-version-pin.js";
import {
  integrationMcpConfig,
  integrationToolEnv,
  type OpenIntegrationSession,
  writeAttachHelper,
} from "./integration-session-client.js";
import {
  parseProjectRepoCloneUrl,
  projectRepoCheckoutDirName,
  projectRepoHostDirName,
} from "./loop-repo-checkout.js";
import { parseBody } from "./parse-body.js";
import { getPersonalRunnerProject } from "./personal-runner.js";
import { getOverrideBinaryPaths, slugifyLoopId } from "./symphony-loop.js";
import { expandHome, resolveWorktreeParentDir } from "./symphony-utils.js";

/**
 * Instruction actions of a workflow (docs/workflows.md "Actions"): the API
 * asks this computer to run an instruction's agent in the run's workspace —
 * the plan folder the run's loops share, `<worktree parent>/loops/<key>`, with
 * the PRD, the plan, the work files and the repositories — so the agent has
 * the run's whole context. The agent only reads: no file tools that write, no
 * web, read-only git, and its own folder (`.agentflow-ai/actions/<id>`) for
 * the prompt and the transcript, so it never touches what a loop running in
 * the same workspace writes. It reads the run's source item and writes what
 * the workflow grants only through the AgentFlow integration tools: an MCP
 * server whose session token this computer gets for the action run and hands
 * to the agent in its environment alone (`--strict-mcp-config`, so no MCP
 * server of this computer's configuration is loaded). The API checks and
 * carries out every call with the connection's credentials; the final answer
 * is a note.
 *
 * The answer is an ndjson stream: a `status` line at once (a run takes longer
 * than the command executor waits for response headers), then the `result`
 * line and `done`.
 */

export const INSTRUCTION_ACTIONS_DIR = path.join(".agentflow-ai", "actions");

/**
 * Read the workspace and its history and use the integration tools; never
 * change files, never reach the web.
 */
export const INSTRUCTION_ALLOWED_TOOLS = [
  `mcp__${INTEGRATION_MCP_SERVER_NAME}`,
  "Read",
  "Grep",
  "Glob",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
].join(",");

/**
 * Denied even if a settings file on the computer allows them: deny rules win
 * over every allow rule and permission mode.
 */
export const INSTRUCTION_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
].join(",");

const PROMPT_FILE = "prompt.md";
const OUTPUT_FILE = "claude-output.jsonl";
const RESULT_FILE = "result.json";
export const INSTRUCTION_MCP_CONFIG_FILE = "mcp-config.json";
const KILL_GRACE_MS = 5000;
const STDERR_TAIL_MAX = 1000;

export type WorkflowInstructionDeps = {
  processManager: ProcessManager;
  getAllowedDirectories: () => string[];
  getClaudeShellEnv: ClaudeCodeShellEnvProvider;
  /** Absent when this computer has no AgentFlow API key. */
  openIntegrationSession?: OpenIntegrationSession;
  timeoutMs?: number;
};

export function registerWorkflowInstructionRoutes(
  dispatcher: OperationDispatcher,
  deps: WorkflowInstructionDeps
): void {
  dispatcher.register(
    "POST",
    WORKFLOW_INSTRUCTION_GATEWAY_PATH,
    async (context) => {
      context.response.statusCode = 200;
      context.response.setHeader("Content-Type", "application/x-ndjson");
      context.response.setHeader("Cache-Control", "no-cache");
      context.response.flushHeaders();
      writeLine(context.response, { type: "status", status: "running" });
      const parsed = parseInstructionBody(parseBody(context));
      const result = parsed.ok
        ? await runInstruction(parsed.request, deps, (stop) =>
            context.request.once("close", stop)
          )
        : failure(parsed.error, false);
      writeLine(context.response, result);
      writeLine(context.response, { type: "done" });
      context.response.end();
    }
  );
}

/**
 * The run's workspace on this computer, computed the way a loop opens it
 * (loop-workspace.ts) without touching a repository: the primary
 * repository's checkout is `<allowed dir>/<host>/<owner>__<repo>`, and the
 * workspace `loops/<key>` next to the checkouts' host folders.
 */
export function resolveInstructionWorkspace(
  request: Pick<WorkflowInstructionRequest, "workspaceKey" | "repository">,
  allowedDirs: readonly string[]
): string {
  // A personal runner's loops all run in its project folder.
  const personal = getPersonalRunnerProject();
  if (personal) {
    return personal.projectDir;
  }
  const parent = allowedDirs[0];
  if (!parent) {
    throw new Error("no allowed directories configured");
  }
  const cloneUrl = parseProjectRepoCloneUrl(request.repository.cloneUrl);
  const checkout = path.join(
    expandHome(parent),
    projectRepoHostDirName(cloneUrl),
    projectRepoCheckoutDirName(request.repository.fullName)
  );
  const workspace = path.join(
    resolveWorktreeParentDir(path.dirname(checkout)),
    "loops",
    slugifyLoopId(request.workspaceKey)
  );
  assertPathAllowed(workspace, [...allowedDirs]);
  return workspace;
}

/** The answer of the agent, or why there is none, from its stream-json lines. */
export function readInstructionAnswer(
  resultLine: ClaudeResultLine | null,
  exit: { code: number | null; stderr: string; timedOut: boolean }
): WorkflowInstructionResult {
  if (exit.timedOut) {
    return failure(
      `The instruction's agent did not finish within ${Math.round(
        WORKFLOW_INSTRUCTION_TIMEOUT_MS / 60_000
      )} minutes.`,
      true
    );
  }
  if (!resultLine) {
    const detail = exit.stderr.trim().slice(-STDERR_TAIL_MAX);
    return failure(
      `The instruction's agent ended without an answer (exit code ${exit.code ?? "none"})${detail ? `: ${detail}` : ""}`,
      true
    );
  }
  if (resultLine.is_error) {
    return failure(
      `The instruction's agent failed: ${resultLine.result ?? resultLine.subtype ?? "unknown error"}`,
      true
    );
  }
  const usage = resultLine.usage ?? {};
  return {
    type: "result",
    ok: true,
    answer: (resultLine.result ?? "").slice(0, WORKFLOW_INSTRUCTION_ANSWER_MAX),
    costUsd: resultLine.total_cost_usd ?? null,
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

type ParsedRequest = WorkflowInstructionRequest & {
  claudeEnv: Record<string, string>;
  claudeCodeVersion?: string;
};

/** The request plus the computer's Claude settings the API adds to every body. */
const instructionBodySchema = workflowInstructionRequestSchema.extend({
  claudeEnv: modelProviderEnvSchema.optional(),
  claudeCodeVersion: claudeCodeVersionSchema.optional(),
});

/** What Claude Code writes as the last line of a `-p` stream-json run. */
const claudeResultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
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

function parseInstructionBody(
  body: Record<string, unknown> | null
): { ok: true; request: ParsedRequest } | { ok: false; error: string } {
  const parsed = instructionBodySchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid instruction request: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    };
  }
  return {
    ok: true,
    request: { ...parsed.data, claudeEnv: parsed.data.claudeEnv ?? {} },
  };
}

async function runInstruction(
  request: ParsedRequest,
  deps: WorkflowInstructionDeps,
  onCancel: (stop: () => void) => void
): Promise<WorkflowInstructionResult> {
  let workspace: string;
  try {
    workspace = resolveInstructionWorkspace(
      request,
      deps.getAllowedDirectories()
    );
  } catch (error) {
    return failure(`No workspace for the run: ${errorText(error)}`, false);
  }
  const folder = path.join(
    workspace,
    INSTRUCTION_ACTIONS_DIR,
    request.actionRunId
  );
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, PROMPT_FILE), request.prompt, "utf8");

  const binary = await resolveLoopHarnessBinary({
    adapter: { harness: LoopHarness.Claude, binaryName: "claude" },
    claudeCodeVersion: request.claudeCodeVersion,
    override: getOverrideBinaryPaths()?.claude,
  });
  if (binary.error) {
    return failure(binary.error, true);
  }
  const session = await openSession(deps, request.actionRunId);
  if (!session.ok) {
    return session.failure;
  }
  const mcpConfigFile = path.join(folder, INSTRUCTION_MCP_CONFIG_FILE);
  await writeFile(
    mcpConfigFile,
    `${JSON.stringify(integrationMcpConfig(session.mcpUrl), null, 2)}\n`,
    "utf8"
  );
  const attachHelper = session.filesUrl
    ? await writeAttachHelper(folder)
    : null;
  const env = await deps.getClaudeShellEnv(request.claudeEnv);
  const result = await spawnAgent({
    deps,
    command: binary.resolved.path,
    workspace,
    outputFile: path.join(folder, OUTPUT_FILE),
    mcpConfigFile,
    prompt: request.prompt,
    // The token lives only in the agent's environment, never in a file.
    env: { ...env, ...integrationToolEnv(session, attachHelper) },
    onCancel,
  });
  await writeFile(
    path.join(folder, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );
  return result;
}

async function openSession(
  deps: WorkflowInstructionDeps,
  actionRunId: string
): Promise<
  | { ok: true; token: string; mcpUrl: string; filesUrl?: string }
  | { ok: false; failure: WorkflowInstructionResult }
> {
  if (!deps.openIntegrationSession) {
    return {
      ok: false,
      failure: failure(
        "This computer has no AgentFlow API key, so the instruction's agent cannot get its integration tools.",
        false
      ),
    };
  }
  try {
    const grant = await deps.openIntegrationSession(actionRunId);
    return {
      ok: true,
      token: grant.token,
      mcpUrl: grant.mcpUrl,
      filesUrl: grant.filesUrl,
    };
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        `The instruction's integration tools could not be opened: ${errorText(error)}`,
        true
      ),
    };
  }
}

/** Runs the agent read-only in the workspace and waits for its answer. */
function spawnAgent(input: {
  deps: WorkflowInstructionDeps;
  command: string;
  workspace: string;
  outputFile: string;
  mcpConfigFile: string;
  prompt: string;
  env: Record<string, string>;
  onCancel: (stop: () => void) => void;
}): Promise<WorkflowInstructionResult> {
  const { deps } = input;
  return new Promise((resolve) => {
    let resultLine: ClaudeResultLine | null = null;
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
    }, deps.timeoutMs ?? WORKFLOW_INSTRUCTION_TIMEOUT_MS);
    deps.processManager
      .spawnStreaming({
        command: input.command,
        args: [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          // Ask-mode: in -p nothing can approve a tool outside the allow list.
          "--permission-mode",
          "default",
          `--allowedTools=${INSTRUCTION_ALLOWED_TOOLS}`,
          `--disallowedTools=${INSTRUCTION_DISALLOWED_TOOLS}`,
          // Only the AgentFlow integration tools: no MCP server this
          // computer's own configuration names.
          "--mcp-config",
          input.mcpConfigFile,
          "--strict-mcp-config",
          // The plugins a loop runs with, for the same guards (secret-guard).
          ...pluginDirArgs(),
        ],
        cwd: input.workspace,
        env: input.env,
        input: input.prompt,
        onLine: (line) => {
          writes = writes.then(() =>
            appendFile(input.outputFile, `${line}\n`, "utf8")
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
            resolve(
              readInstructionAnswer(resultLine, { code, stderr, timedOut })
            );
          writes.then(settle, settle);
        },
      })
      .then((handle) => {
        pid = handle.pid;
        input.onCancel(stop);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        resolve(
          failure(
            `The instruction's agent could not start: ${errorText(error)}`,
            true
          )
        );
      });
  });
}

function parseResultLine(line: string): ClaudeResultLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = claudeResultLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function failure(error: string, retryable: boolean): WorkflowInstructionResult {
  return {
    type: "result",
    ok: false,
    error: error.slice(0, WORKFLOW_INSTRUCTION_ERROR_MAX),
    retryable,
  };
}

function writeLine(response: ServerResponse, payload: object): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
