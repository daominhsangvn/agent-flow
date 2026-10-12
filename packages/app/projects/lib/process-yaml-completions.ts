import {
  PROCESS_INSTRUCTION_VARIABLES,
  ProcessDocumentType,
  ProcessExecuteReview,
  ProcessPlanRecommendations,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import { PROCESS_YAML_KEYS } from "./process-yaml";

/**
 * Suggestions of the process YAML editor: where the cursor is in the YAML
 * (a key or a value, of which mapping, inside which kind of step) and what
 * fits there. Pure, so the editor only adapts them to its popup.
 */

/** Container path of the cursor: keys, and "#" for a list item. */
export type YamlPath = readonly string[];

export const YamlCursorKind = {
  /** Typing a key of the mapping at `path`. */
  Key: "key",
  /** Typing the value of `key` in the mapping at `path`. */
  Value: "value",
  /** Typing an item of the list `key` (show, artifacts, mounts). */
  Item: "item",
  /** Inside `{{` of an instruction or title. */
  Variable: "variable",
} as const;
export type YamlCursorKind =
  (typeof YamlCursorKind)[keyof typeof YamlCursorKind];

export type YamlCursorContext = {
  kind: YamlCursorKind;
  path: YamlPath;
  /** The key whose value or item is typed. */
  key: string | null;
  /** Offset where the typed word starts (replaced by a suggestion). */
  from: number;
  typed: string;
  /** `type` of the step the cursor is in, if any. */
  stepType: string | null;
  /** Keys the mapping already has (not suggested again). */
  existingKeys: readonly string[];
  /** The cursor's line starts a list item ("- "). */
  itemStart: boolean;
};

export type ProcessCompletionData = {
  /** Full names of the project's repositories (toolkit.repository). */
  repositories: readonly string[];
  /** Ids of the process's steps (an approval's show). */
  stepIds: readonly string[];
};

export const ProcessCompletionKind = {
  Key: "property",
  Value: "enum",
  Variable: "variable",
  Snippet: "snippet",
} as const;
export type ProcessCompletionKind =
  (typeof ProcessCompletionKind)[keyof typeof ProcessCompletionKind];

export type ProcessCompletion = {
  label: string;
  /** Text inserted from `from`; a snippet uses #{placeholders}. */
  insert: string;
  kind: ProcessCompletionKind;
  detail?: string;
  info?: string;
};

export function yamlCursorContext(
  text: string,
  pos: number
): YamlCursorContext | null {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const variable = VARIABLE_RE.exec(before);
  if (variable) {
    const typed = variable[1] ?? "";
    return {
      kind: YamlCursorKind.Variable,
      path: [],
      key: null,
      from: pos - typed.length,
      typed,
      stepType: null,
      existingKeys: [],
      itemStart: false,
    };
  }
  const lines = text.split("\n");
  const lineIndex = text.slice(0, lineStart).split("\n").length - 1;
  const valueMatch = VALUE_RE.exec(before);
  if (valueMatch) {
    const [, indent = "", dash = "", key = "", typed = ""] = valueMatch;
    const scope = scopeOf(lines, lineIndex, indent.length, dash);
    return {
      kind: YamlCursorKind.Value,
      path: scope.path,
      key,
      from: pos - typed.length,
      typed,
      stepType: scope.stepType,
      existingKeys: scope.keys,
      itemStart: dash !== "",
    };
  }
  const keyMatch = KEY_RE.exec(before);
  if (!keyMatch) {
    return null;
  }
  const [, indent = "", dash = "", typed = ""] = keyMatch;
  const scope = scopeOf(lines, lineIndex, indent.length, dash);
  const parentKey = scope.path.at(-2) ?? null;
  // "- an" under show: is an item of a list of values, not a key.
  if (dash && parentKey && LIST_KEYS.includes(parentKey)) {
    return {
      kind: YamlCursorKind.Item,
      path: scope.path,
      key: parentKey,
      from: pos - typed.length,
      typed,
      stepType: scope.stepType,
      existingKeys: [],
      itemStart: true,
    };
  }
  return {
    kind: YamlCursorKind.Key,
    path: scope.path,
    key: null,
    from: pos - typed.length,
    typed,
    stepType: scope.stepType,
    existingKeys: scope.keys,
    itemStart: dash !== "",
  };
}

/** What fits at the cursor, best first; filtered by what is typed. */
export function processYamlCompletions(
  context: YamlCursorContext,
  data: ProcessCompletionData
): ProcessCompletion[] {
  const all = candidates(context, data);
  const typed = context.typed.toLowerCase();
  return typed
    ? all.filter((completion) => completion.label.toLowerCase().includes(typed))
    : all;
}

/** The step snippets offered on a new item of `steps:`. */
export const PROCESS_STEP_SNIPPETS: readonly ProcessCompletion[] = [
  {
    label: "Agent step",
    kind: ProcessCompletionKind.Snippet,
    detail: "type: agent",
    info: "Runs one instruction (a toolkit command or plain text) in the workspace.",
    insert:
      "type: agent\n  id: #{id}\n  name: #{Name}\n  instruction: |\n    #{What the agent does}\n  questions: continue\n  finish: none",
  },
  {
    label: "Approval step",
    kind: ProcessCompletionKind.Snippet,
    detail: "type: approval",
    info: "A person approves before the run goes on; `show` lists what they review.",
    insert:
      "type: approval\n  id: #{review}\n  name: #{Review}\n  show:\n    - #{step id}",
  },
  {
    label: "AgentFlow plan",
    kind: ProcessCompletionKind.Snippet,
    detail: "type: agentflow.plan",
    info: "The built-in planning agents write the run's Implementation Plan.",
    insert:
      "type: agentflow.plan\n  id: #{plan}\n  name: #{Plan}\n  questions: ask\n  recommendations: accept",
  },
  {
    label: "AgentFlow implement",
    kind: ProcessCompletionKind.Snippet,
    detail: "type: agentflow.execute",
    info: "The built-in implementation agents; needs a AgentFlow plan step before it.",
    insert:
      "type: agentflow.execute\n  id: #{execute}\n  name: #{Implement}\n  review: full",
  },
];

/** "key:" followed by the cursor's value: `- key: va`, `key: va`. */
const VALUE_RE = /^(\s*)(-\s+)?([A-Za-z][\w-]*):\s+([^\s#][^#]*?|)$/;
/** A key being typed: `  ke`, `- ke`, or an empty line. */
const KEY_RE = /^(\s*)(-\s+)?([A-Za-z][\w-]*|)$/;
const VARIABLE_RE = /\{\{\s*([\w.]*)$/;
/** Keys whose values are lists of scalars. */
const LIST_KEYS: readonly string[] = ["show", "artifacts", "mounts"];
const STEP_LIST_KEY = "steps";

type LineInfo = {
  indent: number;
  item: boolean;
  /** Column of the line's key (after "- " for an item start). */
  contentIndent: number;
  key: string | null;
  /** Text after "key:", trimmed ("" for a key that opens a block). */
  value: string;
  blank: boolean;
};

const LINE_RE = /^(\s*)(-\s+)?(?:([A-Za-z][\w-]*):(?:\s+|$))?(.*)$/;
const TRAILING_COMMENT_RE = /\s+#.*$/;

function lineInfo(line: string): LineInfo {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return {
      indent: 0,
      item: false,
      contentIndent: 0,
      key: null,
      value: "",
      blank: true,
    };
  }
  const match = LINE_RE.exec(line);
  const indent = match?.[1]?.length ?? 0;
  const dash = match?.[2] ?? "";
  return {
    indent,
    item: dash !== "",
    contentIndent: indent + dash.length,
    key: match?.[3] ?? null,
    value: (match?.[4] ?? "").replace(TRAILING_COMMENT_RE, "").trim(),
    blank: false,
  };
}

type Scope = {
  path: string[];
  stepType: string | null;
  /** Keys of the cursor's mapping. */
  keys: string[];
};

/**
 * The containers around a line whose key starts at `indent` (+ the dash):
 * walking up, an item start at the same column opens the mapping, a
 * shallower `key:` opens its parent.
 */
function scopeOf(
  lines: readonly string[],
  lineIndex: number,
  indent: number,
  dash: string
): Scope {
  const infos = lines.map(lineInfo);
  const mapLevel = indent + dash.length;
  const climb: Climb = {
    path: dash ? ["#"] : [],
    level: dash ? indent : mapLevel,
    mapLevel,
    itemLine: dash ? lineIndex : null,
  };
  for (let index = lineIndex - 1; index >= 0; index--) {
    const line = infos[index];
    if (line && !climbLine(climb, line, index)) {
      break;
    }
  }
  return {
    path: climb.path,
    keys: mappingKeys(infos, lineIndex, mapLevel, dash !== ""),
    stepType: stepTypeOf(infos, climb, lineIndex),
  };
}

type Climb = {
  /** Containers found so far, outermost first. */
  path: string[];
  /** Column a line must be left of to contain the ones found so far. */
  level: number;
  /** Column of the cursor's mapping keys. */
  mapLevel: number;
  /** Item start of the cursor's mapping, when it is a list item. */
  itemLine: number | null;
};

/** Takes one line of the upward scan into account; false ends the scan. */
function climbLine(climb: Climb, line: LineInfo, index: number): boolean {
  if (line.blank || !isLeftOf(line, climb.level)) {
    return true;
  }
  if (line.item && line.contentIndent === climb.level) {
    // The item start of the mapping the scan is in.
    climb.path.unshift("#");
    if (climb.itemLine === null && climb.level === climb.mapLevel) {
      climb.itemLine = index;
    }
    climb.level = line.indent;
    return true;
  }
  if (line.key && line.value === "") {
    climb.path.unshift(line.key);
    climb.level = line.contentIndent;
    if (line.item) {
      climb.path.unshift("#");
      climb.level = line.indent;
    }
    return true;
  }
  return false;
}

function isLeftOf(line: LineInfo, level: number): boolean {
  return line.contentIndent < level || (line.item && line.indent < level);
}

/** Keys of the mapping whose keys sit at column `level` around `lineIndex`. */
function mappingKeys(
  infos: readonly LineInfo[],
  lineIndex: number,
  level: number,
  itemStart: boolean
): string[] {
  const above = itemStart ? [] : keysAbove(infos, lineIndex, level);
  return [...above, ...keysBelow(infos, lineIndex, level)];
}

/** Keys of the mapping above the line, up to its item start (included). */
function keysAbove(
  infos: readonly LineInfo[],
  lineIndex: number,
  level: number
): string[] {
  const keys: string[] = [];
  for (let index = lineIndex - 1; index >= 0; index--) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (line.contentIndent < level) {
      break;
    }
    if (line.contentIndent === level && line.key) {
      keys.push(line.key);
    }
    if (line.item && line.contentIndent === level) {
      break;
    }
  }
  return keys;
}

/** Keys of the mapping below the line, up to the next item of its list. */
function keysBelow(
  infos: readonly LineInfo[],
  lineIndex: number,
  level: number
): string[] {
  const keys: string[] = [];
  for (let index = lineIndex + 1; index < infos.length; index++) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (
      line.contentIndent < level ||
      (line.item && line.contentIndent === level)
    ) {
      break;
    }
    if (line.contentIndent === level && line.key) {
      keys.push(line.key);
    }
  }
  return keys;
}

/** `type:` of the step mapping the cursor is in (path steps/#/...). */
function stepTypeOf(
  infos: readonly LineInfo[],
  climb: Climb,
  lineIndex: number
): string | null {
  if (climb.path[0] !== STEP_LIST_KEY || climb.path[1] !== "#") {
    return null;
  }
  const start =
    climb.itemLine ?? stepItemStart(infos, lineIndex, climb.mapLevel);
  return start === null ? null : typeOfItem(infos, start);
}

/** The item start of the step above a nested line (e.g. inside its document). */
function stepItemStart(
  infos: readonly LineInfo[],
  lineIndex: number,
  mapLevel: number
): number | null {
  for (let index = lineIndex; index >= 0; index--) {
    const line = infos[index];
    if (line?.item && !line.blank && line.contentIndent <= mapLevel) {
      return index;
    }
  }
  return null;
}

/** The `type:` value of the list item starting at `start`. */
function typeOfItem(infos: readonly LineInfo[], start: number): string | null {
  const stepLevel = infos[start]?.contentIndent ?? 0;
  for (let index = start; index < infos.length; index++) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (index > start && endsItem(line, stepLevel)) {
      return null;
    }
    if (line.contentIndent === stepLevel && line.key === "type" && line.value) {
      return line.value;
    }
  }
  return null;
}

/** The line starts the next item of the list, or leaves it. */
function endsItem(line: LineInfo, itemLevel: number): boolean {
  return (
    line.contentIndent < itemLevel ||
    (line.item && line.contentIndent === itemLevel)
  );
}

function candidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): ProcessCompletion[] {
  switch (context.kind) {
    case YamlCursorKind.Variable:
      return PROCESS_INSTRUCTION_VARIABLES.map((variable) => ({
        label: variable.name,
        insert: `${variable.name}}}`,
        kind: ProcessCompletionKind.Variable,
        info: variable.description,
      }));
    case YamlCursorKind.Item:
      return itemCandidates(context, data);
    case YamlCursorKind.Value:
      return valueCandidates(context, data);
    default:
      return keyCandidates(context);
  }
}

