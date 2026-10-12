import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createHeadlessSafeStorage } from "../src/headless/headless-safe-storage.js";
import {
  evaluateRunnerHealth,
  readRunnerStatus,
  STATUS_STALE_AFTER_MS,
  writeRunnerStatus,
} from "../src/headless/headless-status.js";
import { ensureRunnerWorktreeSettings } from "../src/headless/headless-workspace.js";
import Store from "../src/headless/shims/electron-store.js";
import {
  loadReposConfig,
  updateSettings,
} from "../src/server/operations/repos-config-utils.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";

const POSIX_ONLY = process.platform === "win32";
const PRIVATE_FILE_MODE = 0o600;
const UNAUTHORIZED_RE = /Unauthorized/;
const WORKSPACE_DIR = "/workspace";
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-runner-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type JobsSchema = { activeJobs: string[]; terminalJobs: string[] };

test("electron-store shim persists values across instances with defaults", () => {
  const first = new Store<JobsSchema>({
    name: "jobs",
    cwd: dataDir,
    defaults: { activeJobs: [], terminalJobs: [] },
  });
  assert.deepEqual(first.get("activeJobs", []), []);
  first.set("activeJobs", ["job-1"]);

  const second = new Store<JobsSchema>({ name: "jobs", cwd: dataDir });
  assert.deepEqual(second.get("activeJobs"), ["job-1"]);
  // Defaults are written with the first change, as electron-store does.
  assert.deepEqual(second.get("terminalJobs"), []);

  second.delete("activeJobs");
  assert.equal(
    new Store<JobsSchema>({ name: "jobs", cwd: dataDir }).has("activeJobs"),
    false
  );
});

test("electron-store shim writes private files", { skip: POSIX_ONLY }, () => {
  const store = new Store<JobsSchema>({ name: "jobs", cwd: dataDir });
  store.set("activeJobs", []);
  assert.equal(fs.statSync(store.path).mode % 0o1000, PRIVATE_FILE_MODE);
});

test("electron-store shim keeps a corrupt file aside and starts empty", () => {
  fs.writeFileSync(path.join(dataDir, "jobs.json"), "{ not json");
  const store = new Store<JobsSchema>({
    name: "jobs",
    cwd: dataDir,
    defaults: { activeJobs: [] },
  });
  assert.deepEqual(store.get("activeJobs"), []);
  assert.ok(
    fs
      .readdirSync(dataDir)
      .some((name) => name.startsWith("jobs.json.corrupt-"))
  );
});

test("headless safe storage round-trips and reuses its key", () => {
  const sealed =
    createHeadlessSafeStorage(dataDir).encryptString("runner-token");
  assert.equal(sealed.includes(Buffer.from("runner-token")), false);
  assert.equal(
    createHeadlessSafeStorage(dataDir).decryptString(sealed),
    "runner-token"
  );
});

test("headless safe storage rejects tampered values", () => {
  const storage = createHeadlessSafeStorage(dataDir);
  const sealed = storage.encryptString("runner-token");
  const last = sealed.length - 1;
  sealed[last] = 255 - sealed[last];
  assert.throws(() => storage.decryptString(sealed));
});

test("runner status round-trips and drives the healthcheck", () => {
  const now = new Date("2026-10-05T10:00:00.000Z");
  assert.deepEqual(
    evaluateRunnerHealth(readRunnerStatus(dataDir), now).healthy,
    false
  );

  writeRunnerStatus(dataDir, {
    state: CloudSocketState.Online,
    computeTargetId: "target-1",
    error: null,
    activeCommands: 1,
    queueDepth: 0,
    updatedAt: now.toISOString(),
  });
  const status = readRunnerStatus(dataDir);
  assert.equal(evaluateRunnerHealth(status, now).healthy, true);

  const later = new Date(now.getTime() + STATUS_STALE_AFTER_MS + 1);
  assert.equal(evaluateRunnerHealth(status, later).healthy, false);
});

test("a degraded runner is unhealthy and says why", () => {
  const now = new Date();
  const verdict = evaluateRunnerHealth(
    {
      state: CloudSocketState.Degraded,
      computeTargetId: null,
      error: "Unauthorized",
      activeCommands: 0,
      queueDepth: 0,
      updatedAt: now.toISOString(),
    },
    now
  );
  assert.equal(verdict.healthy, false);
  assert.match(verdict.reason, UNAUTHORIZED_RE);
});

test("the workspace becomes the confirmed worktree parent once", async () => {
  const configDir = path.join(dataDir, ".agentflow-ai");
  await ensureRunnerWorktreeSettings(configDir, WORKSPACE_DIR);
  const first = await loadReposConfig(configDir);
  assert.deepEqual(first.settings, {
    worktreeParentDir: WORKSPACE_DIR,
    worktreeParentDirConfirmed: true,
  });

  await updateSettings({ worktreeParentDir: "/custom" }, configDir);
  await ensureRunnerWorktreeSettings(configDir, WORKSPACE_DIR);
  const kept = await loadReposConfig(configDir);
  assert.equal(kept.settings.worktreeParentDir, "/custom");
});
