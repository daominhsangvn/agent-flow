import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { PREVIOUS_WORK_DIR } from "../src/server/operations/loop-replan.js";
import {
  decodePlanStateBundle,
  encodePlanStateBundle,
  PLAN_STATE_FILE,
  PlanLoopOutcome,
  PlanNextStep,
  PlanPhase,
  type PlanStateManifest,
} from "../src/server/operations/plan-state-bundle.js";
import {
  isLocalHarnessSession,
  openPlanWorkDir,
  parentResumeArgs,
  savePlanState,
} from "../src/server/operations/plan-state-sync.js";

const API = "http://127.0.0.1:3002/api";
const STORAGE = "http://127.0.0.1:9100/loop-state";

type Call = { method: string; url: string; body?: unknown };
const RESTORED_RE = /restored the state of PLAN loop loop-plan/;
const CURRENT_RE = /already holds the state/;
const NONE_SAVED_RE = /none saved for this plan yet/;
const NOT_RESTORED_RE = /not restored/;

let root: string;
let workDir: string;
let calls: Call[];
let logs: string[];
let savedState: Buffer | null;
let stateUrl: string;
let uploads: Map<string, Buffer>;
const realFetch = globalThis.fetch;

function manifest(
  loopId: string,
  history: string[] = [loopId]
): PlanStateManifest {
  return {
    schemaVersion: 1,
    loopId,
    command: LoopCommand.Plan,
    outcome: PlanLoopOutcome.Succeeded,
    savedAt: "2026-10-11T08:00:00.000Z",
    baseCommit: null,
    phase: PlanPhase.Planned,
    nextStep: PlanNextStep.Execute,
    progress: {
      tasksTotal: 1,
      tasksDone: 0,
      openQuestions: 0,
      answeredQuestions: 0,
    },
    history: history.map((id) => ({
      loopId: id,
      command: LoopCommand.Plan,
      outcome: PlanLoopOutcome.Succeeded,
      savedAt: "2026-10-11T08:00:00.000Z",
      phase: PlanPhase.Planned,
    })),
    skipped: [],
  };
}

function saved(loopId: string, planJson: string): Buffer {
  const meta = manifest(loopId);
  return encodePlanStateBundle({
    manifest: meta,
    files: [
      { path: "plan.json", data: Buffer.from(planJson) },
      { path: "investigation-log.md", data: Buffer.from("explored") },
      { path: PLAN_STATE_FILE, data: Buffer.from(JSON.stringify(meta)) },
    ],
  });
}

const STATE_KEY = "org-1/loops/loop-next/run-1";

function loop(command: string, replan = false) {
  return {
    loopId: "loop-next",
    command,
    replan,
    agentFlowAuthToken: "jwt",
    s3StateKey: STATE_KEY,
  };
}

async function open(command: string, replan = false): Promise<string> {
  return await openPlanWorkDir(root, {
    loop: loop(command, replan),
    apiBaseUrl: API,
    log: (line) => logs.push(line),
  });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  const body =
    typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  calls.push({ method, url, body });
  if (url === `${API}/loops/loop-next/plan-state` && method === "GET") {
    return json({ state: savedState ? { url: stateUrl } : null });
  }
  if (url.endsWith("/plan-state") && method === "POST") {
    const latest = (body as { latest: boolean }).latest;
    return json({
      urls: [
        `${STORAGE}/loops/copy.json.gz`,
        ...(latest ? [`${STORAGE}/state.json.gz`] : []),
      ],
    });
  }
  if (url === stateUrl && savedState) {
    return new Response(new Uint8Array(savedState), { status: 200 });
  }
  if (url.startsWith(STORAGE) && method === "PUT") {
    uploads.set(url, Buffer.from(init?.body as Uint8Array));
    return new Response(null, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "plan-state-sync-"));
  workDir = path.join(root, ".agentflow-ai", "work");
  calls = [];
  logs = [];
  savedState = null;
  stateUrl = `${STORAGE}/state.json.gz?sig=1`;
  uploads = new Map();
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(fakeFetch(String(input), init))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

describe("restoring a plan's state", () => {
  test("a plain PLAN and a STEP start from their own work directory", async () => {
    assert.equal(await open(LoopCommand.Plan), workDir);
    await open(LoopCommand.Step);
    assert.ok(existsSync(workDir));
    assert.deepEqual(calls, []);
  });

  test("an EXECUTE gets the state another computer saved", async () => {
    savedState = saved("loop-plan", '{"content":"# Plan"}');
    await open(LoopCommand.Execute);
    assert.equal(
      readFileSync(path.join(workDir, "plan.json"), "utf8"),
      '{"content":"# Plan"}'
    );
    assert.equal(
      readFileSync(path.join(workDir, "investigation-log.md"), "utf8"),
      "explored"
    );
    assert.match(logs.join("\n"), RESTORED_RE);
    assert.equal(calls[0]?.url, `${API}/loops/loop-next/plan-state`);
  });

  test("a work directory that already holds the state is left alone", async () => {
    savedState = saved("loop-plan", '{"content":"# Plan"}');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, "plan.json"), "local progress");
    writeFileSync(
      path.join(workDir, PLAN_STATE_FILE),
      JSON.stringify(manifest("loop-exec", ["loop-plan", "loop-exec"]))
    );
    await open(LoopCommand.RequestChanges);
    assert.equal(
      readFileSync(path.join(workDir, "plan.json"), "utf8"),
      "local progress"
    );
    assert.match(logs.join("\n"), CURRENT_RE);
  });

  test("a re-plan gets the earlier plan as previous-work", async () => {
    savedState = saved("loop-plan", '{"content":"# Plan v1"}');
    await open(LoopCommand.Plan, true);
    const previous = path.join(root, ".agentflow-ai", PREVIOUS_WORK_DIR);
    assert.equal(
      readFileSync(path.join(previous, "plan.json"), "utf8"),
      '{"content":"# Plan v1"}'
    );
    assert.equal(existsSync(path.join(workDir, "plan.json")), false);
  });

  test("without a saved state the loop keeps its local work directory", async () => {
    await open(LoopCommand.Execute);
    assert.match(logs.join("\n"), NONE_SAVED_RE);
  });

  test("a storage URL on a host that is not allowed is refused", async () => {
    savedState = saved("loop-plan", "{}");
    stateUrl = "http://storage.example.com/state.json.gz";
    await open(LoopCommand.Execute);
    assert.equal(existsSync(path.join(workDir, "plan.json")), false);
    assert.match(logs.join("\n"), NOT_RESTORED_RE);
  });
});

