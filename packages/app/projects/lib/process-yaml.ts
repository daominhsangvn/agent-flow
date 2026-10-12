import { stableStringify } from "@agentflow-ai/loops-api/stable-stringify";
import {
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import {
  type Document,
  isMap,
  isPair,
  isScalar,
  LineCounter,
  parseDocument,
  stringify,
} from "yaml";

/**
 * The YAML view of the process editor: a draft as YAML (the text the user
 * wrote, comments kept, while it still describes the draft; else generated)
 * and YAML back to a draft, with every problem placed where it is in the
 * text so the editor can underline it.
 */

export const ProcessYamlSeverity = {
  Error: "error",
  Warning: "warning",
} as const;
export type ProcessYamlSeverity =
  (typeof ProcessYamlSeverity)[keyof typeof ProcessYamlSeverity];

/** A problem of the YAML, at offsets of the text. */
export type ProcessYamlProblem = {
  from: number;
  to: number;
  /** 1-based line of `from`. */
  line: number;
  message: string;
  severity: ProcessYamlSeverity;
};

export type ParsedProcessYaml =
  /** The draft the YAML describes, `source` set to the text. */
  | { ok: true; draft: ProjectProcessInput }
  /** The text is not YAML (or not a mapping): its first problem. */
  | { ok: false; problem: ProcessYamlProblem };

/** Keys of each kind of mapping, in the order generated YAML writes them. */
export const PROCESS_YAML_KEYS = {
  process: ["toolkit", "steps"],
  toolkit: ["repository", "mounts", "instructions"],
  document: ["type", "path", "title"],
  steps: {
    [ProcessStepType.Agent]: [
      "type",
      "id",
      "name",
      "instruction",
      "questions",
      "artifacts",
      "reply",
      "document",
      "finish",
      "timeoutMinutes",
    ],
    [ProcessStepType.Approval]: ["type", "id", "name", "show"],
    [ProcessStepType.AgentFlowPlan]: [
      "type",
      "id",
      "name",
      "questions",
      "recommendations",
    ],
    [ProcessStepType.AgentFlowExecute]: ["type", "id", "name", "review"],
  },
} as const;

/** The draft as YAML: defaults and empty values left out, long text as blocks. */
export function processToYaml(draft: ProjectProcessInput): string {
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
  return stringify(toolkit ? { toolkit, steps } : { steps }, {
    lineWidth: 0,
    blockQuote: "literal",
  });
}

/** The YAML as a draft (`source` = the text), or why it is not one. */
export function parseProcessYaml(text: string): ParsedProcessYaml {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  const [error] = document.errors;
  if (error) {
    return {
      ok: false,
      problem: problemAt(
        lineCounter,
        error.pos[0],
        error.pos[1],
        cleanMessage(error.message),
        ProcessYamlSeverity.Error
      ),
    };
  }
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (!isRecord(value)) {
    return {
      ok: false,
      problem: problemAt(
        lineCounter,
        0,
        Math.max(text.length, 1),
        "Write the process as a mapping with steps: (and optionally toolkit:)",
        ProcessYamlSeverity.Error
      ),
    };
  }
  return {
    ok: true,
    draft: { ...(value as ProjectProcessInput), source: text },
  };
}

/** Every problem of the YAML: syntax, then the schema's, then unknown keys. */
export function processYamlProblems(text: string): ProcessYamlProblem[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map((error) =>
      problemAt(
        lineCounter,
        error.pos[0],
        error.pos[1],
        cleanMessage(error.message),
        ProcessYamlSeverity.Error
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
        const [from, to] = rangeOf(document, issue.path, text);
        return problemAt(
          lineCounter,
          from,
          to,
          issue.message,
          ProcessYamlSeverity.Error
        );
      });
  return [...schemaProblems, ...unknownKeyProblems(document, lineCounter)];
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
export function processYamlSyntaxProblem(
  text: string
): ProcessYamlProblem | null {
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
 * Offsets of the node at `path` (a value or a key's mapping); for a
 * missing key, the first line of the closest node that exists.
 */
function rangeOf(
  document: Document,
  path: readonly PropertyKey[],
  text: string
): [number, number] {
  for (let length = path.length; length >= 0; length--) {
    const node =
      length === 0
        ? document.contents
        : document.getIn(path.slice(0, length) as unknown[], true);
    const range = (node as { range?: [number, number, number] } | null)?.range;
    if (!range) {
      continue;
    }
    if (length === path.length) {
      return [range[0], Math.max(range[1], range[0] + 1)];
    }
    const lineEnd = text.indexOf("\n", range[0]);
    return [range[0], lineEnd < 0 ? Math.max(range[1], range[0] + 1) : lineEnd];
  }
  return [0, Math.min(text.length, 1)];
}

/** Keys the process does not know, which the schema would silently drop. */
function unknownKeyProblems(
  document: Document,
  lineCounter: LineCounter
): ProcessYamlProblem[] {
  const problems: ProcessYamlProblem[] = [];
  const check = (node: unknown, known: readonly string[], where: string) => {
    if (!isMap(node)) {
      return;
    }
    for (const pair of node.items) {
      if (!(isPair(pair) && isScalar(pair.key))) {
        continue;
      }
      const key = String(pair.key.value);
      const range = pair.key.range;
      if (!known.includes(key) && range) {
        const hint = closestKey(key, known);
        problems.push(
          problemAt(
            lineCounter,
            range[0],
            range[1],
            `Unknown key "${key}" in ${where}${hint ? ` - did you mean "${hint}"?` : ""}`,
            ProcessYamlSeverity.Warning
          )
        );
      }
    }
  };
  check(document.contents, PROCESS_YAML_KEYS.process, "the process");
  check(
    document.getIn(["toolkit"], true),
    PROCESS_YAML_KEYS.toolkit,
    "toolkit"
  );
  const steps = document.getIn(["steps"], true);
  const items = (steps as { items?: unknown[] } | null)?.items ?? [];
  items.forEach((item, index) => {
    const type = isMap(item) ? item.get("type") : undefined;
    check(
      item,
      stepKeys(String(type ?? ProcessStepType.Agent)),
      `step ${index + 1}`
    );
    if (isMap(item)) {
      check(
        item.get("document", true),
        PROCESS_YAML_KEYS.document,
        `the document of step ${index + 1}`
      );
    }
  });
  return problems;
}

/**
 * A known key a typo is closest to: at most one edit per three letters
 * (a swap of two letters is one edit), so "instrcution" hints "instruction"
 * but "file" does not hint "title".
 */
function closestKey(key: string, known: readonly string[]): string | null {
  const limit = Math.min(3, Math.max(1, Math.floor(key.length / 3)));
  let best: { key: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance <= limit && (!best || distance < best.distance)) {
      best = { key: candidate, distance };
    }
  }
  return best?.key ?? null;
}

/** Edit distance with adjacent swaps (optimal string alignment). */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0)
  );
  for (let i = 0; i < rows; i++) {
    const row = table[i];
    if (row) {
      row[0] = i;
    }
  }
  for (let j = 0; j < columns; j++) {
    const row = table[0];
    if (row) {
      row[j] = j;
    }
  }
  const cell = (i: number, j: number) => table[i]?.[j] ?? 0;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        cell(i - 1, j) + 1,
        cell(i, j - 1) + 1,
        cell(i - 1, j - 1) + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, cell(i - 2, j - 2) + 1);
      }
      const row = table[i];
      if (row) {
        row[j] = value;
      }
    }
  }
  return cell(a.length, b.length);
}

function problemAt(
  lineCounter: LineCounter,
  from: number,
  to: number,
  message: string,
  severity: ProcessYamlSeverity
): ProcessYamlProblem {
  return {
    from,
    to: Math.max(to, from + 1),
    line: lineCounter.linePos(from).line,
    message,
    severity,
  };
}

/** The yaml library's message without its "at line N, column M:" tail (the editor marks the place). */
function cleanMessage(message: string): string {
  const [first = message] = message.split("\n");
  return first.replace(TRAILING_POSITION_RE, "").trim();
}

const TRAILING_POSITION_RE = /\s+at line \d+, column \d+:?\s*$/;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
