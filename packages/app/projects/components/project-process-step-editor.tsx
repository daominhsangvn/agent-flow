"use client";

import {
  PROCESS_INSTRUCTION_VARIABLES,
  ProcessDocumentType,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
// Cross-slice: the document type names belong to the documents slice.
import { DOCUMENT_TYPE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";
import {
  linesToList,
  listToLines,
  PROCESS_STEP_TYPE_LABELS,
  type ProcessDraftStep,
} from "../lib/process-draft";

export type ProcessStepEditorProps = {
  step: ProcessDraftStep;
  index: number;
  count: number;
  onChange: (step: ProcessDraftStep) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
};

/** One step of the project process editor, with the fields of its type. */
export function ProcessStepEditor({
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: Readonly<ProcessStepEditorProps>) {
  const fieldId = useId();
  return (
    <li
      className="space-y-3 rounded-md border p-3"
      data-testid="process-step-editor"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground text-xs">
          {index + 1}.
        </span>
        <Badge variant="outline">{PROCESS_STEP_TYPE_LABELS[step.type]}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button
            aria-label={`Move ${step.name || "step"} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Move ${step.name || "step"} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowDownIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Remove ${step.name || "step"}`}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${fieldId}-name`} label="Name">
          <Input
            id={`${fieldId}-name`}
            onChange={(event) =>
              onChange({ ...step, name: event.target.value })
            }
            value={step.name}
          />
        </Field>
        <Field id={`${fieldId}-id`} label="Step id">
          <Input
            id={`${fieldId}-id`}
            onChange={(event) => onChange({ ...step, id: event.target.value })}
            value={step.id}
          />
        </Field>
      </div>
      <StepTypeFields fieldId={fieldId} onChange={onChange} step={step} />
    </li>
  );
}

function StepTypeFields({
  step,
  fieldId,
  onChange,
}: {
  step: ProcessDraftStep;
  fieldId: string;
  onChange: (step: ProcessDraftStep) => void;
}) {
  switch (step.type) {
    case ProcessStepType.AgentFlowPlan:
      return (
        <QuestionsSelect
          id={`${fieldId}-questions`}
          onChange={(questions) => onChange({ ...step, questions })}
          value={step.questions ?? ProcessQuestionsPolicy.Ask}
        />
      );
    case ProcessStepType.AgentFlowExecute:
      return (
        <p className="text-muted-foreground text-xs">
          Implements the approved plan and pushes a branch in each repository
          with changes. Needs a AgentFlow plan step before it.
        </p>
      );
    case ProcessStepType.Approval:
      return (
        <Field
          hint="Step ids or file globs shown to the approver, one per line."
          id={`${fieldId}-show`}
          label="Show"
        >
          <Textarea
            id={`${fieldId}-show`}
            onChange={(event) =>
              onChange({ ...step, show: linesToList(event.target.value) })
            }
            rows={2}
            value={listToLines(step.show)}
          />
        </Field>
      );
    default:
      return (
        <AgentStepFields fieldId={fieldId} onChange={onChange} step={step} />
      );
  }
}

function AgentStepFields({
  step,
  fieldId,
  onChange,
}: {
  step: Extract<ProcessDraftStep, { type: typeof ProcessStepType.Agent }>;
  fieldId: string;
  onChange: (step: ProcessDraftStep) => void;
}) {
  return (
    <div className="space-y-3">
      <Field
        hint={`A toolkit command (e.g. /speckit-specify) or plain instructions. Variables: ${PROCESS_INSTRUCTION_VARIABLES.map((variable) => `{{${variable.name}}}`).join(", ")}.`}
        id={`${fieldId}-instruction`}
        label="Instruction"
      >
        <Textarea
          id={`${fieldId}-instruction`}
          onChange={(event) =>
            onChange({ ...step, instruction: event.target.value })
          }
          rows={3}
          value={step.instruction}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <QuestionsSelect
          id={`${fieldId}-questions`}
          onChange={(questions) => onChange({ ...step, questions })}
          value={step.questions ?? ProcessQuestionsPolicy.Continue}
        />
        <Field id={`${fieldId}-finish`} label="When the step ends">
          <Select
            onValueChange={(finish) =>
              onChange({ ...step, finish: finish as typeof step.finish })
            }
            value={step.finish ?? ProcessStepFinish.None}
          >
            <SelectTrigger id={`${fieldId}-finish`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ProcessStepFinish.None}>
                Keep the changes for the next step
              </SelectItem>
              <SelectItem value={ProcessStepFinish.Push}>
                Commit and push every repository
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        hint="Files (globs from the workspace root) shown on the run, one per line."
        id={`${fieldId}-artifacts`}
        label="Artifacts"
      >
        <Textarea
          id={`${fieldId}-artifacts`}
          onChange={(event) =>
            onChange({ ...step, artifacts: linesToList(event.target.value) })
          }
          rows={2}
          value={listToLines(step.artifacts)}
        />
      </Field>
      <Field
        hint="Optional. A file the step writes for people outside AgentFlow, e.g. the answer to post on the ticket. Post actions get its content as {{reply}}."
        id={`${fieldId}-reply`}
        label="Reply file"
      >
        <Input
          className="font-mono text-sm"
          id={`${fieldId}-reply`}
          onChange={(event) =>
            onChange({ ...step, reply: event.target.value.trim() || null })
          }
          placeholder=".agentflow-ai/work/reply.md"
          value={step.reply ?? ""}
        />
      </Field>
      <StepDocumentFields
        fieldId={fieldId}
        onChange={(document) => onChange({ ...step, document })}
        value={step.document ?? null}
      />
    </div>
  );
}

type StepDocumentDraft = NonNullable<
  Extract<ProcessDraftStep, { type: typeof ProcessStepType.Agent }>["document"]
>;

/** Value of the "Publish as document" select when the step publishes none. */
const NO_DOCUMENT = "none";

/** "Publish as document": type, file and title of the document the step publishes. */
function StepDocumentFields({
  fieldId,
  value,
  onChange,
}: {
  fieldId: string;
  value: StepDocumentDraft | null;
  onChange: (document: StepDocumentDraft | null) => void;
}) {
  return (
    <div className="space-y-3">
      <Field
        hint="Optional. When the step ends, one of its files becomes a document of the project, produced by the run's PRD or Issue: a PRD for a new feature, a plan, or a document such as a bug analysis. Later loops of the step add versions to it."
        id={`${fieldId}-document`}
        label="Publish as document"
      >
        <Select
          onValueChange={(type) =>
            onChange(
              type === NO_DOCUMENT
                ? null
                : {
                    type: type as StepDocumentDraft["type"],
                    path: value?.path ?? "",
                    title: value?.title ?? "",
                  }
            )
          }
          value={value?.type ?? NO_DOCUMENT}
        >
          <SelectTrigger id={`${fieldId}-document`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_DOCUMENT}>Nothing</SelectItem>
            {Object.values(ProcessDocumentType).map((type) => (
              <SelectItem key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {value ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            hint="The file the step writes, from the workspace root."
            id={`${fieldId}-document-path`}
            label="Document file"
          >
            <Input
              className="font-mono text-sm"
              id={`${fieldId}-document-path`}
              onChange={(event) =>
                onChange({ ...value, path: event.target.value.trim() })
              }
              placeholder=".agentflow-ai/work/prd.md"
              value={value.path}
            />
          </Field>
          <Field
            hint="Variables: {{issue.key}}, {{issue.title}}. Empty: the Issue's title."
            id={`${fieldId}-document-title`}
            label="Document title"
          >
            <Input
              id={`${fieldId}-document-title`}
              onChange={(event) =>
                onChange({ ...value, title: event.target.value })
              }
              placeholder="PRD: {{issue.title}}"
              value={value.title ?? ""}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function QuestionsSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (
    value: (typeof ProcessQuestionsPolicy)[keyof typeof ProcessQuestionsPolicy]
  ) => void;
}) {
  return (
    <Field id={id} label="Questions">
      <Select
        onValueChange={(next) =>
          onChange(
            next as (typeof ProcessQuestionsPolicy)[keyof typeof ProcessQuestionsPolicy]
          )
        }
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ProcessQuestionsPolicy.Ask}>
            Stop and ask
          </SelectItem>
          <SelectItem value={ProcessQuestionsPolicy.Continue}>
            Decide and go on
          </SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
