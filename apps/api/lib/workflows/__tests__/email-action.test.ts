import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowRunSnapshot,
  WorkflowRunStepSnapshot,
} from "@/lib/integrations/types";
import {
  executeEmailAction,
  MAIL_NOT_CONFIGURED_REASON,
} from "@/lib/workflows/engine/email-action";
import { snapshotTemplateVariables } from "@/lib/workflows/engine/snapshot";
import { renderTemplate } from "@/lib/workflows/template";

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: mocks.createTransport,
}));

const RUN_URL = "https://app.test/acme/workflows/w/runs/run-1";
const SUMMARY = `🛂 The "Approve" step for **CALC-1** waits for an approval in AgentFlow: ${RUN_URL}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SMTP_URL", "smtp://localhost:1025");
  vi.stubEnv("EMAIL_FROM", "AgentFlow <agentflow@acme.dev>");
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  mocks.sendMail.mockResolvedValue({ messageId: "<m@acme.dev>" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("executeEmailAction", () => {
  it("sends the event to the recipients with a subject and body describing it", async () => {
    const result = await send({ to: ["ada@acme.dev"], cc: ["lead@acme.dev"] });

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      detail: "Sent to 2 recipients.",
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const mail = sentMail();
    expect(mail).toMatchObject({
      from: "AgentFlow <agentflow@acme.dev>",
      to: ["ada@acme.dev"],
      cc: ["lead@acme.dev"],
      subject: "[AgentFlow] Approval needed: CALC-1: Add history",
      messageId: "<workflow-action-action-run-1@agentflow>",
    });
    expect(mail.text).toBe(
      [
        SUMMARY,
        "--",
        "Workflow: Calculator",
        "Item: https://jira.test/browse/CALC-1",
        `Run: ${RUN_URL}`,
      ].join("\n\n")
    );
  });

  it("asks for an answer when the step waits on questions", async () => {
    await send(
      { to: ["ada@acme.dev"] },
      { step: step({ awaitingApproval: false, questions: ["Which format?"] }) }
    );

    expect(sentMail().subject).toBe(
      "[AgentFlow] Your answer is needed: CALC-1: Add history"
    );
  });

  it("names the workflow and event for events that ask nothing", async () => {
    await send(
      { to: ["ada@acme.dev"] },
      {
        event: WorkflowRunEvent.Failed,
        step: null,
        source: source({ title: null }),
      }
    );

    expect(sentMail().subject).toBe(
      `[AgentFlow] Calculator (${WorkflowRunEvent.Failed}): CALC-1`
    );
  });

  it("renders the subject and body templates", async () => {
    await send({
      to: ["ada@acme.dev"],
      subject: "Waiting:\n{{source.key}}",
      body: "{{summary}}\n\nOpen {{run.url}}",
    });

    expect(sentMail()).toMatchObject({
      subject: "Waiting: CALC-1",
      text: `${SUMMARY}\n\nOpen ${RUN_URL}`,
    });
  });

  it("skips without SMTP_URL", async () => {
    vi.stubEnv("SMTP_URL", "");

    const result = await send({ to: ["ada@acme.dev"] });

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason: MAIL_NOT_CONFIGURED_REASON,
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("skips a stored config that no longer parses", async () => {
    const result = await send({ to: ["not an address"] });

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("retries when the relay cannot be reached or answers 4xx", async () => {
    mocks.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET" })
    );
    const unreachable = await send({ to: ["ada@acme.dev"] });
    mocks.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("Greylisted"), { responseCode: 451 })
    );
    const greylisted = await send({ to: ["ada@acme.dev"] });

    expect(unreachable).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "The mail relay could not be reached: connect ECONNREFUSED",
      retryable: true,
    });
    expect(greylisted).toMatchObject({ retryable: true });
  });

  it("fails for good when the relay refuses the message (5xx)", async () => {
    mocks.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 })
    );

    const result = await send({ to: ["ada@acme.dev"] });

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "The mail relay refused the message (550): Mailbox unavailable",
      retryable: false,
    });
  });
});

function send(config: unknown, overrides: Partial<WorkflowRunSnapshot> = {}) {
  const run = snapshot(overrides);
  return executeEmailAction({
    config,
    snapshot: run,
    render: (template) =>
      renderTemplate(template, snapshotTemplateVariables(run)),
    actionRunId: "action-run-1",
  });
}

function sentMail(): Record<string, unknown> {
  return mocks.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
}

function step(
  overrides: Partial<WorkflowRunStepSnapshot> = {}
): WorkflowRunStepSnapshot {
  return {
    id: "approve",
    name: "Approve",
    questions: [],
    awaitingApproval: true,
    ...overrides,
  };
}

function source(overrides: Partial<WorkflowRunSnapshot["source"]> = {}) {
  return {
    provider: "jira",
    externalId: "10001",
    key: "CALC-1",
    url: "https://jira.test/browse/CALC-1",
    title: "Add history",
    container: null,
    ...overrides,
  } as WorkflowRunSnapshot["source"];
}

function snapshot(
  overrides: Partial<WorkflowRunSnapshot>
): WorkflowRunSnapshot {
  return {
    id: "run-1",
    url: RUN_URL,
    status: WorkflowRunStatus.NeedsApproval,
    event: WorkflowRunEvent.NeedsInput,
    workflow: { id: "w", name: "Calculator" },
    trigger: null,
    source: source(),
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: null,
    pullRequests: [],
    repositories: [],
    repository: null,
    error: null,
    step: step(),
    reply: null,
    documents: [],
    releaseNotes: null,
    stepReplies: {},
    summaryMarkdown: SUMMARY,
    startedAt: "2026-10-19T08:00:00.000Z",
    completedAt: null,
    ...overrides,
  } as WorkflowRunSnapshot;
}
