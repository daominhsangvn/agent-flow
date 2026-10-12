"use client";

import type {
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import { WORKFLOW_TRIGGERS_MAX } from "@repo/api/src/types/workflow";
// Cross-slice: trigger configs are rendered by the integrations slice's
// descriptor-driven form.
import { IntegrationFieldForm } from "@repo/app/integrations/components/integration-field-form";
import { IntegrationInboundDialog } from "@repo/app/integrations/components/integration-inbound-dialog";
import type {
  IntegrationFieldErrors,
  IntegrationFieldValues,
} from "@repo/app/integrations/lib/integration-field-values";
import { Button } from "@repo/design-system/components/ui/button";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { GlobeIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import {
  BUILT_IN_HTTP_CONNECTION,
  findConnectionProvider,
  getTriggerConnections,
} from "../lib/workflow-catalog";
import {
  createTriggerDraft,
  type WorkflowFormValues,
  type WorkflowTriggerDraft,
} from "../lib/workflow-form";
import {
  ConnectionSelectItems,
  isRadixResetValue,
  MissingConnectionsHint,
} from "./workflow-connection-options";
import { WorkflowEditorSection } from "./workflow-editor-section";

export type WorkflowEditorTriggersProps = {
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  /** Descriptor-validation errors of each trigger config, keyed by row index. */
  configErrors: Record<number, IntegrationFieldErrors>;
  /** Called after a trigger config (or the trigger list) changed. */
  onConfigChange: () => void;
  /** Org-relative Settings path of the Connections section. */
  connectionsSettingsPath?: string;
  /** The saved workflow's own HTTP endpoint connection, once it exists. */
  httpEndpointConnectionId?: string | null;
};

/** The repeater of triggers: connection, trigger type, its config and an enabled switch. */
export function WorkflowEditorTriggers({
  providers,
  connections,
  configErrors,
  onConfigChange,
  connectionsSettingsPath,
  httpEndpointConnectionId = null,
}: Readonly<WorkflowEditorTriggersProps>) {
  const { control, formState } = useFormContext<WorkflowFormValues>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: "triggers",
  });
  const triggerConnections = getTriggerConnections(providers, connections);
  const listError =
    formState.errors.triggers?.message ??
    formState.errors.triggers?.root?.message;

  const handleAdd = () => {
    append(createTriggerDraft(defaultTriggerSource(triggerConnections)));
  };

  return (
    <WorkflowEditorSection
      description="Events that start a run. A run imports the item as a PRD (a product requirement) or an Issue and hands it to the agent team."
      title="Triggers"
    >
      {triggerConnections.length === 0 ? (
        <MissingConnectionsHint
          message="The workflow can start from its own HTTP endpoint. To start runs from Jira issues or Azure DevOps work items, add a connection."
          settingsPath={connectionsSettingsPath}
        />
      ) : null}
      <ol aria-label="Triggers" className="space-y-4">
        {fields.map((field, index) => (
          <li key={field.id}>
            <TriggerRow
              configErrors={configErrors[index] ?? {}}
              connections={connections}
              httpEndpointConnectionId={httpEndpointConnectionId}
              index={index}
              onConfigChange={onConfigChange}
              onRemove={() => {
                remove(index);
                onConfigChange();
              }}
              providers={providers}
              triggerConnections={triggerConnections}
            />
          </li>
        ))}
      </ol>
      {listError ? (
        <p className="text-destructive text-sm" role="alert">
          {listError}
        </p>
      ) : null}
      <Button
        disabled={fields.length >= WORKFLOW_TRIGGERS_MAX}
        onClick={handleAdd}
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        Add trigger
      </Button>
    </WorkflowEditorSection>
  );
}

type TriggerRowProps = {
  index: number;
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  triggerConnections: readonly IntegrationConnection[];
  configErrors: IntegrationFieldErrors;
  onConfigChange: () => void;
  onRemove: () => void;
  httpEndpointConnectionId: string | null;
};

