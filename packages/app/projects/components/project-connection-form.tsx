"use client";

import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  PROJECT_CONNECTIONS_ADD_MAX,
  type ProjectConnection,
  projectConnectionKeySchema,
  suggestProjectConnectionKey,
} from "@repo/api/src/types/project-connection";
// Cross-slice: the form lists the org's connections and renders the
// provider's field descriptors with the integrations slice's generic form.
import { IntegrationFieldForm } from "@repo/app/integrations/components/integration-field-form";
import { MutationErrorMessage } from "@repo/app/integrations/components/mutation-error-message";
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import {
  useIntegrationConnections,
  useIntegrationProviders,
} from "@repo/app/integrations/hooks/use-integrations";
import {
  buildFieldValues,
  collectFieldValues,
  hasFieldErrors,
  type IntegrationFieldErrors,
  type IntegrationFieldValues,
  validateFieldValues,
} from "@repo/app/integrations/lib/integration-field-values";
// Cross-slice: same "manage connections" hint the workflow editor shows.
import { MissingConnectionsHint } from "@repo/app/workflows/components/workflow-connection-options";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { type FormEvent, useMemo, useState } from "react";
import {
  ProjectConnectionMutationErrorTitle,
  useAddProjectConnection,
  useUpdateProjectConnection,
} from "../hooks/use-project-connections";

export type ProjectConnectionFormProps = {
  projectId: string;
  /** The project connection to edit; omitted to add some. */
  existing?: ProjectConnection;
  /** Connections already in the project (a connection is added once). */
  takenConnectionIds?: readonly string[];
  onDone: () => void;
  connectionsSettingsPath?: string;
};

/**
 * Adds project connections, or edits one. A connection is one account (one
 * Jira bot): adding picks one or more connections of one integration, each
 * under its own key (suggested from its name, never changed after creation),
 * with the same project settings, so each workflow can use its own bot on the
 * same Jira projects. Editing changes the name and the settings.
 */
