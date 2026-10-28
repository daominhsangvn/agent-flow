"use client";

import type { IntegrationConnection } from "@repo/api/src/types/integration";
import type { Workflow } from "@repo/api/src/types/workflow";
// Cross-slice: triggers and actions are offered from the integrations slice's
// provider catalog and the org's connections; that slice also owns the inline
// mutation and query errors shared by both slices.
import { MutationErrorMessage } from "@repo/app/integrations/components/mutation-error-message";
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import {
  useIntegrationConnections,
  useIntegrationProviders,
} from "@repo/app/integrations/hooks/use-integrations";
// Cross-slice: the YAML names the org's projects, members and repositories.
import { useOrgProjectConnections } from "@repo/app/projects/hooks/use-project-connections";
import { useProjectRepositories } from "@repo/app/projects/hooks/use-project-repositories";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  type YamlProblem,
  YamlProblemSeverity,
} from "@repo/app/shared/lib/yaml-problems";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { AlertTriangleIcon, InfoIcon, Loader2Icon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { useCreateWorkflow, useUpdateWorkflow } from "../hooks/use-workflows";
import type { WorkflowComputeTargetChoices } from "../lib/workflow-editor-options";
import {
  WORKFLOW_SOURCE_SYSTEMS_NOTICE,
  WorkflowMutationErrorTitle,
} from "../lib/workflow-labels";
import { parseWorkflowYaml } from "../lib/workflow-yaml";
import type { WorkflowYamlCatalog } from "../lib/workflow-yaml-schema";
import { newWorkflowYaml, workflowToYaml } from "../lib/workflow-yaml-write";
import { WorkflowActionsPreview } from "./workflow-actions-preview";
import { WorkflowConfigurationGuide } from "./workflow-configuration-guide";
import { MissingConnectionsHint } from "./workflow-connection-options";
import { WorkflowHttpEndpoint } from "./workflow-http-endpoint";

export type WorkflowEditorProps = {
  /** The workflow to edit; absent to create a new one. */
  workflow?: Workflow;
  /** Admins edit; members get the same YAML read-only. */
  isAdmin: boolean;
  /** Runners (compute targets), fetched by the shell (web-only hook). */
  computeTargets: WorkflowComputeTargetChoices;
  /** Org-relative Settings path of the Connections section, for the "manage connections" hint. */
  connectionsSettingsPath?: string;
};

/**
 * Create / edit a workflow as YAML: name, triggers, the agent team and the
 * actions, each on the run events it lists. Everything the YAML can name —
 * connections and their trigger and action types and options, projects,
 * runners, users, run events — comes from the org and the provider catalog:
 * the editor suggests it as you type, the configuration guide above it
 * explains it, and the preview below it shows which action runs when and on
 * which connection. Saving sends the whole workflow (`SaveWorkflowInput`);
 * after a create the page moves to the new workflow. A save with problems
 * stops and lists them by line.
 */
export function WorkflowEditor(props: Readonly<WorkflowEditorProps>) {
  const providers = useIntegrationProviders();
  // Connections are admin-only; members see the workflow read-only.
  const connections = useIntegrationConnections({ enabled: props.isAdmin });
  const projectConnections = useOrgProjectConnections({
    enabled: props.isAdmin,
  });
  const projects = useProjects();
  const users = useOrganizationUsers();
  const { computeTargets } = props;

  const catalog = useMemo<WorkflowYamlCatalog>(
    () => ({
      providers: providers.data ?? [],
      projectConnections: projectConnections.data ?? [],
      projects: (projects.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
      })),
      users: (users.data ?? [])
        .filter((user) => user.active)
        .map((user) => ({
          id: user.id,
          name: getUserDisplayName(user),
          email: user.email,
        })),
      runners: computeTargets.options,
    }),
    [
      providers.data,
      projectConnections.data,
      projects.data,
      users.data,
      computeTargets.options,
    ]
  );

  if (
    providers.isLoading ||
    connections.isLoading ||
    projectConnections.isLoading ||
    projects.isLoading ||
    users.isLoading ||
    computeTargets.isLoading
  ) {
    return (
      <div
        aria-label="Loading workflow editor"
        className="space-y-4"
        role="status"
      >
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (providers.error || connections.error || projectConnections.error) {
    return (
      <QueryErrorMessage
        error={providers.error ?? connections.error ?? projectConnections.error}
        onRetry={() => {
          providers.refetch();
          connections.refetch();
          projectConnections.refetch();
        }}
        title="Couldn't load integrations"
      />
    );
  }

  const unavailable = [
    projects.error ? "projects" : null,
    users.error ? "members" : null,
    computeTargets.error ? "runners" : null,
  ].filter((name) => name !== null);

  return (
    <WorkflowYamlForm
      {...props}
      catalog={catalog}
      connections={connections.data ?? []}
      // Remounts (and regenerates the YAML) only for another workflow.
      key={props.workflow?.id ?? "new"}
      unavailable={unavailable}
    />
  );
}

// The code editor loads with the page section that shows it.
const LazyWorkflowYamlEditor = lazy(() =>
  import("./workflow-yaml-editor").then((module) => ({
    default: module.WorkflowYamlEditor,
  }))
);

type WorkflowYamlFormProps = WorkflowEditorProps & {
  catalog: WorkflowYamlCatalog;
  /** The organization connections (the workflow's own HTTP endpoint is one). */
  connections: readonly IntegrationConnection[];
  /** Lists that could not be loaded: their names are not suggested or resolved. */
  unavailable: readonly string[];
};

function WorkflowYamlForm({
  workflow,
  isAdmin,
  connectionsSettingsPath,
  catalog,
  connections,
  unavailable,
}: Readonly<WorkflowYamlFormProps>) {
  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const { navigate } = useNavigation();
  const buildOrgPath = useOrgPath();
  // The text of the stored workflow, written once; edits stay the user's.
  const [savedText, setSavedText] = useState(() =>
    workflow ? workflowToYaml(workflow, catalog) : newWorkflowYaml(catalog)
  );
  const [text, setText] = useState(savedText);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const result = useMemo(
    () => parseWorkflowYaml(text, catalog, workflow),
    [text, catalog, workflow]
  );
  const projectId = result.input?.projectId ?? workflow?.project?.id ?? "";
  // Repositories are only suggested for `repository:` keys (agent.repository,
  // the process toolkit), so they load once the YAML has one.
  const repositories = useProjectRepositories(projectId, {
    enabled: REPOSITORY_KEY_RE.test(text),
  });
  const completionData = useMemo(
    () => ({
      ...catalog,
      repositories: (repositories.data ?? []).map(
        (repository) => repository.fullName
      ),
    }),
    [catalog, repositories.data]
  );
  const isPending = createWorkflow.isPending || updateWorkflow.isPending;
  const readOnly = !isAdmin;
  const isDirty = text !== savedText;
  const usesHttpEndpoint = Boolean(
    workflow?.triggers.some((trigger) => trigger.builtInHttp) ||
      result.input?.triggers.some((trigger) => trigger.connectionKey === null)
  );

  const save = () => {
    setSubmitAttempted(true);
    if (!result.input) {
      return;
    }
    if (workflow) {
      updateWorkflow.mutate(
        { id: workflow.id, input: result.input },
        {
          onSuccess: () => {
            setSavedText(text);
            setSubmitAttempted(false);
            toast.success("Workflow saved");
          },
        }
      );
      return;
    }
    createWorkflow.mutate(result.input, {
      onSuccess: (created) => {
        toast.success("Workflow created");
        navigate(buildOrgPath(`/workflows/${created.id}`));
      },
    });
  };

  return (
    <form
      aria-label={workflow ? `Edit ${workflow.name}` : "New workflow"}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {readOnly ? (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>
            Only organization admins can change workflows. You are viewing this
            workflow read-only.
          </AlertDescription>
        </Alert>
      ) : null}
      <WorkflowYamlIntro />
      <WorkflowConfigurationGuide catalog={catalog} defaultOpen={!workflow} />
      {unavailable.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertDescription>
            Couldn't load the {unavailable.join(" and ")}: they are not
            suggested, and the YAML can only name them by id.
          </AlertDescription>
        </Alert>
      ) : null}
      <MissingConnectionsHint
        message="Connections are named by their project key: add Jira, Azure DevOps or Microsoft Teams to a project on its Integrations tab (the organization connection is set up in Settings). connection: http needs none."
        settingsPath={connectionsSettingsPath}
      />
      <Suspense
        fallback={
          <pre className="max-h-[36rem] overflow-auto rounded-md border p-3 font-mono text-xs">
            {text}
          </pre>
        }
      >
        <LazyWorkflowYamlEditor
          completionData={completionData}
          onChange={setText}
          readOnly={readOnly}
          value={text}
        />
      </Suspense>
      {result.input ? (
        <WorkflowActionsPreview
          actions={result.input.actions}
          catalog={catalog}
          triggers={result.input.triggers}
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          The actions in run order show here once the YAML has no errors.
        </p>
      )}
      {usesHttpEndpoint ? (
        <WorkflowHttpEndpoint
          connection={connections.find(
            (connection) => connection.id === workflow?.httpEndpointConnectionId
          )}
        />
      ) : null}
      {submitAttempted ? (
        <WorkflowYamlProblems problems={result.problems} />
      ) : null}
      {readOnly ? null : (
        <WorkflowEditorFooter
          error={workflow ? updateWorkflow.error : createWorkflow.error}
          hasProblems={submitAttempted && !result.input}
          isDirty={isDirty}
          isEdit={Boolean(workflow)}
          isPending={isPending}
          onDiscard={() => {
            setText(savedText);
            setSubmitAttempted(false);
          }}
        />
      )}
    </form>
  );
}

