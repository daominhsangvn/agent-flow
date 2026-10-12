/**
 * @file headless-session-reporter.ts
 * @description Reports what a headless runner's agents do to AgentFlow's
 * Sessions and Agents pages:
 *
 * - every loop as an agent session, while it runs (status `active`, refreshed
 *   as its stream grows) and once more when it ends (`inactive` / `error`),
 *   folded from the loop's own Claude Code stream (headless-session-stream.ts);
 * - the agent components the runner offers (the bundled plugins' subagents,
 *   commands and skills) and those of each loop workspace (a toolkit's
 *   `.claude/commands`), as the compute target's component inventory.
 *
 * It uses the same routes and payloads as the desktop app's sync lanes
 * (`POST /desktop/agent-sessions/sync`, `POST /desktop/components/sync`) with
 * the runner's API key. AgentFlow ingests them only when the organization
 * allows session sync (Settings → Organization); a refusal pauses the
 * reporter for a while instead of retrying every tick.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import type { JobStore, LocalJob } from "../main/jobs/job-store.js";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import {
  buildSyncedSession,
  createLoopSessionStream,
  foldStreamLine,
  type LoopSessionStream,
  RUNNER_HARNESS,
} from "./headless-session-stream.js";
import type { LoopTranscripts } from "./headless-transcript-uploader.js";

const LOG_TAG = "session-reporter";
export const SESSION_REPORT_INTERVAL_MS = 20_000;
/** A refused or failing sync waits this long before the next attempt. */
export const SESSION_REPORT_BACKOFF_MS = 5 * 60_000;
/** A running loop's transcripts are archived at most this often. */
export const TRANSCRIPT_UPLOAD_INTERVAL_MS = 5 * 60_000;
/** Finished loops older than this are not reported after a runner restart. */
const FINISHED_LOOP_REPORT_WINDOW_MS = 24 * 60 * 60_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const COMPONENT_SYNC_SCHEMA_VERSION = 1;
/** The routes cap a request body at 256 KiB; leave room for the envelope. */
const REQUEST_BODY_BUDGET_BYTES = 200 * 1024;
const COMPONENT_CONTENT_MAX_CHARS = 32_000;
const COMPONENTS_PER_REQUEST_MAX = 200;
const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");
const MARKDOWN_EXT = ".md";
const GITDIR_POINTER_RE = /^gitdir:\s*(.+)$/m;
const HEAD_BRANCH_RE = /^ref:\s*refs\/heads\/(.+)$/m;
/** `claude-output-<YYYYMMDD>-<HHMMSS>-<suffix>.jsonl`, a finished loop's stream. */
const ARCHIVED_STREAM_RE = /^claude-output-(\d{8})-(\d{6})-[^/]*\.jsonl$/;
/**
 * How long after a loop ended its stream may still be written (exit, flush).
 * Short: the next loop of the work directory can start seconds later.
 */
const LIVE_STREAM_SLACK_MS = 2000;
/**
 * How long before its loop's recorded start a run may start (setup). A run
 * never starts after its loop ended: an archive that did is the next loop's.
 */
const ARCHIVE_MATCH_SLACK_MS = 60_000;
const TRAILING_SLASHES_RE = /\/+$/;
const SKILL_FILE = "SKILL.md";
const FRONTMATTER_NAME_RE = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m;
const FRONTMATTER_DESCRIPTION_RE = /^description:\s*["']?(.+?)["']?\s*$/m;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "QUEUED",
  "STARTING",
  "RUNNING",
  "AWAITING_USER",
  "CANCEL_PENDING",
]);
const FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILED", "UNKNOWN"]);

export type SessionReporterDeps = {
  apiUrl: string;
  apiKey: string;
  runnerName: string;
  jobStore: Pick<JobStore, "listRunning" | "listCompleted">;
  /** The compute target while the runner is online, else null. */
  getComputeTargetId: () => string | null;
  getPluginDirs: () => string[];
  /**
   * Archives a loop's Claude transcripts (the session Trace). Omitted = no
   * transcript archiving. Resolves false when a file was not archived.
   */
  uploadTranscripts?: (
    computeTargetId: string,
    loop: LoopTranscripts
  ) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  intervalMs?: number;
};

export type HeadlessSessionReporter = {
  /** One reporting pass (exposed for tests; the timer calls it). */
  tick(): Promise<void>;
  stop(): void;
};

