"use client";

import {
  agentStepFinish,
  PROCESS_PRESETS,
  PROCESS_STEPS_MAX,
  type ProcessStep,
  ProcessStepFinish,
  ProcessStepType,
  type ProjectProcess,
  type ProjectProcessInput,
  type ProjectProcessVersion,
} from "@repo/api/src/types/project-process";
// Cross-slice: same retryable error block as the repositories list.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { useIntegrationProviders } from "@repo/app/integrations/hooks/use-integrations";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROCESS_FORM_EDITOR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { lazy, Suspense, useId, useMemo, useState } from "react";
import { useProjectConnections } from "../hooks/use-project-connections";
import {
  useProjectProcess,
  useProjectProcessVersions,
  useSaveProjectProcess,
} from "../hooks/use-project-process";
import { useProjectRepositories } from "../hooks/use-project-repositories";
import {
  linesToList,
  listToLines,
  moveProcessStep,
  newProcessStep,
  PROCESS_STEP_TYPE_LABELS,
  validateProcessDraft,
} from "../lib/process-draft";
import {
  parseProcessYaml,
  processYamlText,
  withoutProcessSource,
} from "../lib/process-yaml";
import { ProcessStepEditor } from "./project-process-step-editor";

export type ProjectProcessPanelProps = {
  projectId: string;
  /** Org admins change the process; members read it and its history (the API enforces it). */
  isAdmin: boolean;
};

/**
 * Project → Process: the steps this project's workflow runs follow between
 * their pre and post actions. Without a process, runs follow the built-in
 * AgentFlow flow of each workflow's agent settings. Every save is a new
 * version; runs already started keep the version they started with.
 */
