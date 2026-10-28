import type { IntegrationProviderSummary } from "@repo/api/src/types/integration";
import {
  PROCESS_INSTRUCTION_VARIABLES,
  ProcessDocumentType,
  ProcessExecuteReview,
  ProcessPlanRecommendations,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepRole,
  ProcessStepType,
  ReviewSession,
} from "@repo/api/src/types/project-process";
import {
  CONNECTIONS_GRANT_DOC,
  type GrantableConnection,
  grantKeyCompletions,
  grantValueCompletions,
} from "@repo/app/integrations/lib/connection-grant-completions";
import {
  filterYamlCompletions,
  type YamlCompletion,
  YamlCompletionKind,
} from "@repo/app/shared/lib/yaml-completion";
import {
  analyzeYamlCursor,
  type YamlCursor,
  YamlCursorKind,
} from "@repo/app/shared/lib/yaml-cursor";
import { PROCESS_YAML_KEYS } from "./process-yaml";

/**
 * Suggestions of the process YAML editor: where the cursor is in the YAML
 * (a key or a value, of which mapping, inside which kind of step) and what
 * fits there. Pure, so the editor only adapts them to its popup.
 */

/** Where the cursor is, plus the `type` of the step it is in. */
export type YamlCursorContext = Omit<YamlCursor, "itemValues"> & {
  /** `type` of the step the cursor is in, if any. */
  stepType: string | null;
};

export type ProcessCompletionData = {
  /** Full names of the project's repositories (toolkit.repository). */
  repositories: readonly string[];
  /** Ids of the process's steps (an approval's show). */
  stepIds: readonly string[];
  /** The project's connections an agent step's `connections:` may grant. */
  projectConnections: readonly GrantableConnection[];
  providers: readonly IntegrationProviderSummary[];
};

export function yamlCursorContext(
  text: string,
  pos: number
): YamlCursorContext | null {
  const cursor = analyzeYamlCursor(text, pos, {
    isScalarList: (_path, key) => LIST_KEYS.includes(key),
  });
  if (!cursor) {
    return null;
  }
  const { itemValues, ...rest } = cursor;
  return { ...rest, stepType: processStepTypeOf(cursor) };
}

/** What fits at the cursor, best first; filtered by what is typed. */
export function processYamlCompletions(
  context: YamlCursorContext,
  data: ProcessCompletionData
): YamlCompletion[] {
  return filterYamlCompletions(candidates(context, data), context.typed);
}

/** The step snippets offered on a new item of `steps:`. */
export const PROCESS_STEP_SNIPPETS: readonly YamlCompletion[] = [
  {
    label: "Agent step",
    kind: YamlCompletionKind.Snippet,
    detail: "type: agent",
    info: "Runs one instruction (a toolkit command or plain text) in the workspace.",
    insert:
      "type: agent\n  id: #{id}\n  name: #{Name}\n  instruction: |\n    #{What the agent does}\n  questions: continue\n  finish: none",
  },
  {
    label: "Approval step",
    kind: YamlCompletionKind.Snippet,
    detail: "type: approval",
    info: "A person approves before the run goes on; `show` lists what they review.",
    insert:
      "type: approval\n  id: #{review}\n  name: #{Review}\n  show:\n    - #{step id}",
  },
  {
    label: "AgentFlow plan",
    kind: YamlCompletionKind.Snippet,
    detail: "type: agentflow.plan",
    info: "The built-in planning agents write the run's Implementation Plan.",
    insert:
      "type: agentflow.plan\n  id: #{plan}\n  name: #{Plan}\n  questions: ask\n  recommendations: accept",
  },
  {
    label: "AgentFlow implement",
    kind: YamlCompletionKind.Snippet,
    detail: "type: agentflow.execute",
    info: "The built-in implementation agents; needs a AgentFlow plan step before it.",
    insert:
      "type: agentflow.execute\n  id: #{execute}\n  name: #{Implement}\n  review: full",
  },
];

