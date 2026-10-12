import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopArtifactType } from "@agentflow-ai/loops-api/artifacts";
import { writeArtifactsForExecuteOrAmend } from "../src/server/operations/symphony-loop.js";
import {
  IMPORTED_PLAN_MARKDOWN_FILE,
  isSamePlan,
} from "../src/shared/plan-artifact-utils.js";

// What the plan's own plan.json says, and what the API stores for it: the
// document sanitizer entity-encodes `&` and `>` in prose.
const PLAN = "# Plan\n## API & Data Impacts\n- T-1.1: a -> b, `x && y`\n";
const HOSTED =
  "# Plan\n## API &amp; Data Impacts\n- T-1.1: a -&gt; b, `x && y`\n";

let workDir: string;

function execute(raw?: Record<string, unknown>) {
  return writeArtifactsForExecuteOrAmend(
    workDir,
    [
      {
        id: "plan-1",
        type: LoopArtifactType.ImplementationPlan,
        title: "Plan",
        content: HOSTED,
        ...(raw ? { raw } : {}),
      },
    ],
    undefined,
    undefined,
    { command: "EXECUTE", loopId: "loop-exec" }
  );
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "plan-alignment-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("plan content alignment", () => {
  test("the hosted plan is the same plan as its plan.json", () => {
    assert.equal(isSamePlan(PLAN, HOSTED), true);
    assert.equal(isSamePlan(PLAN, PLAN), true);
    assert.equal(isSamePlan(PLAN, `${HOSTED}- T-1.2: new task\n`), false);
    assert.equal(isSamePlan(undefined, HOSTED), false);
    assert.equal(isSamePlan(null, null), false);
  });

  test("EXECUTE keeps the uploaded plan.json instead of importing the hosted markdown", async () => {
    const result = await execute({
      content: PLAN,
      pendingTasks: [{ id: "T-1.1" }],
    });
    assert.equal(result.importedPlanFile, null);
    const plan = JSON.parse(
      readFileSync(path.join(workDir, "plan.json"), "utf8")
    );
    assert.deepEqual(plan.pendingTasks, [{ id: "T-1.1" }]);
    // The plan's own text: the hosted copy's `&amp;` would hide its sections
    // from the plan validator.
    assert.equal(plan.content, PLAN);
    assert.equal(
      existsSync(path.join(workDir, IMPORTED_PLAN_MARKDOWN_FILE)),
      false
    );
  });

  test("EXECUTE keeps a restored plan.json when there is no raw plan", async () => {
    const local = JSON.stringify({
      content: PLAN,
      completedTasks: [{ id: "T-1.1" }],
    });
    writeFileSync(path.join(workDir, "plan.json"), local);
    const result = await execute();
    assert.equal(result.importedPlanFile, null);
    assert.equal(readFileSync(path.join(workDir, "plan.json"), "utf8"), local);
  });
});
