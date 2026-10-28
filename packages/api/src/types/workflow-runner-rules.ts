import { z } from "zod";

/**
 * Runner rules of a workflow (docs/workflows.md "Runner rules"): which runner
 * a run uses, chosen from its source item when the run imports it. The rules
 * are tried in order; the first whose condition holds names the runner, and
 * the workflow's own runner is used when none does. Typically one rule per
 * person, sending the items assigned to them to their personal runner:
 *
 *   source.assignee_email == "an@acme.dev"
 *   source.status == "Ready for Testing" && source.labels contains "qa"
 *   source.type in ["Bug", "Sub-bug"] || source.priority == "Highest"
 *
 * A condition compares a source field with a quoted value: `==`, `!=`,
 * `contains` (a list field has the value; a text field contains it) and
 * `in [..]`. Comparisons ignore case and surrounding spaces; a field the
 * item does not have is empty. `&&` / `and`, `||` / `or`, `!` / `not` and
 * parentheses combine them.
 */

export const WORKFLOW_RUNNER_RULES_MAX = 50;
export const WORKFLOW_RUNNER_CONDITION_MAX = 1000;

/** The source fields a condition can read. */
export const WorkflowRunnerConditionField = {
  Key: "source.key",
  Title: "source.title",
  Type: "source.type",
  Status: "source.status",
  Priority: "source.priority",
  Labels: "source.labels",
  Assignee: "source.assignee",
  AssigneeEmail: "source.assignee_email",
  Reporter: "source.reporter",
  ReporterEmail: "source.reporter_email",
  Provider: "source.provider",
} as const;
export type WorkflowRunnerConditionField =
  (typeof WorkflowRunnerConditionField)[keyof typeof WorkflowRunnerConditionField];

/** What each field holds, for the editor's suggestions and documentation. */
export const WORKFLOW_RUNNER_CONDITION_FIELDS: ReadonlyArray<{
  field: WorkflowRunnerConditionField;
  description: string;
}> = [
  {
    field: WorkflowRunnerConditionField.Key,
    description: "Item key, e.g. PROJ-12",
  },
  { field: WorkflowRunnerConditionField.Title, description: "Item title" },
  {
    field: WorkflowRunnerConditionField.Type,
    description: "Item type, e.g. Story, Bug",
  },
  { field: WorkflowRunnerConditionField.Status, description: "Item status" },
  {
    field: WorkflowRunnerConditionField.Priority,
    description: "Item priority",
  },
  {
    field: WorkflowRunnerConditionField.Labels,
    description: "Item labels (a list)",
  },
  {
    field: WorkflowRunnerConditionField.Assignee,
    description: "Assignee's display name",
  },
  {
    field: WorkflowRunnerConditionField.AssigneeEmail,
    description: "Assignee's email, where the provider shares it",
  },
  {
    field: WorkflowRunnerConditionField.Reporter,
    description: "Reporter's display name",
  },
  {
    field: WorkflowRunnerConditionField.ReporterEmail,
    description: "Reporter's email, where the provider shares it",
  },
  {
    field: WorkflowRunnerConditionField.Provider,
    description: "Provider, e.g. jira",
  },
];

/** The facts of a source item a condition reads; null: the item has none. */
export type WorkflowRunnerConditionFacts = Partial<
  Record<WorkflowRunnerConditionField, string | readonly string[] | null>
>;

export const workflowRunnerRuleSchema = z.object({
  /** Runner (compute target) of the rule; same access rule as `computeTargetId`. */
  computeTargetId: z.string().uuid(),
  condition: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_RUNNER_CONDITION_MAX)
    .superRefine((value, context) => {
      const parsed = parseRunnerCondition(value);
      if (!parsed.ok) {
        context.addIssue({ code: "custom", message: parsed.error });
      }
    }),
});
export type WorkflowRunnerRule = z.infer<typeof workflowRunnerRuleSchema>;

export type RunnerCondition =
  | { kind: "and" | "or"; left: RunnerCondition; right: RunnerCondition }
  | { kind: "not"; operand: RunnerCondition }
  | {
      kind: "compare";
      field: WorkflowRunnerConditionField;
      operator: RunnerConditionOperator;
      values: string[];
    };

export const RunnerConditionOperator = {
  Equals: "==",
  NotEquals: "!=",
  Contains: "contains",
  In: "in",
} as const;
export type RunnerConditionOperator =
  (typeof RunnerConditionOperator)[keyof typeof RunnerConditionOperator];

