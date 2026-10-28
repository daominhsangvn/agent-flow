/** EVALUATE_PLAN inputs: prd.md holds the PRD, plan.md the plan under evaluation. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LoopArtifactType } from "@agentflow-ai/loops-api/artifacts";
import { writePlanArtifact } from "../src/server/operations/symphony-loop.js";

test("a plan evaluation writes the PRD to prd.md although the plan is the primary artifact", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "evaluate-plan-"));
  try {
    await writePlanArtifact(
      workDir,
      [
        {
          id: "prd-1",
          type: LoopArtifactType.Prd,
          content: "# Basic calculator",
        },
        {
          id: "pln-4",
          type: LoopArtifactType.ImplementationPlan,
          content: "# Implementation Plan: CALC-4 Basic Calculator",
        },
      ],
      undefined,
      "pln-4"
    );

    assert.equal(
      await fs.readFile(path.join(workDir, "prd.md"), "utf8"),
      "# Basic calculator"
    );
    assert.equal(
      await fs.readFile(path.join(workDir, "plan.md"), "utf8"),
      "# Implementation Plan: CALC-4 Basic Calculator"
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
