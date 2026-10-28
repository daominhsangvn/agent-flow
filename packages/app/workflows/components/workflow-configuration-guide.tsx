"use client";

import {
  type IntegrationActionSummary,
  type IntegrationFieldDescriptor,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import {
  PROCESS_INSTRUCTION_VARIABLES,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  WORKFLOW_TEMPLATE_VARIABLES,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
// Cross-slice: the same settings summary as the project's Integrations tab.
import { summarizeSettings } from "@repo/app/projects/components/project-connections-panel";
// Cross-slice: agent.process is the project process, so its keys read the same.
import { PROCESS_YAML_KEYS } from "@repo/app/projects/lib/process-yaml";
import {
  PROCESS_STEP_SNIPPETS,
  PROCESS_YAML_KEY_DOCS,
} from "@repo/app/projects/lib/process-yaml-completions";
import { Badge } from "@repo/design-system/components/ui/badge";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { type ReactNode, useState } from "react";
import { findProvider } from "../lib/workflow-catalog";
import {
  WORKFLOW_RUN_EVENT_DESCRIPTIONS,
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_RUN_EVENT_ORDER,
} from "../lib/workflow-labels";
import {
  WORKFLOW_ACTION_EXAMPLES,
  WORKFLOW_ACTION_KEY_DOCS,
  WORKFLOW_ACTION_ORDER_GUIDE,
  WORKFLOW_CONNECTION_CHOICE_GUIDE,
  WORKFLOW_INSTRUCTION_GUIDE,
  WORKFLOW_ORCHESTRATOR_KEY_DOCS,
  WORKFLOW_PRD_KEY_DOCS,
  WORKFLOW_PROCESS_GUIDE,
  WORKFLOW_REPOSITORY_KEY_DOCS,
  WORKFLOW_RUN_GUIDE,
  WORKFLOW_TRIGGER_KEY_DOCS,
  WORKFLOW_YAML_KEY_DOCS,
  type WorkflowYamlKeyDoc,
} from "../lib/workflow-yaml-docs";
import {
  BUILT_IN_HTTP_REFERENCE,
  WORKFLOW_YAML_KEYS,
  type WorkflowYamlCatalog,
} from "../lib/workflow-yaml-schema";

/**
 * Everything an admin needs to write a workflow's YAML without leaving the
 * editor: how a run goes and every key of the workflow, its triggers and its
 * agent; the run events and when they fire; the keys of an action, how an
 * instruction runs and which connection an action without one works on; the
 * process steps and their keys; the org's connections with every trigger and
 * action type and their options; the template variables and when each has a
 * value; and worked examples to copy. Connections and types
 * come from the org and the provider catalog, so the guide always matches
 * what the YAML can name.
 */

export type WorkflowConfigurationGuideProps = {
  catalog: Pick<
    WorkflowYamlCatalog,
    "providers" | "projectConnections" | "projects"
  >;
  /** Open at first (a new workflow); closed when editing a saved one. */
  defaultOpen?: boolean;
};

export function WorkflowConfigurationGuide({
  catalog,
  defaultOpen = false,
}: Readonly<WorkflowConfigurationGuideProps>) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      aria-label="Configuration guide"
      className="rounded-md border px-3"
    >
      <CollapsibleSection
        onOpenChange={setOpen}
        open={open}
        title="Configuration guide"
      >
        <Tabs defaultValue={GuideTab.Workflow}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value={GuideTab.Workflow}>Workflow</TabsTrigger>
            <TabsTrigger value={GuideTab.Events}>Run events</TabsTrigger>
            <TabsTrigger value={GuideTab.Actions}>Actions</TabsTrigger>
            <TabsTrigger value={GuideTab.Process}>Process</TabsTrigger>
            <TabsTrigger value={GuideTab.Connections}>Connections</TabsTrigger>
            <TabsTrigger value={GuideTab.Variables}>Variables</TabsTrigger>
            <TabsTrigger value={GuideTab.Examples}>Examples</TabsTrigger>
          </TabsList>
          <TabsContent className="mt-3" value={GuideTab.Workflow}>
            <WorkflowKeysGuide />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Events}>
            <RunEventsGuide />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Actions}>
            <ActionsGuide />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Process}>
            <ProcessGuide />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Connections}>
            <ConnectionsGuide catalog={catalog} />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Variables}>
            <VariablesGuide />
          </TabsContent>
          <TabsContent className="mt-3" value={GuideTab.Examples}>
            <ExamplesGuide />
          </TabsContent>
        </Tabs>
      </CollapsibleSection>
    </section>
  );
}

const GuideTab = {
  Workflow: "workflow",
  Events: "events",
  Actions: "actions",
  Process: "process",
  Connections: "connections",
  Variables: "variables",
  Examples: "examples",
} as const;