export function ProjectConnectionForm({
  projectId,
  existing,
  takenConnectionIds = [],
  onDone,
  connectionsSettingsPath,
}: Readonly<ProjectConnectionFormProps>) {
  const providers = useIntegrationProviders();
  const connections = useIntegrationConnections();
  const usable = useMemo(
    () => usableConnections(connections.data ?? [], providers.data ?? []),
    [connections.data, providers.data]
  );

  if (connections.isLoading || providers.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (existing) {
    const provider =
      (providers.data ?? []).find((item) => item.key === existing.provider) ??
      null;
    return provider ? (
      <div className="space-y-3 rounded-md border p-3">
        <EditFields
          existing={existing}
          onDone={onDone}
          projectId={projectId}
          provider={provider}
        />
      </div>
    ) : null;
  }
  if (usable.length === 0) {
    return (
      <MissingConnectionsHint
        message="No connection can be added yet. Connect Jira, Azure DevOps or Teams in Settings first."
        settingsPath={connectionsSettingsPath}
      />
    );
  }
  return (
    <div className="space-y-3 rounded-md border p-3">
      <AddFields
        connections={usable}
        onDone={onDone}
        projectId={projectId}
        providers={providers.data ?? []}
        takenConnectionIds={takenConnectionIds}
      />
    </div>
  );
}

type Selection = {
  connectionId: string;
  name: string;
  key: string;
  isKeyEdited: boolean;
};

type EntryErrors = { name?: string; key?: string };

type AddErrors = {
  connections?: string;
  entries?: Record<string, EntryErrors>;
  settings?: IntegrationFieldErrors;
};

function AddFields({
  projectId,
  connections,
  providers,
  takenConnectionIds,
  onDone,
}: Readonly<{
  projectId: string;
  connections: readonly IntegrationConnection[];
  providers: readonly IntegrationProviderSummary[];
  takenConnectionIds: readonly string[];
  onDone: () => void;
}>) {
  const add = useAddProjectConnection(projectId);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [settings, setSettings] = useState<IntegrationFieldValues>({});
  const [errors, setErrors] = useState<AddErrors>({});
  const byId = new Map(connections.map((item) => [item.id, item]));
  const providerKey = selected[0]
    ? byId.get(selected[0].connectionId)?.provider
    : undefined;
  const provider =
    providers.find((item) => item.key === providerKey) ?? undefined;

  const toggle = (connection: IntegrationConnection, checked: boolean) => {
    if (!checked) {
      setSelected((current) =>
        current.filter((entry) => entry.connectionId !== connection.id)
      );
      return;
    }
    if (selected.length === 0) {
      const next = providers.find((item) => item.key === connection.provider);
      setSettings(buildFieldValues(next?.projectSettingsFields ?? [], {}));
    }
    setSelected((current) => [
      ...current,
      {
        connectionId: connection.id,
        name: connection.name,
        key: suggestProjectConnectionKey(connection.name),
        isKeyEdited: false,
      },
    ]);
  };

  const change = (connectionId: string, patch: Partial<Selection>) => {
    setSelected((current) =>
      current.map((entry) => {
        if (entry.connectionId !== connectionId) {
          return entry;
        }
        const next = { ...entry, ...patch };
        if (patch.name !== undefined && !next.isKeyEdited) {
          next.key = suggestProjectConnectionKey(patch.name);
        }
        return next;
      })
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateAdd(selected, provider, settings);
    setErrors(nextErrors);
    if (!provider || hasAddErrors(nextErrors)) {
      return;
    }
    add.mutate(
      {
        connections: selected.map((entry) => ({
          connectionId: entry.connectionId,
          key: entry.key.trim(),
          name: entry.name.trim(),
        })),
        settings: collectFieldValues(provider.projectSettingsFields, settings)
          .config,
      },
      { onSuccess: onDone }
    );
  };

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <fieldset className="space-y-1.5">
        <legend className="font-medium text-sm">Connections</legend>
        <p className="text-muted-foreground text-xs">
          Each connection is one account (bot). Pick several to give each
          workflow its own bot on the same projects; they share the settings
          below.
        </p>
        <ul className="space-y-1">
          {connections.map((connection) => {
            const isTaken = takenConnectionIds.includes(connection.id);
            const isSelected = selected.some(
              (entry) => entry.connectionId === connection.id
            );
            const isOtherProvider =
              providerKey !== undefined && connection.provider !== providerKey;
            const isFull =
              !isSelected && selected.length >= PROJECT_CONNECTIONS_ADD_MAX;
            const id = `project-connection-pick-${connection.id}`;
            return (
              <li className="flex items-center gap-2" key={connection.id}>
                <Checkbox
                  checked={isSelected}
                  disabled={isTaken || isOtherProvider || isFull}
                  id={id}
                  onCheckedChange={(checked) =>
                    toggle(connection, checked === true)
                  }
                />
                <Label
                  className="flex items-center gap-2 font-normal"
                  htmlFor={id}
                >
                  <ProviderIcon provider={connection.provider} />
                  {connection.name}
                  {isTaken ? (
                    <span className="text-muted-foreground text-xs">
                      (already in this project)
                    </span>
                  ) : null}
                </Label>
              </li>
            );
          })}
        </ul>
        <FieldError message={errors.connections} />
      </fieldset>
      {selected.map((entry) => (
        <EntryFields
          connectionName={byId.get(entry.connectionId)?.name ?? ""}
          entry={entry}
          errors={errors.entries?.[entry.connectionId]}
          key={entry.connectionId}
          onChange={(patch) => change(entry.connectionId, patch)}
          showConnection={selected.length > 1}
        />
      ))}
      {provider ? (
        <IntegrationFieldForm
          errors={errors.settings}
          fields={provider.projectSettingsFields}
          idPrefix="project-connection-settings"
          onChange={setSettings}
          values={settings}
        />
      ) : null}
      <MutationErrorMessage
        error={add.error}
        title={ProjectConnectionMutationErrorTitle.Add}
      />
      <FormButtons
        isPending={add.isPending}
        label={selected.length > 1 ? "Add connections" : "Add connection"}
        onCancel={onDone}
      />
    </form>
  );
}

function EntryFields({
  entry,
  connectionName,
  showConnection,
  errors,
  onChange,
}: Readonly<{
  entry: Selection;
  connectionName: string;
  showConnection: boolean;
  errors: EntryErrors | undefined;
  onChange: (patch: Partial<Selection>) => void;
}>) {
  const id = entry.connectionId;
  return (
    <div className="space-y-1">
      {showConnection ? (
        <p className="font-medium text-muted-foreground text-xs">
          {connectionName}
        </p>
      ) : null}
      <NameKeyFields
        errors={errors}
        idSuffix={id}
        isKeyFixed={false}
        keyValue={entry.key}
        name={entry.name}
        onKeyChange={(key) => onChange({ key, isKeyEdited: true })}
        onNameChange={(name) => onChange({ name })}
      />
    </div>
  );
}

function EditFields({
  projectId,
  existing,
  provider,
  onDone,
}: Readonly<{
  projectId: string;
  existing: ProjectConnection;
  provider: IntegrationProviderSummary;
  onDone: () => void;
}>) {
  const update = useUpdateProjectConnection(projectId);
  const [name, setName] = useState(existing.name);
  const [settings, setSettings] = useState<IntegrationFieldValues>(() =>
    buildFieldValues(provider.projectSettingsFields, existing.settings)
  );
  const [errors, setErrors] = useState<{
    name?: string;
    settings?: IntegrationFieldErrors;
  }>({});

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const settingsErrors = validateFieldValues(
      provider.projectSettingsFields,
      settings
    );
    const nextErrors = {
      ...(name.trim() === "" ? { name: "Enter a name" } : {}),
      ...(hasFieldErrors(settingsErrors) ? { settings: settingsErrors } : {}),
    };
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    update.mutate(
      {
        id: existing.id,
        input: {
          name: name.trim(),
          settings: collectFieldValues(provider.projectSettingsFields, settings)
            .config,
        },
      },
      { onSuccess: onDone }
    );
  };

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <p className="text-muted-foreground text-xs">
        Connection: {existing.connectionName}
      </p>
      <NameKeyFields
        errors={errors}
        idSuffix={existing.id}
        isKeyFixed
        keyValue={existing.key}
        name={name}
        onKeyChange={() => undefined}
        onNameChange={setName}
      />
      <IntegrationFieldForm
        errors={errors.settings}
        fields={provider.projectSettingsFields}
        idPrefix="project-connection-settings"
        onChange={setSettings}
        values={settings}
      />
      <MutationErrorMessage
        error={update.error}
        title={ProjectConnectionMutationErrorTitle.Update}
      />
      <FormButtons
        isPending={update.isPending}
        label="Save"
        onCancel={onDone}
      />
    </form>
  );
}

