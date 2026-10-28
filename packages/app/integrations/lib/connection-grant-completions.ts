import {
  ConnectionAccess,
  SOURCE_CONNECTION_KEY,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import {
  IntegrationOperationTarget,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  type YamlCompletion,
  YamlCompletionKind,
} from "@repo/app/shared/lib/yaml-completion";

/**
 * Suggestions inside a `connections:` grant map (packages/api
 * connection-grants.ts), shared by the workflow editor (an instruction's
 * grant) and the process editor (an agent step's grant): `source` and the
 * project's connection keys, then what each may be granted.
 */

/** A project connection as a grant names it. */
export type GrantableConnection = {
  key: string;
  name: string;
  provider: string;
};

/** `source` and each project connection key (once), as mapping keys. */
export function grantKeyCompletions(
  connections: readonly GrantableConnection[],
  providers: readonly IntegrationProviderSummary[]
): YamlCompletion[] {
  const seen = new Set<string>();
  const unique = connections.filter((connection) => {
    if (seen.has(connection.key)) {
      return false;
    }
    seen.add(connection.key);
    return true;
  });
  return [
    keyCompletion(
      SOURCE_CONNECTION_KEY,
      "the run's source item",
      `Writes on the item that started the run, e.g. source: [${SourceOperation.Comment}, ${SourceOperation.Transition}]; also ${SourceOperation.Label} and ${SourceOperation.Link}.`
    ),
    ...unique.map((connection) =>
      keyCompletion(
        connection.key,
        providerName(providers, connection.provider),
        `${connection.name}: read, or a list of the operations the agent may carry out on it.`
      )
    ),
  ];
}

/** `read`, the source writes, or the external operations of a key's provider. */
export function grantValueCompletions(
  key: string,
  provider: IntegrationProviderSummary | undefined
): YamlCompletion[] {
  const read = value(
    ConnectionAccess.Read,
    "Read only: the agent may look its items up (connection_get_item)"
  );
  if (key === SOURCE_CONNECTION_KEY) {
    return [
      read,
      value(`[${SourceOperation.Comment}]`, "Comment on the source item"),
      value(
        `[${SourceOperation.Transition}]`,
        "Move the source item to another status"
      ),
      value(
        `[${SourceOperation.Comment}, ${SourceOperation.Transition}]`,
        "Comment on and move the source item"
      ),
      value(
        `[${SourceOperation.Label}]`,
        "Add or remove labels (tags) of the source item"
      ),
      value(`[${SourceOperation.Link}]`, "Add a web link to the source item"),
    ];
  }
  const operations = (provider?.actions ?? []).filter(
    (action) => action.target === IntegrationOperationTarget.External
  );
  return [
    read,
    ...operations.map((action) =>
      value(`[${action.key}]`, `${action.displayName}: ${action.description}`)
    ),
  ];
}

/** The grant map's documentation, for a `connections:` key. */
export const CONNECTIONS_GRANT_DOC = {
  detail: "mapping of key: grant",
  info: "What the agent may read and write through its integration tools. source: [comment, transition] on the run's source item; <key>: read reads that connection's items; <key>: [operation types] writes there; { allow, with, approval: required } fixes options or waits for a person's approval on the run page. Left out: it only reads the source item.",
} as const;

function keyCompletion(
  key: string,
  detail: string,
  info: string
): YamlCompletion {
  return {
    label: key,
    insert: `${key}: `,
    kind: YamlCompletionKind.Key,
    detail,
    info,
  };
}

function value(label: string, info: string): YamlCompletion {
  return { label, insert: label, kind: YamlCompletionKind.Value, info };
}

function providerName(
  providers: readonly IntegrationProviderSummary[],
  key: string
): string {
  return providers.find((provider) => provider.key === key)?.displayName ?? key;
}
