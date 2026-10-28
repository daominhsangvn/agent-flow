import { SourceOperation } from "@repo/api/src/types/connection-grants";
import { PROCESS_ANSWER_MAX } from "@repo/api/src/types/project-process";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { log } from "@repo/observability/log";
import { sourceGrantDefinitions } from "@/lib/integrations/connection-grants";
import {
  createProviderContext,
  type LoadedConnection,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import { truncateText } from "@/lib/integrations/markdown";
import { loadProjectConnectionRuntime } from "@/lib/integrations/project-connections";
import type {
  SourceItemComment,
  SourceItemRef,
} from "@/lib/integrations/types";
import { renderTemplate } from "../template";
import { buildRunSnapshot, snapshotTemplateVariables } from "./snapshot";
import type { EngineRun } from "./step-outcome";

const LOG_PREFIX = "[workflows/source-connection]";

/**
 * The run's source connection with its effective runtime: the project
 * connection whose item started the run (its own account when it has one),
 * else the trigger's own connection (the built-in HTTP endpoint).
 */
export async function loadSourceConnection(
  run: Pick<
    EngineRun,
    "organizationId" | "projectConnectionId" | "connectionId"
  >
): Promise<LoadedConnection | null> {
  if (run.projectConnectionId) {
    const loaded = await loadProjectConnectionRuntime(
      run.organizationId,
      run.projectConnectionId
    );
    return loaded?.connection ?? null;
  }
  return run.connectionId
    ? await loadConnectionRuntime(run.organizationId, run.connectionId)
    : null;
}

/**
 * Removes a label (tag) from the run's source item with its provider's label
 * operation (jira.update_labels, azure_devops.update_tags). The one write on
 * a source system the engine does on its own: a review's feedback label is
 * removed once acted on, so people can add it again (docs/workflows.md
 * "Review loops"). Best effort: true when removed, a failure is logged.
 */
export async function removeSourceLabel(
  run: Pick<
    EngineRun,
    "id" | "organizationId" | "projectConnectionId" | "connectionId"
  >,
  label: string,
  actionRunId: string
): Promise<boolean> {
  const loaded = await loadSourceConnection(run);
  const [definition] = loaded
    ? sourceGrantDefinitions(loaded.provider.key, [SourceOperation.Label])
    : [];
  const config = definition?.configSchema.safeParse({ remove: [label] });
  const snapshot = await buildRunSnapshot(run.id, WorkflowRunEvent.NeedsInput);
  if (!(loaded && definition && config?.success && snapshot)) {
    log.warn(`${LOG_PREFIX} Cannot remove the label from the source item`, {
      runId: run.id,
      label,
    });
    return false;
  }
  const result = await definition.execute({
    ...createProviderContext(loaded.runtime, LOG_PREFIX),
    config: config.data,
    run: snapshot,
    actionRunId,
    attempt: 1,
    render: (template) =>
      renderTemplate(template, snapshotTemplateVariables(snapshot)),
  });
  if (result.status !== WorkflowActionRunStatus.Succeeded) {
    log.warn(`${LOG_PREFIX} Could not remove the label from the source item`, {
      runId: run.id,
      label,
      outcome: result.status,
    });
    return false;
  }
  return true;
}

/**
 * The feedback people wrote on the run's source item for a review round:
 * its comments after `after` (the previous decision; null: any) up to
 * `until` (this decision), except the bot's own, oldest first. Empty when
 * the item cannot be read; the round then points the agent at the item.
 */
export async function readFeedbackComments(
  run: Pick<
    EngineRun,
    "id" | "organizationId" | "projectConnectionId" | "connectionId"
  >,
  item: SourceItemRef | null,
  window: { after: string | null; until: string }
): Promise<string> {
  const loaded = await loadSourceConnection(run);
  const source = loaded?.provider.source;
  if (!(loaded && source && item)) {
    return "";
  }
  try {
    const fetched = await source.fetchItem(
      createProviderContext(loaded.runtime, LOG_PREFIX),
      item
    );
    const bot = loaded.runtime.account?.displayName ?? null;
    const after = window.after ? Date.parse(window.after) : 0;
    const until = Date.parse(window.until) + FEEDBACK_CLOCK_SKEW_MS;
    const comments = fetched.comments.filter(
      (comment) => comment.author !== bot && isWithin(comment, after, until)
    );
    return truncateText(
      comments
        .map(
          (comment) =>
            `${comment.author ?? "Someone"}: ${comment.bodyMarkdown.trim()}`
        )
        .join("\n\n"),
      PROCESS_ANSWER_MAX
    );
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not read the feedback comments`, {
      runId: run.id,
      error,
    });
    return "";
  }
}

/** A comment just before its webhook arrives still belongs to the decision. */
const FEEDBACK_CLOCK_SKEW_MS = 60_000;

function isWithin(
  comment: SourceItemComment,
  after: number,
  until: number
): boolean {
  const at = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
  return Number.isFinite(at) && at > after && at <= until;
}