export type RunnerConditionParse =
  | { ok: true; condition: RunnerCondition }
  | { ok: false; error: string };

/** Parses a condition; the error names what is wrong and where. */
export function parseRunnerCondition(text: string): RunnerConditionParse {
  const tokens = tokenize(text);
  if (!tokens.ok) {
    return tokens;
  }
  const parser = new ConditionParser(tokens.tokens);
  try {
    const condition = parser.parseOr();
    parser.expectEnd();
    return { ok: true, condition };
  } catch (error) {
    if (error instanceof ConditionSyntaxError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** True when the condition holds for the facts. */
export function evaluateRunnerCondition(
  condition: RunnerCondition,
  facts: WorkflowRunnerConditionFacts
): boolean {
  switch (condition.kind) {
    case "and":
      return (
        evaluateRunnerCondition(condition.left, facts) &&
        evaluateRunnerCondition(condition.right, facts)
      );
    case "or":
      return (
        evaluateRunnerCondition(condition.left, facts) ||
        evaluateRunnerCondition(condition.right, facts)
      );
    case "not":
      return !evaluateRunnerCondition(condition.operand, facts);
    default:
      return compare(condition, facts[condition.field] ?? null);
  }
}

/**
 * The runner of the first rule whose condition holds, else `fallback`. A
 * rule whose condition no longer parses never matches.
 */
export function chooseRunnerByRules(
  rules: readonly WorkflowRunnerRule[],
  facts: WorkflowRunnerConditionFacts,
  fallback: string
): { computeTargetId: string; ruleIndex: number | null } {
  for (const [index, rule] of rules.entries()) {
    const parsed = parseRunnerCondition(rule.condition);
    if (parsed.ok && evaluateRunnerCondition(parsed.condition, facts)) {
      return { computeTargetId: rule.computeTargetId, ruleIndex: index };
    }
  }
  return { computeTargetId: fallback, ruleIndex: null };
}

const FIELDS: ReadonlySet<string> = new Set(
  Object.values(WorkflowRunnerConditionField)
);
const WORD_OPERATORS: Record<string, Token["type"]> = {
  and: "and",
  or: "or",
  not: "not",
  contains: "contains",
  in: "in",
};
const WHITESPACE_RE = /\s/;
const WORD_START_RE = /[A-Za-z_]/;
const WORD_RE = /[A-Za-z0-9_.]/;

type Token =
  | { type: "string"; value: string; at: number }
  | { type: "field"; value: string; at: number }
  | {
      type:
        | "and"
        | "or"
        | "not"
        | "contains"
        | "in"
        | "=="
        | "!="
        | "("
        | ")"
        | "["
        | "]"
        | ",";
      at: number;
    };

class ConditionSyntaxError extends Error {}

const SYMBOLS: readonly [string, Token["type"]][] = [
  ["&&", "and"],
  ["||", "or"],
  ["==", "=="],
  ["!=", "!="],
  ["!", "not"],
  ["(", "("],
  [")", ")"],
  ["[", "["],
  ["]", "]"],
  [",", ","],
];

type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; error: string };
/** One token (null: whitespace) and where the next one starts. */
type ScanResult =
  | { ok: true; token: Token | null; next: number }
  | { ok: false; error: string };

function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const scan = scanToken(text, index);
    if (!scan.ok) {
      return scan;
    }
    if (scan.token) {
      tokens.push(scan.token);
    }
    index = scan.next;
  }
  return { ok: true, tokens };
}

function scanToken(text: string, index: number): ScanResult {
  const char = text[index] ?? "";
  if (WHITESPACE_RE.test(char)) {
    return { ok: true, token: null, next: index + 1 };
  }
  if (char === '"' || char === "'") {
    return scanString(text, index, char);
  }
  const symbol = SYMBOLS.find(([literal]) => text.startsWith(literal, index));
  if (symbol) {
    return {
      ok: true,
      token: { type: symbol[1], at: index } as Token,
      next: index + symbol[0].length,
    };
  }
  if (WORD_START_RE.test(char)) {
    return scanWord(text, index);
  }
  return { ok: false, error: `Unexpected "${char}" at character ${index + 1}` };
}