describe("saving a plan's state", () => {
  function job(command: string, status: string) {
    return { loopId: "loop-next", command, status, s3StateKey: STATE_KEY };
  }

  beforeEach(() => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      path.join(workDir, "plan.json"),
      JSON.stringify({ pendingTasks: [], openQuestions: [{ id: "Q-001" }] })
    );
    writeFileSync(path.join(workDir, "symphony-loop.log"), "runner log");
  });

  test("a finished PLAN becomes the plan's latest state", async () => {
    await savePlanState(job(LoopCommand.Plan, "COMPLETED"), workDir, {
      apiBaseUrl: API,
      getToken: () => "jwt",
    });
    const post = calls.find((call) => call.method === "POST");
    assert.deepEqual(post?.body, { latest: true });
    assert.deepEqual([...uploads.keys()].sort(), [
      `${STORAGE}/loops/copy.json.gz`,
      `${STORAGE}/state.json.gz`,
    ]);
    const bundle = decodePlanStateBundle(
      uploads.get(`${STORAGE}/state.json.gz`) ?? Buffer.alloc(0)
    );
    assert.equal(bundle.manifest.loopId, "loop-next");
    assert.equal(bundle.manifest.phase, PlanPhase.AwaitingAnswers);
    assert.deepEqual(
      bundle.files.map((file) => file.path),
      ["plan.json", PLAN_STATE_FILE]
    );
    const local = JSON.parse(
      readFileSync(path.join(workDir, PLAN_STATE_FILE), "utf8")
    );
    assert.equal(local.nextStep, PlanNextStep.AnswerQuestions);
  });

  test("a failed PLAN saves only its own copy", async () => {
    await savePlanState(job(LoopCommand.Plan, "FAILED"), workDir, {
      apiBaseUrl: API,
      getToken: () => "jwt",
    });
    assert.deepEqual(calls.find((call) => call.method === "POST")?.body, {
      latest: false,
    });
    assert.deepEqual([...uploads.keys()], [`${STORAGE}/loops/copy.json.gz`]);
  });

  test("a failed EXECUTE keeps its unpushed progress off the latest state", async () => {
    await savePlanState(job(LoopCommand.Execute, "FAILED"), workDir, {
      apiBaseUrl: API,
      getToken: () => "jwt",
    });
    assert.deepEqual(calls.find((call) => call.method === "POST")?.body, {
      latest: false,
    });
    const local = JSON.parse(
      readFileSync(path.join(workDir, PLAN_STATE_FILE), "utf8")
    );
    assert.equal(local.outcome, PlanLoopOutcome.Failed);
  });

  test("a loop the cloud keeps no state for saves nothing", async () => {
    await savePlanState(
      { loopId: "loop-next", command: LoopCommand.Plan, status: "COMPLETED" },
      workDir,
      { apiBaseUrl: API, getToken: () => "jwt" }
    );
    savedState = saved("loop-plan", "{}");
    await openPlanWorkDir(root, {
      loop: { ...loop(LoopCommand.Execute), s3StateKey: undefined },
      apiBaseUrl: API,
      log: (line) => logs.push(line),
    });
    assert.deepEqual(calls, []);
  });

  test("other loops save nothing, and a failure never throws", async () => {
    await savePlanState(job(LoopCommand.Step, "COMPLETED"), workDir, {
      apiBaseUrl: API,
      getToken: () => "jwt",
    });
    assert.deepEqual(calls, []);
    await savePlanState(job(LoopCommand.Plan, "COMPLETED"), workDir, {
      apiBaseUrl: API,
      getToken: () => null,
    });
    assert.equal(uploads.size, 0);
  });
});

describe("resuming the parent session", () => {
  test("only a session on this computer is resumed", () => {
    const configDir = path.join(root, "claude");
    mkdirSync(path.join(configDir, "projects", "-workspace-loops-pln-1"), {
      recursive: true,
    });
    writeFileSync(
      path.join(
        configDir,
        "projects",
        "-workspace-loops-pln-1",
        "sess-1.jsonl"
      ),
      "{}"
    );
    const env = { CLAUDE_CONFIG_DIR: configDir };
    assert.equal(isLocalHarnessSession("sess-1", env), true);
    assert.equal(isLocalHarnessSession("sess-2", env), false);
    assert.equal(isLocalHarnessSession("../sess-1", env), false);
    assert.equal(
      isLocalHarnessSession("sess-1", { CLAUDE_CONFIG_DIR: root }),
      false
    );

    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      assert.deepEqual(parentResumeArgs("sess-1"), ["--resume", "sess-1"]);
      assert.deepEqual(parentResumeArgs("sess-2"), []);
      assert.deepEqual(parentResumeArgs(undefined), []);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });
});
