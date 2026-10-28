import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";

/**
 * Values written in YAML (a workflow's trigger and action options, a
 * connection's settings), checked against the field descriptors: the value
 * kinds the form produced (a list, a number, true or false, text) and the
 * allowed options of a select.
 */

export type CheckedValue =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** The value as the field's kind holds it, or why it is not one. */
export function checkFieldValue(
  field: IntegrationFieldDescriptor,
  value: unknown
): CheckedValue {
  if (value === null || value === undefined) {
    return { ok: true, value: undefined };
  }
  if (field.kind === IntegrationFieldKind.Boolean) {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { ok: false, message: `${field.key} is true or false` };
  }
  if (field.kind === IntegrationFieldKind.Number) {
    return typeof value === "number"
      ? { ok: true, value }
      : { ok: false, message: `${field.key} is a number` };
  }
  if (LIST_KINDS.includes(field.kind)) {
    return checkList(field, value);
  }
  if (TEXT_KINDS.includes(field.kind) && isScalarValue(value)) {
    return checkText(field, String(value));
  }
  return { ok: false, message: `${field.key} is text` };
}

const TEXT_KINDS: readonly IntegrationFieldKind[] = [
  IntegrationFieldKind.Text,
  IntegrationFieldKind.Textarea,
  IntegrationFieldKind.Secret,
  IntegrationFieldKind.Url,
  IntegrationFieldKind.Email,
  IntegrationFieldKind.Select,
  IntegrationFieldKind.Template,
];

const LIST_KINDS: readonly IntegrationFieldKind[] = [
  IntegrationFieldKind.MultiSelect,
  IntegrationFieldKind.StringList,
];

/** A list of words, each one an option when the field has options. */
function checkList(
  field: IntegrationFieldDescriptor,
  value: unknown
): CheckedValue {
  if (!(Array.isArray(value) && value.every(isScalarValue))) {
    return {
      ok: false,
      message: `${field.key} is a list, e.g. [${field.placeholder ?? "value"}]`,
    };
  }
  const items = value.map(String);
  const options = optionValues(field);
  const unknown = options
    ? items.find((item) => !options.includes(item))
    : undefined;
  return unknown === undefined
    ? { ok: true, value: items }
    : { ok: false, message: optionsMessage(field.key, unknown, options ?? []) };
}

/** Text (a number or true written for a text field reads as its text). */
function checkText(
  field: IntegrationFieldDescriptor,
  text: string
): CheckedValue {
  const options = optionValues(field);
  if (
    field.kind === IntegrationFieldKind.Select &&
    options &&
    !options.includes(text)
  ) {
    return { ok: false, message: optionsMessage(field.key, text, options) };
  }
  return { ok: true, value: text };
}

function optionValues(
  field: IntegrationFieldDescriptor
): readonly string[] | undefined {
  return field.options?.map((option) => option.value);
}

function optionsMessage(
  key: string,
  value: string,
  options: readonly string[]
): string {
  return `"${value}" is not an option of ${key}. Options: ${options.join(", ")}`;
}

function isScalarValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
