import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  parseRunnerCapabilitiesMarkdown,
  RUNNER_CAPABILITIES_FILE_NAME,
  RUNNER_CAPABILITIES_MAX_CHARS,
  RUNNER_CAPABILITIES_MAX_WARNINGS,
  RUNNER_CAPABILITIES_REFRESH_ERROR_MAX,
  RUNNER_CAPABILITIES_REFRESH_GATEWAY_PATH,
  type RunnerCapabilitiesRefreshRequest,
  type RunnerCapabilitiesRefreshResult,
  RunnerCapabilitiesSource,
  runnerCapabilitiesGitCredentialPath,
  runnerCapabilitiesRefreshRequestSchema,
} from "@repo/api/src/types/runner-capabilities";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { collectCapabilityWarningsIn } from "./capability-warnings.js";
import { buildGitCredentialEnv } from "./loop-git-access.js";
import { ensureProjectRepoCheckout } from "./loop-repo-checkout.js";
import { parseBody } from "./parse-body.js";
import { getResolvedGitPathAsync } from "./symphony-loop.js";

/**
 * Reads AGENTFLOW.md from a project's toolkit repository on this computer and
 * uploads it for the project. The repository is cloned or fetched with
 * credentials the API issues for this one refresh, and the file is read from
 * the remote branch, so the working tree is never touched.
 *
 * The answer is an ndjson stream: a `status` line at once, then the `result`
 * line and `done`.
 */

const LOG_TAG = "capabilities-refresh";
const GIT_READ_TIMEOUT_MS = 30_000;
const UPLOAD_ERROR_BODY_MAX = 300;
const TRAILING_SLASHES_RE = /\/+$/;
const execFileAsync = promisify(execFile);

export type CapabilitiesRefreshDeps = {
  getAllowedDirectories: () => string[];
  getApiOrigin?: () => string;
  getApiKey?: () => string | null;
  getComputeTargetId?: () => string | null;
  resolveGitBin?: () => Promise<string>;
  ensureCheckout?: typeof ensureProjectRepoCheckout;
  fetchImpl?: typeof fetch;
};

export function registerCapabilitiesRefreshRoutes(
  dispatcher: OperationDispatcher,
  deps: CapabilitiesRefreshDeps
): void {
  dispatcher.register(
    "POST",
    RUNNER_CAPABILITIES_REFRESH_GATEWAY_PATH,
    async (context) => {
      context.response.statusCode = 200;
      context.response.setHeader("Content-Type", "application/x-ndjson");
      context.response.setHeader("Cache-Control", "no-cache");
      context.response.flushHeaders();
      writeLine(context.response, { type: "status", status: "running" });
      const parsed = runnerCapabilitiesRefreshRequestSchema.safeParse(
        parseBody(context) ?? undefined
      );
      const result = parsed.success
        ? await runCapabilitiesRefresh(parsed.data, deps)
        : failure("the refresh request is not valid");
      writeLine(context.response, result);
      writeLine(context.response, { type: "done" });
      context.response.end();
    }
  );
}

export async function runCapabilitiesRefresh(
  request: RunnerCapabilitiesRefreshRequest,
  deps: CapabilitiesRefreshDeps
): Promise<RunnerCapabilitiesRefreshResult> {
  try {
    return await refresh(request, deps);
  } catch (error) {
    gatewayLog.warn(LOG_TAG, `Refresh failed: ${errorText(error)}`);
    return failure(errorText(error));
  }
}

