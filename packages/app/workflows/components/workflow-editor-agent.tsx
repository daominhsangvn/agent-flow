"use client";

import {
  WORKFLOW_INSTRUCTIONS_MAX,
  type WorkflowProjectRef,
  type WorkflowUserRef,
  workflowAgentModeSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
// Cross-slice: a project with a process of its own replaces mode and stop-on-questions.
import { useProjectProcess } from "@repo/app/projects/hooks/use-project-process";
// Cross-slice: the agent runs in one of the org's projects, as one of its members.
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
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
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useFormContext, useWatch } from "react-hook-form";
import type { WorkflowComputeTargetChoices } from "../lib/workflow-editor-options";
import { RUN_AS_SAVER, type WorkflowFormValues } from "../lib/workflow-form";
import {
  WORKFLOW_AGENT_MODE_DESCRIPTIONS,
  WORKFLOW_AGENT_MODE_LABELS,
} from "../lib/workflow-labels";
import { WorkflowEditorProcess } from "./workflow-editor-process";
import { WorkflowEditorSection } from "./workflow-editor-section";

export type WorkflowEditorAgentProps = {
  computeTargets: WorkflowComputeTargetChoices;
  /** The saved project, so it stays labelled even if the list does not include it. */
  currentProject: WorkflowProjectRef | null;
  /** The saved run-as user, so it stays labelled even if they left the list. */
  currentRunAsUser: WorkflowUserRef | null;
};

/** Project, mode, compute target, run-as user, repository and instructions of the agent team. */
export function WorkflowEditorAgent({
  computeTargets,
  currentProject,
  currentRunAsUser,
}: Readonly<WorkflowEditorAgentProps>) {
  const { control } = useFormContext<WorkflowFormValues>();
  const mode = useWatch({ control, name: "mode" });
  const overrideRepository = useWatch({ control, name: "overrideRepository" });
  const projectId = useWatch({ control, name: "projectId" });
  const ownProcess = useWatch({ control, name: "ownProcess" });
  const projectProcess = useProjectProcess(projectId || null);
  const customProcess = projectProcess.data?.current ?? null;
  // A process (the project's or the workflow's own) replaces the built-in
  // flow's mode and open-questions settings.
  const followsProcess = Boolean(ownProcess || customProcess?.definition);

  return (
    <WorkflowEditorSection
      description="How the agent team works on each item, after the pre actions: it imports the item (a PRD when the item is a product requirement, else an Issue), writes the plan and optionally implements it. Loops run on a desktop compute target as the run-as user."
      title="Agent team"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <ProjectField currentProject={currentProject} />
        <RunAsField currentRunAsUser={currentRunAsUser} />
      </div>
      {customProcess?.definition && !ownProcess ? (
        <p
          className="rounded-lg border p-3 text-sm"
          data-testid="workflow-project-process-notice"
        >
          The project has its own process (version {customProcess.version},{" "}
          {customProcess.definition.steps.map((step) => step.name).join(" → ")}
          ). Its runs follow it between the pre and post actions, so the mode
          and the open-questions setting below do not apply. Change it on the
          project&apos;s Process tab.
        </p>
      ) : null}
      {projectId ? (
        <WorkflowEditorProcess
          projectId={projectId}
          projectProcess={customProcess}
        />
      ) : null}
      {followsProcess ? null : <ModeField />}
      {!followsProcess && mode === WorkflowAgentMode.PlanAndExecute ? (
        <FormField
          control={control}
          name="stopOnOpenQuestions"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Stop when the plan has open questions</FormLabel>
                <FormDescription className="text-xs">
                  The run waits for a person instead of implementing a plan with
                  unanswered questions. Answer on the ticket and assign it to
                  the bot again, or approve the plan in AgentFlow.
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
      ) : null}
      <ComputeTargetField computeTargets={computeTargets} />
      <FormField
        control={control}
        name="overrideRepository"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Use a specific repository</FormLabel>
              <FormDescription className="text-xs">
                By default the project's repository is used. The repository must
                be in the project's team repository pool.
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      {overrideRepository ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={control}
            name="repositoryFullName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repository</FormLabel>
                <FormControl>
                  <Input placeholder="acme/web" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="repositoryBranch"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Base branch</FormLabel>
                <FormControl>
                  <Input placeholder="main" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      ) : null}
      <FormField
        control={control}
        name="titleTemplate"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Imported item title</FormLabel>
            <FormControl>
              <Input className="font-mono text-sm" {...field} />
            </FormControl>
            <FormDescription className="text-xs">
              Title of the imported PRD or Issue. Use variables such as{" "}
              <code>{"{{source.key}}"}</code> and{" "}
              <code>{"{{source.title}}"}</code>.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="instructions"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Additional instructions</FormLabel>
            <FormControl>
              <Textarea
                maxLength={WORKFLOW_INSTRUCTIONS_MAX}
                placeholder="Coding conventions, areas to avoid, how to test..."
                rows={4}
                {...field}
              />
            </FormControl>
            <FormDescription className="text-xs">
              Appended to every imported PRD or Issue under "Additional
              instructions".
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </WorkflowEditorSection>
  );
}

