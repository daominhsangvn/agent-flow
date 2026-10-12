"use client";

import type {
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import { WORKFLOW_ACTIONS_MAX } from "@repo/api/src/types/workflow";
import type { IntegrationFieldErrors } from "@repo/app/integrations/lib/integration-field-values";
import { Button } from "@repo/design-system/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@repo/design-system/components/ui/form";
import { Switch } from "@repo/design-system/components/ui/switch";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { getActionConnections } from "../lib/workflow-catalog";
import {
  countWorkflowActions,
  createPreActionDraft,
  WorkflowActionList,
  type WorkflowFormValues,
} from "../lib/workflow-form";
import { MissingConnectionsHint } from "./workflow-connection-options";
import {
  ActionDescription,
  ActionSettingsFields,
  ActionSourceFields,
  useActionRowState,
} from "./workflow-editor-action-fields";
import { WorkflowEditorSection } from "./workflow-editor-section";

export type WorkflowEditorPreActionsProps = {
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  /** Descriptor-validation errors of each pre action config, keyed by row index. */
  configErrors: Record<number, IntegrationFieldErrors>;
  /** Called after a pre action config (or the order of the list) changed. */
  onConfigChange: () => void;
  /** Org-relative Settings path of the Connections section. */
  connectionsSettingsPath?: string;
};

/**
 * The ordered repeater of pre actions. They run right after a trigger fires,
 * one after another in this order, before the agent team starts (e.g. move
 * the Jira issue to In Progress). A failed pre action stops the run unless
 * "Continue if this action fails" is on. Pre actions have no event selector:
 * they always run on the trigger.
 */
export function WorkflowEditorPreActions({
  providers,
  connections,
  configErrors,
  onConfigChange,
  connectionsSettingsPath,
}: Readonly<WorkflowEditorPreActionsProps>) {
  const { control } = useFormContext<WorkflowFormValues>();
  const { fields, append, remove, move } = useFieldArray({
    control,
    name: WorkflowActionList.Pre,
  });
  const postActions = useWatch({ control, name: WorkflowActionList.Post });
  const actionCount = countWorkflowActions({
    preActions: fields,
    postActions: postActions ?? [],
  });
  const actionConnections = getActionConnections(providers, connections);

  const handleAdd = () => {
    const onlyConnection =
      actionConnections.length === 1 ? actionConnections[0].id : "";
    append(createPreActionDraft(onlyConnection));
  };

  // Config errors are keyed by row index, so they are recomputed after every
  // structural change of the list.
  const handleMove = (from: number, to: number) => {
    move(from, to);
    onConfigChange();
  };

  return (
    <WorkflowEditorSection
      description="Run right after a trigger fires, one after another, before the agent team starts (e.g. move the Jira issue to In Progress). If one fails, the run stops unless 'Continue if this action fails' is on."
      title="Pre actions"
    >
      {actionConnections.length === 0 ? (
        <MissingConnectionsHint
          message="Add a Jira, Azure DevOps or Microsoft Teams connection to update tickets or post messages; the built-in HTTPS request works without one."
          settingsPath={connectionsSettingsPath}
        />
      ) : null}
      {fields.length > 0 ? (
        <ol aria-label="Pre actions" className="space-y-4">
          {fields.map((field, index) => (
            <li key={field.id}>
              <PreActionRow
                actionConnections={actionConnections}
                configErrors={configErrors[index] ?? {}}
                connections={connections}
                index={index}
                isFirst={index === 0}
                isLast={index === fields.length - 1}
                onConfigChange={onConfigChange}
                onMoveDown={() => handleMove(index, index + 1)}
                onMoveUp={() => handleMove(index, index - 1)}
                onRemove={() => {
                  remove(index);
                  onConfigChange();
                }}
                providers={providers}
              />
            </li>
          ))}
        </ol>
      ) : null}
      <Button
        disabled={actionCount >= WORKFLOW_ACTIONS_MAX}
        onClick={handleAdd}
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        Add pre action
      </Button>
    </WorkflowEditorSection>
  );
}

type PreActionRowProps = {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  actionConnections: readonly IntegrationConnection[];
  configErrors: IntegrationFieldErrors;
  onConfigChange: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
};

function PreActionRow({
  index,
  isFirst,
  isLast,
  providers,
  connections,
  actionConnections,
  configErrors,
  onConfigChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: Readonly<PreActionRowProps>) {
  const { control } = useFormContext<WorkflowFormValues>();
  const row = useActionRowState({
    list: WorkflowActionList.Pre,
    index,
    providers,
    connections,
  });
  const name = `Pre action ${index + 1}`;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{name}</h3>
        <div className="flex items-center gap-1">
          <Button
            aria-label={`Move ${name.toLowerCase()} up`}
            disabled={isFirst}
            onClick={onMoveUp}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowUpIcon className="size-4 text-muted-foreground" />
          </Button>
          <Button
            aria-label={`Move ${name.toLowerCase()} down`}
            disabled={isLast}
            onClick={onMoveDown}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowDownIcon className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
      <ActionSourceFields
        actionConnections={actionConnections}
        connections={connections}
        index={index}
        list={WorkflowActionList.Pre}
        onTypeChange={onConfigChange}
        providers={providers}
        row={row}
      />
      <ActionDescription row={row} />
      <ActionSettingsFields
        configErrors={configErrors}
        idPrefix={`workflow-pre-action-${index}`}
        index={index}
        list={WorkflowActionList.Pre}
        onConfigChange={onConfigChange}
        row={row}
      />
      <FormField
        control={control}
        name={`preActions.${index}.continueOnError`}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Continue if this action fails</FormLabel>
              <FormDescription className="text-xs">
                When off, a failure of this action stops the run before the
                agent team starts.
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      <div className="flex items-center justify-end gap-3">
        <FormField
          control={control}
          name={`preActions.${index}.enabled`}
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
          aria-label={`Remove ${name.toLowerCase()}`}
          onClick={onRemove}
          size="sm"
          type="button"
          variant="ghost"
        >
          <TrashIcon className="size-4 text-muted-foreground" />
          Remove
        </Button>
      </div>
    </div>
  );
}
