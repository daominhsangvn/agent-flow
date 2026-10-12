import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionRunStatus,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
} from "../../types";
import { checkRequestCallbackUrl } from "./callback-hosts";
import type {
  WebhookConnectionConfig,
  WebhookConnectionSecrets,
} from "./connection";
import { describeOutboundFailure, sendOutboundWebhook } from "./outbound";
import { readSigningSecret } from "./signing-secret";
import { optionalHttpUrlSchema, readHttpUrl } from "./urls";

export const WebhookActionType = {
  Post: "webhook.post",
} as const;
export type WebhookActionType =
  (typeof WebhookActionType)[keyof typeof WebhookActionType];

/** Where webhook.post sends the event, in precedence order. */
export const WebhookPostTarget = {
  SourceCallback: "source_callback",
  ActionUrl: "action_url",
  ConnectionCallback: "connection_callback",
} as const;
export type WebhookPostTarget =
  (typeof WebhookPostTarget)[keyof typeof WebhookPostTarget];

export const NO_TARGET_URL_REASON =
  "no target url: set a URL on the action or a default callback URL on the connection";

const TARGET_LABELS: Record<WebhookPostTarget, string> = {
  [WebhookPostTarget.SourceCallback]: "request's callback URL",
  [WebhookPostTarget.ActionUrl]: "action URL",
  [WebhookPostTarget.ConnectionCallback]: "connection's callback URL",
};

export const webhookPostConfigSchema = z.object({
  url: optionalHttpUrlSchema,
  useSourceCallback: z.boolean().default(true),
});
export type WebhookPostConfig = z.infer<typeof webhookPostConfigSchema>;

const POST_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "url",
    label: "URL",
    kind: IntegrationFieldKind.Url,
    required: false,
    placeholder: "https://example.com/hooks/agentflow",
    description: "Defaults to the connection's callback URL.",
  },
  {
    key: "useSourceCallback",
    label: "Prefer the callbackUrl sent with the triggering request",
    kind: IntegrationFieldKind.Boolean,
    defaultValue: true,
    description:
      'When the run was started by an HTTPS request that included "callbackUrl", post there instead. The callback must use one of the connection\'s allowed callback hosts or, when the connection lists none, a public host; otherwise the URL above is used.',
  },
];

type WebhookPostContext = ActionContext<
  WebhookPostConfig,
  WebhookConnectionConfig,
  WebhookConnectionSecrets
>;

export type ResolvedPostTarget = { url: string; target: WebhookPostTarget };

export type PostTargetResolution = {
  /** null when neither the request, the action nor the connection supplies a usable URL. */
  resolved: ResolvedPostTarget | null;
  /** Why the request's callbackUrl was refused; null when it was used, absent or not preferred. */
  sourceCallbackRefusal: string | null;
};

export const webhookPostAction = defineAction<
  WebhookPostConfig,
  WebhookConnectionConfig,
  WebhookConnectionSecrets
>({
  key: WebhookActionType.Post,
  displayName: "Call an HTTPS endpoint",
  description:
    "POSTs {type, timestamp, run} as JSON to an HTTPS endpoint, signed with Standard Webhooks headers when the connection has a signing secret. Retries of an event keep the same webhook-id.",
  configSchema: webhookPostConfigSchema,
  configFields: POST_FIELDS,
  defaultEvents: [...WORKFLOW_POST_ACTION_EVENTS],
  execute: executeWebhookPost,
});

/**
 * Request callbackUrl (when preferred and its host is allowed) → action URL →
 * connection callback URL. A refused request callback falls through to the
 * admin-configured URLs and the refusal is reported with the result.
 */
export function resolvePostTarget(
  context: Pick<WebhookPostContext, "config" | "connection" | "run">
): PostTargetResolution {
  const source = resolveSourceCallback(context);
  if (source.ok && source.value) {
    return {
      resolved: { url: source.value, target: WebhookPostTarget.SourceCallback },
      sourceCallbackRefusal: null,
    };
  }
  const candidates: Array<{ url: unknown; target: WebhookPostTarget }> = [
    { url: context.config.url, target: WebhookPostTarget.ActionUrl },
    {
      url: context.connection.secrets.callbackUrl,
      target: WebhookPostTarget.ConnectionCallback,
    },
  ];
  const sourceCallbackRefusal = source.ok ? null : source.error;
  for (const candidate of candidates) {
    const url = readHttpUrl(candidate.url);
    if (url) {
      return {
        resolved: { url, target: candidate.target },
        sourceCallbackRefusal,
      };
    }
  }
  return { resolved: null, sourceCallbackRefusal };
}

async function executeWebhookPost(
  context: WebhookPostContext
): Promise<ActionResult> {
  const { resolved, sourceCallbackRefusal } = resolvePostTarget(context);
  const refusalNote = sourceCallbackRefusal
    ? `The request's callbackUrl was not used: ${sourceCallbackRefusal}.`
    : null;
  if (!resolved) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      reason: refusalNote
        ? `${NO_TARGET_URL_REASON}. ${refusalNote}`
        : NO_TARGET_URL_REASON,
    };
  }
  const now = context.now();
  const response = await sendOutboundWebhook(context.http, {
    url: resolved.url,
    payload: {
      type: context.run.event,
      timestamp: now.toISOString(),
      run: context.run,
    },
    // Stable across retries, so receivers can de-duplicate redeliveries.
    messageId: context.actionRunId,
    attempt: context.attempt,
    signingSecret: readSigningSecret(context.connection.secrets.signingSecret),
    now,
  });
  const targetLabel = TARGET_LABELS[resolved.target];
  if (response.ok) {
    return {
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: String(response.status),
      detail: withNote(
        `Delivered to the ${targetLabel} (HTTP ${response.status}).`,
        refusalNote
      ),
    };
  }
  context.log.warn("Webhook post action failed", {
    connectionId: context.connection.id,
    runId: context.run.id,
    event: context.run.event,
    target: resolved.target,
    status: response.status,
    retryable: response.retryable,
  });
  return {
    status: WorkflowActionRunStatus.Failed,
    error: withNote(
      `The ${targetLabel} ${describeOutboundFailure(response)}.`,
      refusalNote
    ),
    retryable: response.retryable,
  };
}

/**
 * Ok(url) to post to the request's callbackUrl, Ok(null) when the action
 * does not prefer it or the request sent none, Err(reason) when it was sent
 * but its host is not allowed.
 */
function resolveSourceCallback(
  context: Pick<WebhookPostContext, "config" | "connection" | "run">
): Result<string | null, string> {
  if (!context.config.useSourceCallback) {
    return Result.ok(null);
  }
  const url = readHttpUrl(context.run.sourceExtras.callbackUrl);
  if (!url) {
    return Result.ok(null);
  }
  return checkRequestCallbackUrl(
    url,
    context.connection.config.allowedCallbackHosts
  );
}

function withNote(text: string, note: string | null): string {
  return note ? `${text} ${note}` : text;
}
