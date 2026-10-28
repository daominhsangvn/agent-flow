import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  type LoopStepConfig,
  LoopStepFinish,
} from "@agentflow-ai/loops-api/loop-step";
import { acquireInstanceLock } from "../src/headless/headless-instance-lock.js";
import type { SupportedRuntimeSelection } from "../src/server/operations/harness-pipeline.js";
import {
  buildStepLaunch,
  matchStepFiles,
} from "../src/server/operations/loop-step.js";
import {
  collectPersonalStepFiles,
  configurePersonalRunnerProject,
  isPersonalProjectDir,
  type PersonalRunnerProject,
  personalLoopRejection,
  personalRunWorkDir,
  personalStepInstructions,
  preparePersonalRunWorkDir,
} from "../src/server/operations/personal-runner.js";
import { resolveInstructionWorkspace } from "../src/server/operations/workflow-instruction.js";

const root = mkdtempSync(path.join(os.tmpdir(), "personal-runner-"));
after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => configurePersonalRunnerProject(null));
const OTHER_PROJECT_RE = /runs only project PRO-1.*PRO-2/;
const NO_PROJECT_RE = /no project/;
const NOT_A_STEP_RE = /process steps only, not PLAN/;
const FINISH_PUSH_RE = /finish: push/;
const ONE_AT_A_TIME_RE = /one loop at a time/;
const EXCLUDE_LINE_RE = /^\.agentflow-ai\/$/m;
const QUESTIONS_FILE_RE = /questions\.json/;
const AGENTFLOW_WORKDIR_RE = /\$AGENTFLOW_WORKDIR/;
const BYPASS_RE = /bypassPermissions/;
const NO_TERMINAL_RE = /do not ask in the terminal/;
const SYSTEM_PROMPT_RE = /--append-system-prompt/;
const MCP_CONFIG_RE = /--mcp-config/;
const HOLDER_RE = /process 101/;

function project(
  overrides: Partial<PersonalRunnerProject> = {}
): PersonalRunnerProject {
  return {
    projectKey: "PRO-1",
    projectDir: path.join(root, "brenock"),
    parallel: false,
    skipPermissions: false,
    ...overrides,
  };
}

function step(overrides: Partial<LoopStepConfig> = {}): LoopStepConfig {
  return {
    runId: "run-1",
    stepId: "clarify",
    name: "Clarify",
    fresh: true,
    askQuestions: true,
    artifacts: [],
    finish: LoopStepFinish.None,
    toolkit: null,
    ...overrides,
  };
}

function runtime(harness: string): SupportedRuntimeSelection {
  return {
    ok: true,
    harness: { adapter: { harness } },
  } as unknown as SupportedRuntimeSelection;
}

describe("personalLoopRejection", () => {
  test("runs a step of its own project, whatever the key's case", () => {
    const body = {
      command: LoopCommand.Step,
      projectKey: "pro-1",
      step: step(),
    };
    assert.equal(personalLoopRejection(body, project(), false), null);
  });

  test("refuses another project's loop and a loop without a project", () => {
    const other = personalLoopRejection(
      { command: LoopCommand.Step, projectKey: "PRO-2", step: step() },
      project(),
      false
    );
    assert.match(other ?? "", OTHER_PROJECT_RE);
    const none = personalLoopRejection(
      { command: LoopCommand.Step, step: step() },
      project(),
      false
    );
    assert.match(none ?? "", NO_PROJECT_RE);
  });

  test("refuses loops that are not process steps", () => {
    const reason = personalLoopRejection(
      { command: LoopCommand.Plan, projectKey: "PRO-1" },
      project(),
      false
    );
    assert.match(reason ?? "", NOT_A_STEP_RE);
  });

  test("refuses a step AgentFlow would commit and push", () => {
    const reason = personalLoopRejection(
      {
        command: LoopCommand.Step,
        projectKey: "PRO-1",
        step: step({ finish: LoopStepFinish.Push }),
      },
      project(),
      false
    );
    assert.match(reason ?? "", FINISH_PUSH_RE);
  });

  test("runs one loop at a time unless the project's commands run in parallel", () => {
    const body = {
      command: LoopCommand.Step,
      projectKey: "PRO-1",
      step: step(),
    };
    assert.match(
      personalLoopRejection(body, project(), true) ?? "",
      ONE_AT_A_TIME_RE
    );
    assert.equal(
      personalLoopRejection(body, project({ parallel: true }), true),
      null
    );
  });
});

