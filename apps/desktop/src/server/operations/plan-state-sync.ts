/**
 * @file plan-state-sync.ts
 * @description Saves and restores a plan's state (plan-state-bundle.ts)
 * through the API, which keeps it in object storage under the plan — the
 * latest state, and one copy per loop — and hands out presigned URLs for it.
 *
 * - When a PLAN, EXECUTE or REQUEST_CHANGES loop ends, its work directory is
 *   saved: always as that loop's copy, and as the plan's latest state when
 *   the loop succeeded. A failed loop's state stays on its computer (a
 *   half-made plan, or tasks whose code was never pushed, must not reach
 *   another computer); a retry there continues from it, since a work
 *   directory that grew from the latest state is kept.
 * - When an EXECUTE or REQUEST_CHANGES loop starts, the latest state is
 *   restored into its work directory, and for a workflow re-plan into
 *   `previous-work` (loop-replan.ts hands the earlier plan over from there).
 *   A work directory that already holds that state, or a newer one that grew
 *   from it, is left as it is.
 *
 * Only loops the cloud keeps state for (the request carries `s3StateKey`, as
 * every dispatched loop does) take part. Both directions are best-effort:
 * without a saved state a loop works from its local work directory and the
 * plan document, as before.
 */

import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { z } from "zod";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import { withTokenRefreshRetry } from "../../main/loop/loop-refresh.js";
import type { LoopTokenStore } from "../../main/loop/loop-token-store.js";
import { normalizeAndValidateOrigin } from "../../main/settings/origin-policy.js";
import type { LoopHttpResult } from "./loop-http.js";
import { PREVIOUS_WORK_DIR } from "./loop-replan.js";
import {
  buildPlanStateManifest,
  collectPlanStateFiles,
  decodePlanStateBundle,
  encodePlanStateBundle,
  extractPlanStateBundle,
  isLocalPlanStateCurrent,
  PLAN_STATE_COMMANDS,
  PLAN_STATE_FILE,
  PlanLoopOutcome,
  readPlanStateManifest,
} from "./plan-state-bundle.js";

const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_ID_RE = /^[\w-]{1,128}$/;
const TRANSFER_TIMEOUT_MS = 120_000;
/** A bundle larger than this is not downloaded (the caps keep them far smaller). */
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

const downloadEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ state: z.object({ url: z.string() }).nullable() }),
});
const uploadEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ urls: z.array(z.string()).min(1) }),
});

export type PlanStateLoop = {
  loopId: string;
  command: string;
  replan?: boolean;
  agentFlowAuthToken: string;
  s3StateKey?: string;
};

type PlanStateApi = {
  apiBaseUrl: string;
  getToken: () => string | null;
  /** Refreshes an expired loop token once (the finalizer has one). */
  loopTokenStore?: LoopTokenStore;
};

/**
 * Creates the loop's work directory (`<root>/.agentflow-ai/work`) and
 * restores the plan's latest state into it when the loop continues a plan.
 */
export async function openPlanWorkDir(
  rootDir: string,
  input: {
    loop: PlanStateLoop;
    apiBaseUrl: string;
    log: (line: string) => void;
  }
): Promise<string> {
  const workDir = path.join(rootDir, ".agentflow-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  const target = restoreTarget(input.loop, workDir);
  if (target) {
    try {
      input.log(await restorePlanState(target, input));
    } catch (error) {
      input.log(
        `Plan state: not restored (${errorMessage(error)}); using the local work directory`
      );
    }
  }
  return workDir;
}

/**
 * Saves the loop's work directory as the plan's state. The finalizer calls it
 * before the loop's terminal event, so the plan's next loop (which the API may
 * start right after it) finds this state. Never throws: a failure is logged
 * and the loop finalizes as usual.
 */
export async function savePlanState(
  job: { loopId: string; command: string; status: string; s3StateKey?: string },
  claudeWorkDir: string,
  api: PlanStateApi
): Promise<void> {
  const saves =
    job.s3StateKey &&
    PLAN_STATE_COMMANDS.has(job.command) &&
    existsSync(claudeWorkDir);
  if (!saves) {
    return;
  }
  try {
    const outcome =
      job.status === "COMPLETED" || job.status === "RUNNING"
        ? PlanLoopOutcome.Succeeded
        : PlanLoopOutcome.Failed;
    const { files, skipped } = await collectPlanStateFiles(claudeWorkDir);
    const manifest = await buildPlanStateManifest({
      workDir: claudeWorkDir,
      loopId: job.loopId,
      command: job.command,
      outcome,
      savedAt: new Date().toISOString(),
      skipped,
    });
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(claudeWorkDir, PLAN_STATE_FILE), manifestData);
    const body = encodePlanStateBundle({
      manifest,
      files: [...files, { path: PLAN_STATE_FILE, data: manifestData }],
    });
    const latest = outcome === PlanLoopOutcome.Succeeded;
    for (const url of await requestUploadUrls(api, job.loopId, latest)) {
      await transfer(url, { method: "PUT", body });
    }
    gatewayLog.info(
      "plan-state",
      `loopId=${job.loopId} saved the plan state (${manifest.phase}, next: ${manifest.nextStep}; ${files.length + 1} files, ${body.length} bytes${latest ? "" : ", kept as this loop's copy only"})`
    );
  } catch (error) {
    gatewayLog.warn(
      "plan-state",
      `loopId=${job.loopId} plan state not saved: ${errorMessage(error)}`
    );
  }
}