type LoopState = {
  stream: LoopSessionStream;
  offset: number;
  remainder: string;
  /**
   * Inode of the stream file the loop was read from. run-loop.sh renames a
   * finished stream to its archive (same inode), while the next loop of the
   * work directory writes a new `claude-output.jsonl` (new inode).
   */
  fileIno: number | null;
  /** What was last reported: stream size + job status; empty = never. */
  reported: string;
  finalReported: boolean;
  /** Read while the worktree exists; finalization removes it. */
  workBranch: string | null;
  /** When the transcripts were last archived (epoch ms; 0 = never). */
  transcriptsArchivedAt: number;
  /** The finished loop's transcripts are archived in full. */
  transcriptsFinal: boolean;
  /** A full archive of the finished loop was attempted (retries wait). */
  transcriptsFinalTried: boolean;
};

export function startHeadlessSessionReporter(
  deps: SessionReporterDeps
): HeadlessSessionReporter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const loops = new Map<string, LoopState>();
  const reportedComponents = new Map<string, string>();
  const scannedWorkspaces = new Set<string>();
  let pausedUntil = 0;
  let running = false;
  let stopped = false;

  const post = async (
    route: string,
    computeTargetId: string,
    body: unknown
  ): Promise<boolean> => {
    const url = `${deps.apiUrl.replace(TRAILING_SLASHES_RE, "")}${route}?computeTargetId=${encodeURIComponent(computeTargetId)}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        return true;
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      gatewayLog.warn(
        LOG_TAG,
        `${route} answered ${response.status}; pausing session reporting: ${detail}`
      );
    } catch (error) {
      gatewayLog.warn(
        LOG_TAG,
        `${route} failed; pausing session reporting: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    pausedUntil = now().getTime() + SESSION_REPORT_BACKOFF_MS;
    return false;
  };

  const syncComponents = async (
    computeTargetId: string,
    components: SyncedComponent[]
  ): Promise<boolean> => {
    const changed = components.filter(
      (component) =>
        reportedComponents.get(component.externalId) !== component.contentHash
    );
    for (const batch of chunkBySize(changed)) {
      const sent = await post("/desktop/components/sync", computeTargetId, {
        schemaVersion: COMPONENT_SYNC_SCHEMA_VERSION,
        batchId: randomUUID(),
        syncMode: AgentSessionSyncMode.Incremental,
        componentCount: batch.length,
        components: batch,
      });
      if (!sent) {
        return false;
      }
      for (const component of batch) {
        reportedComponents.set(
          component.externalId,
          component.contentHash ?? ""
        );
      }
    }
    return true;
  };

  /** A loop workspace's own definitions (a mounted toolkit), once per workspace. */
  const syncWorkspaceOnce = async (
    computeTargetId: string,
    workspace: string | null
  ): Promise<boolean> => {
    if (!workspace || scannedWorkspaces.has(workspace)) {
      return true;
    }
    scannedWorkspaces.add(workspace);
    return await syncComponents(
      computeTargetId,
      scanWorkspaceComponents(workspace)
    );
  };

  /**
   * Archives the loop's transcripts: while it runs at most every
   * TRANSCRIPT_UPLOAD_INTERVAL_MS, and once more in full when it has ended.
   * A failure only delays the next attempt; it never holds up reporting.
   */
  const archiveTranscripts = async (
    computeTargetId: string,
    job: LocalJob,
    state: LoopState,
    final: boolean
  ): Promise<void> => {
    if (
      !(deps.uploadTranscripts && state.stream.sessionId) ||
      state.transcriptsFinal
    ) {
      return;
    }
    const at = now().getTime();
    const due =
      at - state.transcriptsArchivedAt >= TRANSCRIPT_UPLOAD_INTERVAL_MS;
    if (!(due || (final && !state.transcriptsFinalTried))) {
      return;
    }
    state.transcriptsArchivedAt = at;
    state.transcriptsFinalTried ||= final;
    const archived = await deps.uploadTranscripts(computeTargetId, {
      externalSessionId: job.loopId,
      harnessSessionIds: [...state.stream.harnessSessionIds],
    });
    state.transcriptsFinal = final && archived;
  };

  const reportLoop = async (
    computeTargetId: string,
    job: LocalJob
  ): Promise<boolean> => {
    const state = loops.get(job.loopId) ?? newLoopState();
    loops.set(job.loopId, state);
    if (state.finalReported) {
      await archiveTranscripts(computeTargetId, job, state, true);
      return true;
    }
    readNewLines(job, state, now().toISOString());
    state.workBranch = worktreeBranch(job.worktreeDir) ?? state.workBranch;
    const isRunning = RUNNING_STATUSES.has(job.status);
    // A loop is reported once its stream has started a Claude session; one
    // that never ran Claude, or a finished loop whose stream is gone, has
    // nothing to report.
    if (!state.stream.sessionId) {
      state.finalReported = !isRunning;
      return true;
    }
    const signature = `${state.offset}:${job.status}`;
    if (signature === state.reported) {
      return true;
    }
    const workspace = state.stream.cwd ?? job.claudeWorkDir ?? null;
    if (!(await syncWorkspaceOnce(computeTargetId, workspace))) {
      return false;
    }
    const session = buildSyncedSession(state.stream, {
      loopId: job.loopId,
      name: sessionName(job),
      running: isRunning,
      failed: FAILED_STATUSES.has(job.status),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      endedAt: job.completedAt ?? null,
      repositoryFullName: job.primaryRepoFullName ?? null,
      worktreePath: job.worktreeDir ?? job.claudeWorkDir ?? null,
      sourceArtifactId: job.artifactId ?? null,
      baseBranch: job.baseBranch ?? null,
      workBranch: state.workBranch,
      runnerName: deps.runnerName,
      command: job.command,
    });
    const sent = await post("/desktop/agent-sessions/sync", computeTargetId, {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      sessions: [session],
    });
    if (sent) {
      state.reported = signature;
      state.finalReported = !isRunning;
      await archiveTranscripts(computeTargetId, job, state, !isRunning);
    }
    return sent;
  };

  const tick = async (): Promise<void> => {
    const computeTargetId = deps.getComputeTargetId();
    if (running || stopped || !computeTargetId) {
      return;
    }
    if (now().getTime() < pausedUntil) {
      return;
    }
    running = true;
    try {
      const plugins = scanPluginComponents(deps.getPluginDirs());
      if (!(await syncComponents(computeTargetId, plugins))) {
        return;
      }
      for (const job of reportableJobs(deps.jobStore, now())) {
        if (!(await reportLoop(computeTargetId, job))) {
          return;
        }
      }
    } catch (error) {
      gatewayLog.warn(
        LOG_TAG,
        `Session report failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, deps.intervalMs ?? SESSION_REPORT_INTERVAL_MS);
  timer.unref();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      loops.clear();
      reportedComponents.clear();
      scannedWorkspaces.clear();
    },
  };
}

function newLoopState(): LoopState {
  return {
    stream: createLoopSessionStream(),
    offset: 0,
    remainder: "",
    fileIno: null,
    reported: "",
    finalReported: false,
    workBranch: null,
    transcriptsArchivedAt: 0,
    transcriptsFinal: false,
    transcriptsFinalTried: false,
  };
}

/** Running loops, then loops that finished within the report window. */
function reportableJobs(
  jobStore: Pick<JobStore, "listRunning" | "listCompleted">,
  now: Date
): LocalJob[] {
  const cutoff = now.getTime() - FINISHED_LOOP_REPORT_WINDOW_MS;
  const finished = jobStore
    .listCompleted()
    .filter((job) => Date.parse(job.completedAt ?? job.updatedAt) >= cutoff);
  return [...jobStore.listRunning(), ...finished];
}

/** Folds the stream bytes written since the last pass. */
function readNewLines(job: LocalJob, state: LoopState, at: string): void {
  const file = resolveStreamFile(job, state.fileIno);
  if (!file) {
    return;
  }
  let handle: number | null = null;
  try {
    const { size, ino } = fs.statSync(file);
    if (
      size < state.offset ||
      (state.fileIno !== null && ino !== state.fileIno)
    ) {
      // A new stream (a resumed loop rewrote it): start over.
      Object.assign(state, newLoopState(), {
        reported: state.reported,
        workBranch: state.workBranch,
        transcriptsArchivedAt: state.transcriptsArchivedAt,
      });
    }
    state.fileIno = ino;
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    while (state.offset < size) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, state.offset);
      if (read <= 0) {
        break;
      }
      state.offset += read;
      const text = state.remainder + buffer.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      state.remainder = lines.pop() ?? "";
      for (const line of lines) {
        foldStreamLine(state.stream, line, at);
      }
    }
  } catch {
    // The loop has not written its stream yet, or it was cleaned up.
  } finally {
    if (handle !== null) {
      fs.closeSync(handle);
    }
  }
}

function sessionName(job: LocalJob): string {
  const subject = job.artifactSlug ?? job.ticketId ?? job.loopId.slice(0, 8);
  const repo = job.primaryRepoFullName ? ` · ${job.primaryRepoFullName}` : "";
  return `${job.command} ${subject}${repo}`;
}

/** The bundled plugins and their subagents, commands and skills. */
export function scanPluginComponents(pluginDirs: string[]): SyncedComponent[] {
  const components: SyncedComponent[] = [];
  for (const dir of pluginDirs) {
    const manifest = readJson(path.join(dir, PLUGIN_MANIFEST));
    const plugin =
      typeof manifest?.name === "string" ? manifest.name : path.basename(dir);
    const version =
      typeof manifest?.version === "string" ? manifest.version : null;
    const manifestText = JSON.stringify(manifest ?? {});
    components.push(
      component({
        kind: AgentComponentKind.Plugin,
        key: plugin,
        name: plugin,
        version,
        description:
          typeof manifest?.description === "string"
            ? manifest.description
            : null,
        installPath: dir,
        content: manifestText,
        scope: "user",
      }),
      ...definitionComponents(dir, {
        prefix: `${plugin}:`,
        version,
        scope: "user",
        packId: plugin,
      })
    );
  }
  return components;
}

/** Project-level definitions of a loop workspace (e.g. a mounted toolkit). */
export function scanWorkspaceComponents(workspace: string): SyncedComponent[] {
  return definitionComponents(path.join(workspace, ".claude"), {
    prefix: "",
    version: null,
    scope: "project",
    packId: null,
    projectPath: workspace,
  });
}

type DefinitionOptions = {
  prefix: string;
  version: string | null;
  scope: string;
  packId: string | null;
  projectPath?: string;
};

function definitionComponents(
  root: string,
  options: DefinitionOptions
): SyncedComponent[] {
  const found: SyncedComponent[] = [];
  for (const file of markdownFiles(path.join(root, "agents"))) {
    const content = readText(file);
    const name =
      frontmatterValue(content, FRONTMATTER_NAME_RE) ??
      path.basename(file, MARKDOWN_EXT);
    found.push(
      component({
        kind: AgentComponentKind.Subagent,
        key: `${options.prefix}${name}`,
        name,
        description: frontmatterValue(content, FRONTMATTER_DESCRIPTION_RE),
        installPath: file,
        content,
        ...options,
      })
    );
  }
  for (const file of markdownFiles(path.join(root, "commands"))) {
    const content = readText(file);
    const name = path.basename(file, MARKDOWN_EXT);
    found.push(
      component({
        kind: AgentComponentKind.Command,
        key: `/${options.prefix}${name}`,
        name: `/${options.prefix}${name}`,
        description: frontmatterValue(content, FRONTMATTER_DESCRIPTION_RE),
        installPath: file,
        content,
        ...options,
      })
    );
  }
  for (const dir of subdirectories(path.join(root, "skills"))) {
    const file = path.join(dir, SKILL_FILE);
    if (!fs.existsSync(file)) {
      continue;
    }
    const content = readText(file);
    const name =
      frontmatterValue(content, FRONTMATTER_NAME_RE) ?? path.basename(dir);
    found.push(
      component({
        kind: AgentComponentKind.Skill,
        key: `${options.prefix}${name}`,
        name,
        description: frontmatterValue(content, FRONTMATTER_DESCRIPTION_RE),
        installPath: file,
        content,
        ...options,
      })
    );
  }
  return found;
}

function component(input: {
  kind: string;
  key: string;
  name: string;
  version: string | null;
  description: string | null;
  installPath: string;
  content: string;
  scope: string;
  packId?: string | null;
  projectPath?: string;
}): SyncedComponent {
  const content = input.content.slice(0, COMPONENT_CONTENT_MAX_CHARS);
  const seenAt = new Date().toISOString();
  return {
    externalId: `${RUNNER_HARNESS}:${input.kind}:${input.key}`,
    componentKind: input.kind,
    harness: RUNNER_HARNESS,
    name: input.name,
    componentKey: input.key,
    version: input.version,
    description: input.description,
    installPath: input.installPath,
    packId: input.packId ?? null,
    scope: input.scope,
    projectPath: input.projectPath ?? null,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    resolvedState: "resolved",
    lastSeenAt: seenAt,
    scannedAt: seenAt,
  };
}

/** Batches that stay under the route's body cap and item limit. */
function chunkBySize(components: SyncedComponent[]): SyncedComponent[][] {
  const batches: SyncedComponent[][] = [];
  let batch: SyncedComponent[] = [];
  let bytes = 0;
  for (const entry of components) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (
      batch.length > 0 &&
      (bytes + size > REQUEST_BODY_BUDGET_BYTES ||
        batch.length >= COMPONENTS_PER_REQUEST_MAX)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function markdownFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXT))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function frontmatterValue(content: string, pattern: RegExp): string | null {
  const frontmatter = FRONTMATTER_RE.exec(content)?.[1];
  const value = frontmatter ? pattern.exec(frontmatter)?.[1]?.trim() : null;
  return value ? value.slice(0, 500) : null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return "";
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The loop's stream file. While the loop runs the harness appends to
 * `claude-output.jsonl`. Loops of one work directory share that name: when a
 * PLAN or EXECUTE loop ends, run-loop.sh renames its stream to
 * `claude-output-<run id>.jsonl` (the run id starts with the run's start time,
 * `YYYYMMDD-HHMMSS`, the runner's clock), and a STEP loop leaves it in place
 * for the next STEP loop to replace. So a finished loop follows the file it
 * was read from by inode (a rename keeps it, so the read offset carries
 * over); one never read (a runner restarted after it ended) takes the archive
 * that started closest to it, else a live file last written before it ended.
 */
export function resolveStreamFile(
  job: LocalJob,
  knownIno: number | null = null
): string | null {
  const live = job.jsonlPath;
  if (!live) {
    return null;
  }
  if (RUNNING_STATUSES.has(job.status)) {
    return fs.existsSync(live) ? live : null;
  }
  const dir = path.dirname(live);
  const archives = safeReaddir(dir).filter((name) =>
    ARCHIVED_STREAM_RE.test(name)
  );
  if (knownIno !== null) {
    return (
      [live, ...archives.map((name) => path.join(dir, name))].find(
        (file) => inoOf(file) === knownIno
      ) ?? null
    );
  }
  const archive = nearestArchive(job, dir, archives);
  if (archive) {
    return archive;
  }
  const liveWrittenAt = mtimeOf(live);
  const endedAt = Date.parse(job.completedAt ?? job.updatedAt);
  return liveWrittenAt !== null &&
    liveWrittenAt <= endedAt + LIVE_STREAM_SLACK_MS
    ? live
    : null;
}

/** The archive whose run started closest to the loop, within its run time. */
function nearestArchive(
  job: LocalJob,
  dir: string,
  archives: string[]
): string | null {
  const startedAt = Date.parse(job.startedAt);
  const endedAt = Date.parse(job.completedAt ?? job.updatedAt);
  let best: { file: string; distance: number } | null = null;
  for (const name of archives) {
    const match = ARCHIVED_STREAM_RE.exec(name);
    if (!match) {
      continue;
    }
    const runStartedAt = runIdTime(match[1] ?? "", match[2] ?? "");
    if (
      runStartedAt < startedAt - ARCHIVE_MATCH_SLACK_MS ||
      runStartedAt > endedAt + LIVE_STREAM_SLACK_MS
    ) {
      continue;
    }
    const distance = Math.abs(runStartedAt - startedAt);
    if (!best || distance < best.distance) {
      best = { file: path.join(dir, name), distance };
    }
  }
  return best?.file ?? null;
}

/** `YYYYMMDD`, `HHMMSS` of a run id as epoch ms (the runner runs in UTC). */
function runIdTime(date: string, time: string): number {
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
  );
}

function inoOf(file: string): number | null {
  try {
    return fs.statSync(file).ino;
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The branch checked out in a worktree, from its HEAD (a linked worktree's
 * `.git` is a file naming its git dir). Null when gone or detached.
 */
export function worktreeBranch(worktreeDir: string | undefined): string | null {
  if (!worktreeDir) {
    return null;
  }
  const dotGit = path.join(worktreeDir, ".git");
  let gitDir = dotGit;
  try {
    if (fs.statSync(dotGit).isFile()) {
      const pointer = GITDIR_POINTER_RE.exec(fs.readFileSync(dotGit, "utf8"));
      if (!pointer?.[1]) {
        return null;
      }
      gitDir = path.resolve(worktreeDir, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8");
    return HEAD_BRANCH_RE.exec(head)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
