import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  LoopArtifactFile,
  LoopArtifactType,
} from "@agentflow-ai/loops-api/artifacts";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  LOOP_STEP_ARTIFACT_KEY,
  LOOP_STEP_FILE_BYTES_MAX,
  type LoopStepConfig,
  LoopStepFile,
  LoopStepFinish,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import type { SupportedRuntimeSelection } from "../src/server/operations/harness-pipeline.js";
import {
  buildStepLaunch,
  buildStepWorkspaceInstructions,
  collectStepFiles,
  globToRegExp,
  isFreshLoopRequest,
  isPushingStep,
  prepareLoopStep,
  readStepOutputs,
} from "../src/server/operations/loop-step.js";

const TOOLKIT_MISSING_RE = /acme\/speckit is not in the loop workspace/;
const SLASH_LAUNCH_RE =
  /'--resume' 'session-b' '\/speckit-specify CSV export' 2>/;

let root: string;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-step-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function step(overrides: Partial<LoopStepConfig> = {}): LoopStepConfig {
  return {
    runId: "run-1",
    stepId: "specify",
    name: "Specify",
    fresh: true,
    askQuestions: true,
    artifacts: ["specs/*/spec.md"],
    finish: LoopStepFinish.None,
    toolkit: null,
    ...overrides,
  };
}

/** A workspace: <root>/<name> with a work directory and two repositories. */
function workspace(name: string) {
  const rootDir = path.join(root, name);
  const workDir = path.join(rootDir, ".agentflow-ai", "work");
  const shop = path.join(rootDir, "shop");
  const kit = path.join(rootDir, "speckit");
  for (const dir of [workDir, shop, kit]) {
    mkdirSync(dir, { recursive: true });
  }
  return { rootDir, workDir, shop, kit };
}

function runtime(harness: string): SupportedRuntimeSelection {
  return {
    ok: true,
    harness: { adapter: { harness } },
  } as unknown as SupportedRuntimeSelection;
}

describe("loop step requests", () => {
  test("only PLAN and a run's first step start fresh", () => {
    assert.equal(isFreshLoopRequest({ command: LoopCommand.Plan }), true);
    assert.equal(isFreshLoopRequest({ command: LoopCommand.Execute }), false);
    assert.equal(
      isFreshLoopRequest({ command: LoopCommand.Step, step: step() }),
      true
    );
    assert.equal(
      isFreshLoopRequest({
        command: LoopCommand.Step,
        step: step({ fresh: false }),
      }),
      false
    );
  });

  test("only a step that finishes with push is pushed like EXECUTE", () => {
    assert.equal(
      isPushingStep({
        command: LoopCommand.Step,
        step: step({ finish: LoopStepFinish.Push }),
      }),
      true
    );
    assert.equal(
      isPushingStep({ command: LoopCommand.Step, step: step() }),
      false
    );
    assert.equal(isPushingStep({ command: LoopCommand.Execute }), false);
  });
});

