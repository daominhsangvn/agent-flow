"use client";

import {
  type NormalizedConnectionGrant,
  normalizeConnectionGrants,
  SOURCE_CONNECTION_KEY,
} from "@repo/api/src/types/connection-grants";
import { IntegrationOperationTarget } from "@repo/api/src/types/integration";
import {
  IntegrationToolName,
  operationToolName,
  SOURCE_OPERATION_TOOL,
} from "@repo/api/src/types/integration-tools";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowActionInput,
  WorkflowActionStage,
  WorkflowRunEvent,
  type WorkflowTriggerInput,
  workflowInstructionConfigSchema,
} from "@repo/api/src/types/workflow";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  WORKFLOW_EMAIL_LABEL,
  workflowEmailConfigSchema,
} from "@repo/api/src/types/workflow-email";
import { Badge } from "@repo/design-system/components/ui/badge";
import { findActionDefinition } from "../lib/workflow-catalog";
import {
  WORKFLOW_INSTRUCTION_LABEL,
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_RUN_EVENT_ORDER,
} from "../lib/workflow-labels";
import {
  BUILT_IN_HTTP_REFERENCE,
  type WorkflowYamlCatalog,
} from "../lib/workflow-yaml-schema";

/**
 * What the YAML being edited does on a run, read back from the save body:
 * per run event in lifecycle order, the actions that run on it in list
 * order, each with what it is (an instruction or a type), the connection
 * it works on (including the one the run will choose when the action names
 * none) and, for an instruction, what its agent may write. It lets an admin
 * check the order, the connections and the grants before saving.
 */

export type WorkflowActionsPreviewProps = {
  actions: readonly WorkflowActionInput[];
  triggers: readonly WorkflowTriggerInput[];
  catalog: Pick<WorkflowYamlCatalog, "providers">;
};

