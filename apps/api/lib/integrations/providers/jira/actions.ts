import type { JsonValue } from "@repo/api/src/types/common";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import { truncateText } from "../../markdown";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
  HttpMethod,
} from "../../types";
import { markdownToAdf } from "./adf";
import {
  type JiraError,
  jiraIssuePath,
  jiraRequest,
  jiraRequestWithoutBody,
} from "./client";
import { JiraActionType, JiraCommentTarget, JiraDeployment } from "./constants";
import {
  type JiraConnectionConfig,
  type JiraSecrets,
  type JiraTransition,
  jiraCreatedCommentSchema,
  jiraTransitionsSchema,
} from "./schemas";

/**
 * Actions of the Jira provider, usable as pre actions (run.triggered, before
 * the agent team: no plan or pull request yet) and as post actions. Both act
 * on the run's source issue and are skipped when the run did not come from
 * this Jira site. Failures map to ActionResult (retryable for timeouts, 429
 * and 5xx; 4xx are final).
 */

export const JIRA_DEFAULT_COMMENT_TEMPLATE = "{{summary}}";

const MESSAGE_TEMPLATE_MAX_LENGTH = 20_000;
/** Jira rejects comment bodies over 32 767 characters. */
const COMMENT_MAX_LENGTH = 30_000;
const TRANSITION_NAME_MAX_LENGTH = 255;
const LISTED_TRANSITIONS_MAX = 10;

export const jiraAddCommentConfigSchema = z.object({
  message: z
    .string()
    .max(MESSAGE_TEMPLATE_MAX_LENGTH)
    .default(JIRA_DEFAULT_COMMENT_TEMPLATE),
  target: z.enum(JiraCommentTarget).default(JiraCommentTarget.Source),
});
export type JiraAddCommentConfig = z.infer<typeof jiraAddCommentConfigSchema>;

export const jiraTransitionIssueConfigSchema = z.object({
  transitionName: z
    .string()
    .trim()
    .min(1, "Enter the transition or status name")
    .max(TRANSITION_NAME_MAX_LENGTH),
});
export type JiraTransitionIssueConfig = z.infer<
  typeof jiraTransitionIssueConfigSchema
>;

const ADD_COMMENT_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "message",
    label: "Comment",
    kind: IntegrationFieldKind.Template,
    defaultValue: JIRA_DEFAULT_COMMENT_TEMPLATE,
    description:
      "Markdown. Jira Cloud shows it as rich text (headings, lists, links, code); Data Center shows the text as written.",
  },
  {
    key: "target",
    label: "Post on",
    kind: IntegrationFieldKind.Select,
    defaultValue: JiraCommentTarget.Source,
    options: [{ value: JiraCommentTarget.Source, label: "The source issue" }],
  },
];

const TRANSITION_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "transitionName",
    label: "Transition or status",
    kind: IntegrationFieldKind.Text,
    required: true,
    placeholder: "In Review",
    description:
      "Name of the workflow transition, or of the status it leads to (case-insensitive). Skipped when the issue cannot make that transition from its current status.",
  },
];

type JiraActionContext<TConfig> = ActionContext<
  TConfig,
  JiraConnectionConfig,
  JiraSecrets
>;

export const jiraAddCommentAction = defineAction<
  JiraAddCommentConfig,
  JiraConnectionConfig,
  JiraSecrets
>({
  key: JiraActionType.AddComment,
  displayName: "Comment on the Jira issue",
  description:
    "Adds a comment to the Jira issue the run was started from, e.g. the plan link or the pull request.",
  configSchema: jiraAddCommentConfigSchema,
  configFields: ADD_COMMENT_FIELDS,
  defaultEvents: [
    WorkflowRunEvent.Started,
    WorkflowRunEvent.NeedsInput,
    WorkflowRunEvent.Succeeded,
    WorkflowRunEvent.Failed,
  ],
  execute: executeAddComment,
});

export const jiraTransitionIssueAction = defineAction<
  JiraTransitionIssueConfig,
  JiraConnectionConfig,
  JiraSecrets
>({
  key: JiraActionType.TransitionIssue,
  displayName: "Transition the Jira issue",
  description:
    'Moves the Jira issue the run was started from through a workflow transition, e.g. to "In Review" when the pull request is open.',
  configSchema: jiraTransitionIssueConfigSchema,
  configFields: TRANSITION_FIELDS,
  defaultEvents: [WorkflowRunEvent.Succeeded],
  execute: executeTransitionIssue,
});

