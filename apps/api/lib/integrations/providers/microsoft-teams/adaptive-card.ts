import type { JsonObject } from "@repo/api/src/types/common";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { truncateText } from "../../markdown";
import type { WorkflowRunSnapshot } from "../../types";
import {
  isHttpUrl,
  markdownLink,
  toAdaptiveCardMarkdown,
} from "./card-markdown";

/**
 * Builds the message body a Teams Workflows webhook expects: a "message"
 * envelope with one Adaptive Card 1.4 attachment (1.5 fails to render through
 * the Flow bot and on iOS). Only Action.OpenUrl buttons are used; Teams
 * ignores Submit/Http actions posted by a workflow.
 */

export const ADAPTIVE_CARD_CONTENT_TYPE =
  "application/vnd.microsoft.card.adaptive";
export const ADAPTIVE_CARD_SCHEMA_URL =
  "http://adaptivecards.io/schemas/adaptive-card.json";
export const ADAPTIVE_CARD_VERSION = "1.4";
/** Teams drops messages above ~28 KB; keep headroom for the workflow's own envelope. */
export const TEAMS_MAX_PAYLOAD_BYTES = 25_000;

const TITLE_MAX_LENGTH = 300;
const ACTION_TITLE_MAX_LENGTH = 40;
const TEST_CARD_NAME_MAX_LENGTH = 120;
const WHITESPACE_RUN_RE = /\s+/g;

export type TeamsCardFact = { title: string; value: string };
export type TeamsCardLink = { title: string; url: string };
export type TeamsCardContent = {
  title: string;
  /** Adaptive Card markdown (see toAdaptiveCardMarkdown); empty omits the block. */
  message: string;
  facts: TeamsCardFact[];
  links: TeamsCardLink[];
};

export type RunCardOptions = {
  /** Rendered title template. Blank falls back to the workflow name. */
  title: string;
  /** Rendered message template (markdown). */
  message: string;
  includeFacts: boolean;
};

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  [WorkflowRunStatus.Received]: "Received",
  [WorkflowRunStatus.PreActions]: "Running pre actions",
  [WorkflowRunStatus.Ingesting]: "Importing",
  [WorkflowRunStatus.Planning]: "Planning",
  [WorkflowRunStatus.Executing]: "Implementing",
  [WorkflowRunStatus.Running]: "Running a process step",
  [WorkflowRunStatus.NeedsInput]: "Needs input",
  [WorkflowRunStatus.NeedsApproval]: "Waiting for approval",
  [WorkflowRunStatus.Succeeded]: "Succeeded",
  [WorkflowRunStatus.Failed]: "Failed",
  [WorkflowRunStatus.Cancelled]: "Cancelled",
};

/** The full webhook body, with the message truncated so the payload stays under TEAMS_MAX_PAYLOAD_BYTES. */
export function buildTeamsMessage(content: TeamsCardContent): JsonObject {
  return wrapCard(fitToPayloadBudget(content));
}

export function buildRunCardContent(
  run: WorkflowRunSnapshot,
  options: RunCardOptions
): TeamsCardContent {
  return {
    title: clip(options.title.trim() || run.workflow.name, TITLE_MAX_LENGTH),
    message: toAdaptiveCardMarkdown(options.message),
    facts: options.includeFacts ? runFacts(run) : [],
    links: runLinks(run),
  };
}

export function buildTestCardContent(connectionName: string): TeamsCardContent {
  const name = clip(connectionName, TEST_CARD_NAME_MAX_LENGTH);
  return {
    title: "AgentFlow is connected",
    message: `This channel will receive AgentFlow workflow notifications sent through the **${name}** connection.`,
    facts: [],
    links: [],
  };
}

function wrapCard(content: TeamsCardContent): JsonObject {
  const body: JsonObject[] = [
    {
      type: "TextBlock",
      text: content.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
  ];
  if (content.facts.length > 0) {
    body.push({ type: "FactSet", facts: content.facts });
  }
  if (content.message) {
    body.push({ type: "TextBlock", text: content.message, wrap: true });
  }
  const card: JsonObject = {
    $schema: ADAPTIVE_CARD_SCHEMA_URL,
    type: "AdaptiveCard",
    version: ADAPTIVE_CARD_VERSION,
    body,
  };
  if (content.links.length > 0) {
    card.actions = content.links.map((link) => ({
      type: "Action.OpenUrl",
      title: link.title,
      url: link.url,
    }));
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        contentUrl: null,
        content: card,
      },
    ],
  };
}

function fitToPayloadBudget(content: TeamsCardContent): TeamsCardContent {
  if (payloadBytes(content) <= TEAMS_MAX_PAYLOAD_BYTES) {
    return content;
  }
  // Longest truncation whose complete payload fits (measured, since JSON
  // escaping and multi-byte characters make the size non-linear in length).
  let low = 0;
  let high = content.message.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      payloadBytes(withTruncatedMessage(content, middle)) <=
      TEAMS_MAX_PAYLOAD_BYTES
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return withTruncatedMessage(content, low);
}

function withTruncatedMessage(
  content: TeamsCardContent,
  maxLength: number
): TeamsCardContent {
  return { ...content, message: truncateText(content.message, maxLength) };
}

function payloadBytes(content: TeamsCardContent): number {
  return Buffer.byteLength(JSON.stringify(wrapCard(content)), "utf8");
}

/** Facts whose value is missing (e.g. no pull request yet in a pre action) are left out. */
function runFacts(run: WorkflowRunSnapshot): TeamsCardFact[] {
  const facts: TeamsCardFact[] = [
    { title: "Status", value: RUN_STATUS_LABELS[run.status] ?? run.status },
    { title: "Source", value: markdownLink(run.source.key, run.source.url) },
    { title: "Pull request", value: pullRequestLink(run.pullRequest) },
  ];
  return facts.filter((fact) => fact.value.trim() !== "");
}

function pullRequestLink(
  pullRequest: WorkflowRunSnapshot["pullRequest"]
): string {
  if (!pullRequest) {
    return "";
  }
  const label =
    pullRequest.number === null ? pullRequest.url : `#${pullRequest.number}`;
  return markdownLink(label, pullRequest.url);
}

function runLinks(run: WorkflowRunSnapshot): TeamsCardLink[] {
  const candidates = [
    { title: "Open run", url: run.url },
    { title: "Open pull request", url: run.pullRequest?.url ?? null },
    {
      title: clip(`Open ${run.source.key}`, ACTION_TITLE_MAX_LENGTH),
      url: run.source.url,
    },
  ];
  // Teams rejects a card whose OpenUrl target is not an absolute URL.
  return candidates.filter(
    (link): link is TeamsCardLink => link.url !== null && isHttpUrl(link.url)
  );
}

function clip(text: string, maxLength: number): string {
  const singleLine = text.replaceAll(WHITESPACE_RUN_RE, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}
