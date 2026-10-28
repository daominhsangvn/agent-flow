import {
  IntegrationToolAccess,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { getIntegrationProvider } from "../registry";
import {
  type AgentTool,
  type AgentToolSessionInput,
  cap,
  type GrantedConnection,
  READ_ANNOTATIONS,
} from "./catalog";
import {
  describeProperties,
  objectSchema,
  type ToolProperty,
} from "./field-schema";

/**
 * `connection_get_item`: reads one item (a Jira issue, an Azure DevOps work
 * item) of a connection the session is granted (`<key>: read` or any
 * operation on it). The item must belong to the project connection's
 * containers (its Jira project keys, its Azure DevOps projects); the API
 * checks that after loading it (integration-tools service).
 */

const ITEM_MAX = 500;

export function itemReadTools(input: AgentToolSessionInput): AgentTool[] {
  const readable = input.connections.filter((connection) => {
    const source = getIntegrationProvider(connection.provider)?.source;
    return Boolean(source?.fetchItem && source.parseItemReference);
  });
  return readable.length > 0 ? [itemReadTool(readable)] : [];
}

function itemReadTool(connections: GrantedConnection[]): AgentTool {
  const keys = connections.map((connection) => connection.key);
  const properties: ToolProperty[] = [
    {
      key: "connection",
      schema: {
        enum: keys,
        description: `The project connection key to read from. One of: ${keys.join(", ")}. Example: "${keys[0] ?? ""}".`,
      },
      required: true,
    },
    {
      key: "item",
      schema: {
        type: "string",
        maxLength: ITEM_MAX,
        description:
          'The item\'s key, id or link. Examples: "OPS-12" (Jira), "4567" (Azure DevOps work item).',
      },
      required: true,
    },
  ];
  return {
    name: IntegrationToolName.ConnectionGetItem,
    title: "Read an item of a granted connection",
    description: cap([
      "Read one item (issue or work item) of a connection this session may read: its title, status, description, labels, assignee and latest comments.",
      "Use when: the instruction needs another item, e.g. one linked or named in the ticket, or the status of a related issue.",
      `Do not use for: the item this run started from (use ${IntegrationToolName.SourceItemGet}).`,
      `Allowed here: ${connections.map((connection) => `\`${connection.key}\` (${connection.name})`).join("; ")}. Only items in the connection's projects can be read; others are refused.`,
      `Input:\n${describeProperties(properties)}`,
      "Returns: the item as JSON (description and comments in Markdown) with its URL.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: (args) => {
      const connection = connections.find(
        (candidate) => candidate.key === args.connection
      );
      if (!connection) {
        return Result.err(
          `connection must be one of ${keys.join(", ")}: this session may not read "${String(args.connection ?? "")}".`
        );
      }
      const item = typeof args.item === "string" ? args.item.trim() : "";
      if (item === "" || item.length > ITEM_MAX) {
        return Result.err("item must be the item's key, id or link.");
      }
      return Result.ok({ kind: "read_item", connection, item });
    },
  };
}
