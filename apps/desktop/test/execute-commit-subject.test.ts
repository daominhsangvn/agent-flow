import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { buildCommitSubject } from "../src/server/operations/execute-push-finalization.js";

let workDir: string;

function subjectFor(heading: string, slug?: string): string {
  writeFileSync(path.join(workDir, "plan.md"), `# ${heading}\n\nBody\n`);
  return buildCommitSubject(workDir, slug);
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "commit-subject-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("buildCommitSubject", () => {
  test("drops a document-kind prefix from the plan heading", () => {
    assert.equal(
      subjectFor(
        "Implementation plan — RC-1: Make the calculator work",
        "PLN-11"
      ),
      "PLN-11: RC-1: Make the calculator work"
    );
    assert.equal(subjectFor("Implementation Plan: Dark mode"), "Dark mode");
    assert.equal(subjectFor("PRD - Export to CSV"), "Export to CSV");
  });

  test("keeps headings that only start with the same words", () => {
    assert.equal(
      subjectFor("Planning board filters"),
      "Planning board filters"
    );
    assert.equal(subjectFor("Implementation plan"), "Implementation plan");
  });
});
