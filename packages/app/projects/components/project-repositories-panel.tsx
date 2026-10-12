"use client";

import {
  IntegrationCapability,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  type IntegrationProviderSummary,
  type IntegrationRepository,
} from "@repo/api/src/types/integration";
import type { ProjectRepository } from "@repo/api/src/types/project-repository";
// Cross-slice: repository rows show the integrations slice's provider glyph,
// and the add form lists the org's connections from its hooks.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import {
  useIntegrationConnections,
  useIntegrationProviders,
} from "@repo/app/integrations/hooks/use-integrations";
// Cross-slice: same "manage connections" hint the workflow editor shows.
import { MissingConnectionsHint } from "@repo/app/workflows/components/workflow-connection-options";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  useAddProjectRepository,
  useConnectionRepositories,
  useCreateConnectionRepository,
  useProjectRepositories,
  useRemoveProjectRepository,
} from "../hooks/use-project-repositories";

export type ProjectRepositoriesPanelProps = {
  projectId: string;
  /** Org admins add and remove repositories; members see them (the API enforces it). */
  isAdmin: boolean;
  /** Org-relative path of the Connections settings, for the "no connection" hint. */
  connectionsSettingsPath?: string;
};

/**
 * Project → Repositories: the repositories agent loops work in, each added
 * from an integration connection that offers repositories (GitHub, Azure
 * DevOps, Bitbucket, Local Git). A Local Git connection can also create a new
 * repository on the spot, for projects without a remote. The connection keeps
 * the credentials; loops clone and push through it and workflow actions open
 * pull requests with it.
 */