/** Keys whose values are lists of scalars. */
const LIST_KEYS: readonly string[] = ["show", "artifacts", "mounts"];
/** An agent step's grant map. */
const GRANTS_PATH = "steps/#/connections";
const STEP_LIST_KEY = "steps";

/** `type:` of the step mapping the cursor is in (path steps/#/...). */
function processStepTypeOf(cursor: YamlCursor): string | null {
  if (
    cursor.kind === YamlCursorKind.Variable ||
    cursor.path[0] !== STEP_LIST_KEY ||
    cursor.path[1] !== "#"
  ) {
    return null;
  }
  return cursor.itemValues.type ?? null;
}

function candidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): YamlCompletion[] {
  switch (context.kind) {
    case YamlCursorKind.Variable:
      return PROCESS_INSTRUCTION_VARIABLES.map((variable) => ({
        label: variable.name,
        insert: `${variable.name}}}`,
        kind: YamlCompletionKind.Variable,
        info: variable.description,
      }));
    case YamlCursorKind.Item:
      return itemCandidates(context, data);
    case YamlCursorKind.Value:
      return valueCandidates(context, data);
    default:
      return keyCandidates(context, data);
  }
}

function keyCandidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): YamlCompletion[] {
  const where = context.path.join("/");
  if (where === GRANTS_PATH) {
    return grantKeyCompletions(data.projectConnections, data.providers).filter(
      (completion) => !context.existingKeys.includes(completion.label)
    );
  }
  let keys: readonly string[];
  if (where === "") {
    keys = PROCESS_YAML_KEYS.process;
  } else if (where === "toolkit") {
    keys = PROCESS_YAML_KEYS.toolkit;
  } else if (where === "steps/#/document") {
    keys = PROCESS_YAML_KEYS.document;
  } else if (where === "steps/#/review") {
    keys = PROCESS_YAML_KEYS.review;
  } else if (where === "steps/#/review/feedback") {
    keys = PROCESS_YAML_KEYS.reviewFeedback;
  } else if (where === "steps/#/retry") {
    keys = PROCESS_YAML_KEYS.retry;
  } else if (SIGNAL_PATHS.has(where)) {
    keys = PROCESS_YAML_KEYS.signal;
  } else if (where === "steps/#") {
    keys = stepKeysFor(context.stepType);
  } else {
    return [];
  }
  const keyCompletions = keys
    .filter((key) => !context.existingKeys.includes(key))
    .map((key) => keyCompletion(key, where, context.stepType));
  const snippets =
    where === "steps/#" && context.itemStart && context.stepType === null
      ? PROCESS_STEP_SNIPPETS
      : [];
  return [...snippets, ...keyCompletions];
}

function stepKeysFor(stepType: string | null): readonly string[] {
  if (stepType && stepType in PROCESS_YAML_KEYS.steps) {
    return PROCESS_YAML_KEYS.steps[
      stepType as keyof typeof PROCESS_YAML_KEYS.steps
    ];
  }
  // Type not chosen yet: every step key, type first.
  return [...new Set(Object.values(PROCESS_YAML_KEYS.steps).flat())];
}

function keyCompletion(
  key: string,
  where: string,
  stepType: string | null
): YamlCompletion {
  // An agent step's review is a mapping; AgentFlow's implement step's a value.
  const agentReview =
    key === "review" &&
    where === "steps/#" &&
    stepType !== ProcessStepType.AgentFlowExecute;
  const doc = agentReview
    ? AGENT_REVIEW_DOC
    : (PROCESS_YAML_KEY_DOCS[`${where}/${key}`] ?? PROCESS_YAML_KEY_DOCS[key]);
  const block = agentReview ? BlockKind.Map : BLOCK_KEYS[key];
  let insert = `${key}: `;
  if (block === BlockKind.Map) {
    insert = `${key}:\n  `;
  } else if (block === BlockKind.List) {
    insert = `${key}:\n  - `;
  }
  return {
    label: key,
    insert,
    kind: YamlCompletionKind.Key,
    detail: doc?.detail,
    info: doc?.info,
  };
}

function valueCandidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): YamlCompletion[] {
  const where = context.path.join("/");
  const values = (
    entries: ReadonlyArray<{ value: string; info: string }>
  ): YamlCompletion[] =>
    entries.map((entry) => ({
      label: entry.value,
      insert: entry.value,
      kind: YamlCompletionKind.Value,
      info: entry.info,
    }));
  if (where === "steps/#" && context.key === "type") {
    return values(STEP_TYPE_VALUES);
  }
  if (where === GRANTS_PATH && context.key) {
    const connection = data.projectConnections.find(
      (candidate) => candidate.key === context.key
    );
    return grantValueCompletions(
      context.key,
      data.providers.find((provider) => provider.key === connection?.provider)
    );
  }
  if (where === "steps/#/document" && context.key === "type") {
    return values(DOCUMENT_TYPE_VALUES);
  }
  if (context.key === "questions") {
    return values(QUESTIONS_VALUES);
  }
  if (context.key === "finish") {
    return values(FINISH_VALUES);
  }
  if (context.key === "role") {
    return values(ROLE_VALUES);
  }
  if (context.key === "releaseNotes") {
    return values(RELEASE_NOTES_VALUES);
  }
  if (context.key === "recommendations") {
    return values(RECOMMENDATIONS_VALUES);
  }
  if (
    context.key === "review" &&
    context.stepType === ProcessStepType.AgentFlowExecute
  ) {
    return values(REVIEW_VALUES);
  }
  if (where === "steps/#/review" && context.key === "session") {
    return values(REVIEW_SESSION_VALUES);
  }
  if (context.key === "consumeLabels" || context.key === "mention") {
    return values(BOOLEAN_VALUES);
  }
  if (where === "toolkit" && context.key === "repository") {
    return data.repositories.map((repository) => ({
      label: repository,
      insert: repository,
      kind: YamlCompletionKind.Value,
      info: "A repository of this project",
    }));
  }
  return [];
}

function itemCandidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): YamlCompletion[] {
  if (context.key === "show") {
    return data.stepIds.map((id) => ({
      label: id,
      insert: id,
      kind: YamlCompletionKind.Value,
      info: "Show this step's files to the approver",
    }));
  }
  if (context.key === "mounts") {
    return [".claude/commands", ".claude/skills", ".specify"].map((mount) => ({
      label: mount,
      insert: mount,
      kind: YamlCompletionKind.Value,
      info: "A directory of the toolkit repository linked into the workspace",
    }));
  }
  return [];
}

const BlockKind = { Map: "map", List: "list" } as const;
type BlockKind = (typeof BlockKind)[keyof typeof BlockKind];

const BLOCK_KEYS: Record<string, BlockKind> = {
  retry: BlockKind.Map,
  approve: BlockKind.Map,
  complete: BlockKind.Map,
  feedback: BlockKind.Map,
  labels: BlockKind.List,
  toolkit: BlockKind.Map,
  document: BlockKind.Map,
  connections: BlockKind.Map,
  steps: BlockKind.List,
  show: BlockKind.List,
  artifacts: BlockKind.List,
  mounts: BlockKind.List,
};

const STEP_TYPE_VALUES = [
  {
    value: ProcessStepType.Agent,
    info: "One instruction run by the agent in the workspace",
  },
  {
    value: ProcessStepType.Approval,
    info: "A person approves before the run goes on",
  },
  {
    value: ProcessStepType.AgentFlowPlan,
    info: "The AgentFlow planning agents (the run's Implementation Plan)",
  },
  {
    value: ProcessStepType.AgentFlowExecute,
    info: "The AgentFlow implementation agents (after a plan step)",
  },
];

const DOCUMENT_TYPE_VALUES = [
  {
    value: ProcessDocumentType.Prd,
    info: "A PRD of the project, e.g. for a new feature",
  },
  {
    value: ProcessDocumentType.Doc,
    info: "A document, e.g. a bug analysis or a change request's impact",
  },
  {
    value: ProcessDocumentType.ImplementationPlan,
    info: "An Implementation Plan",
  },
];

