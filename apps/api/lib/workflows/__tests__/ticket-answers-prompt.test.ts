import { describe, expect, it } from "vitest";
import type { SourceItem, SourceItemComment } from "@/lib/integrations/types";
import { ticketAnswersPrompt } from "@/lib/workflows/engine/agent-step-resume";

const ASKED_AT = "2026-10-20T10:00:00.000Z";
const BEFORE = "2026-10-20T09:00:00.000Z";
const AFTER = "2026-10-20T11:00:00.000Z";
const OWN_QUESTION_ID = "100";
const OTHER_QUESTION_ID = "200";

const waiting = {
  stepId: "plan",
  loopId: "loop-1",
  questions: [{ id: "q1", question: "Which date format?" }],
  askedAt: ASKED_AT,
  answers: null,
  answeredBy: null,
};

describe("ticketAnswersPrompt", () => {
  it("takes only the replies in the thread of the run's own question", () => {
    const prompt = ticketAnswersPrompt(
      waiting,
      item([
        comment({ id: OWN_QUESTION_ID, author: "Bot", body: "Dev questions" }),
        comment({ id: OTHER_QUESTION_ID, author: "Bot", body: "QC questions" }),
        comment({ id: "101", parentId: OWN_QUESTION_ID, body: "dev answer" }),
        comment({ id: "201", parentId: OTHER_QUESTION_ID, body: "qc answer" }),
        comment({ id: "300", body: "top-level note" }),
      ]),
      new Set([OWN_QUESTION_ID])
    );

    expect(prompt).toContain("dev answer");
    expect(prompt).not.toContain("qc answer");
    expect(prompt).not.toContain("top-level note");
    expect(prompt).not.toContain("Dev questions");
  });

  it("falls back to top-level comments when nobody replied in the run's thread", () => {
    const prompt = ticketAnswersPrompt(
      waiting,
      item([
        comment({ id: OWN_QUESTION_ID, author: "Bot", body: "Dev questions" }),
        comment({ id: "201", parentId: OTHER_QUESTION_ID, body: "qc answer" }),
        comment({ id: "300", body: "1a, 2b" }),
      ]),
      new Set([OWN_QUESTION_ID])
    );

    expect(prompt).toContain("1a, 2b");
    expect(prompt).not.toContain("qc answer");
    expect(prompt).not.toContain("Dev questions");
  });

  it("ignores comments written before the question", () => {
    const prompt = ticketAnswersPrompt(
      waiting,
      item([comment({ id: "50", body: "old note", createdAt: BEFORE })]),
      new Set([OWN_QUESTION_ID])
    );

    expect(prompt).not.toContain("old note");
    expect(prompt).toContain("updated the issue instead");
  });
});

function comment(input: {
  id: string;
  parentId?: string;
  author?: string;
  body: string;
  createdAt?: string;
}): SourceItemComment {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    author: input.author ?? "Shawn",
    createdAt: input.createdAt ?? AFTER,
    bodyMarkdown: input.body,
  };
}

function item(comments: SourceItemComment[]): SourceItem {
  return {
    provider: "jira",
    externalId: "10013",
    key: "LD-2",
    url: null,
    title: "LD-2",
    container: "LD",
    bodyMarkdown: "",
    itemType: null,
    status: null,
    priority: null,
    labels: [],
    reporter: null,
    assignee: null,
    sections: [],
    comments,
    attachments: [],
  };
}
