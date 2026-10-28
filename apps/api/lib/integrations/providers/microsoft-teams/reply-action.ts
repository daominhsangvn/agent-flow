import type { JsonObject } from "@repo/api/src/types/common";
import { SourceOperation } from "@repo/api/src/types/connection-grants";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
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
  type ItemEditInput,
  type ItemReplyInput,
  type ItemReplyResult,
  type ProviderContext,
} from "../../types";
import {
  checkServiceUrl,
  describeConnectorFailure,
  sendToConversation,
  updateActivity,
} from "./bot-connector";
import {
  readBotCredentials,
  type TeamsConnectionConfig,
  type TeamsConnectionSecrets,
} from "./connection";
import { TeamsExtra } from "./constants";
import { acquireEntraToken, BOT_FRAMEWORK_SCOPE } from "./entra-token";
import { TeamsActionType } from "./post-message-action";

/**
 * microsoft_teams.reply: the bot answers in the channel thread the run came
 * from (a markdown message, optionally mentioning who asked). It acts on the
 * run's source item, so agents can use it as a `source: [comment]` grant,
 * and it is skipped for runs that did not come from a Teams mention.
 */

export const TEAMS_DEFAULT_REPLY_TEMPLATE = "{{summary}}";

const MESSAGE_TEMPLATE_MAX_LENGTH = 20_000;
/** Teams drops bot messages above ~28 KB. */
const REPLY_MAX_LENGTH = 20_000;
const MENTION_NAME_MAX_LENGTH = 100;
const ANGLE_BRACKETS_RE = /[<>]/g;

export const teamsReplyConfigSchema = z.object({
  message: z
    .string()
    .max(MESSAGE_TEMPLATE_MAX_LENGTH)
    .default(TEAMS_DEFAULT_REPLY_TEMPLATE),
  mentionRequester: z.boolean().default(true),
});
export type TeamsReplyConfig = z.infer<typeof teamsReplyConfigSchema>;

const REPLY_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "message",
    label: "Message",
    kind: IntegrationFieldKind.Template,
    defaultValue: TEAMS_DEFAULT_REPLY_TEMPLATE,
    description:
      "Markdown. Teams shows bold, italic, links, lists and code. Long messages are truncated to fit the Teams size limit.",
  },
  {
    key: "mentionRequester",
    label: "Mention who asked",
    kind: IntegrationFieldKind.Boolean,
    defaultValue: true,
    description:
      "Start the reply with an @mention of the person who mentioned the bot.",
  },
];

/** What the run's source extras must hold (set by the inbound bot activity). */
const replyTargetSchema = z.object({
  [TeamsExtra.ServiceUrl]: z.string().min(1),
  [TeamsExtra.ConversationId]: z.string().min(1),
  [TeamsExtra.RequesterId]: z.string().min(1).nullish(),
  [TeamsExtra.RequesterName]: z.string().nullish(),
});

type TeamsReplyContext = ActionContext<
  TeamsReplyConfig,
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>;

export const teamsReplyAction = defineAction<
  TeamsReplyConfig,
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>({
  key: TeamsActionType.Reply,
  displayName: "Reply in the Teams thread",
  description:
    "The bot answers in the channel thread whose mention started the run, e.g. that it is on it, the questions of the plan or the pull request.",
  configSchema: teamsReplyConfigSchema,
  configFields: REPLY_FIELDS,
  sourceOperation: SourceOperation.Comment,
  defaultEvents: [
    WorkflowRunEvent.Started,
    WorkflowRunEvent.NeedsInput,
    WorkflowRunEvent.Succeeded,
    WorkflowRunEvent.Failed,
  ],
  execute: executeReply,
});

async function executeReply(context: TeamsReplyContext): Promise<ActionResult> {
  if (context.run.source.provider !== IntegrationProviderKey.MicrosoftTeams) {
    return skipped("The run did not come from a Teams mention.");
  }
  const target = replyTargetSchema.safeParse(context.run.sourceExtras);
  const serviceUrl = target.success
    ? checkServiceUrl(target.data[TeamsExtra.ServiceUrl])
    : null;
  if (!(target.success && serviceUrl)) {
    return skipped("The run does not say which Teams thread to answer in.");
  }
  const bot = readBotCredentials(context.connection);
  if (!(bot.ok && bot.value)) {
    return failed(
      "The Teams connection has no bot: enter its App ID, tenant ID and client secret.",
      false
    );
  }
  const text = context.render(context.config.message).trim();
  if (!text) {
    return skipped("The message is empty after rendering the template.");
  }
  const token = await acquireEntraToken(
    context.http,
    bot.value,
    BOT_FRAMEWORK_SCOPE,
    context.now()
  );
  if (!token.ok) {
    return failed(token.error.message, token.error.retryable);
  }
  const sent = await sendToConversation(context.http, {
    serviceUrl,
    token: token.value,
    conversationId: target.data[TeamsExtra.ConversationId],
    activity: buildReplyActivity(text, {
      id: context.config.mentionRequester
        ? (target.data[TeamsExtra.RequesterId] ?? null)
        : null,
      name: target.data[TeamsExtra.RequesterName] ?? null,
    }),
  });
  if (sent.ok) {
    return {
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: sent.value.id ?? undefined,
      detail: `Replied in the Teams thread of ${context.run.source.key}.`,
    };
  }
  context.log.warn("Teams reply was not accepted", {
    connectionId: context.connection.id,
    runId: context.run.id,
    event: context.run.event,
    status: sent.error.status,
    retryable: sent.error.retryable,
  });
  return failed(describeConnectorFailure(sent.error), sent.error.retryable);
}

