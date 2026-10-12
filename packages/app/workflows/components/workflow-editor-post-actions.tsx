"use client";

import type {
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_ACTIONS_MAX,
  WORKFLOW_POST_ACTION_EVENTS,
  type WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import type { IntegrationFieldErrors } from "@repo/app/integrations/lib/integration-field-values";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import { Label } from "@repo/design-system/components/ui/label";
import { Switch } from "@repo/design-system/components/ui/switch";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { getActionConnections } from "../lib/workflow-catalog";
import {
  countWorkflowActions,
  createPostActionDraft,
  getDefinitionDefaultEvents,
  getPostActionEvents,
  WorkflowActionList,
  type WorkflowFormValues,
} from "../lib/workflow-form";
import {
  WORKFLOW_RUN_EVENT_DESCRIPTIONS,
  WORKFLOW_RUN_EVENT_LABELS,
} from "../lib/workflow-labels";
import { MissingConnectionsHint } from "./workflow-connection-options";
import {
  ActionDescription,
  ActionSettingsFields,
  ActionSourceFields,
  useActionRowState,
} from "./workflow-editor-action-fields";
import { WorkflowEditorSection } from "./workflow-editor-section";

export type WorkflowEditorPostActionsProps = {
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  /** Descriptor-validation errors of each post action config, keyed by row index. */
  configErrors: Record<number, IntegrationFieldErrors>;
  /** Called after a post action config (or the post action list) changed. */
  onConfigChange: () => void;
  /** Org-relative Settings path of the Connections section. */
  connectionsSettingsPath?: string;
};

/**
 * The repeater of post actions: connection, action type, the run events it
 * runs on (never run.triggered, which belongs to pre actions) and its config.
 */
export function WorkflowEditorPostActions({
  providers,
  connections,
  configErrors,
  onConfigChange,
  connectionsSettingsPath,
}: Readonly<WorkflowEditorPostActionsProps>) {
  const { control, formState } = useFormContext<WorkflowFormValues>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: WorkflowActionList.Post,
  });
  const preActions = useWatch({ control, name: WorkflowActionList.Pre });
  const actionCount = countWorkflowActions({
    preActions: preActions ?? [],
    postActions: fields,
  });
  const actionConnections = getActionConnections(providers, connections);
  const listError =
    formState.errors.postActions?.message ??
    formState.errors.postActions?.root?.message;

  const handleAdd = () => {
    const onlyConnection =
      actionConnections.length === 1 ? actionConnections[0].id : "";
    append(createPostActionDraft(onlyConnection));
  };

  return (
    <WorkflowEditorSection
      description="Run when the run reaches the selected events: comment the pull request on the ticket, move it to another state, post to Microsoft Teams or call an HTTPS endpoint."
      title="Post actions"
    >
      {actionConnections.length === 0 ? (
        <MissingConnectionsHint
          message="Add a Jira, Azure DevOps or Microsoft Teams connection to update tickets or post messages; the built-in HTTPS request works without one."
          settingsPath={connectionsSettingsPath}
        />
      ) : null}
      {fields.length > 0 ? (
        <ol aria-label="Post actions" className="space-y-4">
          {fields.map((field, index) => (
            <li key={field.id}>
              <PostActionRow
                actionConnections={actionConnections}
                configErrors={configErrors[index] ?? {}}
                connections={connections}
                index={index}
                onConfigChange={onConfigChange}
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
      {listError ? (
        <p className="text-destructive text-sm" role="alert">
          {listError}
        </p>
      ) : null}
      <Button
        disabled={actionCount >= WORKFLOW_ACTIONS_MAX}
        onClick={handleAdd}
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        Add post action
      </Button>
    </WorkflowEditorSection>
  );
}

type PostActionRowProps = {
  index: number;
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
  actionConnections: readonly IntegrationConnection[];
  configErrors: IntegrationFieldErrors;
  onConfigChange: () => void;
  onRemove: () => void;
};

function PostActionRow({
  index,
  providers,
  connections,
  actionConnections,
  configErrors,
  onConfigChange,
  onRemove,
}: Readonly<PostActionRowProps>) {
  const { control, setValue, formState } = useFormContext<WorkflowFormValues>();
  const row = useActionRowState({
    list: WorkflowActionList.Post,
    index,
    providers,
    connections,
  });

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Post action {index + 1}</h3>
        <div className="flex items-center gap-3">
          <FormField
            control={control}
            name={`postActions.${index}.enabled`}
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
            aria-label={`Remove post action ${index + 1}`}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <TrashIcon className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
      <ActionSourceFields
        actionConnections={actionConnections}
        connections={connections}
        index={index}
        list={WorkflowActionList.Post}
        onTypeChange={(definition) => {
          setValue(
            `postActions.${index}.events`,
            getDefinitionDefaultEvents(definition),
            { shouldDirty: true, shouldValidate: formState.isSubmitted }
          );
          onConfigChange();
        }}
        providers={providers}
        row={row}
      />
      <ActionDescription row={row} />
      <RunEventsField index={index} />
      <ActionSettingsFields
        configErrors={configErrors}
        idPrefix={`workflow-post-action-${index}`}
        index={index}
        list={WorkflowActionList.Post}
        onConfigChange={onConfigChange}
        row={row}
      />
    </div>
  );
}

function RunEventsField({ index }: Readonly<{ index: number }>) {
  const { control } = useFormContext<WorkflowFormValues>();

  return (
    <FormField
      control={control}
      name={`postActions.${index}.events`}
      render={({ field }) => {
        const toggle = (event: WorkflowRunEvent, checked: boolean) => {
          const next = checked
            ? [...field.value, event]
            : field.value.filter((item) => item !== event);
          field.onChange(getPostActionEvents(next));
        };
        return (
          <FormItem>
            <fieldset className="m-0 min-w-0 space-y-2 border-0 p-0">
              <legend className="mb-2 font-medium text-sm">Run on</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {WORKFLOW_POST_ACTION_EVENTS.map((event) => {
                  const optionId = `workflow-post-action-${index}-event-${event}`;
                  return (
                    <div className="flex items-start gap-2" key={event}>
                      <Checkbox
                        checked={field.value.includes(event)}
                        className="mt-0.5"
                        id={optionId}
                        onCheckedChange={(checked) =>
                          toggle(event, checked === true)
                        }
                      />
                      <div className="space-y-0.5">
                        <Label className="font-normal" htmlFor={optionId}>
                          {WORKFLOW_RUN_EVENT_LABELS[event]}
                        </Label>
                        <p className="text-muted-foreground text-xs">
                          {WORKFLOW_RUN_EVENT_DESCRIPTIONS[event]}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </fieldset>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}
