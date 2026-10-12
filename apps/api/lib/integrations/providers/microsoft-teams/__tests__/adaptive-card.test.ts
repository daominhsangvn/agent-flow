import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  buildRunCardContent,
  buildTeamsMessage,
  buildTestCardContent,
  TEAMS_MAX_PAYLOAD_BYTES,
} from "../adaptive-card";
import {
  makePreActionRunSnapshot,
  makeRunSnapshot,
} from "./teams.test-helpers";

const TRUNCATION_MARKER = "…(truncated)";

describe("buildTeamsMessage for a run", () => {
  it("builds the Workflows message envelope with an Adaptive Card 1.4", () => {
    const run = makeRunSnapshot();

    const message = buildTeamsMessage(
      buildRunCardContent(run, {
        title: "Jira intake: PROJ-123",
        message: "## Done\n**PROJ-123** shipped",
        includeFacts: true,
      })
    );

    expect(message).toEqual({
      type: "message",
      attachments: [
        {
          contentType: ADAPTIVE_CARD_CONTENT_TYPE,
          contentUrl: null,
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              {
                type: "TextBlock",
                text: "Jira intake: PROJ-123",
                weight: "Bolder",
                size: "Medium",
                wrap: true,
              },
              {
                type: "FactSet",
                facts: [
                  { title: "Status", value: "Succeeded" },
                  {
                    title: "Source",
                    value:
                      "[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)",
                  },
                  {
                    title: "Pull request",
                    value: "[#42](https://github.com/acme/repo/pull/42)",
                  },
                ],
              },
              {
                type: "TextBlock",
                text: "**Done**\n**PROJ-123** shipped",
                wrap: true,
              },
            ],
            actions: [
              { type: "Action.OpenUrl", title: "Open run", url: run.url },
              {
                type: "Action.OpenUrl",
                title: "Open pull request",
                url: "https://github.com/acme/repo/pull/42",
              },
              {
                type: "Action.OpenUrl",
                title: "Open PROJ-123",
                url: "https://acme.atlassian.net/browse/PROJ-123",
              },
            ],
          },
        },
      ],
    });
  });

  it("omits the fact set when facts are disabled", () => {
    const content = buildRunCardContent(makeRunSnapshot(), {
      title: "Title",
      message: "Body",
      includeFacts: false,
    });

    expect(content.facts).toEqual([]);
    expect(cardOf(buildTeamsMessage(content)).body).toEqual([
      expect.objectContaining({ type: "TextBlock", text: "Title" }),
      expect.objectContaining({ type: "TextBlock", text: "Body" }),
    ]);
  });

  it("leaves out the pull request and source links when the run has none", () => {
    const run = makeRunSnapshot({
      status: WorkflowRunStatus.NeedsInput,
      pullRequest: null,
      source: { ...makeRunSnapshot().source, url: null },
    });

    const content = buildRunCardContent(run, {
      title: "t",
      message: "m",
      includeFacts: true,
    });

    expect(content.facts).toEqual([
      { title: "Status", value: "Needs input" },
      { title: "Source", value: "PROJ-123" },
    ]);
    expect(content.links).toEqual([{ title: "Open run", url: run.url }]);
  });

  it("labels every run status", () => {
    for (const status of Object.values(WorkflowRunStatus)) {
      const content = buildRunCardContent(makeRunSnapshot({ status }), {
        title: "t",
        message: "m",
        includeFacts: true,
      });

      expect(content.facts[0]?.value).not.toBe(status);
    }
  });

  it("builds a pre action card from a run.triggered snapshot", () => {
    const run = makePreActionRunSnapshot();

    const content = buildRunCardContent(run, {
      title: "t",
      message: run.summaryMarkdown,
      includeFacts: true,
    });

    expect(run.event).toBe(WorkflowRunEvent.Triggered);
    expect(content.facts).toEqual([
      { title: "Status", value: "Running pre actions" },
      {
        title: "Source",
        value: "[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)",
      },
    ]);
    expect(content.message).toBe(run.summaryMarkdown);
    expect(content.links.map((link) => link.title)).toEqual([
      "Open run",
      "Open PROJ-123",
    ]);
  });

  it("skips facts without a value", () => {
    const run = makePreActionRunSnapshot({
      source: { ...makeRunSnapshot().source, key: "", url: null },
    });

    const content = buildRunCardContent(run, {
      title: "t",
      message: "m",
      includeFacts: true,
    });

    expect(content.facts.map((fact) => fact.title)).toEqual(["Status"]);
  });

  it("labels a pull request without a number by its URL", () => {
    const run = makeRunSnapshot({
      pullRequest: {
        url: "https://git.example.com/pr/7",
        number: null,
        branch: null,
      },
    });

    const content = buildRunCardContent(run, {
      title: "t",
      message: "m",
      includeFacts: true,
    });

    expect(content.facts[2]).toEqual({
      title: "Pull request",
      value: "[https://git.example.com/pr/7](https://git.example.com/pr/7)",
    });
  });

  it("drops buttons whose URL is not absolute and omits empty action lists", () => {
    const run = makeRunSnapshot({
      url: "/acme/workflows/wf-1/runs/run-1",
      pullRequest: null,
      source: { ...makeRunSnapshot().source, url: null },
    });

    const message = buildTeamsMessage(
      buildRunCardContent(run, {
        title: "t",
        message: "m",
        includeFacts: false,
      })
    );

    expect(cardOf(message)).not.toHaveProperty("actions");
  });

  it("falls back to the workflow name for a blank title and keeps titles on one line", () => {
    const run = makeRunSnapshot();

    expect(
      buildRunCardContent(run, {
        title: "   ",
        message: "",
        includeFacts: false,
      }).title
    ).toBe("Jira intake");
    expect(
      buildRunCardContent(run, {
        title: "line one\nline two",
        message: "",
        includeFacts: false,
      }).title
    ).toBe("line one line two");
  });

  it("omits the message block when the rendered message is empty", () => {
    const message = buildTeamsMessage(
      buildRunCardContent(makeRunSnapshot(), {
        title: "t",
        message: "",
        includeFacts: false,
      })
    );

    expect(cardOf(message).body).toHaveLength(1);
  });

  it("truncates long messages so the payload stays under the Teams size limit", () => {
    const longMessage = "Línea con acentos y emoji 🚀. ".repeat(3000);

    const message = buildTeamsMessage(
      buildRunCardContent(makeRunSnapshot(), {
        title: "t",
        message: longMessage,
        includeFacts: true,
      })
    );

    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    expect(bytes).toBeLessThanOrEqual(TEAMS_MAX_PAYLOAD_BYTES);
    expect(bytes).toBeGreaterThan(TEAMS_MAX_PAYLOAD_BYTES - 200);
    const text = messageText(message);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("does not touch messages that already fit", () => {
    const message = buildTeamsMessage(
      buildRunCardContent(makeRunSnapshot(), {
        title: "t",
        message: "short",
        includeFacts: true,
      })
    );

    expect(messageText(message)).toBe("short");
  });
});

describe("buildTestCardContent", () => {
  it("names the connection in a card without facts or buttons", () => {
    const message = buildTeamsMessage(buildTestCardContent("Delivery channel"));

    expect(cardOf(message)).toEqual({
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          text: "AgentFlow is connected",
          weight: "Bolder",
          size: "Medium",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: "This channel will receive AgentFlow workflow notifications sent through the **Delivery channel** connection.",
          wrap: true,
        },
      ],
    });
  });
});

const cardSchema = z
  .object({
    body: z.array(
      z.object({ type: z.string(), text: z.string().optional() }).loose()
    ),
    actions: z.array(z.unknown()).optional(),
  })
  .loose();
const messageSchema = z.object({
  attachments: z.array(z.object({ content: cardSchema })).length(1),
});

function cardOf(message: unknown): z.infer<typeof cardSchema> {
  return messageSchema.parse(message).attachments[0].content;
}

function messageText(message: unknown): string {
  const blocks = cardOf(message).body.filter(
    (block) => block.type === "TextBlock"
  );
  return blocks.at(-1)?.text ?? "";
}