export function ProjectRepositoriesPanel({
  projectId,
  isAdmin,
  connectionsSettingsPath,
}: Readonly<ProjectRepositoriesPanelProps>) {
  const repositories = useProjectRepositories(projectId);
  const [isAdding, setIsAdding] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-medium text-sm">Repositories</h4>
          <p className="text-muted-foreground text-xs">
            Each agent loop checks out all of them, side by side, in one
            workspace folder.
            {isAdmin ? null : " Only organization admins can change them."}
          </p>
        </div>
        {isAdmin ? (
          <Button
            onClick={() => setIsAdding((value) => !value)}
            size="sm"
            type="button"
            variant={isAdding ? "ghost" : "outline"}
          >
            {isAdding ? (
              "Close"
            ) : (
              <>
                <PlusIcon className="size-3.5" />
                Add repository
              </>
            )}
          </Button>
        ) : null}
      </div>
      <RepositoryList
        canRemove={isAdmin}
        error={repositories.error}
        isLoading={repositories.isLoading}
        onRetry={() => repositories.refetch()}
        projectId={projectId}
        repositories={repositories.data ?? []}
      />
      {isAdmin && isAdding ? (
        <AddRepositoryForm
          connectionsSettingsPath={connectionsSettingsPath}
          existing={repositories.data ?? []}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}

type RepositoryListProps = {
  projectId: string;
  canRemove: boolean;
  repositories: ProjectRepository[];
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
};

function RepositoryList({
  projectId,
  canRemove,
  repositories,
  isLoading,
  error,
  onRetry,
}: Readonly<RepositoryListProps>) {
  const remove = useRemoveProjectRepository(projectId);

  if (error) {
    return (
      <QueryErrorMessage
        error={error}
        onRetry={onRetry}
        title="Couldn't load the repositories"
      />
    );
  }
  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (repositories.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
        No repositories yet. Add one from a GitHub, Azure DevOps, Bitbucket or
        Local Git connection, or create one in Local Git.
      </p>
    );
  }
  const isBusy = remove.isPending;
  return (
    <ul className="divide-y rounded-md border">
      {repositories.map((repository) => (
        <li
          className="flex items-center gap-2 px-3 py-2"
          data-testid="project-repository-row"
          key={repository.id}
        >
          <ProviderIcon provider={repository.provider} />
          <div className="min-w-0 flex-1">
            <a
              className="block truncate font-medium text-sm hover:underline"
              href={repository.webUrl}
              rel="noreferrer"
              target="_blank"
            >
              {repository.fullName}
            </a>
            <span className="block truncate text-muted-foreground text-xs">
              {repository.connectionName ??
                "Connection removed: remove this repository and add it again"}
            </span>
          </div>
          {canRemove ? (
            <Button
              aria-label={`Remove ${repository.fullName}`}
              disabled={isBusy}
              onClick={() => remove.mutate(repository.id)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type AddRepositoryFormProps = {
  projectId: string;
  existing: ProjectRepository[];
  connectionsSettingsPath: string | undefined;
};

function AddRepositoryForm({
  projectId,
  existing,
  connectionsSettingsPath,
}: Readonly<AddRepositoryFormProps>) {
  const connections = useRepositoryConnections();
  const [connectionId, setConnectionId] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const selected =
    connections.data.find((connection) => connection.id === connectionId) ??
    null;

  if (connections.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (connections.data.length === 0) {
    return (
      <MissingConnectionsHint
        message="No connection offers repositories yet. Connect GitHub, Azure DevOps, Bitbucket or Local Git in Settings first."
        settingsPath={connectionsSettingsPath}
      />
    );
  }

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(draftQuery.trim());
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <form className="flex flex-wrap gap-2" onSubmit={onSearch}>
        <Select
          onValueChange={(value) => {
            if (value) {
              setConnectionId(value);
            }
          }}
          value={connectionId}
        >
          <SelectTrigger aria-label="Connection" className="w-56" size="sm">
            <SelectValue placeholder="Choose a connection" />
          </SelectTrigger>
          <SelectContent>
            {connections.data.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                <span className="flex items-center gap-2">
                  <ProviderIcon provider={connection.provider} />
                  {connection.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Search repositories"
          className="h-8 min-w-40 flex-1"
          disabled={!selected}
          onChange={(event) => setDraftQuery(event.target.value)}
          placeholder="Filter by name"
          value={draftQuery}
        />
        <Button disabled={!selected} size="sm" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {selected ? (
        <AvailableRepositories
          connection={selected}
          existing={existing}
          projectId={projectId}
          query={query}
        />
      ) : null}
      {selected && connections.canCreate.has(selected.provider) ? (
        <CreateRepositoryForm connection={selected} projectId={projectId} />
      ) : null}
    </div>
  );
}

/**
 * A new repository in the connection (Local Git): created with a first
 * commit on main, then added to the project.
 */
function CreateRepositoryForm({
  projectId,
  connection,
}: Readonly<{ projectId: string; connection: IntegrationConnection }>) {
  const create = useCreateConnectionRepository(connection.id);
  const add = useAddProjectRepository(projectId);
  const [name, setName] = useState("");
  const isBusy = create.isPending || add.isPending;

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const repository = await create
      .mutateAsync({ name: trimmed })
      .catch(() => null);
    if (!repository) {
      return;
    }
    add.mutate(
      { connectionId: connection.id, externalId: repository.externalId },
      { onSuccess: () => setName("") }
    );
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t pt-2"
      data-testid="create-repository-form"
      onSubmit={onCreate}
    >
      <span className="text-muted-foreground text-xs">
        Or create a new repository in {connection.name}:
      </span>
      <Input
        aria-label="New repository name"
        className="h-8 min-w-40 flex-1"
        disabled={isBusy}
        onChange={(event) => setName(event.target.value)}
        placeholder="repository-name"
        value={name}
      />
      <Button
        disabled={isBusy || !name.trim()}
        size="sm"
        type="submit"
        variant="outline"
      >
        {isBusy ? "Creating…" : "Create and add"}
      </Button>
    </form>
  );
}

type AvailableRepositoriesProps = {
  projectId: string;
  connection: IntegrationConnection;
  query: string;
  existing: ProjectRepository[];
};

function AvailableRepositories({
  projectId,
  connection,
  query,
  existing,
}: Readonly<AvailableRepositoriesProps>) {
  const available = useConnectionRepositories(connection.id, query, {
    enabled: true,
  });
  const add = useAddProjectRepository(projectId);
  const added = useMemo(
    () =>
      new Set(
        existing
          .filter((repository) => repository.provider === connection.provider)
          .map((repository) => repository.externalId)
      ),
    [existing, connection.provider]
  );

  if (available.error) {
    return (
      <QueryErrorMessage
        error={available.error}
        onRetry={() => available.refetch()}
        title={`Couldn't list the repositories of ${connection.name}`}
      />
    );
  }
  if (available.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const repositories = available.data ?? [];
  if (repositories.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {query
          ? `No repository matches "${query}".`
          : "The connection cannot access any repository."}
      </p>
    );
  }
  return (
    <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
      {repositories.map((repository) => (
        <AvailableRepositoryRow
          isAdded={added.has(repository.externalId)}
          isPending={add.isPending}
          key={repository.externalId}
          onAdd={() =>
            add.mutate({
              connectionId: connection.id,
              externalId: repository.externalId,
            })
          }
          repository={repository}
        />
      ))}
    </ul>
  );
}

function AvailableRepositoryRow({
  repository,
  isAdded,
  isPending,
  onAdd,
}: Readonly<{
  repository: IntegrationRepository;
  isAdded: boolean;
  isPending: boolean;
  onAdd: () => void;
}>) {
  return (
    <li
      className="flex items-center gap-2 px-3 py-1.5"
      data-testid="available-repository-row"
    >
      <span className="min-w-0 flex-1 truncate text-sm">
        {repository.fullName}
      </span>
      {repository.isPrivate ? (
        <LockIcon
          aria-label="Private"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      <Button
        aria-label={`Add ${repository.fullName}`}
        disabled={isAdded || isPending}
        onClick={onAdd}
        size="sm"
        type="button"
        variant="ghost"
      >
        {isAdded ? "Added" : "Add"}
      </Button>
    </li>
  );
}

/**
 * Enabled connections whose provider offers repositories, and the providers
 * that can also create them.
 */
function useRepositoryConnections(): {
  data: IntegrationConnection[];
  canCreate: ReadonlySet<string>;
  isLoading: boolean;
} {
  const providers = useIntegrationProviders();
  const connections = useIntegrationConnections();
  const canCreate = useMemo(
    () =>
      providersWith(providers.data, IntegrationCapability.RepositoryCreation),
    [providers.data]
  );
  const data = useMemo(() => {
    const repositoryProviders = providersWith(
      providers.data,
      IntegrationCapability.Repositories
    );
    return (connections.data ?? []).filter(
      (connection) =>
        repositoryProviders.has(connection.provider) &&
        connection.status !== IntegrationConnectionStatus.Disabled
    );
  }, [providers.data, connections.data]);
  return {
    data,
    canCreate,
    isLoading: providers.isLoading || connections.isLoading,
  };
}

function providersWith(
  providers: IntegrationProviderSummary[] | undefined,
  capability: IntegrationCapability
): Set<string> {
  return new Set(
    (providers ?? [])
      .filter((provider) => provider.capabilities.includes(capability))
      .map((provider) => provider.key)
  );
}
