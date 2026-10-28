/**
 * A suggestion of a YAML editor's popup, independent of the editor library:
 * the completion modules (project process, workflow configuration) produce
 * these, and `YamlCodeEditor` turns them into CodeMirror completions.
 */

export const YamlCompletionKind = {
  Key: "property",
  Value: "enum",
  Variable: "variable",
  Snippet: "snippet",
} as const;
export type YamlCompletionKind =
  (typeof YamlCompletionKind)[keyof typeof YamlCompletionKind];

export type YamlCompletion = {
  label: string;
  /** Text inserted from the cursor's `from`; a snippet uses #{placeholders}. */
  insert: string;
  kind: YamlCompletionKind;
  detail?: string;
  info?: string;
};

/** What fits at the cursor: the suggestions and where the typed word starts. */
export type YamlCompletionResult = {
  from: number;
  options: readonly YamlCompletion[];
  /** Inside `{{`: a typed word may contain dots (`source.key`). */
  variable: boolean;
};

/** The completions whose label contains what is typed (all when nothing is). */
export function filterYamlCompletions(
  completions: readonly YamlCompletion[],
  typed: string
): YamlCompletion[] {
  const needle = typed.toLowerCase();
  return needle
    ? completions.filter((completion) =>
        completion.label.toLowerCase().includes(needle)
      )
    : [...completions];
}
