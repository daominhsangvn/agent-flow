import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  type NormalizedConnectionGrant,
  PULL_REQUESTS_CONNECTION_KEY,
  type PullRequestOperation,
  SOURCE_CONNECTION_KEY,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import {
  INTEGRATION_ATTACH_COMMAND_ENV,
  INTEGRATION_ATTACHMENT_MAX_BYTES,
  INTEGRATION_COMMENT_ATTACHMENTS_MAX,
  IntegrationToolAccess,
  type IntegrationToolAnnotations,
  type IntegrationToolDescriptor,
  IntegrationToolName,
  operationToolName,
  SOURCE_OPERATION_TOOL,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { sourceGrantDefinitions } from "../connection-grants";
import { findActionDefinition, getIntegrationProvider } from "../registry";
import type {
  IntegrationActionDefinition,
  IntegrationReadDefinition,
  SourceItemRef,
} from "../types";
import { sourceAttachmentReadTools } from "./attachment-read-tool";
import {
  describeProperties,
  fieldProperties,
  objectSchema,
  type ToolProperty,
} from "./field-schema";
import { itemReadTools } from "./item-read-tool";
import { operationReadTools } from "./operation-read-tools";
import { pullRequestTools } from "./pull-request-tools";

/**
 * The integration tools of one agent session (docs/workflows.md "Integration
 * tools"), computed from its `connections:` grants and nothing else:
 *
 * - `integrations_overview` and `source_item_get` (read the run's source
 *   item) are always there when the run has a source connection, and
 *   `source_item_attachment_read` (the text of a file attached to it) when
 *   its provider reads attachments (attachment-read-tool.ts);
 * - `source_item_comment` / `source_item_transition` when `source` grants
 *   comment / transition. They take no item and no connection: the item is
 *   the run's, pinned by AgentFlow, so a key written in the item's text can
 *   never redirect them. The comment takes `attachments` (files the agent
 *   uploaded to the item first) when the provider attaches files;
 * - one tool per external operation granted on a project connection key
 *   (`microsoft_teams_post_message`), whose `connection` argument is an enum
 *   of exactly the keys granting it;
 * - `connection_get_item` to read an item of a granted connection, within
 *   the project connection's containers (item-read-tool.ts).
 *
 * A grant with `approval: required` keeps its tools; their calls wait for a
 * person on the run page.
 *
 * Fields fixed by the grant (`with`) are not arguments. Descriptions follow
 * the rules checked by catalog.test.ts: what it does first, when to use it,
 * the nearest wrong choice, every restriction the server enforces, what it
 * returns. Pure: the API's integration-tools service resolves sessions and
 * carries out the calls.
 */

export const AGENT_TOOL_DESCRIPTION_MAX = 1800;

/** A granted project connection other than the run's source. */
export type GrantedConnection = {
  key: string;
  name: string;
  provider: string;
  projectConnectionId: string;
};

export type AgentToolSessionInput = {
  /** Who the tools serve: "an instruction", `the process step "Fix"`. */
  agent: string;
  workflowName: string;
  runUrl: string;
  source: {
    ref: SourceItemRef;
    /** Provider of the run's source connection; null: no source connection. */
    provider: string | null;
    /** Its project connection key; null for older runs and HTTP endpoints. */
    key: string | null;
  };
  grants: readonly NormalizedConnectionGrant[];
  /** The granted keys other than `source` that exist in the run's project. */
  connections: readonly GrantedConnection[];
  /** The run's pull requests (`pull_requests` grants act on these only). */
  pullRequests: readonly RunPullRequestRef[];
};

/** A pull request of the run, as the pull_request_* tools name it. */
export type RunPullRequestRef = {
  url: string;
  number: number;
  /** Full name of its repository. */
  repository: string;
  provider: string;
};

/** Which review threads pull_request_threads returns. */
export const PullRequestThreadFilter = { Open: "open", All: "all" } as const;
export type PullRequestThreadFilter =
  (typeof PullRequestThreadFilter)[keyof typeof PullRequestThreadFilter];

/** What a call resolves to once its arguments are checked. */
export type PlannedToolCall =
  | { kind: "overview" }
  | { kind: "read_source" }
  | {
      kind: "read_source_attachment";
      /** The file name, as the agent wrote it. */
      name: string;
    }
  | {
      kind: "read_item";
      connection: GrantedConnection;
      /** As the agent wrote it: parsed by the provider when it runs. */
      item: string;
    }
  | {
      kind: "write";
      /** null: the run's source connection. */
      connection: GrantedConnection | null;
      definition: IntegrationActionDefinition<unknown>;
      config: unknown;
      /** Template fields of `config` to render against the run. */
      renderFields: string[];
      /** Ids of files uploaded to the source item that the comment shows. */
      attachments: string[];
      /** The grant requires a person's approval before it is carried out. */
      requiresApproval: boolean;
    }
  | {
      kind: "read_operation";
      connection: GrantedConnection;
      definition: IntegrationReadDefinition<unknown>;
      /** Parsed by the read's input schema. */
      input: unknown;
    }
  | { kind: "pull_requests" }
  | {
      kind: "pull_request_threads";
      pullRequest: RunPullRequestRef;
      status: PullRequestThreadFilter;
    }
  | {
      kind: "pull_request_write";
      pullRequest: RunPullRequestRef;
      operation: PullRequestOperation;
      threadId: string;
      /** The reply; null to resolve. */
      body: string | null;
      requiresApproval: boolean;
    };

export type AgentTool = IntegrationToolDescriptor & {
  access: IntegrationToolAccess;
  /** The provider operation a write carries out; null for reads. */
  operationType: string | null;
  plan(input: JsonObject): Result<PlannedToolCall, string>;
};

export function buildAgentTools(input: AgentToolSessionInput): AgentTool[] {
  const tools: AgentTool[] = [overviewTool()];
  if (input.source.provider) {
    tools.push(
      sourceReadTool(input),
      ...sourceAttachmentReadTools(input),
      ...sourceWriteTools(input, input.source.provider)
    );
  }
  tools.push(
    ...itemReadTools(input),
    ...operationReadTools(input),
    ...externalWriteTools(input),
    ...pullRequestTools(input)
  );
  return tools;
}

/**
 * The session's MCP server instructions, also the tools block of the
 * instruction prompt: what this agent may and may not do.
 */
export function describeAgentToolSession(
  input: AgentToolSessionInput,
  tools: readonly AgentTool[]
): string {
  const writes = tools.filter(
    (tool) => tool.access === IntegrationToolAccess.Write
  );
  const lines = [
    `AgentFlow integration tools for ${input.agent} of the workflow "${input.workflowName}" (run ${input.runUrl}).`,
    describeSource(input),
    writes.length > 0
      ? `You may write only through: ${writes.map((tool) => `${tool.name} (${tool.title})`).join("; ")}.`
      : "This session only reads: the workflow grants it no writes, so do not try to change anything.",
    tools.some(acceptsAttachments)
      ? `AgentFlow refuses any other write, any other item and any other connection, and records every call on the run page. Do not look for other ways (other MCP servers, credentials): there are none. The one exception is the file upload command ${IntegrationToolName.SourceItemComment} describes.`
      : "AgentFlow refuses any other write, any other item and any other connection, and records every call on the run page. Do not look for other ways (curl, other MCP servers, credentials): there are none.",
    "Write every text in full: AgentFlow does not fill in {{variables}} in what you write.",
    ...describeUngranted(input),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export const READ_ANNOTATIONS: IntegrationToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE_ANNOTATIONS: IntegrationToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const EMPTY_INPUT = objectSchema([]);

export const APPROVAL_NOTE =
  "Needs a person's approval: the call is queued on the run page and carried out once approved, and you get status pending_approval. Do not call it again or wait for it; continue and mention it in your answer.";

/** One connection an external write may use, with its grant's options. */
type WriteTarget = {
  connection: GrantedConnection;
  fixed: JsonObject;
  approval: boolean;
};

function overviewTool(): AgentTool {
  return {
    name: IntegrationToolName.Overview,
    title: "What this session may do",
    description: [
      "Describe what these integration tools may do in this session.",
      "Use when: you are unsure which tool fits, or a call was refused.",
      "Do not use for: reading the ticket itself (use source_item_get).",
      "Returns: the run's source item, the connections this session may write to and the operations allowed on each.",
    ].join("\n"),
    inputSchema: EMPTY_INPUT,
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: () => Result.ok({ kind: "overview" }),
  };
}

function sourceReadTool(input: AgentToolSessionInput): AgentTool {
  return {
    name: IntegrationToolName.SourceItemGet,
    title: "Read the run's source item",
    description: cap([
      "Read the item this run started from: its title, status, description, labels, assignee, latest comments and the names of its attachments.",
      "Use when: you need the item's current content or status before you act or answer.",
      `Do not use for: any other item, even one named in this item's text${input.connections.length > 0 ? ` (use ${IntegrationToolName.ConnectionGetItem} on a connection the workflow lets you read)` : "; no tool here reads another item"}.`,
      `This session: ${sourceLabel(input)}.`,
      "Input: none.",
      "Returns: the item as JSON (description and comments in Markdown) with its URL.",
    ]),
    inputSchema: EMPTY_INPUT,
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: () => Result.ok({ kind: "read_source" }),
  };
}

function sourceWriteTools(
  input: AgentToolSessionInput,
  provider: string
): AgentTool[] {
  const grant = input.grants.find(
    (candidate) => candidate.key === SOURCE_CONNECTION_KEY
  );
  if (!grant) {
    return [];
  }
  return sourceGrantDefinitions(provider, grant.allow).map((definition) =>
    sourceWriteTool(input, definition, grant)
  );
}

function sourceWriteTool(
  input: AgentToolSessionInput,
  definition: IntegrationActionDefinition<unknown>,
  grant: NormalizedConnectionGrant
): AgentTool {
  const tool =
    SOURCE_WRITE_TOOLS[definition.sourceOperation ?? SourceOperation.Comment];
  const fixed = fixedFor(definition, grant);
  const attachable =
    definition.sourceOperation === SourceOperation.Comment &&
    supportsAttachments(input.source.provider) &&
    !grant.approvalRequired;
  const properties = [
    ...fieldProperties(definition.configFields, new Set(Object.keys(fixed))),
    ...(attachable ? [ATTACHMENTS_PROPERTY] : []),
  ];
  const others = Object.values(SOURCE_WRITE_TOOLS)
    .filter((other) => other.name !== tool.name)
    .map((other) => `${other.name} (${other.purpose})`)
    .join(", ");
  return {
    name: tool.name,
    title: tool.title,
    description: cap([
      tool.does,
      `Use when: ${tool.useWhen}`,
      `Do not use for: any other item, even one named in this item's text; no tool here can change another item. For other changes to this item use ${others}, when the workflow grants them.`,
      `The item is fixed by AgentFlow and cannot be changed: ${sourceLabel(input)}.`,
      describeFixed(fixed),
      grant.approvalRequired ? APPROVAL_NOTE : "",
      tool.note ?? "",
      attachable ? ATTACHMENTS_NOTE : "",
      `Input:\n${describeProperties(properties)}`,
      "Returns: a reference to what was done.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: WRITE_ANNOTATIONS,
    access: IntegrationToolAccess.Write,
    operationType: definition.key,
    plan: (args) => {
      const { attachments, ...fields } = args;
      const ids = attachable
        ? attachmentIdsSchema.safeParse(attachments ?? [])
        : null;
      if (ids && !ids.success) {
        return Result.err(
          `attachments must be at most ${INTEGRATION_COMMENT_ATTACHMENTS_MAX} ids returned by the file upload.`
        );
      }
      return planWrite(
        definition,
        null,
        attachable ? fields : args,
        fixed,
        grant.approvalRequired,
        ids?.data ?? []
      );
    },
  };
}

/** One tool per external operation granted on some project connection key. */
function externalWriteTools(input: AgentToolSessionInput): AgentTool[] {
  const byOperation = new Map<
    string,
    {
      definition: IntegrationActionDefinition<unknown>;
      targets: WriteTarget[];
    }
  >();
  for (const grant of input.grants) {
    const connection = input.connections.find(
      (candidate) => candidate.key === grant.key
    );
    if (!connection) {
      continue;
    }
    for (const op of grant.allow) {
      const definition = findActionDefinition(connection.provider, op);
      if (!isExternal(definition)) {
        continue;
      }
      const entry = byOperation.get(op) ?? { definition, targets: [] };
      entry.targets.push({
        connection,
        fixed: fixedFor(definition, grant),
        approval: grant.approvalRequired,
      });
      byOperation.set(op, entry);
    }
  }
  return [...byOperation.values()].map(({ definition, targets }) =>
    externalWriteTool(definition, targets)
  );
}

function externalWriteTool(
  definition: IntegrationActionDefinition<unknown>,
  targets: WriteTarget[]
): AgentTool {
  const keys = targets.map((target) => target.connection.key);
  const fixedEverywhere = new Set(
    Object.keys(targets[0]?.fixed ?? {}).filter((field) =>
      targets.every((target) => field in target.fixed)
    )
  );
  const connectionProperty: ToolProperty = {
    key: "connection",
    schema: {
      enum: keys,
      description: `The project connection key to use. One of: ${keys.join(", ")}. Example: "${keys[0] ?? ""}".`,
    },
    required: true,
  };
  const properties = [
    connectionProperty,
    ...fieldProperties(definition.configFields, fixedEverywhere),
  ];
  const providerName =
    getIntegrationProvider(targets[0]?.connection.provider ?? "")
      ?.displayName ?? "the provider";
  return {
    name: operationToolName(definition.key),
    title: `${definition.displayName} (${providerName})`,
    description: cap([
      `${definition.displayName}: ${definition.description}`,
      `Use when: the instruction asks for this on ${providerName}, through one of the connections allowed below.`,
      `Do not use for: the item this run started from (use ${IntegrationToolName.SourceItemComment} / ${IntegrationToolName.SourceItemTransition}), or any connection not listed below.`,
      `Allowed here: ${targets.map((target) => `\`${target.connection.key}\` (${target.connection.name})${describeFixedInline(target.fixed)}${target.approval ? ", needs approval" : ""}`).join("; ")}.`,
      targets.some((target) => target.approval) ? APPROVAL_NOTE : "",
      `Input:\n${describeProperties(properties)}`,
      "Returns: a reference to what was done.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: WRITE_ANNOTATIONS,
    access: IntegrationToolAccess.Write,
    operationType: definition.key,
    plan: (args) => {
      const target = targets.find(
        (candidate) => candidate.connection.key === args.connection
      );
      if (!target) {
        return Result.err(
          `connection must be one of ${keys.join(", ")}: this session may not use "${String(args.connection ?? "")}" for ${definition.key}.`
        );
      }
      const { connection: _key, ...fields } = args;
      return planWrite(
        definition,
        target.connection,
        fields,
        target.fixed,
        target.approval,
        []
      );
    },
  };
}

function isExternal(
  definition: IntegrationActionDefinition<unknown> | null
): definition is IntegrationActionDefinition<unknown> {
  return Boolean(
    definition && !definition.sourceOperation && !definition.repositoryScoped
  );
}

/** The grant's fixed values that are fields of this operation. */
function fixedFor(
  definition: IntegrationActionDefinition<unknown>,
  grant: NormalizedConnectionGrant
): JsonObject {
  const keys = new Set(definition.configFields.map((field) => field.key));
  return Object.fromEntries(
    Object.entries(grant.with).filter(([key]) => keys.has(key))
  );
}

/**
 * The operation's config from the arguments plus the grant's fixed values
 * (which win). Template fields the agent did not write (fixed by the
 * workflow, or left to their default such as `{{summary}}`) are rendered
 * against the run; the agent's own text is used as written.
 */
function planWrite(
  definition: IntegrationActionDefinition<unknown>,
  connection: GrantedConnection | null,
  args: JsonObject,
  fixed: JsonObject,
  requiresApproval: boolean,
  attachments: string[]
): Result<PlannedToolCall, string> {
  const parsed = definition.configSchema.safeParse({ ...args, ...fixed });
  if (parsed.success) {
    return Result.ok({
      kind: "write",
      connection,
      definition,
      config: parsed.data,
      attachments,
      renderFields: definition.configFields
        .filter(
          (field) =>
            field.kind === IntegrationFieldKind.Template &&
            (field.key in fixed || !(field.key in args))
        )
        .map((field) => field.key),
      requiresApproval,
    });
  }
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join(", ");
  return Result.err(`Invalid arguments for ${definition.key}: ${issues}`);
}

function sourceLabel(input: AgentToolSessionInput): string {
  const { ref, provider, key } = input.source;
  const providerName = provider
    ? (getIntegrationProvider(provider)?.displayName ?? provider)
    : ref.provider;
  const title = ref.title ? ` "${ref.title}"` : "";
  const via = key ? ` via connection \`${key}\`` : "";
  return `${providerName} ${ref.key}${title}${via}`;
}

function describeSource(input: AgentToolSessionInput): string {
  return input.source.provider
    ? `The run started from ${sourceLabel(input)}; source_item_get reads it.`
    : "The run has no source item these tools can read.";
}

function describeFixed(fixed: JsonObject): string {
  const entries = Object.entries(fixed);
  return entries.length > 0
    ? `Fixed by the workflow (not arguments): ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(", ")}.`
    : "";
}

function describeFixedInline(fixed: JsonObject): string {
  const entries = Object.entries(fixed);
  return entries.length > 0
    ? `, fixed ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(", ")}`
    : "";
}

/** Grants the session cannot use yet, so the agent knows why a tool is missing. */
function describeUngranted(input: AgentToolSessionInput): string[] {
  const lines: string[] = [];
  for (const grant of input.grants) {
    if (
      grant.key !== SOURCE_CONNECTION_KEY &&
      grant.key !== PULL_REQUESTS_CONNECTION_KEY &&
      !input.connections.some((connection) => connection.key === grant.key)
    ) {
      lines.push(`\`${grant.key}\` is not a connection of the run's project.`);
    }
  }
  return lines;
}

function formatValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function cap(lines: readonly string[]): string {
  return lines
    .filter((line) => line !== "")
    .join("\n")
    .slice(0, AGENT_TOOL_DESCRIPTION_MAX);
}

/** The tool of each write on the run's source item (`source:` grants). */
const SOURCE_WRITE_TOOLS: Record<
  SourceOperation,
  {
    name: IntegrationToolName;
    title: string;
    /** Short, for the other tools' "Do not use for" line. */
    purpose: string;
    does: string;
    useWhen: string;
    note?: string;
  }
> = {
  [SourceOperation.Comment]: {
    name: SOURCE_OPERATION_TOOL[SourceOperation.Comment],
    title: "Comment on the run's source item",
    purpose: "comment",
    does: "Post a comment on the item this run started from.",
    useWhen:
      'the instruction asks you to comment on, reply on or report to "the ticket", "this issue" or "the work item".',
  },
  [SourceOperation.Transition]: {
    name: SOURCE_OPERATION_TOOL[SourceOperation.Transition],
    title: "Move the run's source item to another status",
    purpose: "status",
    does: "Move the item this run started from to another status.",
    useWhen:
      'the instruction asks you to move "the ticket" or "this issue", e.g. to In Progress or Done.',
    note: "If the name matches no transition or status, the error lists the ones available.",
  },
  [SourceOperation.Label]: {
    name: SOURCE_OPERATION_TOOL[SourceOperation.Label],
    title: "Change the labels of the run's source item",
    purpose: "labels or tags",
    does: "Add labels (tags on Azure DevOps) to, or remove them from, the item this run started from.",
    useWhen:
      'the instruction asks you to label "the ticket", or to remove a label from it.',
    note: "Removing a label the item does not have is not an error.",
  },
  [SourceOperation.Link]: {
    name: SOURCE_OPERATION_TOOL[SourceOperation.Link],
    title: "Add a web link to the run's source item",
    purpose: "web links",
    does: "Add a web link to the item this run started from, e.g. the page its plan is reviewed on, so later runs find it.",
    useWhen:
      'the instruction asks you to link a page or document to "the ticket".',
    note: "Adding a link the item already has updates its title.",
  },
};

/** The run's source provider attaches files to its items (IntegrationSourceDefinition.attachFile). */
export function supportsAttachments(provider: string | null): boolean {
  return Boolean(
    provider && getIntegrationProvider(provider)?.source?.attachFile
  );
}

const attachmentIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(INTEGRATION_COMMENT_ATTACHMENTS_MAX);

const ATTACHMENTS_PROPERTY: ToolProperty = {
  key: "attachments",
  schema: {
    type: "array",
    items: { type: "string" },
    maxItems: INTEGRATION_COMMENT_ATTACHMENTS_MAX,
    description:
      "Files the comment shows (images inline): the ids the file upload returned. Leave it out for a text-only comment.",
  },
  required: false,
};

const ATTACHMENTS_NOTE = `Files (test evidence, screenshots, logs): upload each one first with Bash, \`"$${INTEGRATION_ATTACH_COMMAND_ENV}" evidence/login-error.png\` (a content type as second argument is optional), then pass the printed data.output.id values in attachments. The upload attaches the file to the item at once, so upload only what the comment shows. At most ${INTEGRATION_COMMENT_ATTACHMENTS_MAX} files per comment, ${INTEGRATION_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB each.`;

/** The comment tool of this session takes files. */
export function acceptsAttachments(tool: IntegrationToolDescriptor): boolean {
  const properties = tool.inputSchema.properties;
  return (
    tool.name === IntegrationToolName.SourceItemComment &&
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties) &&
    ATTACHMENTS_PROPERTY.key in properties
  );
}
