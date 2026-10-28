import {
  ProcessStepType,
  RunProcessSource,
  type RunProcessView,
} from "@repo/api/src/types/project-process";
import { describe, expect, it } from "vitest";
import { approvalFiles, globToRegExp } from "../workflow-run-process";

function file(path: string) {
  return { path, content: path, truncated: false };
}

const PROCESS: RunProcessView = {
  version: 1,
  source: RunProcessSource.Project,
  toolkit: null,
  steps: [
    { id: "specify", name: "Specify", type: ProcessStepType.Agent },
    { id: "plan", name: "Plan", type: ProcessStepType.Agent },
    { id: "review", name: "Review", type: ProcessStepType.Approval },
  ],
  stepId: "review",
  waiting: null,
  approval: null,
  review: null,
  stepFiles: [
    {
      stepId: "specify",
      loopId: "loop-1",
      files: [file("specs/001/spec.md"), file("notes.txt")],
    },
    {
      stepId: "plan",
      loopId: "loop-2",
      files: [file("specs/001/plan.md"), file("specs/001/tasks.md")],
    },
  ],
};

describe("globToRegExp", () => {
  it("matches any depth with ** and one segment with * and ?", () => {
    expect(globToRegExp("specs/**/*.md").test("specs/001/spec.md")).toBe(true);
    expect(globToRegExp("specs/**/*.md").test("specs/spec.md")).toBe(true);
    expect(globToRegExp("specs/*.md").test("specs/001/spec.md")).toBe(false);
    expect(globToRegExp("**").test("a/b/c.txt")).toBe(true);
    expect(globToRegExp("plan?.md").test("plan1.md")).toBe(true);
    expect(globToRegExp("a.md").test("aXmd")).toBe(false);
  });
});

describe("approvalFiles", () => {
  it("shows a named step's files and every file matching a glob, each once", () => {
    const shown = approvalFiles(PROCESS, ["specify", "specs/**/*.md"]);

    expect(shown.map((entry) => [entry.stepId, entry.file.path])).toEqual([
      ["specify", "specs/001/spec.md"],
      ["specify", "notes.txt"],
      ["plan", "specs/001/plan.md"],
      ["plan", "specs/001/tasks.md"],
    ]);
  });

  it("shows nothing for a step without files or a glob without match", () => {
    expect(approvalFiles(PROCESS, ["review", "docs/*.md"])).toEqual([]);
  });
});
