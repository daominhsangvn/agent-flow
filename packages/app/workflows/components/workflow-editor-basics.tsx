"use client";

import {
  WORKFLOW_DESCRIPTION_MAX,
  WORKFLOW_NAME_MAX,
  type Workflow,
} from "@repo/api/src/types/workflow";
// Cross-slice: the inline mutation error is owned by the integrations slice.
import { MutationErrorMessage } from "@repo/app/integrations/components/mutation-error-message";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useFormContext } from "react-hook-form";
import { useSetWorkflowEnabled } from "../hooks/use-workflows";
import type { WorkflowFormValues } from "../lib/workflow-form";
import { WorkflowMutationErrorTitle } from "../lib/workflow-labels";
import { WorkflowEditorSection } from "./workflow-editor-section";

export type WorkflowEditorBasicsProps = {
  /**
   * The saved workflow being edited. Its enabled switch applies right away
   * (`PATCH /workflows/{id}`) instead of with the rest of the form. Absent
   * while creating, where the switch is part of the form.
   */
  workflow?: Workflow;
};

const ENABLED_DESCRIPTION =
  "Triggers start runs only while the workflow is enabled.";

/** Name, description and the enabled switch of a workflow. */
export function WorkflowEditorBasics({
  workflow,
}: Readonly<WorkflowEditorBasicsProps>) {
  const { control } = useFormContext<WorkflowFormValues>();

  return (
    <WorkflowEditorSection
      description="How this workflow is listed. A disabled workflow ignores its triggers."
      title="Basics"
    >
      <FormField
        control={control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input
                maxLength={WORKFLOW_NAME_MAX}
                placeholder="Implement Jira requirements"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea
                maxLength={WORKFLOW_DESCRIPTION_MAX}
                placeholder="What this workflow is for"
                rows={2}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {workflow ? (
        <SavedWorkflowEnabledSwitch workflow={workflow} />
      ) : (
        <FormField
          control={control}
          name="enabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Enabled</FormLabel>
                <FormDescription className="text-xs">
                  {ENABLED_DESCRIPTION}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )}
    </WorkflowEditorSection>
  );
}

/**
 * Enabled switch of a saved workflow. It only flips the flag, so a workflow
 * whose connection, run-as user or compute target broke can still be turned
 * off without fixing (or re-validating) the rest of it.
 */
function SavedWorkflowEnabledSwitch({
  workflow,
}: Readonly<{ workflow: Workflow }>) {
  const setEnabled = useSetWorkflowEnabled();

  return (
    <div className="space-y-2">
      <div className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="workflow-enabled">Enabled</Label>
          <p className="text-muted-foreground text-xs">
            {`${ENABLED_DESCRIPTION} The switch applies right away, without saving other changes.`}
          </p>
        </div>
        <Switch
          checked={workflow.enabled}
          disabled={setEnabled.isPending}
          id="workflow-enabled"
          onCheckedChange={(enabled) =>
            setEnabled.mutate({ id: workflow.id, input: { enabled } })
          }
        />
      </div>
      <MutationErrorMessage
        error={setEnabled.error}
        title={WorkflowMutationErrorTitle.SetEnabled}
      />
    </div>
  );
}
