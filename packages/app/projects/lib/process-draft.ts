import {
  type ProcessStep,
  ProcessStepType,
  type ProjectProcess,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import { processYamlSyntaxProblem } from "./process-yaml";

/**
 * Editing helpers of the project process editor (project-process-panel.tsx):
 * the draft is a ProjectProcessInput validated by the shared schema, so the
 * editor shows exactly the errors the API would answer with.
 */

export type ProcessDraftStep = ProjectProcessInput["steps"][number];

export const PROCESS_STEP_TYPE_LABELS: Record<ProcessStep["type"], string> = {
  [ProcessStepType.AgentFlowPlan]: "AgentFlow plan",
  [ProcessStepType.AgentFlowExecute]: "AgentFlow implement",
  [ProcessStepType.Agent]: "Agent step",
  [ProcessStepType.Approval]: "Approval",
};

export type ProcessDraftIssue = { path: string; message: string };

/**
 * The validated process, else the issues to show next to the editor. A
 * draft edited as YAML whose text does not parse is invalid even though its
 * fields still hold the last text that did.
 */
export function validateProcessDraft(
  draft: ProjectProcessInput
):
  | { ok: true; process: ProjectProcess }
  | { ok: false; issues: ProcessDraftIssue[] } {
  const yamlProblem =
    draft.source === undefined ? null : processYamlSyntaxProblem(draft.source);
  if (yamlProblem) {
    return {
      ok: false,
      issues: [
        { path: `YAML line ${yamlProblem.line}`, message: yamlProblem.message },
      ],
    };
  }
  const parsed = projectProcessSchema.safeParse(draft);
  if (parsed.success) {
    return { ok: true, process: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: describeIssuePath(draft, issue.path),
      message: issue.message,
    })),
  };
}

/** One path per line, blank lines dropped. */
export function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function listToLines(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

/** A new step of `type` with an id not used by the draft yet. */
export function newProcessStep(
  type: ProcessStep["type"],
  draft: ProjectProcessInput
): ProcessDraftStep {
  const base = STEP_ID_BASES[type];
  const used = new Set(draft.steps.map((step) => step.id));
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) {
    id = `${base}-${suffix}`;
  }
  switch (type) {
    case ProcessStepType.AgentFlowPlan:
      return { type, id, name: "Plan", questions: "ask" };
    case ProcessStepType.AgentFlowExecute:
      return { type, id, name: "Implement" };
    case ProcessStepType.Approval:
      return { type, id, name: "Approve", show: [] };
    default:
      return {
        type: ProcessStepType.Agent,
        id,
        name: "Agent step",
        instruction: "",
        questions: "continue",
        artifacts: [],
        finish: "none",
        timeoutMinutes: null,
      };
  }
}

/** The draft with the step at `index` moved by `offset` (-1 up, 1 down). */
export function moveProcessStep(
  draft: ProjectProcessInput,
  index: number,
  offset: -1 | 1
): ProjectProcessInput {
  const target = index + offset;
  if (target < 0 || target >= draft.steps.length) {
    return draft;
  }
  const steps = [...draft.steps];
  const [moved] = steps.splice(index, 1);
  if (moved) {
    steps.splice(target, 0, moved);
  }
  return { ...draft, steps };
}

const STEP_ID_BASES: Record<ProcessStep["type"], string> = {
  [ProcessStepType.AgentFlowPlan]: "plan",
  [ProcessStepType.AgentFlowExecute]: "execute",
  [ProcessStepType.Agent]: "step",
  [ProcessStepType.Approval]: "approve",
};

/** "Step 2 (clarify) · instruction" instead of "steps.1.instruction". */
function describeIssuePath(
  draft: ProjectProcessInput,
  path: readonly PropertyKey[]
): string {
  const [section, index, field] = path;
  if (section === "steps" && typeof index === "number") {
    const step = draft.steps[index];
    const label = step?.name
      ? `Step ${index + 1} (${step.name})`
      : `Step ${index + 1}`;
    return field === undefined ? label : `${label} · ${String(field)}`;
  }
  if (section === "toolkit") {
    return index === undefined ? "Toolkit" : `Toolkit · ${String(index)}`;
  }
  return path.length > 0 ? path.map(String).join(".") : "Process";
}
