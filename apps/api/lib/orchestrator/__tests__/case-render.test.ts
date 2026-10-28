import { OrchestratorTaskStatus } from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderCase } from "@/lib/orchestrator/case-render";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ orchestratorCase: { findUnique: mocks.findUnique } }),
}));

/** CASE.md task lines say what started each task (docs/orchestrator.md). */

type Message = { kind: string; text: string };

function task(
  id: string,
  messages: Message[] | null,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    command: "plan",
    args: null,
    mode: "STEP",
    status: OrchestratorTaskStatus.Running,
    result: null,
    computeTarget: { machineName: "runner-1" },
    conversation: { channelKey: "jira:LD-7" },
    turn: messages ? { messages } : null,
    ...extra,
  };
}

function mockCase(tasks: unknown[]) {
  mocks.findUnique.mockResolvedValue({
    title: "LD-7",
    status: "open",
    sourceKey: null,
    notes: "",
    conversations: [],
    tasks,
    decisions: [],
  });
}

describe("renderCase task lines", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
  });

  it("names the status change that started a task", async () => {
    const text = "Status changed: To Do → Prepare Requirements (by Shawn)";
    mockCase([task("t1", [{ kind: "status_changed", text }])]);
    expect(await renderCase("c1")).toContain(
      `started for: status_changed "${text}"`
    );
  });

  it("names the label that started a task", async () => {
    mockCase([
      task("t1", [
        { kind: "label_added", text: "Label added: create-prd (by Shawn)" },
      ]),
    ]);
    expect(await renderCase("c1")).toContain(
      'started for: label_added "Label added: create-prd (by Shawn)"'
    );
  });

  it("shows the channel and text for a comment turn", async () => {
    mockCase([task("t1", [{ kind: "comment", text: "please start" }])]);
    expect(await renderCase("c1")).toContain(
      'started for: message in jira:LD-7: "please start"'
    );
  });

  it("falls back to the channel without messages", async () => {
    mockCase([task("t1", null)]);
    expect(await renderCase("c1")).toContain("started for: jira:LD-7");
  });

  it("shows why a task was cancelled", async () => {
    mockCase([
      task("t1", [], {
        status: OrchestratorTaskStatus.Cancelled,
        result: {
          reply: null,
          questions: [],
          error: null,
          cancelled: "label removed",
        },
      }),
    ]);
    expect(await renderCase("c1")).toContain("— cancelled: label removed");
  });

  it("shows which message a task answers", async () => {
    mockCase([
      task("t1", [], {
        status: OrchestratorTaskStatus.Succeeded,
        result: { reply: null, questions: [], error: null, replyTo: "10500" },
      }),
    ]);
    expect(await renderCase("c1")).toContain("answers ref 10500");
  });

  it("ends a task line with the names of its files", async () => {
    mockCase([
      task("t1", [], {
        status: OrchestratorTaskStatus.Succeeded,
        result: {
          reply: null,
          questions: [],
          error: null,
          files: [
            { name: "PRD-LD-5.md", size: 10, storageKey: "k", skipped: null },
          ],
        },
      }),
    ]);
    expect(await renderCase("c1")).toContain(" — files: PRD-LD-5.md —");
  });
});