function keyCandidates(context: YamlCursorContext): ProcessCompletion[] {
  const where = context.path.join("/");
  let keys: readonly string[];
  if (where === "") {
    keys = PROCESS_YAML_KEYS.process;
  } else if (where === "toolkit") {
    keys = PROCESS_YAML_KEYS.toolkit;
  } else if (where === "steps/#/document") {
    keys = PROCESS_YAML_KEYS.document;
  } else if (where === "steps/#") {
    keys = stepKeysFor(context.stepType);
  } else {
    return [];
  }
  const keyCompletions = keys
    .filter((key) => !context.existingKeys.includes(key))
    .map((key) => keyCompletion(key, where));
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

function keyCompletion(key: string, where: string): ProcessCompletion {
  const doc = KEY_DOCS[`${where}/${key}`] ?? KEY_DOCS[key];
  const block = BLOCK_KEYS[key];
  let insert = `${key}: `;
  if (block === BlockKind.Map) {
    insert = `${key}:\n  `;
  } else if (block === BlockKind.List) {
    insert = `${key}:\n  - `;
  }
  return {
    label: key,
    insert,
    kind: ProcessCompletionKind.Key,
    detail: doc?.detail,
    info: doc?.info,
  };
}

function valueCandidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): ProcessCompletion[] {
  const where = context.path.join("/");
  const values = (
    entries: ReadonlyArray<{ value: string; info: string }>
  ): ProcessCompletion[] =>
    entries.map((entry) => ({
      label: entry.value,
      insert: entry.value,
      kind: ProcessCompletionKind.Value,
      info: entry.info,
    }));
  if (where === "steps/#" && context.key === "type") {
    return values(STEP_TYPE_VALUES);
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
  if (context.key === "recommendations") {
    return values(RECOMMENDATIONS_VALUES);
  }
  if (context.key === "review") {
    return values(REVIEW_VALUES);
  }
  if (where === "toolkit" && context.key === "repository") {
    return data.repositories.map((repository) => ({
      label: repository,
      insert: repository,
      kind: ProcessCompletionKind.Value,
      info: "A repository of this project",
    }));
  }
  return [];
}

function itemCandidates(
  context: YamlCursorContext,
  data: ProcessCompletionData
): ProcessCompletion[] {
  if (context.key === "show") {
    return data.stepIds.map((id) => ({
      label: id,
      insert: id,
      kind: ProcessCompletionKind.Value,
      info: "Show this step's files to the approver",
    }));
  }
  if (context.key === "mounts") {
    return [".claude/commands", ".claude/skills", ".specify"].map((mount) => ({
      label: mount,
      insert: mount,
      kind: ProcessCompletionKind.Value,
      info: "A directory of the toolkit repository linked into the workspace",
    }));
  }
  return [];
}

const BlockKind = { Map: "map", List: "list" } as const;
type BlockKind = (typeof BlockKind)[keyof typeof BlockKind];

const BLOCK_KEYS: Record<string, BlockKind> = {
  toolkit: BlockKind.Map,
  document: BlockKind.Map,
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

const KEY_DOCS: Record<string, { detail?: string; info: string }> = {
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
    info: "ask: stop and ask when a decision is needed; continue: decide and go on.",
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
    info: "none: keep changes for the next step; push: commit and push every repository with changes.",
  },
  timeoutMinutes: { detail: "5-1440", info: "How long the step may run." },
  recommendations: {
    detail: "accept | suggest",
    info: "Plan step: accept settles a question the agents recommend an answer for with it (only questions without one stop the run); suggest keeps it open for people.",
  },
  review: {
    detail: "full | fast",
    info: "Implement step: full reviews and finalizes the approved plan before implementing it; fast implements it as it is.",
  },
  show: {
    detail: "list",
    info: "Step ids or file globs the approver reviews.",
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
