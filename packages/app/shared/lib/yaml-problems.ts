import { type Document, isMap, isPair, isScalar, type LineCounter } from "yaml";

/**
 * Problems of a YAML text placed where they are in it, so an editor can
 * underline them: shared by the YAML editors (project process, workflow
 * configuration), which decide what a problem is.
 */

export const YamlProblemSeverity = {
  Error: "error",
  Warning: "warning",
} as const;
export type YamlProblemSeverity =
  (typeof YamlProblemSeverity)[keyof typeof YamlProblemSeverity];

/** A problem of the YAML, at offsets of the text. */
export type YamlProblem = {
  from: number;
  to: number;
  /** 1-based line of `from`. */
  line: number;
  message: string;
  severity: YamlProblemSeverity;
};

export function yamlProblemAt(
  lineCounter: LineCounter,
  from: number,
  to: number,
  message: string,
  severity: YamlProblemSeverity
): YamlProblem {
  return {
    from,
    to: Math.max(to, from + 1),
    line: lineCounter.linePos(from).line,
    message,
    severity,
  };
}

/** The yaml library's message without its "at line N, column M:" tail (the editor marks the place). */
export function yamlErrorMessage(message: string): string {
  const [first = message] = message.split("\n");
  return first.replace(TRAILING_POSITION_RE, "").trim();
}

/**
 * Offsets of the node at `path` (a value or a key's mapping); for a
 * missing key, the first line of the closest node that exists.
 */
export function yamlNodeRange(
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

/**
 * Offsets of the KEY `key` in the mapping at `path`, when the text has it:
 * where an unknown key or a value of the wrong kind is underlined.
 */
export function yamlKeyRange(
  document: Document,
  path: readonly PropertyKey[],
  key: string
): [number, number] | null {
  const node =
    path.length === 0
      ? document.contents
      : document.getIn(path as unknown[], true);
  if (!isMap(node)) {
    return null;
  }
  for (const pair of node.items) {
    if (isPair(pair) && isScalar(pair.key) && String(pair.key.value) === key) {
      const range = pair.key.range;
      return range ? [range[0], range[1]] : null;
    }
  }
  return null;
}

/** Keys of the mapping `node` that are not `known`, as warnings with a "did you mean". */
export function unknownYamlKeyProblems(
  node: unknown,
  known: readonly string[],
  where: string,
  lineCounter: LineCounter
): YamlProblem[] {
  if (!isMap(node)) {
    return [];
  }
  const problems: YamlProblem[] = [];
  for (const pair of node.items) {
    if (!(isPair(pair) && isScalar(pair.key))) {
      continue;
    }
    const key = String(pair.key.value);
    const range = pair.key.range;
    if (!known.includes(key) && range) {
      const hint = closestYamlKey(key, known);
      problems.push(
        yamlProblemAt(
          lineCounter,
          range[0],
          range[1],
          `Unknown key "${key}" in ${where}${hint ? ` - did you mean "${hint}"?` : ""}`,
          YamlProblemSeverity.Warning
        )
      );
    }
  }
  return problems;
}

/**
 * A known key a typo is closest to: at most one edit per three letters
 * (a swap of two letters is one edit), so "instrcution" hints "instruction"
 * but "file" does not hint "title".
 */
export function closestYamlKey(
  key: string,
  known: readonly string[]
): string | null {
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

const TRAILING_POSITION_RE = /\s+at line \d+, column \d+:?\s*$/;

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