export function WorkflowActionsPreview({
  actions,
  triggers,
  catalog,
}: Readonly<WorkflowActionsPreviewProps>) {
  const groups = groupByEvent(actions);
  return (
    <section
      aria-label="Actions in run order"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <h3 className="font-medium">Actions in run order</h3>
      {groups.length === 0 ? (
        <p className="text-muted-foreground">
          No actions: a run imports the item and the agent team works on it, and
          nothing is written back to the source system.
        </p>
      ) : (
        <ol className="space-y-3">
          {groups.map((group) => (
            <li className="space-y-1" key={group.event}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {WORKFLOW_RUN_EVENT_LABELS[group.event]}
                </span>
                <code className="text-muted-foreground text-xs">
                  {group.event}
                </code>
                {group.event === WorkflowRunEvent.Triggered ? (
                  <Badge variant="info">before the agent team</Badge>
                ) : null}
              </div>
              <ul className="space-y-1 pl-4">
                {group.items.map((item) => (
                  <ActionLine
                    catalog={catalog}
                    item={item}
                    key={`${group.event}-${item.index}`}
                    triggers={triggers}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type IndexedAction = { action: WorkflowActionInput; index: number };

type EventGroup = { event: WorkflowRunEvent; items: IndexedAction[] };

function ActionLine({
  item,
  triggers,
  catalog,
}: Readonly<{
  item: IndexedAction;
  triggers: readonly WorkflowTriggerInput[];
  catalog: Pick<WorkflowYamlCatalog, "providers">;
}>) {
  const { action, index } = item;
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground tabular-nums">
        Action {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium">
            {describeKind(action, catalog)}
          </span>
          {action.enabled ? null : <Badge variant="muted">disabled</Badge>}
          {action.continueOnError ? (
            <Badge variant="warning">continues on error</Badge>
          ) : null}
        </div>
        <div className="break-words text-muted-foreground text-xs">
          {describeConnection(action, triggers, catalog)}
        </div>
      </div>
    </li>
  );
}

/** The actions of each event, in lifecycle order; list order within one. */
function groupByEvent(actions: readonly WorkflowActionInput[]): EventGroup[] {
  const indexed = actions.map((action, index) => ({ action, index }));
  return WORKFLOW_RUN_EVENT_ORDER.flatMap((event) => {
    const items = indexed.filter(({ action }) => runsOn(action, event));
    return items.length > 0 ? [{ event, items }] : [];
  });
}

function runsOn(action: WorkflowActionInput, event: WorkflowRunEvent): boolean {
  if (action.stage === WorkflowActionStage.Pre) {
    return event === WorkflowRunEvent.Triggered;
  }
  return action.events.includes(event);
}

/** `Instruction: "Move the issue…"` or `Create pull request (type)`. */
function describeKind(
  action: WorkflowActionInput,
  catalog: Pick<WorkflowYamlCatalog, "providers">
): string {
  if (action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    const config = workflowInstructionConfigSchema.safeParse(action.config);
    const text = config.success ? firstLine(config.data.instruction) : "";
    return `${WORKFLOW_INSTRUCTION_LABEL}: "${text}"`;
  }
  if (action.type === WORKFLOW_EMAIL_ACTION_TYPE) {
    const config = workflowEmailConfigSchema.safeParse(action.config);
    const to = config.success ? config.data.to.join(", ") : "";
    return `${WORKFLOW_EMAIL_LABEL} to ${to}`;
  }
  const definition = findActionDefinition(catalog.providers, action.type);
  return definition
    ? `${definition.displayName} (${action.type})`
    : action.type;
}

/** Where the action works, including the run's choice when it names none. */
function describeConnection(
  action: WorkflowActionInput,
  triggers: readonly WorkflowTriggerInput[],
  catalog: Pick<WorkflowYamlCatalog, "providers">
): string {
  if (action.connectionKey) {
    const definition = findActionDefinition(catalog.providers, action.type);
    return definition?.target === IntegrationOperationTarget.SourceItem
      ? `On ${action.connectionKey}: only for runs started from it (never another connection).`
      : `On ${action.connectionKey}.`;
  }
  if (!action.automaticConnection) {
    return `On ${BUILT_IN_HTTP_REFERENCE}: the workflow's own HTTPS call.`;
  }
  if (action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return describeInstructionAccess(action, triggers);
  }
  if (action.type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return "Sent by AgentFlow through the server's mail relay (SMTP_URL).";
  }
  const definition = findActionDefinition(catalog.providers, action.type);
  if (definition?.repositoryScoped) {
    return "Connection chosen by the run: every connection that holds a repository the agent team pushed (one pull request per repository).";
  }
  if (definition?.target === IntegrationOperationTarget.SourceItem) {
    return `On the run's source item, through the connection whose trigger started the run (${triggerKeys(triggers)}).`;
  }
  return `Connection chosen by the run: the project's only connection that offers ${action.type}.`;
}

/** What an instruction's agent reads and may write. */
function describeInstructionAccess(
  action: WorkflowActionInput,
  triggers: readonly WorkflowTriggerInput[]
): string {
  const config = workflowInstructionConfigSchema.safeParse(action.config);
  const grants = normalizeConnectionGrants(
    config.success ? config.data.connections : undefined
  );
  const writes = grants
    .filter((grant) => grant.allow.length > 0)
    .map((grant) => `${grant.key}: ${grant.allow.join(", ")}`);
  const reads = grants
    .filter(
      (grant) => grant.allow.length === 0 && grant.key !== SOURCE_CONNECTION_KEY
    )
    .map((grant) => grant.key);
  const parts = [
    `Reads the run's source item (${triggerKeys(triggers)})${reads.length > 0 ? ` and ${reads.join(", ")}` : ""}.`,
    writes.length > 0
      ? `May write: ${writes.join("; ")}.`
      : "Read-only: list writes under connections: (e.g. source: [comment]).",
    `Agent tools: ${agentToolNames(grants).join(", ")}.`,
  ];
  return parts.join(" ");
}

/**
 * The integration tools a grant gives the agent (the API's catalog decides
 * for sure: a key the project lacks gives none); "(approval)" marks writes
 * that wait for a person.
 */
function agentToolNames(
  grants: readonly NormalizedConnectionGrant[]
): string[] {
  const names: string[] = [IntegrationToolName.SourceItemGet];
  if (grants.some((grant) => grant.key !== SOURCE_CONNECTION_KEY)) {
    names.push(IntegrationToolName.ConnectionGetItem);
  }
  for (const grant of grants) {
    const approval = grant.approvalRequired ? " (approval)" : "";
    for (const op of grant.allow) {
      names.push(`${grantToolName(grant.key, op)}${approval}`);
    }
  }
  return [...new Set(names)];
}

function grantToolName(key: string, operation: string): string {
  if (key !== SOURCE_CONNECTION_KEY) {
    return operationToolName(operation);
  }
  const tool = Object.entries(SOURCE_OPERATION_TOOL).find(
    ([sourceOperation]) => sourceOperation === operation
  )?.[1];
  return tool ?? operationToolName(operation);
}

function triggerKeys(triggers: readonly WorkflowTriggerInput[]): string {
  return [
    ...new Set(
      triggers.map(
        (trigger) => trigger.connectionKey ?? BUILT_IN_HTTP_REFERENCE
      )
    ),
  ].join(" or ");
}

function firstLine(text: string): string {
  const [line = ""] = text.trim().split("\n");
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line;
}

const LINE_MAX = 100;
