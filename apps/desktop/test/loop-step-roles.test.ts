import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LoopArtifactType } from "@agentflow-ai/loops-api/artifacts";
import {
  type LoopStepConfig,
  LoopStepFile,
  LoopStepFinish,
  LoopStepRole,
} from "@agentflow-ai/loops-api/loop-step";
import {
  buildStepWorkspaceInstructions,
  prepareLoopStep,
} from "../src/server/operations/loop-step.js";

/**
 * Step roles on the computer (docs/workflows.md "Step roles"): the role's
 * contract in the workspace CLAUDE.md, the approved plan written for an
 * implement step, and the run's item (not its plan) as the step's issue.
 */

let root: string;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-step-roles-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function step(overrides: Partial<LoopStepConfig> = {}): LoopStepConfig {
  return {
    runId: "run-1",
    stepId: "plan",
    name: "Plan",
    fresh: true,
    askQuestions: true,
    artifacts: [".agentflow-ai/work/plan.md"],
    finish: LoopStepFinish.None,
    toolkit: null,
    role: LoopStepRole.Plan,
    ...overrides,
  };
}

function workDir(name: string) {
  const rootDir = path.join(root, name);
  const dir = path.join(rootDir, ".agentflow-ai", "work");
  mkdirSync(dir, { recursive: true });
  return { rootDir, dir };
}

const PLAN = {
  type: LoopArtifactType.ImplementationPlan,
  title: "Plan: CSV export",
  content: "# Plan\n\n- [ ] Add the export button\n",
};

const PRD = {
  type: LoopArtifactType.Prd,
  title: "PRD: CSV export",
  content: "Export the orders as CSV.",
};

describe("buildStepWorkspaceInstructions with a role", () => {
  test("a plan step is told where its plan goes and that the step fails without it", () => {
    const text = buildStepWorkspaceInstructions(step()) ?? "";

    assert.ok(text.includes("### Plan step"));
    assert.ok(
      text.includes(
        "write it to `.agentflow-ai/work/plan.md` as markdown, also when your tools wrote it elsewhere (copy it there)"
      )
    );
    assert.ok(text.includes("the step fails without it"));
    assert.ok(!text.includes("### Implement step"));
  });

  test("an implement step is told where the approved plan is and where its release notes go", () => {
    const text =
      buildStepWorkspaceInstructions(
        step({
          stepId: "implement",
          name: "Implement",
          role: LoopStepRole.Implement,
          finish: LoopStepFinish.Push,
          releaseNotes: true,
        })
      ) ?? "";

    assert.ok(
      text.includes(
        "The approved implementation plan is `.agentflow-ai/work/plan.md`"
      )
    );
    assert.ok(text.includes("`.agentflow-ai/work/release-notes.md`"));
    assert.ok(!text.includes("### Plan step"));
  });

  test("an implement step without release notes is not asked for them, a step without a role gets neither", () => {
    const implement =
      buildStepWorkspaceInstructions(
        step({ role: LoopStepRole.Implement, finish: LoopStepFinish.Push })
      ) ?? "";
    const plain = buildStepWorkspaceInstructions(step({ role: undefined }));

    assert.ok(implement.includes("### Implement step"));
    assert.ok(!implement.includes("release-notes.md"));
    assert.ok(!plain?.includes("### Plan step"));
    assert.ok(!plain?.includes("### Implement step"));
  });
});

describe("prepareLoopStep with a role", () => {
  test("writes the approved plan for an implement step, and the PRD as its issue", async () => {
    const ws = workDir("implement");

    await prepareLoopStep({
      step: step({ role: LoopStepRole.Implement }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.dir,
      artifacts: [PLAN, PRD],
      repos: [],
      log: () => undefined,
    });

    assert.equal(
      readFileSync(path.join(ws.dir, LoopStepFile.Plan), "utf8"),
      "# Plan\n\n- [ ] Add the export button\n"
    );
    assert.equal(
      readFileSync(path.join(ws.dir, LoopStepFile.Issue), "utf8"),
      "# PRD: CSV export\n\nExport the orders as CSV.\n"
    );
  });

  test("leaves the plan file to a plan step", async () => {
    const ws = workDir("plan");

    await prepareLoopStep({
      step: step(),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.dir,
      artifacts: [PLAN, PRD],
      repos: [],
      log: () => undefined,
    });

    assert.equal(existsSync(path.join(ws.dir, LoopStepFile.Plan)), false);
  });

  test("logs and goes on when an implement step gets no plan", async () => {
    const ws = workDir("no-plan");
    const logged: string[] = [];

    await prepareLoopStep({
      step: step({ role: LoopStepRole.Implement }),
      workspaceRoot: ws.rootDir,
      claudeWorkDir: ws.dir,
      artifacts: [PRD],
      repos: [],
      log: (message) => logged.push(message),
    });

    assert.equal(existsSync(path.join(ws.dir, LoopStepFile.Plan)), false);
    assert.deepEqual(logged, [
      "The implement step got no approved plan; it reads none",
    ]);
  });
});
