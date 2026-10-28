import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (client: unknown) => unknown) =>
    fn({
      orchestratorTask: {
        findMany: (args: { where: { id: { in: string[] }; caseId: string } }) =>
          Promise.resolve(
            mocks.tasks.filter(
              (task) =>
                args.where.id.in.includes(task.id as string) &&
                task.caseId === args.where.caseId
            )
          ),
      },
    }),
}));
vi.mock("@/lib/loops/loop-state", () => ({
  getLoopAttachment: vi.fn(),
  getLoopPrefix: (org: string, loop: string) => `${org}/loops/${loop}/`,
}));

import {
  findCaseTaskFiles,
  inputFileName,
  taskFilesFromStep,
} from "../task-files";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const GOOD_KEY = "org-1/loops/loop-1/step-attachments/0-a.md";

function addTask(storageKey: string | null, loopId: string | null = "loop-1") {
  mocks.tasks = [
    {
      id: TASK_ID,
      caseId: "case-1",
      organizationId: "org-1",
      loopId,
      result: {
        reply: null,
        questions: [],
        error: null,
        files: [{ name: "a.md", size: 1, storageKey, skipped: null }],
      },
    },
  ];
}

describe("findCaseTaskFiles", () => {
  const refs = [{ taskId: TASK_ID, name: "a.md" }];

  it("returns a file stored under the task's loop prefix", async () => {
    addTask(GOOD_KEY);
    const found = await findCaseTaskFiles("case-1", refs);
    expect(found.ok && found.value[0]?.storageKey).toBe(GOOD_KEY);
  });

  it("refuses a forged key of another org or loop", async () => {
    for (const key of [
      "org-2/loops/loop-1/step-attachments/0-a.md",
      "org-1/loops/loop-2/step-attachments/0-a.md",
    ]) {
      addTask(key);
      expect((await findCaseTaskFiles("case-1", refs)).ok).toBe(false);
    }
  });

  it("refuses a file of a task without a loop", async () => {
    addTask(GOOD_KEY, null);
    expect((await findCaseTaskFiles("case-1", refs)).ok).toBe(false);
  });

  it("refuses a task of another case", async () => {
    addTask(GOOD_KEY);
    expect((await findCaseTaskFiles("case-2", refs)).ok).toBe(false);
  });
});

describe("taskFilesFromStep", () => {
  it("names files relative to the work dir and marks unstored ones", () => {
    const { files, filesOmitted } = taskFilesFromStep({
      stepId: "s",
      questions: [],
      files: [],
      questionsError: null,
      attachments: [
        { path: ".agentflow-ai/work/PRD.md", size: 3, storageKey: "k" },
        { path: "x.png", size: 4 },
      ],
      attachmentsOmitted: 2,
    } as never);
    expect(files).toEqual([
      { name: "PRD.md", size: 3, storageKey: "k", skipped: null },
      { name: "x.png", size: 4, storageKey: null, skipped: "not stored" },
    ]);
    expect(filesOmitted).toBe(2);
  });
});

describe("inputFileName", () => {
  it("keeps the basename and replaces unsafe characters", () => {
    expect(inputFileName("evidence/my file.md")).toBe("my_file.md");
  });

  it("never returns a dots-only name", () => {
    expect(inputFileName("a/..")).toBe("file");
    expect(inputFileName("")).toBe("file");
  });
});