/**
 * Whether the Claude session an earlier loop of the plan ran in is on this
 * computer, so `--resume` can continue it. A session lives only where its
 * loop ran; on another computer the loop continues from the restored plan
 * state instead of resuming.
 */
export function isLocalHarnessSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!SESSION_ID_RE.test(sessionId)) {
    return false;
  }
  const projectsDir = path.join(
    env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects"
  );
  try {
    return readdirSync(projectsDir).some((project) =>
      existsSync(path.join(projectsDir, project, `${sessionId}.jsonl`))
    );
  } catch {
    return false;
  }
}

/**
 * `--resume <parent session>` when that session is on this computer, else
 * nothing: the loop then continues from the restored plan state.
 */
export function parentResumeArgs(sessionId: string | undefined): string[] {
  return sessionId && isLocalHarnessSession(sessionId)
    ? ["--resume", sessionId]
    : [];
}

function restoreTarget(loop: PlanStateLoop, workDir: string): string | null {
  if (!loop.s3StateKey) {
    return null;
  }
  if (
    loop.command === LoopCommand.Execute ||
    loop.command === LoopCommand.RequestChanges
  ) {
    return workDir;
  }
  if (loop.command === LoopCommand.Plan && loop.replan === true) {
    return path.join(path.dirname(workDir), PREVIOUS_WORK_DIR);
  }
  return null;
}

async function restorePlanState(
  target: string,
  input: { loop: PlanStateLoop; apiBaseUrl: string }
): Promise<string> {
  const url = await requestDownloadUrl(
    {
      apiBaseUrl: input.apiBaseUrl,
      getToken: () => input.loop.agentFlowAuthToken,
    },
    input.loop.loopId
  );
  if (!url) {
    return "Plan state: none saved for this plan yet; using the local work directory";
  }
  const response = await transfer(url, { method: "GET" });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`bundle too large (${declared} bytes)`);
  }
  const bundle = decodePlanStateBundle(
    Buffer.from(await response.arrayBuffer())
  );
  const { manifest } = bundle;
  const from = `${manifest.command} loop ${manifest.loopId}`;
  if (isLocalPlanStateCurrent(await readPlanStateManifest(target), manifest)) {
    return `Plan state: the local work directory already holds the state of ${from}`;
  }
  await extractPlanStateBundle(bundle, target);
  return `Plan state: restored the state of ${from} (${manifest.phase}, next: ${manifest.nextStep}; ${bundle.files.length} files) into ${path.basename(target)}`;
}

async function requestDownloadUrl(
  api: PlanStateApi,
  loopId: string
): Promise<string | null> {
  const envelope = downloadEnvelopeSchema.parse(
    await callApi(api, loopId, { method: "GET" })
  );
  return envelope.data.state?.url ?? null;
}

async function requestUploadUrls(
  api: PlanStateApi,
  loopId: string,
  latest: boolean
): Promise<string[]> {
  const envelope = uploadEnvelopeSchema.parse(
    await callApi(api, loopId, {
      method: "POST",
      body: JSON.stringify({ latest }),
    })
  );
  return envelope.data.urls;
}

async function callApi(
  api: PlanStateApi,
  loopId: string,
  init: { method: string; body?: string }
): Promise<unknown> {
  let payload: unknown = null;
  const attempt = async (
    getToken: () => string | null
  ): Promise<LoopHttpResult> => {
    const token = getToken();
    if (token === null) {
      return { success: false, kind: "auth", error: "missing_token" };
    }
    const response = await fetch(
      `${api.apiBaseUrl}/loops/${encodeURIComponent(loopId)}/plan-state`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      const error = `plan-state HTTP ${response.status}`;
      return { success: false, kind: "http", status: response.status, error };
    }
    payload = await response.json();
    return { success: true, status: response.status };
  };
  const result = api.loopTokenStore
    ? await withTokenRefreshRetry(
        loopId,
        api.apiBaseUrl,
        api.getToken,
        api.loopTokenStore,
        attempt
      )
    : await attempt(api.getToken);
  if (!result.success) {
    throw new Error(result.error);
  }
  return payload;
}

/** GET or PUT a presigned storage URL: https, or http to an allowed host. */
async function transfer(
  rawUrl: string,
  init: { method: "GET" | "PUT"; body?: Buffer }
): Promise<Response> {
  const url = new URL(rawUrl);
  normalizeAndValidateOrigin(url.origin);
  if (url.username || url.password) {
    throw new Error("storage URL must not carry credentials");
  }
  const response = await fetch(url, {
    method: init.method,
    ...(init.body ? { body: new Uint8Array(init.body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`storage ${init.method} HTTP ${response.status}`);
  }
  return response;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
