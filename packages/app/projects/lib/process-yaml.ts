import { stableStringify } from "@agentflow-ai/loops-api/stable-stringify";
import {
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import {
  unknownYamlKeyProblems,
  type YamlProblem,
  YamlProblemSeverity,
  yamlErrorMessage,
  yamlNodeRange,
  yamlProblemAt,
} from "@repo/app/shared/lib/yaml-problems";
import {
  isMap,
  LineCounter,
  parseDocument,
  stringify,
  type YAMLMap,
} from "yaml";

/**
 * The YAML view of the process editor: a draft as YAML (the text the user
 * wrote, comments kept, while it still describes the draft; else generated)
 * and YAML back to a draft, with every problem placed where it is in the
 * text so the editor can underline it.
 */

export type ParsedProcessYaml =
  /** The draft the YAML describes, `source` set to the text. */
  | { ok: true; draft: ProjectProcessInput }
  /** The text is not YAML (or not a mapping): its first problem. */
  | { ok: false; problem: YamlProblem };

/** Keys of each kind of mapping, in the order generated YAML writes them. */
export const PROCESS_YAML_KEYS = {
  process: ["toolkit", "steps"],
  toolkit: ["repository", "mounts", "instructions"],
  document: ["type", "path", "title"],
  /** An agent step's review (AgentProcessStep.review). */
  review: [
    "approve",
    "complete",
    "feedback",
    "instruction",
    "session",
    "consumeLabels",
  ],
  reviewFeedback: ["labels", "mention"],
  /** An agent step's automatic retry (AgentProcessStep.retry). */
  retry: ["attempts"],
  /** review.approve, review.complete and an approval step's approve. */
  signal: ["labels"],
  steps: {
    [ProcessStepType.Agent]: [
      "type",
      "id",
      "name",
      "role",
      "instruction",
      "questions",
      "artifacts",
      "reply",
      "document",
      "finish",
      "releaseNotes",
      "timeoutMinutes",
      "connections",
      "review",
      "retry",
    ],
    [ProcessStepType.Approval]: ["type", "id", "name", "show", "approve"],
    [ProcessStepType.AgentFlowPlan]: [
      "type",
      "id",
      "name",
      "questions",
      "recommendations",
    ],
    [ProcessStepType.AgentFlowExecute]: [
      "type",
      "id",
      "name",
      "review",
      "releaseNotes",
    ],
  },
} as const;

/** The draft as YAML: defaults and empty values left out, long text as blocks. */
export function processToYaml(draft: ProjectProcessInput): string {
  return stringify(processYamlValue(draft), {
    lineWidth: 0,
    blockQuote: "literal",
  });
}

/**
 * The draft as the plain value `processToYaml` writes, its keys in YAML order:
 * also what a workflow's own process is nested as in the workflow YAML.
 */
export function processYamlValue(draft: ProjectProcessInput): PlainRecord {
  const toolkit = draft.toolkit
    ? ordered(draft.toolkit, PROCESS_YAML_KEYS.toolkit, ["instructions"])
    : null;
  const steps = draft.steps.map((step) => {
    const keys = stepKeys(step.type);
    const plain = ordered(step, keys, []);
    if ("document" in plain && isRecord(plain.document)) {
      plain.document = ordered(plain.document, PROCESS_YAML_KEYS.document, [
        "title",
      ]);
    }
    return plain;
  });
  return toolkit ? { toolkit, steps } : { steps };
}

/** The YAML as a draft (`source` = the text), or why it is not one. */
export function parseProcessYaml(text: string): ParsedProcessYaml {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  const [error] = document.errors;
  if (error) {
    return {
      ok: false,
      problem: yamlProblemAt(
        lineCounter,
        error.pos[0],
        error.pos[1],
        yamlErrorMessage(error.message),
        YamlProblemSeverity.Error
      ),
    };
  }
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (!isRecord(value)) {
    return {
      ok: false,
      problem: yamlProblemAt(
        lineCounter,
        0,
        Math.max(text.length, 1),
        "Write the process as a mapping with steps: (and optionally toolkit:)",
        YamlProblemSeverity.Error
      ),
    };
  }
  return {
    ok: true,
    draft: { ...(value as ProjectProcessInput), source: text },
  };
}

/** Every problem of the YAML: syntax, then the schema's, then unknown keys. */
export function processYamlProblems(text: string): YamlProblem[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map((error) =>
      yamlProblemAt(
        lineCounter,
        error.pos[0],
        error.pos[1],
        yamlErrorMessage(error.message),
        YamlProblemSeverity.Error
      )
    );
  }
  const parsed = parseProcessYaml(text);
  if (!parsed.ok) {
    return [parsed.problem];
  }
  const { source: _source, ...process } = parsed.draft;
  const result = projectProcessSchema.safeParse(process);
  const schemaProblems = result.success
    ? []
    : result.error.issues.map((issue) => {
        const [from, to] = yamlNodeRange(document, issue.path, text);
        return yamlProblemAt(
          lineCounter,
          from,
          to,
          issue.message,
          YamlProblemSeverity.Error
        );
      });
  return [
    ...schemaProblems,
    ...processUnknownKeyProblems(document.contents, lineCounter),
  ];
}