function TriggerRow({
  index,
  providers,
  connections,
  triggerConnections,
  configErrors,
  onConfigChange,
  onRemove,
  httpEndpointConnectionId,
}: Readonly<TriggerRowProps>) {
  const { control, getValues, setValue, formState } =
    useFormContext<WorkflowFormValues>();
  // A removed row can render once more before it unmounts; fall back to an
  // empty draft instead of reading fields of `undefined`.
  const watched: WorkflowTriggerDraft | undefined = useWatch({
    control,
    name: `triggers.${index}`,
  });
  const trigger = watched ?? EMPTY_TRIGGER_DRAFT;
  const provider = findConnectionProvider(
    providers,
    connections,
    trigger.connectionId
  );
  const definition = provider?.triggers.find(
    (candidate) => candidate.key === trigger.type
  );
  const setOptions = {
    shouldDirty: true,
    shouldValidate: formState.isSubmitted,
  };

  const handleConnectionChange = (connectionId: string) => {
    if (isRadixResetValue(connectionId)) {
      return;
    }
    setValue(`triggers.${index}.connectionId`, connectionId, setOptions);
    const nextProvider = findConnectionProvider(
      providers,
      connections,
      connectionId
    );
    const currentType = getValues(`triggers.${index}.type`);
    if (nextProvider?.triggers.some((item) => item.key === currentType)) {
      return;
    }
    const onlyType =
      nextProvider?.triggers.length === 1 ? nextProvider.triggers[0].key : "";
    setValue(`triggers.${index}.type`, onlyType, setOptions);
    setValue(`triggers.${index}.config`, {}, setOptions);
    onConfigChange();
  };

  const handleTypeChange = (type: string) => {
    if (isRadixResetValue(type)) {
      return;
    }
    setValue(`triggers.${index}.type`, type, setOptions);
    setValue(`triggers.${index}.config`, {}, setOptions);
    onConfigChange();
  };

  const handleConfigChange = (config: IntegrationFieldValues) => {
    setValue(`triggers.${index}.config`, config, { shouldDirty: true });
    onConfigChange();
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Trigger {index + 1}</h3>
        <div className="flex items-center gap-3">
          <FormField
            control={control}
            name={`triggers.${index}.enabled`}
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2">
                <FormLabel className="font-normal text-xs">Enabled</FormLabel>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <Button
            aria-label={`Remove trigger ${index + 1}`}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <TrashIcon className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name={`triggers.${index}.connectionId`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Source</FormLabel>
              <Select
                onValueChange={handleConnectionChange}
                value={field.value || undefined}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a source" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={BUILT_IN_HTTP_CONNECTION}>
                    <span className="flex items-center gap-2">
                      <GlobeIcon className="size-4" />
                      HTTP request (this workflow's URL)
                    </span>
                  </SelectItem>
                  <ConnectionSelectItems
                    connections={triggerConnections}
                    selectedId={field.value}
                  />
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`triggers.${index}.type`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Trigger</FormLabel>
              <Select
                disabled={!provider}
                onValueChange={handleTypeChange}
                value={field.value || undefined}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a trigger" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {(provider?.triggers ?? []).map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.displayName}
                    </SelectItem>
                  ))}
                  {field.value && !definition ? (
                    <SelectItem value={field.value}>{field.value}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      {definition ? (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            {definition.description}
          </p>
          {definition.configFields.length > 0 ? (
            <div className="space-y-2 rounded-md bg-muted/30 p-3">
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                Filters and options
              </Label>
              <IntegrationFieldForm
                errors={configErrors}
                fields={definition.configFields}
                idPrefix={`workflow-trigger-${index}`}
                onChange={handleConfigChange}
                values={trigger.config}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {trigger.connectionId === BUILT_IN_HTTP_CONNECTION ? (
        <BuiltInHttpEndpoint
          connection={connections.find(
            (candidate) => candidate.id === httpEndpointConnectionId
          )}
        />
      ) : null}
      {trigger.type && !definition && provider ? (
        <p className="text-destructive text-sm">
          This trigger type is no longer offered by the connection's provider.
          Choose another trigger.
        </p>
      ) : null}
    </div>
  );
}

const EMPTY_TRIGGER_DRAFT: WorkflowTriggerDraft = createTriggerDraft();

/** New triggers start on the only connection, else on the workflow's own HTTP endpoint. */
function defaultTriggerSource(
  triggerConnections: readonly IntegrationConnection[]
): string {
  if (triggerConnections.length === 1) {
    return triggerConnections[0].id;
  }
  return triggerConnections.length === 0 ? BUILT_IN_HTTP_CONNECTION : "";
}

/**
 * Where the workflow's own HTTP endpoint is: its URL and secret (admin-only,
 * revealed in the inbound dialog) once the workflow was saved.
 */
function BuiltInHttpEndpoint({
  connection,
}: Readonly<{ connection: IntegrationConnection | undefined }>) {
  const [isOpen, setIsOpen] = useState(false);
  if (!connection) {
    return (
      <p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
        The workflow gets its own URL and signing secret when you save it. Send
        a JSON body with an id, a title and a description to start a run.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <p className="text-muted-foreground text-sm">
        Requests to this workflow's URL, signed with its secret, start runs.
      </p>
      <Button
        onClick={() => setIsOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Show URL and secret
      </Button>
      {isOpen ? (
        <IntegrationInboundDialog
          connection={connection}
          isAdmin
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </div>
  );
}