function scanString(text: string, index: number, quote: string): ScanResult {
  const end = text.indexOf(quote, index + 1);
  if (end === -1) {
    return { ok: false, error: `Unclosed quote at character ${index + 1}` };
  }
  return {
    ok: true,
    token: { type: "string", value: text.slice(index + 1, end), at: index },
    next: end + 1,
  };
}

/** An operator word (and, or, not, contains, in) or a field. */
function scanWord(text: string, index: number): ScanResult {
  let end = index;
  while (end < text.length && WORD_RE.test(text[end] ?? "")) {
    end++;
  }
  const word = text.slice(index, end);
  const operator = WORD_OPERATORS[word.toLowerCase()];
  if (operator) {
    return {
      ok: true,
      token: { type: operator, at: index } as Token,
      next: end,
    };
  }
  if (FIELDS.has(word)) {
    return {
      ok: true,
      token: { type: "field", value: word, at: index },
      next: end,
    };
  }
  return {
    ok: false,
    error: `Unknown field "${word}"; use one of ${[...FIELDS].join(", ")}`,
  };
}

class ConditionParser {
  private position = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parseOr(): RunnerCondition {
    let left = this.parseAnd();
    while (this.take("or")) {
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token) {
      throw new ConditionSyntaxError(
        `Unexpected ${describe(token)} at character ${token.at + 1}`
      );
    }
  }

  private parseAnd(): RunnerCondition {
    let left = this.parseNot();
    while (this.take("and")) {
      left = { kind: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): RunnerCondition {
    if (this.take("not")) {
      return { kind: "not", operand: this.parseNot() };
    }
    if (this.take("(")) {
      const inner = this.parseOr();
      this.expect(")", "a closing parenthesis");
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): RunnerCondition {
    const field = this.next();
    if (field?.type !== "field") {
      throw new ConditionSyntaxError(
        `Expected a field such as source.assignee_email${field ? ` at character ${field.at + 1}` : " at the end"}`
      );
    }
    const operator = this.next();
    switch (operator?.type) {
      case "==":
      case "!=":
      case "contains":
        return {
          kind: "compare",
          field: field.value as WorkflowRunnerConditionField,
          operator: operator.type,
          values: [this.expectString()],
        };
      case "in":
        return {
          kind: "compare",
          field: field.value as WorkflowRunnerConditionField,
          operator: RunnerConditionOperator.In,
          values: this.parseList(),
        };
      default:
        throw new ConditionSyntaxError(
          `Expected ==, !=, contains or in after ${field.value}`
        );
    }
  }

  private parseList(): string[] {
    this.expect("[", 'a list such as ["Bug", "Task"]');
    const values = [this.expectString()];
    while (this.take(",")) {
      values.push(this.expectString());
    }
    this.expect("]", "the end of the list (])");
    return values;
  }

  private expectString(): string {
    const token = this.next();
    if (token?.type !== "string") {
      throw new ConditionSyntaxError(
        `Expected a quoted value${token ? ` at character ${token.at + 1}` : " at the end"}`
      );
    }
    return token.value;
  }

  private expect(type: Token["type"], what: string): void {
    const token = this.next();
    if (token?.type !== type) {
      throw new ConditionSyntaxError(
        `Expected ${what}${token ? ` at character ${token.at + 1}` : " at the end"}`
      );
    }
  }

  private take(type: Token["type"]): boolean {
    if (this.peek()?.type === type) {
      this.position++;
      return true;
    }
    return false;
  }

  private next(): Token | undefined {
    const token = this.tokens[this.position];
    this.position++;
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }
}

function describe(token: Token): string {
  return "value" in token ? `"${token.value}"` : `"${token.type}"`;
}

function compare(
  condition: Extract<RunnerCondition, { kind: "compare" }>,
  fact: string | readonly string[] | null
): boolean {
  const values = condition.values.map(normalize);
  const facts = (Array.isArray(fact) ? fact : [fact ?? ""]).map((value) =>
    normalize(value as string)
  );
  switch (condition.operator) {
    case RunnerConditionOperator.Equals:
      return facts.some((value) => value === values[0]);
    case RunnerConditionOperator.NotEquals:
      return !facts.some((value) => value === values[0]);
    case RunnerConditionOperator.In:
      return facts.some((value) => values.includes(value));
    default:
      return Array.isArray(fact)
        ? facts.includes(values[0] ?? "")
        : (facts[0] ?? "").includes(values[0] ?? "");
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