describe("prepareLoopStep", () => {
  test("clears the previous step's outputs and writes the step and the Issue", async () => {
    const ws = workspace("prepare");
    for (const file of [
      LoopStepFile.Questions,
      LoopArtifactFile.ExecutionResult,
      "claude-output.jsonl",
      "session-id.txt",
    ]) {
      writeFileSync(path.join(ws.workDir, file), "old");
    }
    // A file an earlier step produced stays.
    writeFileSync(path.join(ws.workDir, "notes.md"), "keep");

    await prepareLoopStep({
      step: step(),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [
        {
          type: LoopArtifactType.ImplementationPlan,
          title: "Plan",
          content: "plan",
        },
        {
          type: LoopArtifactType.Feature,
          title: "PROJ-7: CSV export",
          content: "Export the orders as CSV.",
        },
      ],
      repos: [],
      log: () => undefined,
    });

    for (const file of [
      LoopStepFile.Questions,
      LoopArtifactFile.ExecutionResult,
      "claude-output.jsonl",
      "session-id.txt",
    ]) {
      assert.equal(existsSync(path.join(ws.workDir, file)), false, file);
    }
    assert.equal(
      readFileSync(path.join(ws.workDir, "notes.md"), "utf8"),
      "keep"
    );
    assert.equal(
      readFileSync(path.join(ws.workDir, LoopStepFile.Issue), "utf8"),
      "# PROJ-7: CSV export\n\nExport the orders as CSV.\n"
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(ws.workDir, LoopStepFile.Request), "utf8")
      ),
      step()
    );
  });

  test("links the toolkit's directories into the workspace root, keeping the workspace's own entries", async () => {
    const ws = workspace("toolkit");
    mkdirSync(path.join(ws.kit, ".claude", "skills", "speckit-specify"), {
      recursive: true,
    });
    writeFileSync(
      path.join(ws.kit, ".claude", "skills", "speckit-specify", "SKILL.md"),
      "skill"
    );
    mkdirSync(path.join(ws.kit, ".specify", "scripts"), { recursive: true });
    // The workspace already has its own .claude/skills (project agents).
    mkdirSync(path.join(ws.rootDir, ".claude", "skills", "own"), {
      recursive: true,
    });
    const logs: string[] = [];

    await prepareLoopStep({
      step: step({
        toolkit: {
          repository: "Acme/SpecKit",
          mounts: [".claude/skills", ".specify", ".claude/commands"],
          instructions: "",
        },
      }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [
        { fullName: "acme/shop", dir: ws.shop },
        { fullName: "acme/speckit", dir: ws.kit },
      ],
      log: (message) => logs.push(message),
    });

    assert.ok(lstatSync(path.join(ws.rootDir, ".specify")).isSymbolicLink());
    assert.ok(existsSync(path.join(ws.rootDir, ".specify", "scripts")));
    assert.ok(
      lstatSync(path.join(ws.rootDir, ".claude", "skills")).isDirectory()
    );
    assert.ok(existsSync(path.join(ws.rootDir, ".claude", "skills", "own")));
    assert.equal(
      readFileSync(
        path.join(
          ws.rootDir,
          ".claude",
          "skills",
          "speckit-specify",
          "SKILL.md"
        ),
        "utf8"
      ),
      "skill"
    );
    assert.deepEqual(logs, [
      "Toolkit path .claude/commands was not found in Acme/SpecKit; skipped",
    ]);
  });

  test("fails when the toolkit repository is not in the workspace", async () => {
    const ws = workspace("toolkit-missing");
    await assert.rejects(
      prepareLoopStep({
        step: step({
          toolkit: {
            repository: "acme/speckit",
            mounts: [".specify"],
            instructions: "",
          },
        }),
        workspaceRoot: ws.rootDir,
        claudeWorkDir: ws.workDir,
        artifacts: [],
        repos: [{ fullName: "acme/shop", dir: ws.shop }],
        log: () => undefined,
      }),
      TOOLKIT_MISSING_RE
    );
  });
});

