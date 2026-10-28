import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { workflowEmailConfigSchema } from "@repo/api/src/types/workflow-email";
import { log } from "@repo/observability/log";
import type {
  ActionResult,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import {
  describeMailFailure,
  isMailConfigured,
  sendMail,
} from "@/lib/mail-transport";

/**
 * Email actions (WORKFLOW_EMAIL_ACTION_TYPE, docs/workflows.md "Email"): the
 * run event sent as a plain-text email through the server's mail relay. The
 * workflow names the recipients and the events; subject and body are
 * templates, by default what the event asks of people (answers to the
 * step's questions, an approval, a review) with a link to the run.
 */

const LOG_PREFIX = "[workflows/email-action]";

export const MAIL_NOT_CONFIGURED_REASON =
  "the server sends no email: set SMTP_URL (and EMAIL_FROM) in the API's environment";

export async function executeEmailAction(input: {
  config: unknown;
  snapshot: WorkflowRunSnapshot;
  render: (template: string) => string;
  actionRunId: string;
}): Promise<ActionResult> {
  const config = workflowEmailConfigSchema.safeParse(input.config);
  if (!config.success) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      reason:
        "The email action's configuration is no longer valid. Edit the workflow.",
    };
  }
  if (!isMailConfigured()) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      reason: MAIL_NOT_CONFIGURED_REASON,
    };
  }
  const { to, cc, subject, body } = config.data;
  const recipients = [...to, ...(cc ?? [])].length;
  try {
    await sendMail({
      to,
      cc,
      subject: renderSubject(subject, input),
      text: body ? input.render(body) : defaultEmailBody(input.snapshot),
      // Stable across retries of the action run.
      messageId: `<workflow-action-${input.actionRunId}@agentflow>`,
    });
  } catch (error) {
    const failure = describeMailFailure(error);
    log.warn(`${LOG_PREFIX} Email action failed`, {
      runId: input.snapshot.id,
      event: input.snapshot.event,
      retryable: failure.retryable,
      error: failure.message,
    });
    return {
      status: WorkflowActionRunStatus.Failed,
      error: failure.message,
      retryable: failure.retryable,
    };
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    detail: `Sent to ${recipients} recipient${recipients === 1 ? "" : "s"}.`,
  };
}

/** What the event asks of the reader, and the item it is about. */
export function defaultEmailSubject(snapshot: WorkflowRunSnapshot): string {
  const item = snapshot.source.title
    ? `${snapshot.source.key}: ${snapshot.source.title}`
    : snapshot.source.key;
  return `[AgentFlow] ${subjectAsk(snapshot)}: ${item}`;
}

/** The run's summary of the event, then where to find the workflow, item and run. */
export function defaultEmailBody(snapshot: WorkflowRunSnapshot): string {
  const footer = [
    `Workflow: ${snapshot.workflow.name}`,
    snapshot.source.url ? `Item: ${snapshot.source.url}` : null,
    `Run: ${snapshot.url}`,
  ].filter((line) => line !== null);
  return [snapshot.summaryMarkdown, "--", ...footer].join("\n\n");
}

function renderSubject(
  subject: string | undefined,
  input: { snapshot: WorkflowRunSnapshot; render: (template: string) => string }
): string {
  // A subject is one line: a rendered template's line breaks are dropped.
  const rendered = subject
    ? input.render(subject).replaceAll(/\s+/g, " ").trim()
    : "";
  return rendered || defaultEmailSubject(input.snapshot);
}

function subjectAsk(snapshot: WorkflowRunSnapshot): string {
  if (snapshot.event !== WorkflowRunEvent.NeedsInput) {
    return `${snapshot.workflow.name} (${snapshot.event})`;
  }
  if (snapshot.step?.awaitingApproval) {
    return "Approval needed";
  }
  if (snapshot.step?.review) {
    return "Review needed";
  }
  return "Your answer is needed";
}
