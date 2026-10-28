import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LoopArtifactFile } from "@agentflow-ai/loops-api/artifacts";
import { readReleaseNotes } from "../src/server/operations/execute-release-notes.js";

let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "execute-release-notes-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("readReleaseNotes", () => {
  test("reads the release notes a workflow EXECUTE wrote, trimmed", () => {
    writeFileSync(
      path.join(workDir, LoopArtifactFile.ReleaseNotes),
      "\n## What changed\nCSV export\n\n"
    );

    assert.equal(readReleaseNotes(workDir), "## What changed\nCSV export");
  });

  test("reads nothing when there are none or they are blank", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "execute-no-notes-"));
    try {
      assert.equal(readReleaseNotes(empty), undefined);
      writeFileSync(path.join(empty, LoopArtifactFile.ReleaseNotes), "  \n");
      assert.equal(readReleaseNotes(empty), undefined);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