async function refresh(
  request: RunnerCapabilitiesRefreshRequest,
  deps: CapabilitiesRefreshDeps
): Promise<RunnerCapabilitiesRefreshResult> {
  const origin = deps.getApiOrigin?.().replace(TRAILING_SLASHES_RE, "");
  const apiKey = deps.getApiKey?.();
  const targetId = deps.getComputeTargetId?.();
  if (!(origin && apiKey && targetId)) {
    return failure("this computer is not connected to AgentFlow");
  }
  const { repository, defaultBranch } = request;
  const gitBin = await (deps.resolveGitBin ?? getResolvedGitPathAsync)();
  const env = {
    ...process.env,
    ...buildGitCredentialEnv({
      credentialUrl:
        origin +
        runnerCapabilitiesGitCredentialPath(targetId, request.refreshId),
      token: apiKey,
    }),
  };
  const checkout = await (deps.ensureCheckout ?? ensureProjectRepoCheckout)(
    { fullName: repository, cloneUrl: request.cloneUrl },
    {
      allowedDirs: deps.getAllowedDirectories(),
      gitBin,
      env,
      loopId: `capabilities-${request.refreshId}`,
      configDir: null,
    }
  );
  if (!checkout.ok) {
    return failure(checkout.reason);
  }
  const ref = `refs/remotes/origin/${defaultBranch}`;
  const content = await readFileAtRef(gitBin, checkout.path, ref);
  if (content === null) {
    return failure(
      `${repository} has no ${RUNNER_CAPABILITIES_FILE_NAME} at the root of ${defaultBranch}`
    );
  }
  const tree = await listClaudeTree(gitBin, checkout.path, ref);
  const warnings = [
    ...collectCapabilityWarningsIn(
      content,
      (relativePath) => tree.has(relativePath),
      "the toolkit repository"
    ),
    ...toolkitRepositoryWarnings(content, repository),
  ].slice(0, RUNNER_CAPABILITIES_MAX_WARNINGS);
  const uploadError = await upload({
    origin,
    apiKey,
    targetId,
    projectId: request.projectId,
    content,
    warnings,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (uploadError) {
    return failure(uploadError);
  }
  gatewayLog.info(
    LOG_TAG,
    `Uploaded ${RUNNER_CAPABILITIES_FILE_NAME} of ${repository} for project ${request.projectId}`
  );
  return {
    type: "result",
    ok: true,
    contentHash: createHash("sha256").update(content).digest("hex"),
    warningCount: warnings.length,
  };
}

async function readFileAtRef(
  gitBin: string,
  cwd: string,
  ref: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ["show", `${ref}:${RUNNER_CAPABILITIES_FILE_NAME}`],
      {
        cwd,
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: RUNNER_CAPABILITIES_MAX_CHARS * 4,
      }
    );
    return stdout.slice(0, RUNNER_CAPABILITIES_MAX_CHARS);
  } catch {
    return null;
  }
}

async function listClaudeTree(
  gitBin: string,
  cwd: string,
  ref: string
): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ["ls-tree", "-r", "--name-only", ref, "--", ".claude"],
      { cwd, timeout: GIT_READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

async function upload(input: {
  origin: string;
  apiKey: string;
  targetId: string;
  projectId: string;
  content: string;
  warnings: string[];
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const url = `${input.origin}/compute-targets/${encodeURIComponent(input.targetId)}/capabilities`;
  const response = await input.fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project: input.projectId,
      source: RunnerCapabilitiesSource.Toolkit,
      content: input.content,
      warnings: input.warnings,
    }),
  });
  if (response.ok) {
    return null;
  }
  const body = (await response.text().catch(() => "")).slice(
    0,
    UPLOAD_ERROR_BODY_MAX
  );
  return `Uploading ${RUNNER_CAPABILITIES_FILE_NAME} answered ${response.status}: ${body}`;
}

function failure(error: string): RunnerCapabilitiesRefreshResult {
  return {
    type: "result",
    ok: false,
    error: error.slice(0, RUNNER_CAPABILITIES_REFRESH_ERROR_MAX),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

/**
 * What only the file and the repository it was read from can show: the front
 * matter should name the toolkit, and name this repository.
 */
export function toolkitRepositoryWarnings(
  content: string,
  repository: string
): string[] {
  const parsed = parseRunnerCapabilitiesMarkdown(content);
  if (!parsed.ok) {
    return [];
  }
  const toolkit = parsed.value.toolkit;
  if (!toolkit) {
    return [
      "The front matter names no toolkit: scheduled refreshes find this repository only through the project's process toolkit.",
    ];
  }
  if (toolkit.repository.toLowerCase() !== repository.toLowerCase()) {
    return [
      `The front matter names toolkit ${toolkit.repository} but the file was read from ${repository}.`,
    ];
  }
  return [];
}