/**
 * The text the YAML view shows for a draft: the user's own YAML while it
 * still describes the draft (or while they are fixing it), else generated.
 */
export function processYamlText(draft: ProjectProcessInput): string {
  if (draft.source === undefined) {
    return processToYaml(draft);
  }
  const parsed = parseProcessYaml(draft.source);
  if (!parsed.ok || sameProcess(parsed.draft, draft)) {
    return draft.source;
  }
  return processToYaml(draft);
}

/** The draft without its YAML text (the form view edits the fields only). */
export function withoutProcessSource(
  draft: ProjectProcessInput
): ProjectProcessInput {
  const { source: _source, ...process } = draft;
  return process;
}

/** The YAML syntax problem of a draft's text, if it has one (validateProcessDraft). */
export function processYamlSyntaxProblem(text: string): YamlProblem | null {
  const parsed = parseProcessYaml(text);
  return parsed.ok ? null : parsed.problem;
}

type PlainRecord = Record<string, unknown>;

/** `value`'s keys in `order` first, without null/undefined/empty lists or the empty `omitIfEmpty` strings. */
function ordered(
  value: object,
  order: readonly string[],
  omitIfEmpty: readonly string[]
): PlainRecord {
  const entries = Object.entries(value);
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index < 0 ? order.length : index;
  };
  const result: PlainRecord = {};
  for (const [key, entry] of entries.sort(([a], [b]) => rank(a) - rank(b))) {
    if (key === "source" || entry === null || entry === undefined) {
      continue;
    }
    if (Array.isArray(entry) && entry.length === 0) {
      continue;
    }
    if (entry === "" && omitIfEmpty.includes(key)) {
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function stepKeys(type: string): readonly string[] {
  return (
    PROCESS_YAML_KEYS.steps[type as keyof typeof PROCESS_YAML_KEYS.steps] ??
    PROCESS_YAML_KEYS.steps[ProcessStepType.Agent]
  );
}

function sameProcess(a: ProjectProcessInput, b: ProjectProcessInput): boolean {
  return stableStringify(normalized(a)) === stableStringify(normalized(b));
}

/** Schema defaults applied when it validates, so `questions: ask` equals an omitted default. */
function normalized(draft: ProjectProcessInput): unknown {
  const process = withoutProcessSource(draft);
  const parsed = projectProcessSchema.safeParse(process);
  return parsed.success ? withoutProcessSource(parsed.data) : process;
}

/**
 * Keys the process mapping `node` does not know, which the schema would
 * silently drop. Also used for a workflow's own process, nested in its YAML.
 */
export function processUnknownKeyProblems(
  node: unknown,
  lineCounter: LineCounter
): YamlProblem[] {
  if (!isMap(node)) {
    return [];
  }
  const problems = unknownYamlKeyProblems(
    node,
    PROCESS_YAML_KEYS.process,
    "the process",
    lineCounter
  );
  problems.push(
    ...unknownYamlKeyProblems(
      node.get("toolkit", true),
      PROCESS_YAML_KEYS.toolkit,
      "toolkit",
      lineCounter
    )
  );
  const steps = node.get("steps", true);
  const items = (steps as { items?: unknown[] } | null)?.items ?? [];
  items.forEach((item, index) => {
    const type = isMap(item) ? item.get("type") : undefined;
    problems.push(
      ...unknownYamlKeyProblems(
        item,
        stepKeys(String(type ?? ProcessStepType.Agent)),
        `step ${index + 1}`,
        lineCounter
      )
    );
    if (isMap(item)) {
      problems.push(
        ...unknownYamlKeyProblems(
          item.get("document", true),
          PROCESS_YAML_KEYS.document,
          `the document of step ${index + 1}`,
          lineCounter
        ),
        ...unknownYamlKeyProblems(
          item.get("retry", true),
          PROCESS_YAML_KEYS.retry,
          `the retry of step ${index + 1}`,
          lineCounter
        ),
        ...signalKeyProblems(item, String(type ?? ""), index, lineCounter)
      );
    }
  });
  return problems;
}

/** Unknown keys of an agent step's review, or of an approval step's approve. */
function signalKeyProblems(
  item: YAMLMap,
  type: string,
  index: number,
  lineCounter: LineCounter
): YamlProblem[] {
  const where = `step ${index + 1}`;
  if (type === ProcessStepType.Approval) {
    return unknownYamlKeyProblems(
      item.get("approve", true),
      PROCESS_YAML_KEYS.signal,
      `approve of ${where}`,
      lineCounter
    );
  }
  const review = item.get("review", true);
  if (type === ProcessStepType.AgentFlowExecute || !isMap(review)) {
    return [];
  }
  return [
    ...unknownYamlKeyProblems(
      review,
      PROCESS_YAML_KEYS.review,
      `the review of ${where}`,
      lineCounter
    ),
    ...unknownYamlKeyProblems(
      review.get("feedback", true),
      PROCESS_YAML_KEYS.reviewFeedback,
      `review.feedback of ${where}`,
      lineCounter
    ),
    ...["approve", "complete"].flatMap((key) =>
      unknownYamlKeyProblems(
        review.get(key, true),
        PROCESS_YAML_KEYS.signal,
        `review.${key} of ${where}`,
        lineCounter
      )
    ),
  ];
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
