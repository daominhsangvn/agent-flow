/**
 * @file headless-transcript-uploader.ts
 * @description Archives a loop's Claude Code transcripts to AgentFlow so the
 * session's Trace can be read in the web app. A headless runner has no local
 * session database, so it uploads straight from Claude's project directory
 * through the same redacted, checksummed `/desktop/transcripts` protocol the
 * desktop app uses (sync-plan, presigned PUT, complete).
 *
 * A loop is one AgentFlow session but can span several Claude sessions (an
 * iteration retried in a fresh session). The first Claude session's
 * transcript is the session's `main` file; each later one is archived beside
 * it as `subagent:iteration-<n>-<id>`, and every Claude session's own
 * subagent transcripts follow under that prefix.
 *
 * Each pass re-uploads a changed file whole (no prefix hash), which the plan
 * answers with a full PUT or multipart upload; an unchanged file is skipped
 * locally and an unchanged archive is a server-side noop.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptSyncPlanResponse } from "@repo/api/src/types/desktop-transcripts";
import { walkSubagentTranscripts } from "../main/collectors/claude/claude-home.js";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import {
  createDesktopTranscriptsClient,
  type DesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../main/transcript/desktop-transcripts-client.js";
import { findNewlineBoundary } from "../main/transcript-sync/transcript-checksums.js";
import {
  prepareRedactedTranscriptUploadWindow,
  type TranscriptUploadWindow,
} from "../main/transcript-sync/transcript-upload-window.js";
import { RUNNER_HARNESS } from "./headless-session-stream.js";

const LOG_TAG = "transcript-uploader";
const MAIN_FILE_KEY = "main";
const SUBAGENT_FILE_KEY_PREFIX = "subagent:";
const TRANSCRIPT_EXT = ".jsonl";
const SUBAGENTS_DIR = "subagents";
const HTTP_TOO_MANY_REQUESTS = 429;
/** The transcript routes' rate-limit window. */
export const RATE_LIMIT_PAUSE_MS = 60_000;

export type LoopTranscripts = {
  /** The AgentFlow session id: the loop's first Claude session. */
  externalSessionId: string;
  /** Every Claude session the loop ran, in order (the first is the main file). */
  harnessSessionIds: string[];
};

export type TranscriptFile = {
  fileKey: string;
  filePath: string;
};

export type HeadlessTranscriptUploaderDeps = {
  apiUrl: string;
  apiKey: string;
  /** Claude's config directory (`~/.claude` unless `CLAUDE_CONFIG_DIR`). */
  claudeHome?: string;
  client?: DesktopTranscriptsClient;
  now?: () => number;
};

export type HeadlessTranscriptUploader = {
  /** Archives every changed transcript of the loop; false when one failed. */
  upload(computeTargetId: string, loop: LoopTranscripts): Promise<boolean>;
};