function ProjectField({
  currentProject,
}: Readonly<{ currentProject: WorkflowProjectRef | null }>) {
  const { control } = useFormContext<WorkflowFormValues>();
  const projects = useProjects();
  const options = (projects.data ?? []).map((project) => ({
    id: project.id,
    name: project.name,
  }));
  if (currentProject && !options.some((p) => p.id === currentProject.id)) {
    options.push(currentProject);
  }

  return (
    <FormField
      control={control}
      name="projectId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Project</FormLabel>
          <Select
            disabled={projects.isLoading}
            onValueChange={field.onChange}
            value={field.value || undefined}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    projects.isLoading
                      ? "Loading projects..."
                      : "Select a project"
                  }
                />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription className="text-xs">
            Imported Issues and plans are created in this project.
          </FormDescription>
          {projects.error ? (
            <p className="text-destructive text-sm">
              Couldn't load projects: {projects.error.message}
            </p>
          ) : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function RunAsField({
  currentRunAsUser,
}: Readonly<{ currentRunAsUser: WorkflowUserRef | null }>) {
  const { control } = useFormContext<WorkflowFormValues>();
  const users = useOrganizationUsers();
  // A saved run-as user is always re-sent (an omitted one keeps the stored
  // user on update), so "whoever saves" is only offered when none is stored.
  const offerSaver = currentRunAsUser === null;
  const options = (users.data ?? [])
    .filter((user) => user.active)
    .map((user) => ({ id: user.id, label: getUserDisplayName(user) }));
  if (
    currentRunAsUser &&
    !options.some((user) => user.id === currentRunAsUser.id)
  ) {
    options.push({
      id: currentRunAsUser.id,
      label: currentRunAsUser.name || currentRunAsUser.email,
    });
  }

  return (
    <FormField
      control={control}
      name="runAsUserId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Run as</FormLabel>
          <Select onValueChange={field.onChange} value={field.value}>
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {offerSaver ? (
                <SelectItem value={RUN_AS_SAVER}>Me (whoever saves)</SelectItem>
              ) : null}
              {options.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription className="text-xs">
            Commit author and concurrency budget of the loops.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function ModeField() {
  const { control } = useFormContext<WorkflowFormValues>();

  return (
    <FormField
      control={control}
      name="mode"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Mode</FormLabel>
          <FormControl>
            <RadioGroup
              className="grid gap-3 sm:grid-cols-2"
              onValueChange={(value) => {
                const parsed = workflowAgentModeSchema.safeParse(value);
                if (parsed.success) {
                  field.onChange(parsed.data);
                }
              }}
              value={field.value}
            >
              {MODE_ORDER.map((mode) => (
                <Label
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"
                  htmlFor={`workflow-mode-${mode}`}
                  key={mode}
                >
                  <RadioGroupItem
                    className="mt-0.5"
                    id={`workflow-mode-${mode}`}
                    value={mode}
                  />
                  <span className="space-y-1">
                    <span className="block font-medium text-sm">
                      {WORKFLOW_AGENT_MODE_LABELS[mode]}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {WORKFLOW_AGENT_MODE_DESCRIPTIONS[mode]}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function ComputeTargetField({
  computeTargets,
}: Readonly<{ computeTargets: WorkflowComputeTargetChoices }>) {
  const { control } = useFormContext<WorkflowFormValues>();

  return (
    <FormField
      control={control}
      name="computeTargetId"
      render={({ field }) => {
        const isKnown =
          field.value === "" ||
          computeTargets.options.some((option) => option.id === field.value);
        return (
          <FormItem>
            <FormLabel>Compute target</FormLabel>
            <Select
              disabled={computeTargets.isLoading}
              onValueChange={field.onChange}
              value={field.value || undefined}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      computeTargets.isLoading
                        ? "Loading compute targets..."
                        : "Select a desktop compute target"
                    }
                  />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {computeTargets.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                    {option.isOnline ? "" : " (offline)"}
                    {option.description ? ` - ${option.description}` : ""}
                  </SelectItem>
                ))}
                {isKnown ? null : (
                  <SelectItem value={field.value}>
                    Unavailable compute target
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <FormDescription className="text-xs">
              Workflows run only on desktop compute targets owned by the run-as
              user or shared with the organization. The target must be online
              when a run starts.
            </FormDescription>
            {computeTargets.error ? (
              <p className="text-destructive text-sm">
                Couldn't load compute targets: {computeTargets.error.message}
              </p>
            ) : null}
            {!(computeTargets.isLoading || computeTargets.error) &&
            computeTargets.options.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No compute target is available. Open the AgentFlow desktop app
                on a machine and connect it to this organization.
              </p>
            ) : null}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

const MODE_ORDER: readonly WorkflowAgentMode[] = [
  WorkflowAgentMode.Plan,
  WorkflowAgentMode.PlanAndExecute,
];