const QUESTIONS_VALUES = [
  {
    value: ProcessQuestionsPolicy.Ask,
    info: "Stop and ask the developer when the agent needs a decision",
  },
  {
    value: ProcessQuestionsPolicy.Continue,
    info: "Decide and go on without asking",
  },
];

const RECOMMENDATIONS_VALUES = [
  {
    value: ProcessPlanRecommendations.Accept,
    info: "A question the agents recommend an answer for is settled with it",
  },
  {
    value: ProcessPlanRecommendations.Suggest,
    info: "The recommendation is only a suggestion: the question stays open for people",
  },
];

const REVIEW_VALUES = [
  {
    value: ProcessExecuteReview.Full,
    info: "Evaluate, critic-review and finalize the plan before implementing it, then check the result against it",
  },
  {
    value: ProcessExecuteReview.Fast,
    info: "Implement the approved plan as it is; tests and build checks still run",
  },
];

const FINISH_VALUES = [
  { value: ProcessStepFinish.None, info: "Keep the changes for the next step" },
  {
    value: ProcessStepFinish.Push,
    info: "Commit and push every repository with changes (pull requests come from post actions)",
  },
];

/**
 * What each key of the process YAML means (suggestions here, the workflow
 * configuration guide); a `<where>/<key>` entry overrides the key at that place.
 */
export const PROCESS_YAML_KEY_DOCS: Record<
  string,
  { detail?: string; info: string }
