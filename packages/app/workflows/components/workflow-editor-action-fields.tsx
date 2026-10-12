"use client";

import type {
  IntegrationActionSummary,
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
// Cross-slice: action configs are rendered by the integrations slice's
// descriptor-driven form.
import { IntegrationFieldForm } from "@repo/app/integrations/components/integration-field-form";
import type {
  IntegrationFieldErrors,
  IntegrationFieldValues,
} from "@repo/app/integrations/lib/integration-field-values";
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
import { GlobeIcon } from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";
import {
  BUILT_IN_HTTP_CONNECTION,
  findConnectionProvider,
} from "../lib/workflow-catalog";
import {
  createPreActionDraft,
  type WorkflowActionDraftBase,
  type WorkflowActionList,
  type WorkflowFormValues,
} from "../lib/workflow-form";
import {
  ConnectionSelectItems,
  isRadixResetValue,
} from "./workflow-connection-options";

/**
 * Building blocks shared by the pre action and post action rows of the
 * workflow editor: the connection and action selects, and the action's
 * description and descriptor-driven settings. Both lists offer every action
 * type of the connection's provider; nothing here is provider-specific.
 */

/** The watched row of an action list with its provider and action definition. */
export type ActionRowState = {
  action: WorkflowActionDraftBase;
  provider: IntegrationProviderSummary | undefined;
  definition: IntegrationActionSummary | undefined;
};

export function useActionRowState({
  list,
  index,
  providers,
  connections,
}: {
  list: WorkflowActionList;
  index: number;
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
}): ActionRowState {
  const { control } = useFormContext<WorkflowFormValues>();
  // A removed row can render once more before it unmounts; fall back to an
  // empty draft instead of reading fields of `undefined`.
  const watched: WorkflowActionDraftBase | undefined = useWatch({
    control,
    name: `${list}.${index}`,
  });
  const action = watched ?? EMPTY_ACTION_DRAFT;
  const provider = findConnectionProvider(
    providers,
    connections,
    action.connectionId
  );
  const definition = provider?.actions.find(
    (candidate) => candidate.key === action.type
  );
  return { action, provider, definition };
}

export type ActionSourceFieldsProps = {
  list: WorkflowActionList;
  index: number;
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  /** Connections whose provider offers at least one action. */
  actionConnections: readonly IntegrationConnection[];
  row: ActionRowState;
  /** Called after the action type changed (the config was reset). */
  onTypeChange: (definition: IntegrationActionSummary | undefined) => void;
};

/** Connection select, then the action select of the connection's provider. */
export function ActionSourceFields({
  list,
  index,
  providers,
  connections,
  actionConnections,
  row,
  onTypeChange,
}: Readonly<ActionSourceFieldsProps>) {
  const { control, getValues, setValue, formState } =
    useFormContext<WorkflowFormValues>();
  const setOptions = {
    shouldDirty: true,
    shouldValidate: formState.isSubmitted,
  };

  const applyType = (
    type: string,
    definition: IntegrationActionSummary | undefined
  ) => {
    setValue(`${list}.${index}.type`, type, setOptions);
    setValue(`${list}.${index}.config`, {}, setOptions);
    onTypeChange(definition);
  };

  const handleTypeChange = (type: string) => {
    if (isRadixResetValue(type)) {
      return;
    }
    applyType(
      type,
      row.provider?.actions.find((item) => item.key === type)
    );
  };

  const handleConnectionChange = (connectionId: string) => {
    if (isRadixResetValue(connectionId)) {
      return;
    }
    setValue(`${list}.${index}.connectionId`, connectionId, setOptions);
    const nextProvider = findConnectionProvider(
      providers,
      connections,
      connectionId
    );
    const currentType = getValues(`${list}.${index}.type`);
    if (nextProvider?.actions.some((item) => item.key === currentType)) {
      return;
    }
    const onlyAction =
      nextProvider?.actions.length === 1 ? nextProvider.actions[0] : undefined;
    applyType(onlyAction?.key ?? "", onlyAction);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={control}
        name={`${list}.${index}.connectionId`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Connection</FormLabel>
            <Select
              onValueChange={handleConnectionChange}
              value={field.value || undefined}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a connection" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={BUILT_IN_HTTP_CONNECTION}>
                  <span className="flex items-center gap-2">
                    <GlobeIcon className="size-4" />
                    HTTPS request (built-in)
                  </span>
                </SelectItem>
                <ConnectionSelectItems
                  connections={actionConnections}
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
        name={`${list}.${index}.type`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Action</FormLabel>
            <Select
              disabled={!row.provider}
              onValueChange={handleTypeChange}
              value={field.value || undefined}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an action" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {(row.provider?.actions ?? []).map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.displayName}
                  </SelectItem>
                ))}
                {field.value && !row.definition ? (
                  <SelectItem value={field.value}>{field.value}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

/** The action's description shown under the selects. */
export function ActionDescription({ row }: Readonly<{ row: ActionRowState }>) {
  if (!row.definition) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-sm">
      {row.definition.description}
    </p>
  );
}

export type ActionSettingsFieldsProps = {
  list: WorkflowActionList;
  index: number;
  row: ActionRowState;
  configErrors: IntegrationFieldErrors;
  /** Unique per row on the page, e.g. `workflow-pre-action-0`. */
  idPrefix: string;
  onConfigChange: () => void;
};

/**
 * The descriptor-driven settings of the selected action, plus a warning when
 * the stored type is no longer offered by the connection's provider.
 */
export function ActionSettingsFields({
  list,
  index,
  row,
  configErrors,
  idPrefix,
  onConfigChange,
}: Readonly<ActionSettingsFieldsProps>) {
  const { setValue } = useFormContext<WorkflowFormValues>();

  const handleConfigChange = (config: IntegrationFieldValues) => {
    setValue(`${list}.${index}.config`, config, { shouldDirty: true });
    onConfigChange();
  };

  return (
    <>
      {row.definition && row.definition.configFields.length > 0 ? (
        <div className="space-y-2 rounded-md bg-muted/30 p-3">
          <Label className="text-muted-foreground text-xs uppercase tracking-wide">
            Settings
          </Label>
          <IntegrationFieldForm
            errors={configErrors}
            fields={row.definition.configFields}
            idPrefix={idPrefix}
            onChange={handleConfigChange}
            values={row.action.config}
          />
        </div>
      ) : null}
      {row.action.type && !row.definition && row.provider ? (
        <p className="text-destructive text-sm">
          This action type is no longer offered by the connection's provider.
          Choose another action.
        </p>
      ) : null}
    </>
  );
}

const EMPTY_ACTION_DRAFT: WorkflowActionDraftBase = createPreActionDraft();