/**
 * The project orchestrator's message in the Teams thread of a conversation
 * (docs/orchestrator.md), mentioning whoever asked last. Must not throw.
 */
export async function teamsReplyOnItem(
  context: ProviderContext<TeamsConnectionConfig, TeamsConnectionSecrets>,
  input: ItemReplyInput
): Promise<ItemReplyResult> {
  return await withThreadBot(context, input, async (bot) => {
    const sent = await sendToConversation(context.http, {
      serviceUrl: bot.serviceUrl,
      token: bot.token,
      conversationId: bot.conversationId,
      activity: buildReplyActivity(bot.text, bot.requester),
    });
    return sent.ok
      ? { ok: true, externalRef: sent.value.id ?? null }
      : {
          ok: false,
          error: describeConnectorFailure(sent.error),
          retryable: sent.error.retryable,
        };
  });
}

/** Replaces a message the orchestrator posted in a Teams thread. Must not throw. */
export async function teamsEditOnItem(
  context: ProviderContext<TeamsConnectionConfig, TeamsConnectionSecrets>,
  input: ItemEditInput
): Promise<ItemReplyResult> {
  return await withThreadBot(context, input, async (bot) => {
    const updated = await updateActivity(context.http, {
      serviceUrl: bot.serviceUrl,
      token: bot.token,
      conversationId: bot.conversationId,
      activityId: input.externalRef,
      activity: buildReplyActivity(bot.text, { id: null, name: null }),
    });
    return updated.ok
      ? { ok: true, externalRef: updated.value.id ?? input.externalRef }
      : {
          ok: false,
          error: describeConnectorFailure(updated.error),
          retryable: updated.error.retryable,
        };
  });
}

type ThreadBot = {
  serviceUrl: URL;
  token: string;
  conversationId: string;
  requester: { id: string | null; name: string | null };
  text: string;
};

/** The thread, the bot's token and the text, or why the message cannot go out. */
async function withThreadBot(
  context: ProviderContext<TeamsConnectionConfig, TeamsConnectionSecrets>,
  input: { extras: JsonObject | null; text: string },
  send: (bot: ThreadBot) => Promise<ItemReplyResult>
): Promise<ItemReplyResult> {
  const target = replyTargetSchema.safeParse(input.extras ?? {});
  const serviceUrl = target.success
    ? checkServiceUrl(target.data[TeamsExtra.ServiceUrl])
    : null;
  if (!(target.success && serviceUrl)) {
    return {
      ok: false,
      error: "The conversation does not say which Teams thread to answer in.",
      retryable: false,
    };
  }
  const bot = readBotCredentials(context.connection);
  if (!(bot.ok && bot.value)) {
    return {
      ok: false,
      error:
        "The Teams connection has no bot: enter its App ID, tenant ID and client secret.",
      retryable: false,
    };
  }
  const text = input.text.trim();
  if (!text) {
    return { ok: false, error: "The message is empty.", retryable: false };
  }
  try {
    const token = await acquireEntraToken(
      context.http,
      bot.value,
      BOT_FRAMEWORK_SCOPE,
      context.now()
    );
    if (!token.ok) {
      return {
        ok: false,
        error: token.error.message,
        retryable: token.error.retryable,
      };
    }
    return await send({
      serviceUrl,
      token: token.value,
      conversationId: target.data[TeamsExtra.ConversationId],
      requester: {
        id: target.data[TeamsExtra.RequesterId] ?? null,
        name: target.data[TeamsExtra.RequesterName] ?? null,
      },
      text,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

/** A markdown message, starting with an @mention of the requester when given. */
export function buildReplyActivity(
  text: string,
  requester: { id: string | null; name: string | null }
): JsonObject {
  const body = truncateText(text, REPLY_MAX_LENGTH);
  if (!requester.id) {
    return { type: "message", textFormat: "markdown", text: body };
  }
  const name =
    (requester.name ?? "")
      .replaceAll(ANGLE_BRACKETS_RE, "")
      .trim()
      .slice(0, MENTION_NAME_MAX_LENGTH) || "there";
  const mention = `<at>${name}</at>`;
  return {
    type: "message",
    textFormat: "markdown",
    text: `${mention} ${body}`,
    entities: [
      {
        type: "mention",
        text: mention,
        mentioned: { id: requester.id, name },
      },
    ],
  };
}

function skipped(reason: string): ActionResult {
  return { status: WorkflowActionRunStatus.Skipped, reason };
}

function failed(error: string, retryable: boolean): ActionResult {
  return { status: WorkflowActionRunStatus.Failed, error, retryable };
}
