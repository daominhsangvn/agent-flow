import { vi } from "vitest";

/**
 * The `project` and `projectConnection` delegates the workflow-service suite
 * needs: the project exists or not, and each of its organization connections
 * is a project connection under the connection row's `key`.
 */

type ConnectionRow = Record<string, unknown> & { id: string };

export function projectDelegates(source: {
  projectExists: () => boolean;
  connections: () => ConnectionRow[];
}) {
  return {
    project: {
      findFirst: vi.fn(() =>
        Promise.resolve(source.projectExists() ? { id: "project" } : null)
      ),
      findMany: vi.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          source.projectExists()
            ? args.where.id.in.map((id) => ({ id, name: "Platform" }))
            : []
        )
      ),
    },
    projectConnection: {
      findMany: vi.fn((args: { where: { projectId: { in: string[] } } }) =>
        Promise.resolve(
          source.projectExists()
            ? args.where.projectId.in.flatMap((projectId) =>
                source.connections().map((row) => ({
                  id: `pc-${row.id}`,
                  projectId,
                  key: row.key,
                  name: row.name,
                  connectionId: row.id,
                  settings: { projectKeys: ["PROJ"] },
                  credentialsEncrypted: null,
                  createdAt: new Date(),
                  connection: { provider: row.provider },
                }))
              )
            : []
        )
      ),
    },
  };
}
