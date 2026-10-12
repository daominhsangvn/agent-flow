"use client";

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import type {
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { Workflow } from "@repo/api/src/types/workflow";
// Cross-slice: triggers and actions are offered from the integrations slice's
// provider catalog and the org's connections; that slice also owns the inline
// mutation error shared by both slices.
import { MutationErrorMessage } from "@repo/app/integrations/components/mutation-error-message";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import {
  useIntegrationConnections,
  useIntegrationProviders,
} from "@repo/app/integrations/hooks/use-integrations";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Form } from "@repo/design-system/components/ui/form";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useCreateWorkflow, useUpdateWorkflow } from "../hooks/use-workflows";
import type { WorkflowComputeTargetChoices } from "../lib/workflow-editor-options";
import {
  createEmptyWorkflowFormValues,
  EMPTY_WORKFLOW_CONFIG_ERRORS,
  hasWorkflowConfigErrors,
  toSaveWorkflowInput,
  validateWorkflowConfigs,
  type WorkflowConfigErrors,
  type WorkflowFormValues,
  workflowFormSchema,
  workflowToFormValues,
} from "../lib/workflow-form";
import {
  WORKFLOW_SOURCE_SYSTEMS_NOTICE,
  WorkflowMutationErrorTitle,
} from "../lib/workflow-labels";
import { WorkflowEditorAgent } from "./workflow-editor-agent";
import { WorkflowEditorBasics } from "./workflow-editor-basics";
import { WorkflowEditorPostActions } from "./workflow-editor-post-actions";
import { WorkflowEditorPreActions } from "./workflow-editor-pre-actions";
import { WorkflowEditorTriggers } from "./workflow-editor-triggers";

export type WorkflowEditorProps = {
  /** The workflow to edit; absent to create a new one. */
  workflow?: Workflow;
  /** Admins edit; members get the same form read-only. */
  isAdmin: boolean;
  /** Desktop compute targets, fetched by the shell (web-only hook). */
  computeTargets: WorkflowComputeTargetChoices;
  /** Org-relative Settings path of the Connections section, for the "add a connection" hints. */
  connectionsSettingsPath?: string;
};

/**
 * Create / edit form of a workflow. After the basics, the sections follow the
 * flow of a run: triggers -> pre actions -> agent team -> post actions. Every
 * trigger and action type, and every config field, comes from the provider
 * catalog; nothing provider-specific is hardcoded here, and nothing changes in
 * a source system unless an action of this form says so.
 * Saving sends the whole workflow (`SaveWorkflowInput`); after a create the
 * page moves to the new workflow. On an existing workflow the enabled switch
 * saves on its own, so a save re-sends the stored flag. A failed save shows
 * the server's message in the footer.
 */
