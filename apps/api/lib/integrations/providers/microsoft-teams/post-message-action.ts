import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
} from "../../types";
import { buildRunCardContent, buildTeamsMessage } from "./adaptive-card";
import type {
  TeamsConnectionConfig,
  TeamsConnectionSecrets,
} from "./connection";
import { describeTeamsFailure, postTeamsMessage } from "./teams-client";
import { checkTeamsWebhookUrl } from "./webhook-url";

export const TeamsActionType = {
  PostMessage: "microsoft_teams.post_message",
} as const;
export type TeamsActionType =
  (typeof TeamsActionType)[keyof typeof TeamsActionType];

export const TEAMS_DEFAULT_TITLE_TEMPLATE = "{{workflow.name}}: {{source.key}}";
export const TEAMS_DEFAULT_MESSAGE_TEMPLATE = "{{summary}}";

const TITLE_TEMPLATE_MAX_LENGTH = 500;
const MESSAGE_TEMPLATE_MAX_LENGTH = 20_000;

export const teamsPostMessageConfigSchema = z.object({
  title: z
    .string()
    .max(TITLE_TEMPLATE_MAX_LENGTH)
    .default(TEAMS_DEFAULT_TITLE_TEMPLATE),
  message: z
    .string()
    .max(MESSAGE_TEMPLATE_MAX_LENGTH)
    .default(TEAMS_DEFAULT_MESSAGE_TEMPLATE),
  includeFacts: z.boolean().default(true),
});
export type TeamsPostMessageConfig = z.infer<
  typeof teamsPostMessageConfigSchema
>;

const POST_MESSAGE_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "title",
    label: "Title",
    kind: IntegrationFieldKind.Template,
    defaultValue: TEAMS_DEFAULT_TITLE_TEMPLATE,
    description: "Bold first line of the card.",
  },
  {
    key: "message",
    label: "Message",
    kind: IntegrationFieldKind.Template,
    defaultValue: TEAMS_DEFAULT_MESSAGE_TEMPLATE,
    description:
      "Markdown. Teams shows bold, italic, links and lists; headings become bold lines. Long messages are truncated to fit the Teams size limit.",
  },
  {
    key: "includeFacts",
    label: "Show status, source and pull request",
    kind: IntegrationFieldKind.Boolean,
    defaultValue: true,
  },
];

type TeamsPostMessageContext = ActionContext<
  TeamsPostMessageConfig,
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>;

export const teamsPostMessageAction = defineAction<
  TeamsPostMessageConfig,
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>({
  key: TeamsActionType.PostMessage,
  displayName: "Post to a Teams channel",
  description:
    "Posts an Adaptive Card with the run status, the source item and links to the run and pull request (when there is one) to the channel of the Workflows webhook.",
  configSchema: teamsPostMessageConfigSchema,
  configFields: POST_MESSAGE_FIELDS,
  defaultEvents: [
    WorkflowRunEvent.NeedsInput,
    WorkflowRunEvent.Succeeded,
    WorkflowRunEvent.Failed,
  ],
  execute: executePostMessage,
});

async function executePostMessage(
  context: TeamsPostMessageContext
): Promise<ActionResult> {
  const webhookUrl = checkTeamsWebhookUrl(
    context.connection.secrets.webhookUrl
  );
  if (!webhookUrl.ok) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: webhookUrl.error,
      retryable: false,
    };
  }
  const content = buildRunCardContent(context.run, {
    title: context.render(context.config.title),
    message: context.render(context.config.message),
    includeFacts: context.config.includeFacts,
  });
  const response = await postTeamsMessage(
    context.http,
    webhookUrl.value,
    buildTeamsMessage(content)
  );
  if (response.ok) {
    return {
      status: WorkflowActionRunStatus.Succeeded,
      detail: `Teams accepted the message (HTTP ${response.status}).`,
    };
  }
  context.log.warn("Teams message was not accepted", {
    connectionId: context.connection.id,
    runId: context.run.id,
    event: context.run.event,
    status: response.status,
    retryable: response.retryable,
  });
  return {
    status: WorkflowActionRunStatus.Failed,
    error: describeTeamsFailure(response),
    retryable: response.retryable,
  };
}