/** Every run event in lifecycle order: what `on:` takes. */
function RunEventsGuide() {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        An action runs <code>on</code> one of these events, or a list of them. A
        step that ends one phase and starts the next reports both.
      </p>
      <dl className="divide-y rounded-md border">
        {WORKFLOW_RUN_EVENT_ORDER.map((event) => (
          <div className="grid gap-1 p-2 sm:grid-cols-[14rem_1fr]" key={event}>
            <dt className="space-y-1">
              <code className="font-medium">{event}</code>
              <div className="text-muted-foreground text-xs">
                {WORKFLOW_RUN_EVENT_LABELS[event]}
              </div>
            </dt>
            <dd className="text-muted-foreground">
              {WORKFLOW_RUN_EVENT_DESCRIPTIONS[event]}
              {event === WorkflowRunEvent.Triggered ? (
                <Badge className="ml-2" variant="info">
                  before the agent team
                </Badge>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The keys of an action, instructions, the connection rules and the order. */
function ActionsGuide() {
  return (
    <div className="space-y-4 text-sm">
      <GuideBlock title="Keys of an item of actions">
        <KeyList
          docs={WORKFLOW_ACTION_KEY_DOCS}
          keys={WORKFLOW_YAML_KEYS.action}
        />
        <p className="text-muted-foreground">
          Every action has <code>on</code> and either an{" "}
          <code>instruction</code> or a <code>type</code> with its{" "}
          <code>config</code>.
        </p>
      </GuideBlock>
      <GuideBlock title="How an instruction runs">
        <GuideList items={WORKFLOW_INSTRUCTION_GUIDE} />
      </GuideBlock>
      <GuideBlock title="How a connection is chosen">
        <GuideList items={WORKFLOW_CONNECTION_CHOICE_GUIDE} />
      </GuideBlock>
      <GuideBlock title="Order">
        <p className="text-muted-foreground">{WORKFLOW_ACTION_ORDER_GUIDE}</p>
      </GuideBlock>
    </div>
  );
}

/**
 * The project connections by project (the keys `connection:` and
 * `connections:` take) with what each offers, and the built-in http.
 */
function ConnectionsGuide({
  catalog,
}: Readonly<{
  catalog: Pick<
    WorkflowYamlCatalog,
    "providers" | "projectConnections" | "projects"
  >;
}>) {
  const webhook = findProvider(
    catalog.providers,
    IntegrationProviderKey.Webhook
  );
  const projects = catalog.projects.filter((project) =>
    catalog.projectConnections.some(
      (connection) => connection.projectId === project.id
    )
  );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Name a connection by its key with <code>connection:</code> (or in an
        instruction's <code>connections:</code>). Keys belong to a project: add
        them in the project's Integrations tab. Each offers the trigger and
        action types of its provider; the options of a type go under{" "}
        <code>config:</code>.
      </p>
      {webhook ? (
        <ConnectionEntry
          name={BUILT_IN_HTTP_REFERENCE}
          note="Built in: the workflow's own URL as a trigger, a plain HTTPS call as an action."
          provider={webhook}
        />
      ) : null}
      {projects.length === 0 ? (
        <p className="text-muted-foreground">
          No project connections yet: add Jira, Azure DevOps or Microsoft Teams
          in a project's Integrations tab (the organization connection comes
          from Settings → Integrations).
        </p>
      ) : null}
      {projects.map((project) => (
        <div className="space-y-2" key={project.id}>
          <h4 className="font-medium">{project.name}</h4>
          {catalog.projectConnections
            .filter((connection) => connection.projectId === project.id)
            .map((connection) => (
              <ProjectConnectionEntry
                connection={connection}
                key={connection.id}
                providers={catalog.providers}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

function ProjectConnectionEntry({
  connection,
  providers,
}: Readonly<{
  connection: ProjectConnection;
  providers: readonly IntegrationProviderSummary[];
}>) {
  const provider = findProvider(providers, connection.provider);
  if (!provider) {
    return null;
  }
  const settings = summarizeSettings(
    provider.projectSettingsFields,
    connection.settings
  );
  return (
    <ConnectionEntry
      name={connection.key}
      note={[connection.name, ...settings].join(" · ")}
      provider={provider}
    />
  );
}

function ConnectionEntry({
  name,
  note,
  provider,
}: Readonly<{
  name: string;
  note?: string;
  provider: IntegrationProviderSummary;
}>) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="font-medium">{name}</code>
        <span className="text-muted-foreground text-xs">
          {provider.displayName}
        </span>
      </div>
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      {provider.triggers.length > 0 ? (
        <div className="space-y-1">
          <div className="font-medium text-xs">Triggers</div>
          <ul className="space-y-1">
            {provider.triggers.map((trigger) => (
              <li key={trigger.key}>
                <TypeDetails
                  description={trigger.description}
                  displayName={trigger.displayName}
                  fields={trigger.configFields}
                  typeKey={trigger.key}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {provider.actions.length > 0 ? (
        <div className="space-y-1">
          <div className="font-medium text-xs">
            Action types (also what an instruction on this connection can do)
          </div>
          <ul className="space-y-1">
            {provider.actions.map((action) => (
              <li key={action.key}>
                <TypeDetails
                  badge={repositoryBadge(action)}
                  description={action.description}
                  displayName={action.displayName}
                  fields={action.configFields}
                  typeKey={action.key}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A trigger or action type, expandable to its options. */
function TypeDetails({
  typeKey,
  displayName,
  description,
  fields,
  badge,
}: Readonly<{
  typeKey: string;
  displayName: string;
  description: string;
  fields: readonly IntegrationFieldDescriptor[];
  badge?: string | null;
}>) {
  return (
    <details className="rounded border px-2 py-1">
      <summary className="cursor-pointer">
        <code>{typeKey}</code>{" "}
        <span className="text-muted-foreground">{displayName}</span>
        {badge ? (
          <Badge className="ml-2" variant="muted">
            {badge}
          </Badge>
        ) : null}
      </summary>
      <div className="space-y-1 py-1 text-muted-foreground text-xs">
        <p>{description}</p>
        {fields.length === 0 ? (
          <p>No options.</p>
        ) : (
          <ul className="space-y-1">
            {fields.map((field) => (
              <li key={field.key}>
                <code className="text-foreground">{field.key}</code>{" "}
                {describeField(field)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The template variables, filled in by text options and instructions. */
function VariablesGuide() {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        Text options, <code>titleTemplate</code> and instructions fill in{" "}
        <code>{"{{variables}}"}</code> from the run when the action runs; type{" "}
        <code>{"{{"}</code> in the editor to pick one. A variable without a
        value yet renders as nothing.
      </p>
      <dl className="divide-y rounded-md border">
        {WORKFLOW_TEMPLATE_VARIABLES.map((variable) => (
          <div
            className="grid gap-1 p-2 sm:grid-cols-[16rem_1fr]"
            key={variable.name}
          >
            <dt>
              <code>{`{{${variable.name}}}`}</code>
            </dt>
            <dd className="space-y-1 text-muted-foreground">
              <div>{variable.description}</div>
              <div className="text-xs">Has a value: {variable.available}</div>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Worked `actions` lists to copy into the YAML. */
function ExamplesGuide() {
  return (
    <div className="space-y-4 text-sm">
      {WORKFLOW_ACTION_EXAMPLES.map((example) => (
        <div className="space-y-2" key={example.title}>
          <div className="font-medium">{example.title}</div>
          <p className="text-muted-foreground">{example.description}</p>
          <CodeBlock code={example.yaml} label="YAML" maxHeight={null} />
        </div>
      ))}
    </div>
  );
}

/** How a run goes, and every key of the workflow, its triggers and its agent. */
function WorkflowKeysGuide() {
  return (
    <div className="space-y-4 text-sm">
      <GuideBlock title="How a run goes">
        <GuideList items={WORKFLOW_RUN_GUIDE} />
      </GuideBlock>
      <GuideBlock title="Top-level keys">
        <KeyList docs={WORKFLOW_YAML_KEY_DOCS} keys={WORKFLOW_KEYS} />
        <p className="text-muted-foreground">
          The older <code>preActions:</code> and <code>postActions:</code> lists
          still read, with a warning; the editor writes <code>actions:</code>.
        </p>
      </GuideBlock>
      <GuideBlock title="Keys of an item of triggers">
        <KeyList
          docs={WORKFLOW_TRIGGER_KEY_DOCS}
          keys={WORKFLOW_YAML_KEYS.trigger}
        />
        <p className="text-muted-foreground">
          The Connections tab lists every trigger type with its options.
        </p>
      </GuideBlock>
      <GuideBlock title="Keys of agent">
        <KeyList docs={WORKFLOW_YAML_KEY_DOCS} keys={AGENT_KEYS} />
      </GuideBlock>
      <GuideBlock title="Keys of agent.repository">
        <KeyList
          docs={WORKFLOW_REPOSITORY_KEY_DOCS}
          keys={WORKFLOW_YAML_KEYS.repository}
        />
      </GuideBlock>
      <GuideBlock title="Keys of agent.prd">
        <KeyList docs={WORKFLOW_PRD_KEY_DOCS} keys={WORKFLOW_YAML_KEYS.prd} />
      </GuideBlock>
      <GuideBlock title="Keys of agent.orchestrator">
        <KeyList
          docs={WORKFLOW_ORCHESTRATOR_KEY_DOCS}
          keys={WORKFLOW_YAML_KEYS.orchestrator}
        />
      </GuideBlock>
    </div>
  );
}

/** agent.process: how the steps run, each step type with its keys. */
function ProcessGuide() {
  return (
    <div className="space-y-4 text-sm">
      <GuideBlock title="How a process runs">
        <GuideList items={WORKFLOW_PROCESS_GUIDE} />
      </GuideBlock>
      <GuideBlock title="Keys of agent.process">
        <KeyList
          docs={PROCESS_YAML_KEY_DOCS}
          keys={PROCESS_YAML_KEYS.process}
        />
      </GuideBlock>
      {PROCESS_STEP_TYPES.map((type) => {
        const snippet = PROCESS_STEP_SNIPPETS.find(
          (candidate) => candidate.detail === `type: ${type}`
        );
        return (
          <GuideBlock key={type} title={`Step type ${type}`}>
            {snippet?.info ? (
              <p className="text-muted-foreground">{snippet.info}</p>
            ) : null}
            <KeyList
              docs={PROCESS_YAML_KEY_DOCS}
              keys={PROCESS_YAML_KEYS.steps[type]}
            />
          </GuideBlock>
        );
      })}
      <GuideBlock title="Keys of an agent step's document">
        <KeyList
          docs={PROCESS_YAML_KEY_DOCS}
          keys={PROCESS_YAML_KEYS.document}
          where="steps/#/document"
        />
      </GuideBlock>
      <GuideBlock title="Keys of toolkit">
        <KeyList
          docs={PROCESS_YAML_KEY_DOCS}
          keys={PROCESS_YAML_KEYS.toolkit}
          where="toolkit"
        />
      </GuideBlock>
      <GuideBlock title="Variables of an agent step's instruction">
        <p className="text-muted-foreground">
          A step's instruction and document title take these, not the action
          variables.
        </p>
        <dl className="divide-y rounded-md border">
          {PROCESS_INSTRUCTION_VARIABLES.map((variable) => (
            <div
              className="grid gap-1 p-2 sm:grid-cols-[16rem_1fr]"
              key={variable.name}
            >
              <dt>
                <code>{`{{${variable.name}}}`}</code>
              </dt>
              <dd className="text-muted-foreground">{variable.description}</dd>
            </div>
          ))}
        </dl>
      </GuideBlock>
    </div>
  );
}

/**
 * Keys with what each takes and means. `where` reads a key's doc at that
 * place first (`<where>/<key>`), as the process editor's suggestions do.
 */
function KeyList({
  keys,
  docs,
  where,
}: Readonly<{
  keys: readonly string[];
  docs: Record<string, WorkflowYamlKeyDoc>;
  where?: string;
}>) {
  return (
    <dl className="divide-y rounded-md border">
      {keys.map((key) => {
        const doc = (where ? docs[`${where}/${key}`] : undefined) ?? docs[key];
        return (
          <div className="grid gap-1 p-2 sm:grid-cols-[14rem_1fr]" key={key}>
            <dt className="space-y-1">
              <code className="font-medium">{key}</code>
              {doc?.detail ? (
                <div className="text-muted-foreground text-xs">
                  {doc.detail}
                </div>
              ) : null}
            </dt>
            <dd className="text-muted-foreground">{doc?.info}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function GuideBlock({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="space-y-2">
      <h4 className="font-medium">{title}</h4>
      {children}
    </div>
  );
}

function GuideList({ items }: Readonly<{ items: readonly string[] }>) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function repositoryBadge(action: IntegrationActionSummary): string | null {
  return action.repositoryScoped ? "every pushed repository" : null;
}

/** "(text, required, default …): Label. Description. One of: a, b." */
function describeField(field: IntegrationFieldDescriptor): string {
  const traits = [
    field.kind,
    field.required ? "required" : null,
    field.defaultValue === undefined
      ? null
      : `default ${JSON.stringify(field.defaultValue)}`,
  ].filter((trait) => trait !== null);
  const options = field.options?.length
    ? ` One of: ${field.options.map((option) => String(option.value)).join(", ")}.`
    : "";
  const description = field.description ? ` ${field.description}` : "";
  return `(${traits.join(", ")}): ${field.label}.${description}${options}`;
}

/** The workflow's own keys, without the older action lists. */
const WORKFLOW_KEYS = WORKFLOW_YAML_KEYS.workflow.filter(
  (key) => key !== "preActions" && key !== "postActions"
);

/** agent's keys, without the older place of project. */
const AGENT_KEYS = WORKFLOW_YAML_KEYS.agent.filter((key) => key !== "project");

/** Step types in the order a process usually has them. */
const PROCESS_STEP_TYPES = [
  ProcessStepType.AgentFlowPlan,
  ProcessStepType.Approval,
  ProcessStepType.AgentFlowExecute,
  ProcessStepType.Agent,
] as const;
