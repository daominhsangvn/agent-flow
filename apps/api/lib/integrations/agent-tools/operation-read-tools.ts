import {
  IntegrationToolAccess,
  operationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { getIntegrationProvider } from "../registry";
import type { IntegrationReadDefinition } from "../types";
import {
  type AgentTool,
  type AgentToolSessionInput,
  cap,
  type GrantedConnection,
  READ_ANNOTATIONS,
} from "./catalog";
import {
  describeProperties,
  fieldProperties,
  objectSchema,
  type ToolProperty,
} from "./field-schema";

/**
 * `<provider>_<read>` tools (`confluence_get_page`, ...): the reads a
 * provider offers (IntegrationProviderDefinition.reads), on every key the
 * session is granted (`<key>: read` or any operation on it). Like external
 * writes, `connection` is an enum of exactly those keys; the provider keeps
 * to the project connection's settings (Confluence spaces) when it runs.
 */

export function operationReadTools(input: AgentToolSessionInput): AgentTool[] {
  const byRead = new Map<string, ReadTargets>();
  for (const connection of input.connections) {
    const reads = getIntegrationProvider(connection.provider)?.reads ?? [];
    for (const definition of reads) {
      const entry: ReadTargets = byRead.get(definition.key) ?? {
        definition,
        connections: [],
      };
      entry.connections.push(connection);
      byRead.set(definition.key, entry);
    }
  }
  return [...byRead.values()].map(({ definition, connections }) =>
    operationReadTool(definition, connections)
  );
}

function operationReadTool(
  definition: IntegrationReadDefinition<unknown>,
  connections: GrantedConnection[]
): AgentTool {
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
    ...fieldProperties(definition.inputFields, new Set()),
  ];
  const providerName =
    getIntegrationProvider(connections[0]?.provider ?? "")?.displayName ??
    "the provider";
  return {
    name: operationToolName(definition.key),
    title: `${definition.displayName} (${providerName})`,
    description: cap([
      `${definition.displayName}: ${definition.description}`,
      `Use when: the instruction needs this from ${providerName}, through one of the connections allowed below.`,
      "Do not use for: anything outside the connection's own scope (its spaces or projects); such requests are refused.",
      `Allowed here: ${connections.map((connection) => `\`${connection.key}\` (${connection.name})`).join("; ")}.`,
      `Input:\n${describeProperties(properties)}`,
      "Returns: JSON.",
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
      const { connection: _key, ...fields } = args;
      const parsed = definition.inputSchema.safeParse(fields);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map(
            (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`
          )
          .join(", ");
        return Result.err(`Invalid arguments for ${definition.key}: ${issues}`);
      }
      return Result.ok({
        kind: "read_operation",
        connection,
        definition,
        input: parsed.data,
      });
    },
  };
}

type ReadTargets = {
  definition: IntegrationReadDefinition<unknown>;
  connections: GrantedConnection[];
};
