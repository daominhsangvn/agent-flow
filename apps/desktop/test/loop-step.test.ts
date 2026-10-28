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
  LOOP_STEP_ATTACH_FILE_BYTES_MAX,
  LOOP_STEP_ATTACH_FILES_MAX,
  LOOP_STEP_FILE_BYTES_MAX,
  type LoopStepConfig,
  LoopStepFile,
  LoopStepFinish,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import {
  CLAUDE_OUTPUT_SIDECAR_FILE,
  resolveClaudeOutputPath,
} from "../src/main/cost/token-usage.js";
import type { SupportedRuntimeSelection } from "../src/server/operations/harness-pipeline.js";
import {
  buildStepAttachments,
  buildStepLaunch,
  buildStepWorkspaceInstructions,
  collectStepFiles,
  globToRegExp,
  isFreshLoopRequest,
  isPushingStep,
  prepareLoopStep,
  readStepOutputs,
} from "../src/server/operations/loop-step.js";

const LARGER_THAN_4MB_RE = /larger than 4 MB/;
const TOOLKIT_MISSING_RE = /acme\/speckit is not in the loop workspace/;
const SLASH_LAUNCH_RE =
  /'--resume' 'session-b' '--' '\/speckit-specify CSV export' 2>/;

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
  test("removes files left by an earlier task that match the step's attach globs", async () => {
    const ws = workspace("prepare-attach");
    const work = path.join(ws.rootDir, ".agentflow-ai", "work");
    mkdirSync(path.join(work, "evidence-LD-5"), { recursive: true });
    writeFileSync(path.join(work, "RESULTS-LD-5.md"), "old");
    writeFileSync(path.join(work, "evidence-LD-5", "a.png"), "old");
    writeFileSync(path.join(work, "notes.md"), "keep");

    await prepareLoopStep({
      step: step({
        attach: [
          ".agentflow-ai/work/RESULTS-*.md",
          ".agentflow-ai/work/evidence-*/*.png",
        ],
      }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    });

    assert.equal(existsSync(path.join(work, "RESULTS-LD-5.md")), false);
    assert.equal(existsSync(path.join(work, "evidence-LD-5", "a.png")), false);
    assert.equal(existsSync(path.join(work, "notes.md")), true);
  });

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

  test("starts the step's own output, so it is never read from an earlier loop's archived stream", async () => {
    const ws = workspace("output");
    // EXECUTE's run-loop.sh archived its stream and named it in the sidecar.
    const archived = "claude-output-20261013-104258-execute.jsonl";
    writeFileSync(path.join(ws.workDir, archived), "{}\n");
    writeFileSync(
      path.join(ws.workDir, CLAUDE_OUTPUT_SIDECAR_FILE),
      `${archived}\n`
    );

    await prepareLoopStep({
      step: step(),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    });
    const own = path.join(ws.workDir, "claude-output.jsonl");
    writeFileSync(own, "{}\n");

    assert.equal(resolveClaudeOutputPath(ws.workDir), own);
    assert.equal(existsSync(path.join(ws.workDir, archived)), true);
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
      apiBaseUrl: "http://api.test",
    });

    const command = launch.args.at(-1) ?? "";
    assert.match(command, SLASH_LAUNCH_RE);
    assert.ok(!command.includes(" < "));
  });

  test("forks the resumed session when the step asks for it (a retry)", async () => {
    const ws = workspace("launch-fork");
    const launch = await buildStepLaunch({
      body: {
        command: LoopCommand.Step,
        prompt: "Continue the step.",
        parentSessionId: "session-f",
        step: step({ forkSession: true }),
      },
      runtime: runtime(LoopHarness.Claude),
      baseClaudeArgs: ["-p", "--verbose"],
      stdinClaudeArgs: ["-p", "-", "--verbose"],
      claudeWorkDir: ws.workDir,
      harnessBin: "claude",
      apiBaseUrl: "http://api.test",
    });

    assert.ok(
      (launch.args.at(-1) ?? "").includes(
        "'--resume' 'session-f' '--fork-session'"
      )
    );
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
      apiBaseUrl: "http://api.test",
    });

    assert.ok((launch.args.at(-1) ?? "").includes("step-prompt.txt"));
    assert.equal(
      readFileSync(path.join(ws.workDir, "step-prompt.txt"), "utf8"),
      "Review the spec."
    );
  });
});

describe("step attachments", () => {
  test("a binary file round-trips through base64, a big one is skipped, extra matches are counted", () => {
    const dir = path.join(root, "attach-unit");
    mkdirSync(dir, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 10, 13]);
    writeFileSync(path.join(dir, "a.png"), png);
    writeFileSync(
      path.join(dir, "big.bin"),
      Buffer.alloc(LOOP_STEP_ATTACH_FILE_BYTES_MAX + 1)
    );
    const entry = (name: string) => ({
      path: `w/${name}`,
      file: path.join(dir, name),
    });

    const one = buildStepAttachments([entry("a.png"), entry("big.bin")]);
    assert.equal(one.omitted, 0);
    assert.equal(one.attachments[0].path, "w/a.png");
    assert.deepEqual(Buffer.from(one.attachments[0].data ?? "", "base64"), png);
    assert.equal(one.attachments[1].data, undefined);
    assert.match(one.attachments[1].skipped ?? "", LARGER_THAN_4MB_RE);

    const many = Array.from({ length: LOOP_STEP_ATTACH_FILES_MAX + 3 }, () =>
      entry("a.png")
    );
    const capped = buildStepAttachments(many);
    assert.equal(capped.attachments.length, LOOP_STEP_ATTACH_FILES_MAX);
    assert.equal(capped.omitted, 3);
  });

  test("readStepOutputs collects attach globs from the work directory, and omits the key without attach", async () => {
    const ws = workspace("attach-outputs");
    const base = {
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    };
    await prepareLoopStep({ ...base, step: step({ artifacts: [] }) });
    const plain = readStepOutputs(ws.workDir)[
      LOOP_STEP_ARTIFACT_KEY
    ] as LoopStepResult;
    assert.equal("attachments" in plain, false);

    await prepareLoopStep({
      ...base,
      step: step({ artifacts: [], attach: [".agentflow-ai/work/PRD-*.md"] }),
    });
    writeFileSync(path.join(ws.workDir, "PRD-X.md"), "# PRD");
    const result = readStepOutputs(ws.workDir)[
      LOOP_STEP_ARTIFACT_KEY
    ] as LoopStepResult;
    assert.equal(result.attachments?.length, 1);
    assert.equal(result.attachments?.[0].path, ".agentflow-ai/work/PRD-X.md");
    assert.equal(
      Buffer.from(result.attachments?.[0].data ?? "", "base64").toString(),
      "# PRD"
    );
    assert.equal("attachmentsOmitted" in result, false);
  });
});

describe("step inputs", () => {
  test("writes inputs before the agent starts and removes old ones on the next step", async () => {
    const ws = workspace("inputs");
    const base = {
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.workDir,
      artifacts: [],
      repos: [],
      log: () => undefined,
    };
    await prepareLoopStep({
      ...base,
      step: step({
        inputs: [
          { name: "PRD-X.md", content: "# PRD X" },
          { name: "..", content: "bad" },
        ],
      }),
    });
    const file = path.join(ws.workDir, "inputs", "PRD-X.md");
    assert.equal(readFileSync(file, "utf8"), "# PRD X");

    await prepareLoopStep({ ...base, step: step() });
    assert.equal(existsSync(path.join(ws.workDir, "inputs")), false);
  });
});