describe("the project folder", () => {
  test("is never treated as a removable worktree", () => {
    configurePersonalRunnerProject(project());
    assert.equal(isPersonalProjectDir(path.join(root, "brenock")), true);
    assert.equal(
      isPersonalProjectDir(path.join(root, "brenock", "app")),
      false
    );
    configurePersonalRunnerProject(null);
    assert.equal(isPersonalProjectDir(path.join(root, "brenock")), false);
  });

  test("each run has its own work directory; a run's first step empties only its own", async () => {
    const dir = path.join(root, "runs");
    const first = await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "run-a",
      fresh: true,
    });
    const second = await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "run-b",
      fresh: true,
    });
    writeFileSync(path.join(first, "questions.json"), "[]");
    writeFileSync(path.join(second, "issue.md"), "# B");
    writeFileSync(path.join(dir, "spec.md"), "mine");

    assert.equal(first, personalRunWorkDir(dir, "run-a"));
    assert.notEqual(first, second);
    await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "run-a",
      fresh: true,
    });

    assert.equal(existsSync(path.join(first, "questions.json")), false);
    assert.equal(existsSync(path.join(second, "issue.md")), true);
    assert.equal(readFileSync(path.join(dir, "spec.md"), "utf8"), "mine");
  });

  test("a later step of the run keeps its work directory", async () => {
    const dir = path.join(root, "later");
    const workDir = await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "run-1",
      fresh: true,
    });
    writeFileSync(path.join(workDir, "issue.md"), "# Issue");

    await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "run-1",
      fresh: false,
    });

    assert.equal(existsSync(path.join(workDir, "issue.md")), true);
  });

  test("a run's first step removes work directories unused for 30 days", async () => {
    const dir = path.join(root, "stale");
    const old = await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "old-run",
      fresh: true,
    });
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(old, longAgo, longAgo);

    await preparePersonalRunWorkDir({
      projectDir: dir,
      runId: "new-run",
      fresh: true,
    });

    assert.equal(existsSync(old), false);
  });

  test("a git repository excludes .agentflow-ai/; any other folder gets no .git", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    await preparePersonalRunWorkDir({
      projectDir: repo,
      runId: "r",
      fresh: true,
    });
    assert.match(
      readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"),
      EXCLUDE_LINE_RE
    );

    const plain = path.join(root, "plain");
    mkdirSync(plain, { recursive: true });
    await preparePersonalRunWorkDir({
      projectDir: plain,
      runId: "r",
      fresh: true,
    });
    assert.equal(existsSync(path.join(plain, ".git")), false);
  });

  test("workflow instructions run in the project folder", () => {
    configurePersonalRunnerProject(project());
    const workspace = resolveInstructionWorkspace(
      {
        workspaceKey: "ISS-1",
        repository: {
          fullName: "acme/shop",
          cloneUrl: "https://github.com/acme/shop.git",
        },
      } as Parameters<typeof resolveInstructionWorkspace>[0],
      [path.join(root, "elsewhere")]
    );
    assert.equal(workspace, path.join(root, "brenock"));
  });
});

