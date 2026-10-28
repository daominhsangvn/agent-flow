"use client";

// Cross-slice: the projects using a connection are project connections,
// owned by the projects slice.
import { useConnectionProjects } from "@repo/app/projects/hooks/use-project-connections";
import { QueryErrorMessage } from "./query-error-message";

/**
 * "Used by projects" of a connection's settings dialog: each project that
 * uses the connection, with the key its workflows refer to and whether it
 * uses an account of its own. Fetched when the dialog shows it.
 */
export function IntegrationConnectionProjects({
  connectionId,
}: Readonly<{ connectionId: string }>) {
  const projects = useConnectionProjects(connectionId, { enabled: true });

  if (projects.error) {
    return (
      <QueryErrorMessage
        error={projects.error}
        onRetry={() => projects.refetch()}
        title="Couldn't load the projects using this connection"
      />
    );
  }
  const rows = projects.data ?? [];
  return (
    <section className="space-y-1" data-testid="connection-projects">
      <h4 className="font-medium text-sm">Used by projects</h4>
      {projects.isLoading ? (
        <p className="text-muted-foreground text-xs">Loading…</p>
      ) : null}
      {!projects.isLoading && rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No project uses this connection yet. Add it in a project's
          Integrations tab.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="space-y-0.5 text-xs">
          {rows.map((row) => (
            <li className="flex flex-wrap gap-1" key={row.projectConnectionId}>
              <span className="font-medium">{row.projectName}</span>
              <span className="font-mono text-muted-foreground">{row.key}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