> = {
  toolkit: {
    detail: "mapping",
    info: "A repository of the project whose directories (commands, skills) the agent loads.",
  },
  steps: { detail: "list", info: "The steps a run goes through, in order." },
  "toolkit/repository": {
    detail: "owner/name",
    info: "One of the project's repositories.",
  },
  "toolkit/mounts": {
    detail: "list",
    info: "Directories of the toolkit repository linked into the workspace, e.g. .claude/commands.",
  },
  "toolkit/instructions": {
    detail: "text",
    info: "Added to the workspace CLAUDE.md.",
  },
  type: {
    detail: "agent | approval | agentflow.plan | agentflow.execute",
    info: "What kind of step this is.",
  },
  id: {
    detail: "a-z, 0-9, - or _",
    info: "Unique in the process; used by an approval's show and {{steps.<id>.reply}}.",
  },
  name: { detail: "text", info: "Shown on the run page." },
  instruction: {
    detail: "text",
    info: "What the agent does: a toolkit command or plain text. Variables: {{issue.key}}, {{issue.title}}, {{issue.url}}, {{issue.body}}, {{issue.file}}.",
  },
  questions: {
    detail: "ask | continue",
    info: "ask: stop and ask when a decision is needed (the run waits in input.needed); continue: decide and go on. Default: ask on an AgentFlow plan step, continue on an agent step.",
  },
  artifacts: {
    detail: "list of globs",
    info: "Files (from the workspace root) shown on the run once the step ends.",
  },
  reply: {
    detail: "path",
    info: "A file the step writes for people outside AgentFlow; post actions get it as {{reply}} and {{steps.<id>.reply}}.",
  },
  document: {
    detail: "mapping",
    info: "Publish one of the step's files as a document of the project (PRD, DOC, IMPLEMENTATION_PLAN).",
  },
  finish: {
    detail: "none | push",
    info: "none (default): keep changes for the next step; push: commit and push every repository with changes, reported as execute.started / execute.completed.",
  },
  role: {
    detail: "plan | implement",
    info: "What the step is to AgentFlow. plan: the step writes the run's implementation plan (AgentFlow tells the agent to write it to .agentflow-ai/work/plan.md and keeps it as the run's plan). implement: the step works from the approved plan, always pushes and writes release notes.",
  },
  releaseNotes: {
    detail: "true | false",
    info: "Implement step (role: implement, or agentflow.execute): write release notes when done (default true), published as a document and as {{releaseNotes}}.",
  },
  timeoutMinutes: { detail: "5-1440", info: "How long the step may run." },
  retry: {
    detail: "mapping",
    info: "Retry the step automatically when its agent fails on the model provider (an expired token, a quota, an overload): after a backoff, the failed session goes on in a fork (--resume --fork-session).",
  },
  "steps/#/retry/attempts": {
    detail: "1-5",
    info: "How many times the step is retried automatically before the run fails.",
  },
  "steps/#/approve": {
    detail: "mapping",
    info: "Approval step: labels (tags) added on the ticket that approve it, besides Approve in AgentFlow.",
  },
  "steps/#/review/approve": {
    detail: "mapping",
    info: "Plan step: labels (tags) added on the ticket that approve the plan.",
  },
  "steps/#/review/complete": {
    detail: "mapping",
    info: "Any other step: labels (tags) added on the ticket that end the review (e.g. code review done).",
  },
  "steps/#/review/feedback": {
    detail: "mapping",
    info: "Labels (tags) on the ticket, or a comment that mentions the bot (mention: true), that run the step again with the feedback. A feedback label is removed once acted on.",
  },
  "steps/#/review/instruction": {
    detail: "text",
    info: "Added to the feedback round's prompt. Variables: {{feedback.text}}, {{feedback.author}}, {{feedback.via}}, {{review.round}} and the issue's.",
  },
  "steps/#/review/session": {
    detail: "resume | fresh",
    info: "resume (default): continue the step's session; fresh: start a new one.",
  },
  "steps/#/review/consumeLabels": {
    detail: "true | false",
    info: "Remove a feedback label from the ticket once acted on (default true).",
  },
  labels: { detail: "list", info: "Labels (Jira) or tags (Azure DevOps)." },
  mention: {
    detail: "true | false",
    info: "A comment that mentions the bot sends feedback; its text is the feedback.",
  },
  connections: CONNECTIONS_GRANT_DOC,
  recommendations: {
    detail: "accept | suggest",
    info: "Plan step: accept (default) settles a question the agents recommend an answer for with it (only questions without one stop the run); suggest keeps it open for people.",
  },
  review: {
    detail: "full | fast",
    info: "Implement step: full (default) reviews and finalizes the approved plan before implementing it; fast implements it as it is.",
  },
  show: {
    detail: "list",
    info: "Step ids or file globs the approver reviews. The run waits in input.needed until an org admin approves; a rejection fails the run.",
  },
  "steps/#/document/type": {
    detail: "PRD | DOC | IMPLEMENTATION_PLAN",
    info: "The kind of document.",
  },
  "steps/#/document/path": {
    detail: "path",
    info: "One of the step's files (from the workspace root); its content is the document.",
  },
  "steps/#/document/title": {
    detail: "text",
    info: "Variables {{issue.key}}, {{issue.title}}; empty: the Issue's title.",
  },
};

const ROLE_VALUES = [
  {
    value: ProcessStepRole.Plan,
    info: "Writes the run's implementation plan (kept as the run's plan document)",
  },
  {
    value: ProcessStepRole.Implement,
    info: "Works from the approved plan, pushes and writes release notes",
  },
];

const RELEASE_NOTES_VALUES = [
  { value: "true", info: "Write release notes when done (default)" },
  { value: "false", info: "No release notes" },
];

/** Where a signal's `labels` go: review.approve, review.complete, an approval's approve. */
const SIGNAL_PATHS: ReadonlySet<string> = new Set([
  "steps/#/review/approve",
  "steps/#/review/complete",
  "steps/#/approve",
]);

const AGENT_REVIEW_DOC = {
  detail: "mapping",
  info: "People review the step's work before the run goes on: approve (a plan step) or complete (any other step) lets it go on, feedback runs the step again with it. Decided in AgentFlow, with labels on the ticket or a comment that mentions the bot.",
};

const REVIEW_SESSION_VALUES = [
  {
    value: ReviewSession.Resume,
    info: "Continue the step's agent session with the feedback (default)",
  },
  {
    value: ReviewSession.Fresh,
    info: "A new session with the step's instruction and the feedback",
  },
];

const BOOLEAN_VALUES = [
  { value: "true", info: "Yes" },
  { value: "false", info: "No" },
];