export function ProjectProcessPanel({
  projectId,
  isAdmin,
}: Readonly<ProjectProcessPanelProps>) {
  const process = useProjectProcess(projectId);
  const save = useSaveProjectProcess(projectId);
  const [draft, setDraft] = useState<ProjectProcessInput | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  if (process.error) {
    return (
      <QueryErrorMessage
        error={process.error}
        onRetry={() => process.refetch()}
        title="Couldn't load the project's process"
      />
    );
  }
  if (process.isLoading || !process.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const current = process.data.current;

  return (
    <div className="space-y-4" data-testid="project-process-panel">
      <div>
        <h4 className="font-medium text-sm">Process</h4>
        <p className="text-muted-foreground text-xs">
          The steps every workflow run of this project goes through between its
          pre actions and post actions: the AgentFlow agents, or the commands of
          a toolkit such as Spec Kit. Runs already started keep the version they
          started with.
          {isAdmin ? null : " Only organization admins can change it."}
        </p>
      </div>
      {process.data.invalidVersion === null ? null : (
        <p className="rounded-md border border-destructive/40 p-3 text-destructive text-sm">
          Version {process.data.invalidVersion} cannot be read by this version
          of AgentFlow, so new runs fail. Save a process again to fix it.
        </p>
      )}
      {isAdmin && draft ? (
        <ProcessEditor
          draft={draft}
          isSaving={save.isPending}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onSave={(saved) =>
            save.mutate({ process: saved }, { onSuccess: () => setDraft(null) })
          }
          projectId={projectId}
        />
      ) : (
        <ProcessSummary
          canEdit={isAdmin}
          current={current}
          isSaving={save.isPending}
          onCustomize={() =>
            setDraft(current?.definition ?? clonePreset(PRESET_AGENTFLOW))
          }
          onReset={() => save.mutate({ process: null })}
        />
      )}
      <div>
        <Button
          onClick={() => setShowHistory((value) => !value)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {showHistory ? "Hide history" : "History"}
        </Button>
        {showHistory ? (
          <ProcessHistory
            onRestore={
              isAdmin
                ? (version) => {
                    setDraft(
                      version.definition ?? clonePreset(PRESET_AGENTFLOW)
                    );
                    setShowHistory(false);
                  }
                : null
            }
            projectId={projectId}
          />
        ) : null}
      </div>
    </div>
  );
}

const PRESET_AGENTFLOW = "agentflow";

function clonePreset(key: string): ProjectProcessInput {
  const preset =
    PROCESS_PRESETS.find((candidate) => candidate.key === key) ??
    PROCESS_PRESETS[0];
  return structuredClone(
    preset?.process ?? { toolkit: null, steps: [] }
  ) as ProjectProcessInput;
}

function ProcessSummary({
  canEdit,
  current,
  isSaving,
  onCustomize,
  onReset,
}: {
  canEdit: boolean;
  current: ProjectProcessVersion | null;
  isSaving: boolean;
  onCustomize: () => void;
  onReset: () => void;
}) {
  if (!current?.definition) {
    return (
      <div className="space-y-3 rounded-md border border-dashed p-3">
        <p className="text-sm">
          <span className="font-medium">AgentFlow (default).</span> Runs plan
          with the AgentFlow agents, stop for open questions, then implement and
          push, as set in each workflow&apos;s agent settings.
        </p>
        {canEdit ? (
          <Button onClick={onCustomize} size="sm" type="button">
            Customize
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Version {current.version}
        {current.createdBy?.name ? ` · saved by ${current.createdBy.name}` : ""}
        {` · ${new Date(current.createdAt).toLocaleString()}`}
      </p>
      <ProcessOverview process={current.definition} />
      {canEdit ? (
        <div className="flex gap-2">
          <Button onClick={onCustomize} size="sm" type="button">
            Edit
          </Button>
          <Button
            disabled={isSaving}
            onClick={onReset}
            size="sm"
            type="button"
            variant="outline"
          >
            Use the AgentFlow default
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProcessOverview({ process }: { process: ProjectProcess }) {
  return (
    <div className="space-y-2">
      {process.toolkit ? (
        <p className="text-sm">
          Toolkit:{" "}
          <span className="font-medium">{process.toolkit.repository}</span>{" "}
          <span className="text-muted-foreground">
            ({process.toolkit.mounts.join(", ")})
          </span>
        </p>
      ) : null}
      <ol className="divide-y rounded-md border">
        {process.steps.map((step, index) => (
          <li
            className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            data-testid="process-step-row"
            key={step.id}
          >
            <span className="text-muted-foreground text-xs">{index + 1}.</span>
            <span className="font-medium">{step.name}</span>
            <Badge variant="outline">
              {PROCESS_STEP_TYPE_LABELS[step.type]}
            </Badge>
            <StepFacts step={step} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepFacts({ step }: { step: ProcessStep }) {
  const facts: string[] = [];
  if (step.type === ProcessStepType.Agent) {
    if (step.role) {
      facts.push(step.role);
    }
    facts.push(step.instruction.split("\n")[0] ?? "");
    if (agentStepFinish(step) === ProcessStepFinish.Push) {
      facts.push("pushes");
    }
  }
  if (
    (step.type === ProcessStepType.Agent ||
      step.type === ProcessStepType.AgentFlowPlan) &&
    step.questions === "ask"
  ) {
    facts.push("asks");
  }
  return facts.length > 0 ? (
    <span className="truncate text-muted-foreground text-xs">
      {facts.join(" · ")}
    </span>
  ) : null;
}

/**
 * Edits a process draft: presets, toolkit, steps. The project's Process tab
 * saves it as a version (`onSave`); the workflow editor embeds it for a
 * workflow's own process and saves it with the workflow (no `onSave`).
 */
export function ProcessEditor({
  projectId,
  draft,
  isSaving = false,
  onChange,
  onSave,
  onCancel,
}: {
  projectId: string;
  draft: ProjectProcessInput;
  isSaving?: boolean;
  onChange: (draft: ProjectProcessInput) => void;
  onSave?: (process: ProjectProcess) => void;
  onCancel?: () => void;
}) {
  const validation = validateProcessDraft(draft);
  // The process is edited as YAML; the form view is behind a flag.
  const showForm = useFeatureFlagEnabledOptional(
    PROCESS_FORM_EDITOR_FEATURE_FLAG_KEY
  );
  return (
    <div className="space-y-4" data-testid="project-process-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Start from</span>
        {PROCESS_PRESETS.map((preset) => (
          <Button
            key={preset.key}
            onClick={() => onChange(clonePreset(preset.key))}
            size="sm"
            title={preset.description}
            type="button"
            variant="outline"
          >
            {preset.name}
          </Button>
        ))}
      </div>
      {showForm ? (
        <ProcessEditorTabs
          draft={draft}
          onChange={onChange}
          projectId={projectId}
        />
      ) : (
        <div className="space-y-2">
          <ProcessYamlView
            draft={draft}
            onChange={onChange}
            projectId={projectId}
          />
        </div>
      )}
      {validation.ok ? null : (
        <ul
          className="space-y-1 rounded-md border border-destructive/40 p-3 text-destructive text-sm"
          data-testid="process-issues"
        >
          {validation.issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {onSave ? (
        <div className="flex gap-2">
          <Button
            disabled={!validation.ok || isSaving}
            onClick={() => {
              if (validation.ok) {
                onSave(validation.process);
              }
            }}
            size="sm"
            type="button"
          >
            {isSaving ? "Saving…" : "Save process"}
          </Button>
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ToolkitEditor({
  projectId,
  draft,
  onChange,
}: {
  projectId: string;
  draft: ProjectProcessInput;
  onChange: (draft: ProjectProcessInput) => void;
}) {
  const fieldId = useId();
  const toolkit = draft.toolkit ?? null;
  const repositories = useProjectRepositories(projectId, {
    enabled: toolkit !== null,
  });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={toolkit !== null}
          id={`${fieldId}-use`}
          onCheckedChange={(checked) =>
            onChange({
              ...draft,
              toolkit: checked
                ? {
                    repository: "",
                    mounts: [".claude/skills", ".claude/commands"],
                    instructions: "",
                  }
                : null,
            })
          }
        />
        <Label htmlFor={`${fieldId}-use`}>
          Load skills and commands from a toolkit repository
        </Label>
      </div>
      {toolkit ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-repo`}>Toolkit repository</Label>
            <Select
              onValueChange={(repository) =>
                onChange({ ...draft, toolkit: { ...toolkit, repository } })
              }
              value={toolkit.repository || undefined}
            >
              <SelectTrigger id={`${fieldId}-repo`}>
                <SelectValue placeholder="Choose one of the project's repositories" />
              </SelectTrigger>
              <SelectContent>
                {(repositories.data ?? []).map((repository) => (
                  <SelectItem key={repository.id} value={repository.fullName}>
                    {repository.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-mounts`}>Directories to load</Label>
            <Textarea
              id={`${fieldId}-mounts`}
              onChange={(event) =>
                onChange({
                  ...draft,
                  toolkit: {
                    ...toolkit,
                    mounts: linesToList(event.target.value),
                  },
                })
              }
              rows={3}
              value={listToLines(toolkit.mounts)}
            />
            <p className="text-muted-foreground text-xs">
              Linked from the toolkit repository into the workspace root, one
              per line (e.g. .claude/skills, .specify).
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-instructions`}>
              Toolkit instructions
            </Label>
            <Textarea
              id={`${fieldId}-instructions`}
              onChange={(event) =>
                onChange({
                  ...draft,
                  toolkit: { ...toolkit, instructions: event.target.value },
                })
              }
              rows={3}
              value={toolkit.instructions ?? ""}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProcessHistory({
  projectId,
  onRestore,
}: {
  projectId: string;
  /** Null: the viewer cannot restore a version. */
  onRestore: ((version: ProjectProcessVersion) => void) | null;
}) {
  const versions = useProjectProcessVersions(projectId, true);
  if (versions.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const list = versions.data?.versions ?? [];
  if (list.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No versions yet: the project uses the AgentFlow default.
      </p>
    );
  }
  return (
    <ul
      className="mt-2 divide-y rounded-md border"
      data-testid="process-history"
    >
      {list.map((version) => (
        <li
          className="flex items-center gap-2 px-3 py-2 text-sm"
          key={version.version}
        >
          <span className="font-medium">Version {version.version}</span>
          <span className="text-muted-foreground text-xs">
            {version.definition
              ? `${version.definition.steps.length} steps`
              : "AgentFlow default"}
            {version.createdBy?.name ? ` · ${version.createdBy.name}` : ""}
            {` · ${new Date(version.createdAt).toLocaleString()}`}
          </span>
          {onRestore ? (
            <Button
              className="ml-auto"
              onClick={() => onRestore(version)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Restore
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const ProcessEditorMode = { Yaml: "yaml", Form: "form" } as const;
type ProcessEditorMode =
  (typeof ProcessEditorMode)[keyof typeof ProcessEditorMode];

// The code editor loads when the YAML view first opens.
const LazyProcessYamlEditor = lazy(() =>
  import("./process-yaml-editor").then((module) => ({
    default: module.ProcessYamlEditor,
  }))
);

/** The process as YAML: suggestions while typing, problems underlined. */
function ProcessYamlView({
  projectId,
  draft,
  onChange,
}: {
  projectId: string;
  draft: ProjectProcessInput;
  onChange: (draft: ProjectProcessInput) => void;
}) {
  const repositories = useProjectRepositories(projectId);
  // Only org admins edit the process, and only they may list connections.
  const connections = useProjectConnections(projectId);
  const providers = useIntegrationProviders();
  const stepIds = Array.isArray(draft.steps)
    ? draft.steps.flatMap((step) =>
        typeof step?.id === "string" && step.id ? [step.id] : []
      )
    : [];
  const stepIdsKey = stepIds.join("\n");
  const completionData = useMemo(
    () => ({
      repositories: (repositories.data ?? []).map(
        (repository) => repository.fullName
      ),
      stepIds: stepIdsKey ? stepIdsKey.split("\n") : [],
      projectConnections: connections.data ?? [],
      providers: providers.data ?? [],
    }),
    [repositories.data, stepIdsKey, connections.data, providers.data]
  );
  const text = processYamlText(draft);
  return (
    <>
      <p className="text-muted-foreground text-xs">
        Suggestions appear as you type: the keys that fit where the cursor is,
        their allowed values, your repositories, step ids and the connections an
        agent step's connections: may grant; {"{{"} lists the variables of an
        instruction, Ctrl+Space shows the suggestions anywhere. Comments are
        kept.
      </p>
      <Suspense
        fallback={
          <pre className="max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs">
            {text}
          </pre>
        }
      >
        <LazyProcessYamlEditor
          completionData={completionData}
          onChange={(next) => {
            const parsed = parseProcessYaml(next);
            onChange(parsed.ok ? parsed.draft : { ...draft, source: next });
          }}
          value={text}
        />
      </Suspense>
    </>
  );
}

/** The form can show the draft: a list of step mappings and a toolkit mapping or none. */
function isFormShaped(draft: ProjectProcessInput): boolean {
  const toolkit: unknown = draft.toolkit;
  return (
    (draft.source === undefined || parseProcessYaml(draft.source).ok) &&
    Array.isArray(draft.steps) &&
    draft.steps.every((step) => typeof step === "object" && step !== null) &&
    (toolkit === null ||
      toolkit === undefined ||
      (typeof toolkit === "object" && !Array.isArray(toolkit)))
  );
}

/**
 * The form view of the process editor. A component of its own so the
 * draft's steps are only read once the form is shown: the YAML being typed
 * can hold anything (an empty step, no steps at all) until it is fixed.
 */
function ProcessFormView({
  projectId,
  draft,
  onChange,
}: {
  projectId: string;
  draft: ProjectProcessInput;
  onChange: (draft: ProjectProcessInput) => void;
}) {
  const [newStepType, setNewStepType] = useState<ProcessStep["type"]>(
    ProcessStepType.Agent
  );
  return (
    <>
      <ToolkitEditor draft={draft} onChange={onChange} projectId={projectId} />
      <ol className="space-y-3">
        {draft.steps.map((step, index) => (
          <ProcessStepEditor
            count={draft.steps.length}
            index={index}
            // biome-ignore lint/suspicious/noArrayIndexKey: step ids are edited in place, and every field is controlled, so a position key keeps focus without losing state.
            key={`${index}-${step.type}`}
            onChange={(next) =>
              onChange({
                ...draft,
                steps: draft.steps.map((other, position) =>
                  position === index ? next : other
                ),
              })
            }
            onMove={(offset) => onChange(moveProcessStep(draft, index, offset))}
            onRemove={() =>
              onChange({
                ...draft,
                steps: draft.steps.filter((_, position) => position !== index),
              })
            }
            step={step}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(type) => setNewStepType(type as ProcessStep["type"])}
          value={newStepType}
        >
          <SelectTrigger aria-label="Type of the new step" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PROCESS_STEP_TYPE_LABELS).map(([type, label]) => (
              <SelectItem key={type} value={type}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={draft.steps.length >= PROCESS_STEPS_MAX}
          onClick={() =>
            onChange({
              ...draft,
              steps: [...draft.steps, newProcessStep(newStepType, draft)],
            })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Add step
        </Button>
      </div>
    </>
  );
}

/**
 * The YAML and the form as two tabs (the process-form-editor flag). The form
 * is disabled while the YAML does not parse; its edits regenerate the YAML.
 */
function ProcessEditorTabs({
  projectId,
  draft,
  onChange,
}: {
  projectId: string;
  draft: ProjectProcessInput;
  onChange: (draft: ProjectProcessInput) => void;
}) {
  const [mode, setMode] = useState<ProcessEditorMode>(ProcessEditorMode.Yaml);
  // The form edits the fields: their YAML is generated again from them.
  const onFormChange = (next: ProjectProcessInput) =>
    onChange(withoutProcessSource(next));
  const formEditable = isFormShaped(draft);
  return (
    <Tabs
      onValueChange={(value) => setMode(value as ProcessEditorMode)}
      value={formEditable ? mode : ProcessEditorMode.Yaml}
    >
      <TabsList>
        <TabsTrigger value={ProcessEditorMode.Yaml}>YAML</TabsTrigger>
        <TabsTrigger
          disabled={!formEditable}
          title={formEditable ? undefined : "Fix the YAML to use the form"}
          value={ProcessEditorMode.Form}
        >
          Form
        </TabsTrigger>
      </TabsList>
      <TabsContent className="space-y-2 pt-3" value={ProcessEditorMode.Yaml}>
        <ProcessYamlView
          draft={draft}
          onChange={onChange}
          projectId={projectId}
        />
      </TabsContent>
      <TabsContent className="space-y-4 pt-3" value={ProcessEditorMode.Form}>
        <ProcessFormView
          draft={draft}
          onChange={onFormChange}
          projectId={projectId}
        />
      </TabsContent>
    </Tabs>
  );
}
