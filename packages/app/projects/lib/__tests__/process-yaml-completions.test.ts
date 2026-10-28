import {
  ConnectionAccess,
  SOURCE_CONNECTION_KEY,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { ProcessStepRole } from "@repo/api/src/types/project-process";
import { YamlCursorKind } from "@repo/app/shared/lib/yaml-cursor";
import { describe, expect, it } from "vitest";
import {
  JIRA_KEY,
  PROVIDERS,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  PROCESS_STEP_SNIPPETS,
  type ProcessCompletionData,
  processYamlCompletions,
  yamlCursorContext,
} from "../process-yaml-completions";

const DATA: ProcessCompletionData = {
  repositories: ["brenock/ip-okf", "brenock/ip-web"],
  stepIds: ["analyze", "draft"],
  projectConnections: [
    { key: JIRA_KEY, name: "Acme Jira", provider: IntegrationProviderKey.Jira },
    {
      key: TEAMS_KEY,
      name: "Delivery channel",
      provider: IntegrationProviderKey.MicrosoftTeams,
    },
  ],
  providers: PROVIDERS,
};

/** The context and suggestions at the "§" of the text (YAML uses "|" itself). */
function at(textWithCursor: string) {
  const pos = textWithCursor.indexOf("§");
  const text = textWithCursor.replace("§", "");
  const context = yamlCursorContext(text, pos);
  const labels = context
    ? processYamlCompletions(context, DATA).map(
        (completion) => completion.label
      )
    : [];
  return { context, labels };
}

describe("yamlCursorContext + processYamlCompletions", () => {
  it("offers the process keys at the root", () => {
    expect(at("§").labels).toEqual(["toolkit", "steps"]);
    expect(at("st§").labels).toEqual(["steps"]);
    expect(at("st§").context).toMatchObject({
      kind: YamlCursorKind.Key,
      path: [],
      from: 0,
      typed: "st",
    });
  });

  it("offers the keys of the step's type, without the ones it already has (above and below)", () => {
    const { context, labels } = at(
      "steps:\n  - type: agent\n    id: analyze\n    §\n    name: Analyze\n"
    );

    expect(context).toMatchObject({
      kind: YamlCursorKind.Key,
      path: ["steps", "#"],
      stepType: "agent",
    });
    expect(labels).toEqual([
      "role",
      "instruction",
      "questions",
      "artifacts",
      "reply",
      "document",
      "finish",
      "releaseNotes",
      "timeoutMinutes",
      "connections",
      "review",
      "retry",
    ]);
  });

  it("offers a step's retry attempts", () => {
    expect(
      at("steps:\n  - type: agent\n    id: implement\n    retry:\n      §")
        .labels
    ).toEqual(["attempts"]);
  });

  it("offers a review's keys, its feedback's and its signals' labels", () => {
    const base = "steps:\n  - type: agent\n    id: plan\n    review:\n";

    expect(at(`${base}      §`).labels).toEqual([
      "approve",
      "complete",
      "feedback",
      "instruction",
      "session",
      "consumeLabels",
    ]);
    expect(at(`${base}      feedback:\n        §`).labels).toEqual([
      "labels",
      "mention",
    ]);
    expect(at(`${base}      approve:\n        §`).labels).toEqual(["labels"]);
    expect(at(`${base}      session: §`).labels).toEqual(["resume", "fresh"]);
    const { context } = at("steps:\n  - type: agent\n    id: plan\n    §");
    const review = context
      ? processYamlCompletions(context, DATA).find(
          (completion) => completion.label === "review"
        )
      : undefined;
    expect(review?.insert).toBe("review:\n  ");
  });

  it("offers the roles of an agent step", () => {
    expect(
      at("steps:\n  - type: agent\n    id: plan\n    role: §").labels
    ).toEqual([ProcessStepRole.Plan, ProcessStepRole.Implement]);
  });

  it("offers source and the project's connection keys in a step's grant", () => {
    expect(
      at("steps:\n  - type: agent\n    id: analyze\n    connections:\n      §")
        .labels
    ).toEqual([SOURCE_CONNECTION_KEY, JIRA_KEY, TEAMS_KEY]);
  });

  it("offers what a granted key may do", () => {
    expect(
      at(
        "steps:\n  - type: agent\n    id: analyze\n    connections:\n      source: §"
      ).labels
    ).toContain(`[${SourceOperation.Comment}, ${SourceOperation.Transition}]`);
    expect(
      at(
        `steps:\n  - type: agent\n    id: analyze\n    connections:\n      ${TEAMS_KEY}: §`
      ).labels
    ).toEqual([ConnectionAccess.Read, `[${TEAMS_POST_MESSAGE}]`]);
  });

  it("offers an approval only its own keys", () => {
    expect(at("steps:\n  - type: approval\n    §").labels).toEqual([
      "id",
      "name",
      "show",
      "approve",
    ]);
  });

  it("offers step snippets and every key on a new item of steps", () => {
    const { context, labels } = at("steps:\n  - type: agent\n    id: a\n  - §");

    expect(context).toMatchObject({
      kind: YamlCursorKind.Key,
      path: ["steps", "#"],
      itemStart: true,
      stepType: null,
    });
    expect(labels.slice(0, PROCESS_STEP_SNIPPETS.length)).toEqual(
      PROCESS_STEP_SNIPPETS.map((snippet) => snippet.label)
    );
    expect(labels).toContain("type");
    expect(labels).toContain("show");
  });

  it("offers the step types as the value of type", () => {
    const { context, labels } = at("steps:\n  - type: §");

    expect(context).toMatchObject({
      kind: YamlCursorKind.Value,
      key: "type",
      path: ["steps", "#"],
    });
    expect(labels).toEqual([
      "agent",
      "approval",
      "agentflow.plan",
      "agentflow.execute",
    ]);
  });

  it("offers ask / continue for questions, filtered by what is typed", () => {
    expect(at("steps:\n  - type: agent\n    questions: a§").labels).toEqual([
      "ask",
    ]);
    expect(at("steps:\n  - type: agent\n    finish: §").labels).toEqual([
      "none",
      "push",
    ]);
  });

  it("offers what the AgentFlow agents decide on their own on plan and implement steps", () => {
    expect(
      at("steps:\n  - type: agentflow.plan\n    id: plan\n    §").labels
    ).toEqual(["name", "questions", "recommendations"]);
    expect(
      at("steps:\n  - type: agentflow.plan\n    recommendations: §").labels
    ).toEqual(["accept", "suggest"]);
    expect(
      at("steps:\n  - type: agentflow.execute\n    id: execute\n    §").labels
    ).toEqual(["name", "review", "releaseNotes"]);
    expect(
      at("steps:\n  - type: agentflow.execute\n    releaseNotes: §").labels
    ).toEqual(["true", "false"]);
    expect(
      at("steps:\n  - type: agentflow.execute\n    review: f§").labels
    ).toEqual(["full", "fast"]);
  });

  it("offers the document keys and document types inside a step's document", () => {
    const base = "steps:\n  - type: agent\n    id: prd\n    document:\n";

    expect(at(`${base}      §`).labels).toEqual(["type", "path", "title"]);
    expect(at(`${base}      type: §`).labels).toEqual([
      "PRD",
      "DOC",
      "IMPLEMENTATION_PLAN",
    ]);
    expect(at(`${base}      type: §`).context).toMatchObject({
      path: ["steps", "#", "document"],
    });
  });

  it("offers the project's repositories for the toolkit", () => {
    expect(at("toolkit:\n  §").labels).toEqual([
      "repository",
      "mounts",
      "instructions",
    ]);
    expect(at("toolkit:\n  repository: §").labels).toEqual([
      "brenock/ip-okf",
      "brenock/ip-web",
    ]);
    expect(
      at("toolkit:\n  repository: brenock/ip-okf\n  mounts:\n    - §").labels
    ).toContain(".claude/commands");
  });

  it("offers the process's step ids as items of an approval's show", () => {
    const { context, labels } = at(
      "steps:\n  - type: approval\n    id: review\n    show:\n      - §"
    );

    expect(context).toMatchObject({ kind: YamlCursorKind.Item, key: "show" });
    expect(labels).toEqual(["analyze", "draft"]);
  });

  it("offers the instruction variables after {{, also inside a block of text", () => {
    const inline = at("steps:\n  - type: agent\n    instruction: Read {{iss§");
    const block = at(
      "steps:\n  - type: agent\n    instruction: |\n      Read {{§"
    );

    expect(inline.context).toMatchObject({
      kind: YamlCursorKind.Variable,
      typed: "iss",
    });
    expect(inline.labels).toEqual([
      "issue.key",
      "issue.title",
      "issue.url",
      "issue.body",
      "issue.file",
    ]);
    expect(block.labels).toHaveLength(5);
  });

  it("completes a variable with its closing braces", () => {
    const { context } = at(
      "steps:\n  - type: agent\n    instruction: Read {{issue.k§"
    );
    const [completion] = context ? processYamlCompletions(context, DATA) : [];

    expect(completion).toMatchObject({
      label: "issue.key",
      insert: "issue.key}}",
    });
  });

  it("inserts block keys with their indented first line", () => {
    const { context } = at("steps:\n  - type: agent\n    doc§");
    const [completion] = context ? processYamlCompletions(context, DATA) : [];

    expect(completion).toMatchObject({
      label: "document",
      insert: "document:\n  ",
    });
  });
});
