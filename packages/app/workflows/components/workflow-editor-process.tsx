"use client";

import {
  PROCESS_PRESETS,
  type ProjectProcessInput,
  type ProjectProcessState,
} from "@repo/api/src/types/project-process";
// Cross-slice: a workflow's own process is edited with the project process editor.
import { ProcessEditor } from "@repo/app/projects/components/project-process-panel";
import {
  FormField,
  FormItem,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { useFormContext } from "react-hook-form";
import type { WorkflowFormValues } from "../lib/workflow-form";

const ProcessChoice = {
  Project: "project",
  Own: "own",
} as const;

export type WorkflowEditorProcessProps = {
  projectId: string;
  /** The project's process, when it has one. */
  projectProcess: ProjectProcessState["current"];
};

/**
 * Which process the workflow's runs follow between the pre and post actions:
 * the project's (its current version, or the built-in AgentFlow flow), or
 * one of the workflow's own. Several workflows of one project can then run
 * different steps on the same items, e.g. analysing requirements and
 * answering questions on the tickets.
 */
export function WorkflowEditorProcess({
  projectId,
  projectProcess,
}: Readonly<WorkflowEditorProcessProps>) {
  const { control } = useFormContext<WorkflowFormValues>();
  return (
    <FormField
      control={control}
      name="ownProcess"
      render={({ field }) => {
        const choice = field.value ? ProcessChoice.Own : ProcessChoice.Project;
        return (
          <FormItem
            className="space-y-3 rounded-lg border p-3"
            data-testid="workflow-process"
          >
            <div className="space-y-0.5">
              <Label>Process</Label>
              <p className="text-muted-foreground text-xs">
                The steps a run goes through between the pre and post actions.
              </p>
            </div>
            <RadioGroup
              className="gap-2"
              onValueChange={(value) =>
                field.onChange(
                  value === ProcessChoice.Own
                    ? (field.value ?? startingProcess(projectProcess))
                    : null
                )
              }
              value={choice}
            >
              <ProcessOption
                description={describeProjectProcess(projectProcess)}
                label="The project's process"
                value={ProcessChoice.Project}
              />
              <ProcessOption
                description="Steps only this workflow's runs follow, for example answering questions while another workflow analyses requirements."
                label="Its own process"
                value={ProcessChoice.Own}
              />
            </RadioGroup>
            {field.value ? (
              <ProcessEditor
                draft={field.value}
                onChange={(draft) => field.onChange(draft)}
                projectId={projectId}
              />
            ) : null}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

function ProcessOption({
  value,
  label,
  description,
}: Readonly<{ value: string; label: string; description: string }>) {
  const id = `workflow-process-${value}`;
  return (
    <div className="flex items-start gap-2">
      <RadioGroupItem className="mt-0.5" id={id} value={value} />
      <div className="space-y-0.5">
        <Label className="font-normal" htmlFor={id}>
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
    </div>
  );
}

function describeProjectProcess(
  current: ProjectProcessState["current"]
): string {
  if (!current?.definition) {
    return "The built-in AgentFlow flow: the agent settings below decide whether it implements the plan.";
  }
  return `Version ${current.version}: ${current.definition.steps
    .map((step) => step.name)
    .join(" → ")}. Change it on the project's Process tab.`;
}

/** A new own process starts from the project's, else from the AgentFlow preset. */
function startingProcess(
  current: ProjectProcessState["current"]
): ProjectProcessInput {
  const base = current?.definition ?? PROCESS_PRESETS[0]?.process;
  return structuredClone(
    base ?? { toolkit: null, steps: [] }
  ) as ProjectProcessInput;
}