export function WorkflowEditor(props: Readonly<WorkflowEditorProps>) {
  const providers = useIntegrationProviders();
  const connections = useIntegrationConnections();

  if (providers.isLoading || connections.isLoading) {
    return (
      <div
        aria-label="Loading workflow editor"
        className="space-y-4"
        role="status"
      >
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }
  if (providers.error || connections.error) {
    return (
      <QueryErrorMessage
        error={providers.error ?? connections.error}
        onRetry={() => {
          providers.refetch();
          connections.refetch();
        }}
        title="Couldn't load integrations"
      />
    );
  }

  return (
    <WorkflowEditorForm
      {...props}
      connections={connections.data ?? []}
      providers={providers.data ?? []}
    />
  );
}

type WorkflowEditorFormProps = WorkflowEditorProps & {
  providers: readonly IntegrationProviderSummary[];
  connections: readonly IntegrationConnection[];
};

function WorkflowEditorForm({
  workflow,
  isAdmin,
  computeTargets,
  connectionsSettingsPath,
  providers,
  connections,
}: Readonly<WorkflowEditorFormProps>) {
  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const { navigate } = useNavigation();
  const buildOrgPath = useOrgPath();
  const form = useForm<WorkflowFormValues>({
    resolver: standardSchemaResolver(workflowFormSchema),
    defaultValues: workflow
      ? workflowToFormValues(workflow)
      : createEmptyWorkflowFormValues(),
  });
  const [configErrors, setConfigErrors] = useState<WorkflowConfigErrors>(
    EMPTY_WORKFLOW_CONFIG_ERRORS
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const isPending = createWorkflow.isPending || updateWorkflow.isPending;
  const readOnly = !isAdmin;

  // Config errors are computed on submit; afterwards they follow every edit so
  // a fixed field stops showing its message right away.
  const revalidateConfigs = () => {
    if (submitAttempted) {
      setConfigErrors(validateWorkflowConfigs(form.getValues(), providers));
    }
  };

  const save = (values: WorkflowFormValues) => {
    const nextConfigErrors = validateWorkflowConfigs(values, providers);
    setConfigErrors(nextConfigErrors);
    if (hasWorkflowConfigErrors(nextConfigErrors)) {
      return;
    }
    const input = toSaveWorkflowInput(values, providers);
    if (workflow) {
      updateWorkflow.mutate(
        { id: workflow.id, input: { ...input, enabled: workflow.enabled } },
        {
          onSuccess: (saved) => {
            form.reset(workflowToFormValues(saved));
            toast.success("Workflow saved");
          },
        }
      );
      return;
    }
    createWorkflow.mutate(input, {
      onSuccess: (created) => {
        toast.success("Workflow created");
        navigate(buildOrgPath(`/workflows/${created.id}`));
      },
    });
  };

  const handleSubmit = form.handleSubmit(save, () => {
    // Surface the config problems together with the field errors.
    setConfigErrors(validateWorkflowConfigs(form.getValues(), providers));
  });

  const showErrorSummary =
    submitAttempted &&
    (hasWorkflowConfigErrors(configErrors) ||
      Object.keys(form.formState.errors).length > 0);

  return (
    <Form {...form}>
      <form
        aria-label={workflow ? `Edit ${workflow.name}` : "New workflow"}
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          setSubmitAttempted(true);
          return handleSubmit(event);
        }}
      >
        {readOnly ? (
          <Alert variant="info">
            <InfoIcon />
            <AlertDescription>
              Only organization admins can change workflows. You are viewing
              this workflow read-only.
            </AlertDescription>
          </Alert>
        ) : null}
        <WorkflowFlowIntro />
        <fieldset
          className="m-0 min-w-0 space-y-6 border-0 p-0"
          disabled={readOnly || isPending}
        >
          <WorkflowEditorBasics workflow={workflow} />
          <WorkflowEditorTriggers
            configErrors={configErrors.triggers}
            connections={connections}
            connectionsSettingsPath={connectionsSettingsPath}
            httpEndpointConnectionId={workflow?.httpEndpointConnectionId}
            onConfigChange={revalidateConfigs}
            providers={providers}
          />
          <WorkflowEditorPreActions
            configErrors={configErrors.preActions}
            connections={connections}
            connectionsSettingsPath={connectionsSettingsPath}
            onConfigChange={revalidateConfigs}
            providers={providers}
          />
          <WorkflowEditorAgent
            computeTargets={computeTargets}
            currentProject={workflow?.project ?? null}
            currentRunAsUser={workflow?.runAsUser ?? null}
          />
          <WorkflowEditorPostActions
            configErrors={configErrors.postActions}
            connections={connections}
            connectionsSettingsPath={connectionsSettingsPath}
            onConfigChange={revalidateConfigs}
            providers={providers}
          />
        </fieldset>
        {readOnly ? null : (
          <div className="sticky bottom-0 space-y-2 border-t bg-background py-3">
            <MutationErrorMessage
              error={workflow ? updateWorkflow.error : createWorkflow.error}
              title={
                workflow
                  ? WorkflowMutationErrorTitle.Update
                  : WorkflowMutationErrorTitle.Create
              }
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              {showErrorSummary ? (
                <p className="text-destructive text-sm sm:mr-auto" role="alert">
                  Some fields need attention before the workflow can be saved.
                </p>
              ) : null}
              <Button disabled={isPending} type="submit">
                {isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : null}
                {getSubmitLabel(Boolean(workflow), isPending)}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Form>
  );
}

/** How a run moves through the sections below, and who changes source systems. */
function WorkflowFlowIntro() {
  return (
    <div className="space-y-1 text-muted-foreground text-sm">
      <p>
        When a trigger fires, the pre actions run in order, then the agent team
        works on the item, and the post actions run on the run events you
        choose.
      </p>
      <p className="font-medium text-foreground">
        {WORKFLOW_SOURCE_SYSTEMS_NOTICE}
      </p>
    </div>
  );
}

function getSubmitLabel(isEdit: boolean, isPending: boolean): string {
  if (isPending) {
    return "Saving...";
  }
  return isEdit ? "Save workflow" : "Create workflow";
}