describe("readStepOutputs", () => {
  test("reads the questions, the matching files and records the session id", async () => {
    const ws = workspace("outputs");
    await prepareLoopStep({
      step: step({ artifacts: ["specs/*/spec.md", "**/tasks.md"] }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    });
    mkdirSync(path.join(ws.rootDir, "specs", "001-csv"), { recursive: true });
    writeFileSync(path.join(ws.rootDir, "specs", "001-csv", "spec.md"), "spec");
    writeFileSync(path.join(ws.rootDir, "specs", "001-csv", "tasks.md"), "t");
    writeFileSync(path.join(ws.rootDir, "specs", "001-csv", "plan.md"), "p");
    mkdirSync(path.join(ws.shop, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(ws.shop, "node_modules", "x", "tasks.md"), "no");
    writeFileSync(
      path.join(ws.workDir, LoopStepFile.Questions),
      JSON.stringify({
        questions: [
          { id: "q1", question: "Which delimiter?", options: [",", ";"] },
        ],
      })
    );
    writeFileSync(
      path.join(ws.workDir, "claude-output.jsonl"),
      [
        JSON.stringify({ type: "system", session_id: "session-a" }),
        JSON.stringify({ type: "result", session_id: "session-b" }),
        "not json",
      ].join("\n")
    );

    const outputs = readStepOutputs(ws.workDir);
    const result = outputs[LOOP_STEP_ARTIFACT_KEY] as LoopStepResult;

    assert.equal(result.stepId, "specify");
    assert.deepEqual(result.questions, [
      { id: "q1", question: "Which delimiter?", options: [",", ";"] },
    ]);
    assert.equal(result.questionsError, null);
    assert.deepEqual(
      result.files.map((file) => [file.path, file.content]),
      [
        ["specs/001-csv/spec.md", "spec"],
        ["specs/001-csv/tasks.md", "t"],
      ]
    );
    assert.equal(outputs.executionResult, undefined);
    assert.equal(
      readFileSync(path.join(ws.workDir, "session-id.txt"), "utf8"),
      "session-b\n"
    );
  });

  test("reports questions that are not valid instead of dropping them silently", async () => {
    const ws = workspace("bad-questions");
    await prepareLoopStep({
      step: step({ artifacts: [] }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    });
    writeFileSync(path.join(ws.workDir, LoopStepFile.Questions), "{oops");

    const result = readStepOutputs(ws.workDir)[
      LOOP_STEP_ARTIFACT_KEY
    ] as LoopStepResult;

    assert.deepEqual(result.questions, []);
    assert.ok(result.questionsError?.startsWith("not JSON"));
  });

  test("adds the execution result of a step that pushed", async () => {
    const ws = workspace("pushed");
    await prepareLoopStep({
      step: step({ finish: LoopStepFinish.Push, artifacts: [] }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    });
    writeFileSync(
      path.join(ws.workDir, LoopArtifactFile.ExecutionResult),
      JSON.stringify({ schemaVersion: 2, results: [] })
    );

    assert.deepEqual(readStepOutputs(ws.workDir).executionResult, {
      schemaVersion: 2,
      results: [],
    });
  });

  test("reads nothing for a work directory without a step", () => {
    const ws = workspace("no-step");
    assert.deepEqual(readStepOutputs(ws.workDir), {});
  });
});

describe("step artifacts", () => {
  test("globs match within and across directories", () => {
    assert.ok(globToRegExp("specs/*/spec.md").test("specs/001/spec.md"));
    assert.ok(!globToRegExp("specs/*/spec.md").test("specs/a/b/spec.md"));
    assert.ok(globToRegExp("**/tasks.md").test("tasks.md"));
    assert.ok(globToRegExp("**/tasks.md").test("a/b/tasks.md"));
    assert.ok(globToRegExp("docs/v?.md").test("docs/v1.md"));
    assert.ok(!globToRegExp("docs/v?.md").test("docs/v12.md"));
    assert.ok(!globToRegExp("a.md").test("a-md"));
  });

  test("cuts a file that is too large", () => {
    const dir = path.join(root, "large");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "big.md"),
      "x".repeat(LOOP_STEP_FILE_BYTES_MAX + 10)
    );

    const [file] = collectStepFiles(dir, ["big.md"]);

    assert.equal(file?.truncated, true);
    assert.equal(file?.content.length, LOOP_STEP_FILE_BYTES_MAX);
  });
});

describe("buildStepWorkspaceInstructions", () => {
  test("tells the agent how to ask, whether to commit, and the toolkit's notes", () => {
    const text =
      buildStepWorkspaceInstructions(
        step({
          toolkit: {
            repository: "acme/speckit",
            mounts: [".specify"],
            instructions: "Run scripts from .specify/scripts.",
          },
        })
      ) ?? "";

    assert.ok(text.includes("## Process step: Specify"));
    assert.ok(text.includes(".agentflow-ai/work/questions.json"));
    assert.ok(
      text.includes(
        "at most 10 options per question, each at most 500 characters"
      )
    );
    assert.ok(text.includes("Do not commit or push"));
    assert.ok(
      text.includes("### Toolkit\n\nRun scripts from .specify/scripts.")
    );
    assert.equal(buildStepWorkspaceInstructions(undefined), undefined);
  });

  test("a step that does not ask is told to decide, a pushing step to leave its changes", () => {
    const text =
      buildStepWorkspaceInstructions(
        step({ askQuestions: false, finish: LoopStepFinish.Push })
      ) ?? "";

    assert.ok(!text.includes("questions.json"));
    assert.ok(text.includes("Do not stop to ask questions"));
    assert.ok(text.includes("committed and pushed when you finish"));
    assert.ok(text.includes("Do not push, open pull requests"));
  });
});

describe("buildStepLaunch", () => {
  test("passes a slash command as the prompt argument, resuming the session", async () => {
    const ws = workspace("launch-slash");
    const launch = await buildStepLaunch({
      body: {
        command: LoopCommand.Step,
        prompt: "/speckit-specify CSV export",
        parentSessionId: "session-b",
      },
      runtime: runtime(LoopHarness.Claude),
      baseClaudeArgs: ["-p", "--verbose"],
      stdinClaudeArgs: ["-p", "-", "--verbose"],
      claudeWorkDir: ws.workDir,
      harnessBin: "claude",
    });

    const command = launch.args.at(-1) ?? "";
    assert.match(command, SLASH_LAUNCH_RE);
    assert.ok(!command.includes(" < "));
  });

  test("pipes any other instruction through stdin", async () => {
    const ws = workspace("launch-stdin");
    const launch = await buildStepLaunch({
      body: { command: LoopCommand.Step, prompt: "Review the spec." },
      runtime: runtime(LoopHarness.Claude),
      baseClaudeArgs: ["-p", "--verbose"],
      stdinClaudeArgs: ["-p", "-", "--verbose"],
      claudeWorkDir: ws.workDir,
      harnessBin: "claude",
    });

    assert.ok((launch.args.at(-1) ?? "").includes("step-prompt.txt"));
    assert.equal(
      readFileSync(path.join(ws.workDir, "step-prompt.txt"), "utf8"),
      "Review the spec."
    );
  });
});
