/**
 * `{{variable}}` renderer for action message fields and the issue title
 * template. Variable names are the dotted paths of
 * WORKFLOW_TEMPLATE_VARIABLES (`summary`, `run.url`, `source.key`, ...).
 *
 * - Whitespace inside the braces is ignored: `{{ run.url }}` == `{{run.url}}`.
 * - Unknown names render as an empty string.
 * - Values are inserted verbatim (no escaping); providers escape for their
 *   own output format.
 */

/** Flat map from dotted variable name to its rendered value. */
export type TemplateVariables = Readonly<Record<string, string>>;

// `-` too: process step ids may contain it ({{steps.draft-ticket.reply}}).
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(
  template: string,
  variables: TemplateVariables
): string {
  return template.replaceAll(PLACEHOLDER_RE, (_match, name: string) =>
    Object.hasOwn(variables, name) ? (variables[name] ?? "") : ""
  );
}