export function createHeadlessTranscriptUploader(
  deps: HeadlessTranscriptUploaderDeps
): HeadlessTranscriptUploader {
  const claudeHome =
    deps.claudeHome ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(os.homedir(), ".claude");
  const client =
    deps.client ??
    createDesktopTranscriptsClient({
      getAccessToken: () => Promise.resolve(deps.apiKey),
      getApiOrigin: () => deps.apiUrl,
    });
  /** `<session>\0<fileKey>` -> source size last archived. */
  const archivedSizes = new Map<string, number>();
  const now = deps.now ?? Date.now;
  let pausedUntil = 0;

  const uploadFile = async (
    computeTargetId: string,
    externalSessionId: string,
    file: TranscriptFile
  ): Promise<void> => {
    const archiveKey = `${externalSessionId}\u0000${file.fileKey}`;
    const stat = fs.statSync(file.filePath);
    if (archivedSizes.get(archiveKey) === stat.size) {
      return;
    }
    const rawEndOffset = await findNewlineBoundary(file.filePath, stat.size);
    if (rawEndOffset === 0) {
      return;
    }
    const window = await prepareRedactedTranscriptUploadWindow(
      file.filePath,
      rawEndOffset
    );
    try {
      const identity = {
        computeTargetId,
        externalSessionId,
        fileKey: file.fileKey,
      };
      const checksums = {
        sha256: window.checksums.sha256Hex,
        crc64nvme: window.checksums.crc64NvmeBase64,
      };
      const plan = await client.syncPlan({
        ...identity,
        ...checksums,
        sourceHarness: RUNNER_HARNESS,
        sourcePathHash: createHash("sha256")
          .update(file.filePath)
          .digest("hex"),
        planEndOffset: window.planEndOffset,
        sourceMtime: stat.mtime.toISOString(),
      });
      if (plan.mode !== "noop") {
        await sendPlan(client, plan, window);
        await client.complete({
          ...identity,
          ...checksums,
          mode: plan.mode,
          ...(plan.mode === "multipart" ? { uploadId: plan.uploadId } : {}),
          planEndOffset: window.planEndOffset,
        });
      }
      archivedSizes.set(archiveKey, stat.size);
    } finally {
      await window.dispose();
    }
  };

  return {
    async upload(computeTargetId, loop) {
      if (now() < pausedUntil) {
        return false;
      }
      const files = loopTranscriptFiles(claudeHome, loop.harnessSessionIds);
      let ok = true;
      for (const file of files) {
        try {
          await uploadFile(computeTargetId, loop.externalSessionId, file);
        } catch (error) {
          ok = false;
          if (
            error instanceof TranscriptSyncClientError &&
            error.status === HTTP_TOO_MANY_REQUESTS
          ) {
            // The transcript routes allow a fixed number of requests per
            // minute: wait the window out, the rest goes on a later pass.
            pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
            return false;
          }
          gatewayLog.warn(
            LOG_TAG,
            `Transcript ${file.fileKey} of ${loop.externalSessionId} not archived: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return ok;
    },
  };
}

/**
 * The transcript files of a loop's Claude sessions, keyed for the archive:
 * the first session is `main`, later ones `subagent:iteration-<n>-<id>`, and
 * each session's subagents follow under its prefix.
 */
export function loopTranscriptFiles(
  claudeHome: string,
  harnessSessionIds: string[]
): TranscriptFile[] {
  const projectsDir = path.join(claudeHome, "projects");
  const projects = safeReaddir(projectsDir).map((name) =>
    path.join(projectsDir, name)
  );
  const files: TranscriptFile[] = [];
  harnessSessionIds.forEach((sessionId, index) => {
    const projectDir = projects.find((dir) =>
      fs.existsSync(path.join(dir, `${sessionId}${TRANSCRIPT_EXT}`))
    );
    if (!projectDir) {
      return;
    }
    const prefix = index === 0 ? "" : `iteration-${index + 1}-${sessionId}`;
    files.push({
      fileKey: prefix ? `${SUBAGENT_FILE_KEY_PREFIX}${prefix}` : MAIN_FILE_KEY,
      filePath: path.join(projectDir, `${sessionId}${TRANSCRIPT_EXT}`),
    });
    const subagents = walkSubagentTranscripts(
      path.join(projectDir, sessionId, SUBAGENTS_DIR)
    );
    for (const subagent of subagents) {
      const fileId = prefix ? `${prefix}__${subagent.relId}` : subagent.relId;
      files.push({
        fileKey: `${SUBAGENT_FILE_KEY_PREFIX}${fileId}`,
        filePath: subagent.filePath,
      });
    }
  });
  return files;
}

async function sendPlan(
  client: DesktopTranscriptsClient,
  plan: Exclude<TranscriptSyncPlanResponse, { mode: "noop" }>,
  window: TranscriptUploadWindow
): Promise<void> {
  if (plan.mode === "fullPut") {
    await client.uploadPut(
      plan.url,
      window.openRangeStream(0, window.planEndOffset),
      window.planEndOffset,
      window.checksums.crc64NvmeBase64
    );
    return;
  }
  for (const part of plan.parts) {
    await client.uploadPart(
      part.url,
      window.openRangeStream(part.offset, part.offset + part.byteLength),
      part.byteLength
    );
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