function NameKeyFields({
  idSuffix,
  name,
  keyValue,
  isKeyFixed,
  errors,
  onNameChange,
  onKeyChange,
}: Readonly<{
  idSuffix: string;
  name: string;
  keyValue: string;
  isKeyFixed: boolean;
  errors: EntryErrors | undefined;
  onNameChange: (name: string) => void;
  onKeyChange: (key: string) => void;
}>) {
  const nameId = `project-connection-name-${idSuffix}`;
  const keyId = `project-connection-key-${idSuffix}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          aria-invalid={errors?.name ? true : undefined}
          id={nameId}
          onChange={(event) => onNameChange(event.target.value)}
          value={name}
        />
        <FieldError message={errors?.name} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={keyId}>Key</Label>
        <Input
          aria-invalid={errors?.key ? true : undefined}
          className="font-mono"
          disabled={isKeyFixed}
          id={keyId}
          onChange={(event) => onKeyChange(event.target.value)}
          value={keyValue}
        />
        <p className="text-muted-foreground text-xs">
          {isKeyFixed
            ? "The key never changes: workflows and processes refer to it."
            : "Workflows and processes refer to the connection by this key. It cannot be changed later."}
        </p>
        <FieldError message={errors?.key} />
      </div>
    </div>
  );
}

function FormButtons({
  label,
  isPending,
  onCancel,
}: Readonly<{ label: string; isPending: boolean; onCancel: () => void }>) {
  return (
    <div className="flex justify-end gap-2">
      <Button onClick={onCancel} size="sm" type="button" variant="ghost">
        Cancel
      </Button>
      <Button disabled={isPending} size="sm" type="submit">
        {isPending ? "Saving…" : label}
      </Button>
    </div>
  );
}

function FieldError({ message }: Readonly<{ message: string | undefined }>) {
  return message ? <p className="text-destructive text-xs">{message}</p> : null;
}

/** Connections a project can use: active or in error, not workflow-owned, not built-in. */
function usableConnections(
  connections: readonly IntegrationConnection[],
  providers: readonly IntegrationProviderSummary[]
): IntegrationConnection[] {
  const builtIn = new Set(
    providers.filter((provider) => provider.builtIn).map((item) => item.key)
  );
  return connections.filter(
    (connection) =>
      connection.managedByWorkflowId === null &&
      !builtIn.has(connection.provider) &&
      connection.status !== IntegrationConnectionStatus.Disabled
  );
}

function validateAdd(
  selected: readonly Selection[],
  provider: IntegrationProviderSummary | undefined,
  settings: IntegrationFieldValues
): AddErrors {
  if (selected.length === 0 || !provider) {
    return { connections: "Choose at least one connection" };
  }
  const errors: AddErrors = {};
  const entries: Record<string, EntryErrors> = {};
  const seenKeys = new Set<string>();
  for (const entry of selected) {
    const entryErrors = validateEntry(entry, seenKeys);
    seenKeys.add(entry.key.trim());
    if (entryErrors.name || entryErrors.key) {
      entries[entry.connectionId] = entryErrors;
    }
  }
  if (Object.keys(entries).length > 0) {
    errors.entries = entries;
  }
  const settingsErrors = validateFieldValues(
    provider.projectSettingsFields,
    settings
  );
  if (hasFieldErrors(settingsErrors)) {
    errors.settings = settingsErrors;
  }
  return errors;
}

function validateEntry(
  entry: Selection,
  seenKeys: ReadonlySet<string>
): EntryErrors {
  const errors: EntryErrors = {};
  if (entry.name.trim() === "") {
    errors.name = "Enter a name";
  }
  const key = projectConnectionKeySchema.safeParse(entry.key);
  if (!key.success) {
    errors.key = key.error.issues[0]?.message ?? "Invalid key";
  } else if (seenKeys.has(key.data)) {
    errors.key = "Give each connection its own key";
  }
  return errors;
}

function hasAddErrors(errors: AddErrors): boolean {
  return Object.keys(errors).length > 0;
}