async function executeAddComment(
  ctx: JiraActionContext<JiraAddCommentConfig>
): Promise<ActionResult> {
  const issue = resolveSourceIssue(ctx);
  if (!issue.ok) {
    return skipped(issue.error);
  }
  const text = truncateText(
    ctx.render(ctx.config.message).trim(),
    COMMENT_MAX_LENGTH
  );
  if (!text) {
    return skipped("The comment is empty after rendering the template.");
  }
  const created = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: jiraIssuePath(issue.value, "comment"),
      body: { body: commentBody(ctx.connection.config, text) },
    },
    jiraCreatedCommentSchema
  );
  if (!created.ok) {
    return failed(ctx, created.error, "add the comment");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: created.value.id,
    detail: `Comment ${created.value.id} added to ${ctx.run.source.key}.`,
  };
}

async function executeTransitionIssue(
  ctx: JiraActionContext<JiraTransitionIssueConfig>
): Promise<ActionResult> {
  const issue = resolveSourceIssue(ctx);
  if (!issue.ok) {
    return skipped(issue.error);
  }
  const available = await jiraRequest(
    ctx,
    { method: HttpMethod.Get, path: jiraIssuePath(issue.value, "transitions") },
    jiraTransitionsSchema
  );
  if (!available.ok) {
    return failed(ctx, available.error, "list the transitions");
  }
  const transitions = available.value.transitions ?? [];
  const transition = findTransition(transitions, ctx.config.transitionName);
  if (!transition) {
    return skipped(
      `No transition "${ctx.config.transitionName}" is available for ${ctx.run.source.key} (available: ${describeTransitions(transitions)}).`
    );
  }
  const moved = await jiraRequestWithoutBody(ctx, {
    method: HttpMethod.Post,
    path: jiraIssuePath(issue.value, "transitions"),
    body: { transition: { id: transition.id } },
  });
  if (!moved.ok) {
    return failed(ctx, moved.error, "transition the issue");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: transition.id,
    detail: `Moved ${ctx.run.source.key} with "${transition.name ?? transition.id}" to ${transition.to?.name ?? "the next status"}.`,
  };
}

/** The issue id (stable across project moves) or key of the run's source, or why the action does not apply. */
function resolveSourceIssue(
  ctx: JiraActionContext<unknown>
): Result<string, string> {
  const source = ctx.run.source;
  if (source.provider !== IntegrationProviderKey.Jira) {
    return Result.err("The run's source is not a Jira issue.");
  }
  if (source.url && !isOnSite(source.url, ctx.connection.config.siteUrl)) {
    return Result.err(
      "The run's source issue is on a different Jira site than this connection."
    );
  }
  return Result.ok(source.externalId || source.key);
}

function commentBody(config: JiraConnectionConfig, text: string): JsonValue {
  if (config.deployment === JiraDeployment.Cloud) {
    return markdownToAdf(text);
  }
  return text;
}

/** Transition name first, then the name of the status it leads to; case-insensitive. */
function findTransition(
  transitions: JiraTransition[],
  wanted: string
): JiraTransition | null {
  const target = normalizeName(wanted);
  return (
    transitions.find(
      (transition) => normalizeName(transition.name) === target
    ) ??
    transitions.find(
      (transition) => normalizeName(transition.to?.name) === target
    ) ??
    null
  );
}

function describeTransitions(transitions: JiraTransition[]): string {
  const names = transitions
    .map((transition) => transition.name ?? transition.to?.name ?? "")
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return "none";
  }
  const listed = names.slice(0, LISTED_TRANSITIONS_MAX).join(", ");
  return names.length > LISTED_TRANSITIONS_MAX ? `${listed}, …` : listed;
}

function isOnSite(url: string, siteUrl: string): boolean {
  return url.toLowerCase().startsWith(`${siteUrl.toLowerCase()}/`);
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function skipped(reason: string): ActionResult {
  return { status: WorkflowActionRunStatus.Skipped, reason };
}

function failed(
  ctx: JiraActionContext<unknown>,
  error: JiraError,
  attempted: string
): ActionResult {
  ctx.log.warn("Jira action failed", {
    connectionId: ctx.connection.id,
    runId: ctx.run.id,
    event: ctx.run.event,
    status: error.status,
    kind: error.kind,
    retryable: error.retryable,
  });
  return {
    status: WorkflowActionRunStatus.Failed,
    error: `Could not ${attempted} on ${ctx.run.source.key}: ${error.message}`,
    retryable: error.retryable,
  };
}
