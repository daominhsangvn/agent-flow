"use client";

import type { JsonObject } from "@repo/api/src/types/common";
import type { IntegrationFieldDescriptor } from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
// Cross-slice: rows show the integrations slice's provider glyph and its
// catalog labels the project settings.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { useIntegrationProviders } from "@repo/app/integrations/hooks/use-integrations";
import { Button } from "@repo/design-system/components/ui/button";
import {
  CheckIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  useProjectConnections,
  useRemoveProjectConnection,
} from "../hooks/use-project-connections";
import { ProjectConnectionForm } from "./project-connection-form";

export type ProjectConnectionsPanelProps = {
  projectId: string;
  /** Project connections are seen and changed by org admins only. */
  isAdmin: boolean;
  /** Org-relative path of the Connections settings, for the "no connection" hint. */
  connectionsSettingsPath?: string;
};

/**
 * Project → Integrations: the organization connections this project uses,
 * each under a key that workflow and process YAML refer to
 * (`connection: jira-billing`). Settings narrow what the project works on
 * (Jira project keys, Azure DevOps projects; each belongs to one project).
 * A connection is one account (one bot): for one bot per workflow the
 * project uses several connections with the same settings.
 */
export function ProjectConnectionsPanel({
  projectId,
  isAdmin,
  connectionsSettingsPath,
}: Readonly<ProjectConnectionsPanelProps>) {
  const connections = useProjectConnections(projectId, { enabled: isAdmin });
  const [editing, setEditing] = useState<ProjectConnection | "new" | null>(
    null
  );

  if (!isAdmin) {
    return (
      <div className="space-y-1">
        <h4 className="font-medium text-sm">Integrations</h4>
        <p className="text-muted-foreground text-xs">
          Only organization admins can see and change the project's integration
          connections.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="project-connections-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-medium text-sm">Integrations</h4>
          <p className="text-muted-foreground text-xs">
            Connections this project's workflows and agents use. Workflow and
            process YAML refer to them by key.
          </p>
        </div>
        <Button
          onClick={() => setEditing(editing === "new" ? null : "new")}
          size="sm"
          type="button"
          variant={editing === "new" ? "ghost" : "outline"}
        >
          {editing === "new" ? (
            "Close"
          ) : (
            <>
              <PlusIcon className="size-3.5" />
              Add connection
            </>
          )}
        </Button>
      </div>
      {editing === "new" ? (
        <ProjectConnectionForm
          connectionsSettingsPath={connectionsSettingsPath}
          onDone={() => setEditing(null)}
          projectId={projectId}
          takenConnectionIds={(connections.data ?? []).map(
            (item) => item.connectionId
          )}
        />
      ) : null}
      <ConnectionList
        editingId={editing !== null && editing !== "new" ? editing.id : null}
        error={connections.error}
        isLoading={connections.isLoading}
        onEdit={setEditing}
        onEditDone={() => setEditing(null)}
        onRetry={() => connections.refetch()}
        projectConnections={connections.data ?? []}
        projectId={projectId}
      />
    </div>
  );
}

type ConnectionListProps = {
  projectId: string;
  projectConnections: ProjectConnection[];
  editingId: string | null;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onEdit: (projectConnection: ProjectConnection) => void;
  onEditDone: () => void;
};

function ConnectionList({
  projectId,
  projectConnections,
  editingId,
  isLoading,
  error,
  onRetry,
  onEdit,
  onEditDone,
}: Readonly<ConnectionListProps>) {
  const remove = useRemoveProjectConnection(projectId);
  const providers = useIntegrationProviders();

  if (error) {
    return (
      <QueryErrorMessage
        error={error}
        onRetry={onRetry}
        title="Couldn't load the project's connections"
      />
    );
  }
  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (projectConnections.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
        No connections yet. Add Jira, Azure DevOps or Teams so workflows can
        start from this project's tickets and agents can work with them.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {projectConnections.map((projectConnection) => (
        <li data-testid="project-connection-row" key={projectConnection.id}>
          {editingId === projectConnection.id ? (
            <div className="p-3">
              <ProjectConnectionForm
                existing={projectConnection}
                onDone={onEditDone}
                projectId={projectId}
              />
            </div>
          ) : (
            <ConnectionRow
              isBusy={remove.isPending}
              onEdit={() => onEdit(projectConnection)}
              onRemove={() => remove.mutate(projectConnection.id)}
              projectConnection={projectConnection}
              settingsFields={
                providers.data?.find(
                  (provider) => provider.key === projectConnection.provider
                )?.projectSettingsFields ?? []
              }
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function ConnectionRow({
  projectConnection,
  settingsFields,
  isBusy,
  onEdit,
  onRemove,
}: Readonly<{
  projectConnection: ProjectConnection;
  settingsFields: readonly IntegrationFieldDescriptor[];
  isBusy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}>) {
  const details = [
    projectConnection.connectionName,
    ...summarizeSettings(settingsFields, projectConnection.settings),
  ];
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <ProviderIcon provider={projectConnection.provider} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{projectConnection.name}</span>
          <KeyChip value={projectConnection.key} />
        </div>
        <span className="block truncate text-muted-foreground text-xs">
          {details.join(" · ")}
        </span>
      </div>
      <Button
        aria-label={`Edit ${projectConnection.name}`}
        disabled={isBusy}
        onClick={onEdit}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <PencilIcon className="size-4" />
      </Button>
      <Button
        aria-label={`Remove ${projectConnection.name}`}
        disabled={isBusy}
        onClick={onRemove}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

/** The key as YAML writes it, with a copy button. */
function KeyChip({ value }: Readonly<{ value: string }>) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    globalThis.navigator?.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
      {value}
      <button
        aria-label={`Copy key ${value}`}
        className="text-muted-foreground hover:text-foreground"
        onClick={onCopy}
        type="button"
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </button>
    </span>
  );
}

/** "Jira projects: AB, CD" for each project settings field with a value. */
export function summarizeSettings(
  fields: readonly IntegrationFieldDescriptor[],
  settings: JsonObject
): string[] {
  return fields.flatMap((field) => {
    const value = settings[field.key];
    if (Array.isArray(value)) {
      return value.length > 0 ? [`${field.label}: ${value.join(", ")}`] : [];
    }
    if (typeof value === "string" && value !== "") {
      return [`${field.label}: ${value}`];
    }
    return [];
  });
}
