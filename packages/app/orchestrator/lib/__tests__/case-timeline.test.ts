import {
  type OrchestratorCaseConversation,
  type OrchestratorCaseTask,
  OrchestratorConversationStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
} from "@repo/api/src/types/orchestrator";
import { describe, expect, it } from "vitest";
import {
  buildConversationTimeline,
  CaseTimelineEntryKind,
} from "../case-timeline";

const CONV = "conv-1";

function message(id: string, createdAt: string) {
  return {
    id,
    conversationId: CONV,
    origin: OrchestratorMessageOrigin.External,
    kind: OrchestratorMessageKind.Message,
    actor: null,
    text: id,
    turnId: null,
    createdAt,
  } as unknown as OrchestratorCaseConversation["messages"][number];
}

function turn(id: string, startedAt: string) {
  return {
    id,
    conversationId: CONV,
    status: OrchestratorTurnStatus.Succeeded,
    ended: null,
    summary: null,
    error: null,
    usage: null,
    runnerName: null,
    startedAt,
    finishedAt: null,
  } as unknown as OrchestratorCaseConversation["turns"][number];
}

function task(id: string, turnId: string | null): OrchestratorCaseTask {
  return {
    id,
    conversationId: CONV,
    turnId,
    status: OrchestratorTaskStatus.Queued,
  } as unknown as OrchestratorCaseTask;
}

function conversation(
  messages: OrchestratorCaseConversation["messages"],
  turns: OrchestratorCaseConversation["turns"]
): OrchestratorCaseConversation {
  return {
    id: CONV,
    channelKey: "teams:1",
    status: OrchestratorConversationStatus.Idle,
    createdAt: "2026-01-01T00:00:00.000Z",
    messages,
    turns,
  } as unknown as OrchestratorCaseConversation;
}

describe("buildConversationTimeline", () => {
  it("interleaves messages and turns by time", () => {
    const { entries } = buildConversationTimeline(
      conversation(
        [
          message("m1", "2026-01-01T00:00:01.000Z"),
          message("m2", "2026-01-01T00:00:03.000Z"),
        ],
        [turn("t1", "2026-01-01T00:00:02.000Z")]
      ),
      []
    );

    expect(entries.map((e) => e.kind)).toEqual([
      CaseTimelineEntryKind.Message,
      CaseTimelineEntryKind.Turn,
      CaseTimelineEntryKind.Message,
    ]);
  });

  it("breaks ties by id", () => {
    const at = "2026-01-01T00:00:01.000Z";
    const { entries } = buildConversationTimeline(
      conversation([message("b", at), message("a", at)], []),
      []
    );

    expect(
      entries.map((e) =>
        e.kind === CaseTimelineEntryKind.Message ? e.message.id : ""
      )
    ).toEqual(["a", "b"]);
  });

  it("attaches tasks to their turn and collects the rest", () => {
    const { entries, unassignedTasks } = buildConversationTimeline(
      conversation([], [turn("t1", "2026-01-01T00:00:02.000Z")]),
      [task("k1", "t1"), task("k2", "gone"), task("k3", null)]
    );

    const first = entries[0];
    expect(
      first?.kind === CaseTimelineEntryKind.Turn
        ? first.tasks.map((t) => t.id)
        : []
    ).toEqual(["k1"]);
    expect(unassignedTasks.map((t) => t.id)).toEqual(["k2", "k3"]);
  });
});