describe("a personal step's agent", () => {
  test("is told to write questions to questions.json instead of the terminal", () => {
    const workDir = path.join(
      root,
      "brenock",
      ".agentflow-ai",
      "runs",
      "run-1"
    );
    const text = personalStepInstructions(step(), workDir);
    assert.ok(text.includes(path.join(workDir, "questions.json")));
    assert.match(text, AGENTFLOW_WORKDIR_RE);
    assert.match(text, NO_TERMINAL_RE);
    assert.doesNotMatch(
      personalStepInstructions(step({ askQuestions: false }), workDir),
      QUESTIONS_FILE_RE
    );
  });

  test("gets its instructions in the system prompt and no AgentFlow integration tools", async () => {
    const workDir = path.join(root, "launch", ".agentflow-ai", "work");
    mkdirSync(workDir, { recursive: true });
    let sessionsOpened = 0;
    const launch = await buildStepLaunch({
      body: {
        command: LoopCommand.Step,
        prompt: "/speckit.clarify-all BREP-12",
        step: step({ integrationTools: true }),
      },
      runtime: runtime(LoopHarness.Claude),
      baseClaudeArgs: ["-p", "--allowedTools", "Bash"],
      stdinClaudeArgs: ["-p", "-", "--allowedTools", "Bash"],
      claudeWorkDir: workDir,
      harnessBin: "claude",
      apiBaseUrl: "http://api.test",
      openSession: () => {
        sessionsOpened++;
        return Promise.reject(new Error("not expected"));
      },
      personal: project(),
    });

    const command = launch.args.at(-1) ?? "";
    assert.equal(sessionsOpened, 0);
    assert.deepEqual(launch.env, {});
    assert.match(command, SYSTEM_PROMPT_RE);
    assert.doesNotMatch(command, MCP_CONFIG_RE);
    assert.doesNotMatch(command, BYPASS_RE);
  });

  test("skips permission prompts only when the person chose so", async () => {
    const workDir = path.join(root, "launch-bypass", ".agentflow-ai", "work");
    mkdirSync(workDir, { recursive: true });
    const launch = await buildStepLaunch({
      body: { command: LoopCommand.Step, prompt: "/brep.ship", step: step() },
      runtime: runtime(LoopHarness.Claude),
      baseClaudeArgs: ["-p"],
      stdinClaudeArgs: ["-p", "-"],
      claudeWorkDir: workDir,
      harnessBin: "claude",
      apiBaseUrl: "http://api.test",
      personal: project({ skipPermissions: true }),
    });

    assert.match(launch.args.at(-1) ?? "", BYPASS_RE);
  });
});

describe("acquireInstanceLock", () => {
  test("one runner per data directory; a lock of a stopped process is taken over", () => {
    const dataDir = path.join(root, "data");
    const first = acquireInstanceLock(dataDir, 101, () => true);
    assert.equal(first.ok, true);

    const second = acquireInstanceLock(dataDir, 202, (pid) => pid === 101);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.match(second.error, HOLDER_RE);
    }

    const afterCrash = acquireInstanceLock(dataDir, 303, () => false);
    assert.equal(afterCrash.ok, true);
    if (afterCrash.ok) {
      afterCrash.lock.release();
    }
    assert.equal(existsSync(path.join(dataDir, "runner.lock")), false);
  });

  test("personal runners of two projects never share a lock", () => {
    const one = acquireInstanceLock(path.join(root, "personal", "PRO-1"), 1);
    const two = acquireInstanceLock(path.join(root, "personal", "PRO-2"), 2);
    assert.equal(one.ok && two.ok, true);
  });
});

describe("collectPersonalStepFiles", () => {
  test("reads work-directory globs from the run's work dir and keeps extra fields", () => {
    const projectDir = path.join(root, "collect", "project");
    const workDir = path.join(root, "collect", "work");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, "PRD-X.md"), "prd");
    writeFileSync(path.join(projectDir, "other.md"), "other");

    const files = collectPersonalStepFiles({
      projectDir,
      claudeWorkDir: workDir,
      globs: [".agentflow-ai/work/PRD-*.md", "*.md"],
      collect: (dir, globs) =>
        matchStepFiles(dir, globs).map((p) => ({
          path: p,
          file: path.join(dir, p),
        })),
    });

    assert.deepEqual(files, [
      {
        path: ".agentflow-ai/work/PRD-X.md",
        file: path.join(workDir, "PRD-X.md"),
      },
      { path: "other.md", file: path.join(projectDir, "other.md") },
    ]);
  });
});
