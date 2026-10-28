import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { PlannedToolCall } from "@/lib/integrations/agent-tools/catalog";
import {
  createProviderContext,
  type LoadedConnection,
} from "@/lib/integrations/connection-service";
import {
  itemScopeKey,
  loadProjectConnectionRuntime,
  projectScopeKeys,
  scopeContainer,
} from "@/lib/integrations/project-connections";
import {
  type ReadResult,
  RetryableSourceError,
  type SourceItem,
} from "@/lib/integrations/types";
import { isRecord } from "@/lib/type-guards";
import { scrubProviderError } from "@/lib/workflows/engine/errors";
import { snapshotTemplateVariables } from "@/lib/workflows/engine/snapshot";
import {
  renderTemplate,
  type TemplateVariables,
} from "@/lib/workflows/template";
import { findSessionFiles } from "./attachments";
import { executePullRequestWrite } from "./pull-requests";
import type { ToolSessionContext } from "./session-context";

/**
 * Carries out a checked call with the connection's credentials, which never
 * leave the API. A write on the source runs the provider's own action on the
 * run's source item (pinned: the action takes the item from the run); an
 * external write runs it through the granted project connection.
 */

export type ExecutionOutcome =
  | { ok: true; output: JsonValue; externalRef: string | null }
  | { ok: false; error: string; retryable: boolean };

export async function readSourceItem(
  context: ToolSessionContext
): Promise<ExecutionOutcome> {
  const connection = context.sourceConnection;
  const fetchItem = connection?.provider.source?.fetchItem;
  if (!(connection && fetchItem)) {
    return {
      ok: false,
      error: "The run's source item cannot be read through its connection.",
      retryable: false,
    };
  }
  try {
    const item = await fetchItem(
      createProviderContext(connection.runtime, LOG_PREFIX),
      context.snapshot.source
    );
    return { ok: true, output: toItemOutput(item), externalRef: null };
  } catch (error) {
    return {
      ok: false,
      error: scrubProviderError(error, connection.runtime.secrets),
      retryable: error instanceof RetryableSourceError,
    };
  }
}

/** The text of a file attached to the run's source item, read by its provider. */
export async function readSourceAttachment(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "read_source_attachment" }>
): Promise<ExecutionOutcome> {
  const connection = context.sourceConnection;
  const readAttachment = connection?.provider.source?.readAttachment;
  if (!(connection && readAttachment)) {
    return {
      ok: false,
      error:
        "The run's source item's attachments cannot be read through its connection.",
      retryable: false,
    };
  }
  try {
    const file = await readAttachment(
      createProviderContext(connection.runtime, LOG_PREFIX),
      context.snapshot.source,
      plan.name
    );
    return file.ok
      ? {
          ok: true,
          output: {
            name: file.value.name,
            contentType: file.value.contentType,
            size: file.value.size,
            text: file.value.text,
          },
          externalRef: null,
        }
      : {
          ok: false,
          error: file.error.message,
          retryable: file.error.retryable,
        };
  } catch (error) {
    return {
      ok: false,
      error: scrubProviderError(error, connection.runtime.secrets),
      retryable: true,
    };
  }
}

/**
 * Reads an item of a granted connection: parsed and loaded by its provider,
 * then refused unless it belongs to the project connection's containers.
 */
export async function readConnectionItem(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "read_item" }>
): Promise<ExecutionOutcome> {
  const loaded = await loadProjectConnectionRuntime(
    context.session.organizationId,
    plan.connection.projectConnectionId
  );
  const source = loaded?.connection.provider.source;
  if (!(loaded && source?.parseItemReference)) {
    return {
      ok: false,
      error: `The connection \`${plan.connection.key}\` cannot be read right now.`,
      retryable: false,
    };
  }
  const { provider, runtime } = loaded.connection;
  const reference = source.parseItemReference(runtime.config, plan.item);
  if (!reference.ok) {
    return { ok: false, error: reference.error, retryable: false };
  }
  let item: SourceItem;
  try {
    item = await source.fetchItem(createProviderContext(runtime, LOG_PREFIX), {
      provider: provider.key,
      externalId: reference.value.externalId,
      key: reference.value.key,
      url: null,
      title: null,
      container: null,
    });
  } catch (error) {
    return {
      ok: false,
      error: scrubProviderError(error, runtime.secrets),
      retryable: error instanceof RetryableSourceError,
    };
  }
  const scopes = projectScopeKeys(provider, runtime.config, loaded.settings);
  const scope = itemScopeKey(provider, runtime.config, item.container);
  if (scopes.length > 0 && !(scope && scopes.includes(scope))) {
    return {
      ok: false,
      error: `Not allowed: ${item.key} is not in the projects of \`${plan.connection.key}\` (${scopes.map(scopeContainer).join(", ")}).`,
      retryable: false,
    };
  }
  return { ok: true, output: toItemOutput(item), externalRef: null };
}

/**
 * A provider read (`confluence_get_page`) through the granted project
 * connection; the provider keeps to the project connection's settings.
 */