type WorkflowEditorFooterProps = {
  error: Error | null;
  /** A save was tried and the YAML has errors. */
  hasProblems: boolean;
  isDirty: boolean;
  isEdit: boolean;
  isPending: boolean;
  onDiscard: () => void;
};

/** The save error, the "fix the problems" note, Discard changes and the submit button. */
function WorkflowEditorFooter({
  error,
  hasProblems,
  isDirty,
  isEdit,
  isPending,
  onDiscard,
}: Readonly<WorkflowEditorFooterProps>) {
  return (
    <div className="sticky bottom-0 space-y-2 border-t bg-background py-3">
      <MutationErrorMessage
        error={error}
        title={
          isEdit
            ? WorkflowMutationErrorTitle.Update
            : WorkflowMutationErrorTitle.Create
        }
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        {hasProblems ? (
          <p className="text-destructive text-sm sm:mr-auto" role="alert">
            Fix the problems above before the workflow can be saved.
          </p>
        ) : null}
        {isEdit ? (
          <Button
            disabled={!isDirty || isPending}
            onClick={onDiscard}
            type="button"
            variant="ghost"
          >
            Discard changes
          </Button>
        ) : null}
        <Button disabled={isPending} type="submit">
          {isPending ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {getSubmitLabel(isEdit, isPending)}
        </Button>
      </div>
    </div>
  );
}

/** How a run moves through the YAML, and who changes source systems. */
function WorkflowYamlIntro() {
  return (
    <div className="space-y-1 text-muted-foreground text-sm">
      <p>
        When a trigger fires, the item is imported and the agent team works on
        it. The actions run in the order of the list, each on the run events it
        names with <code>on:</code>: those on <code>workflow.triggered</code>{" "}
        before the agent team, the others as the run plans, implements and ends.
        An action is an instruction an agent carries out, or a type with its
        options. Suggestions appear as you type, Ctrl+Space shows them anywhere,
        and {"{{"} lists the template variables.
      </p>
      <p className="font-medium text-foreground">
        {WORKFLOW_SOURCE_SYSTEMS_NOTICE}
      </p>
    </div>
  );
}

/** The problems of the YAML by line, errors and warnings, after a save attempt. */
function WorkflowYamlProblems({
  problems,
}: Readonly<{ problems: readonly YamlProblem[] }>) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Problems"
      className="space-y-1 rounded-md border p-3 text-sm"
      data-testid="workflow-yaml-problems"
    >
      {problems.map((problem) => (
        <li
          className={
            problem.severity === YamlProblemSeverity.Error
              ? "text-destructive"
              : "text-muted-foreground"
          }
          key={`${problem.from}-${problem.message}`}
        >
          Line {problem.line}: {problem.message}
        </li>
      ))}
    </ul>
  );
}

function getSubmitLabel(isEdit: boolean, isPending: boolean): string {
  if (isPending) {
    return "Saving...";
  }
  return isEdit ? "Save workflow" : "Create workflow";
}

const REPOSITORY_KEY_RE = /^\s*repository:/m;