export async function readOperation(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "read_operation" }>
): Promise<ExecutionOutcome> {
  const loaded = await loadProjectConnectionRuntime(
    context.session.organizationId,
    plan.connection.projectConnectionId
  );
  if (!loaded) {
    return {
      ok: false,
      error: `The connection \`${plan.connection.key}\` cannot be read right now (it was removed or its credentials no longer work).`,
      retryable: false,
    };
  }
  const { runtime } = loaded.connection;
  let result: ReadResult;
  try {
    result = await plan.definition.execute(
      createProviderContext(runtime, LOG_PREFIX),
      plan.input
    );
  } catch (error) {
    return {
      ok: false,
      error: scrubProviderError(error, runtime.secrets),
      retryable: true,
    };
  }
  return result.ok
    ? { ok: true, output: result.value, externalRef: null }
    : {
        ok: false,
        error: scrubProviderError(result.error, runtime.secrets),
        retryable: result.retryable,
      };
}

/** A planned call that writes: a provider operation, or a pull request reply or resolve. */
export type WritePlan = Extract<
  PlannedToolCall,
  { kind: "write" } | { kind: "pull_request_write" }
>;

export async function executeWrite(
  context: ToolSessionContext,
  plan: WritePlan,
  callId: string
): Promise<ExecutionOutcome> {
  if (plan.kind === "pull_request_write") {
    return await executePullRequestWrite(context, plan);
  }
  const connection = await writeConnection(context, plan);
  if (!connection.ok) {
    return connection;
  }
  const files = await findSessionFiles(context.session.id, plan.attachments);
  if (!files.ok) {
    return { ok: false, error: files.error, retryable: false };
  }
  const { runtime } = connection.value;
  const variables = snapshotTemplateVariables(context.snapshot);
  let result: Awaited<ReturnType<typeof plan.definition.execute>>;
  try {
    result = await plan.definition.execute({
      ...createProviderContext(runtime, LOG_PREFIX),
      config: renderDefaults(plan, variables),
      run: context.snapshot,
      // The provider's idempotency key: one per call.
      actionRunId: `${context.session.id}:${callId}`,
      attempt:
        context.session.subject.kind === "instruction"
          ? context.session.subject.attempt
          : 1,
      // The agent's own text is used as written.
      render: (template) => template,
      ...(files.value.length > 0 ? { attachments: files.value } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: scrubProviderError(error, runtime.secrets),
      retryable: true,
    };
  }
  switch (result.status) {
    case "succeeded":
      return {
        ok: true,
        output: {
          done: true,
          reference: result.externalRef ?? null,
          ...(result.detail ? { detail: result.detail } : {}),
        },
        externalRef: result.externalRef ?? null,
      };
    case "skipped":
      return { ok: false, error: result.reason, retryable: false };
    default:
      return {
        ok: false,
        error: scrubProviderError(result.error, runtime.secrets),
        retryable: result.retryable,
      };
  }
}

const LOG_PREFIX = "[integration-tools]";
const DESCRIPTION_MAX = 20_000;
const COMMENTS_MAX = 10;

async function writeConnection(
  context: ToolSessionContext,
  plan: Extract<PlannedToolCall, { kind: "write" }>
): Promise<
  | { ok: true; value: LoadedConnection }
  | Extract<ExecutionOutcome, { ok: false }>
> {
  if (!plan.connection) {
    return context.sourceConnection
      ? { ok: true, value: context.sourceConnection }
      : {
          ok: false,
          error: "The run's source connection is no longer available.",
          retryable: false,
        };
  }
  const loaded = await loadProjectConnectionRuntime(
    context.session.organizationId,
    plan.connection.projectConnectionId
  );
  return loaded
    ? { ok: true, value: loaded.connection }
    : {
        ok: false,
        error: `The connection \`${plan.connection.key}\` cannot be used right now (it was removed or its credentials no longer work).`,
        retryable: false,
      };
}

/** The config with its workflow-written template fields rendered. */
function renderDefaults(
  plan: Extract<PlannedToolCall, { kind: "write" }>,
  variables: TemplateVariables
): unknown {
  if (!isRecord(plan.config) || plan.renderFields.length === 0) {
    return plan.config;
  }
  const config: Record<string, unknown> = { ...plan.config };
  for (const key of plan.renderFields) {
    const value = config[key];
    if (typeof value === "string") {
      config[key] = renderTemplate(value, variables);
    }
  }
  return config;
}

/** A source item as an agent tool shows it. */
export function toItemOutput(item: SourceItem): JsonObject {
  return {
    key: item.key,
    title: item.title,
    url: item.url,
    type: item.itemType,
    status: item.status,
    priority: item.priority,
    labels: item.labels,
    assignee: item.assignee,
    reporter: item.reporter,
    description: item.bodyMarkdown.slice(0, DESCRIPTION_MAX),
    sections: item.sections.map((section) => ({
      title: section.title,
      markdown: section.markdown.slice(0, DESCRIPTION_MAX),
    })),
    comments: item.comments.slice(-COMMENTS_MAX).map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.bodyMarkdown,
    })),
    attachments: item.attachments.map((attachment) => ({
      name: attachment.name,
      contentType: attachment.mimeType,
      size: attachment.size,
    })),
  };
}
