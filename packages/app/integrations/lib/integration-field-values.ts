import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  type IntegrationFieldCondition,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  type IntegrationSecretFieldState,
} from "@repo/api/src/types/integration";
import { z } from "zod";

/**
 * Pure value model behind the descriptor-driven integration forms
 * (`IntegrationFieldForm`). The form edits a flat `Record<string, unknown>`
 * keyed by descriptor key; these helpers decide what a field shows, whether it
 * is valid, and what is finally sent to the API, so the rendered form and the
 * submitted payload can never disagree.
 *
 * A key absent from the value map means "use the descriptor default", which is
 * also what a freshly added trigger or action starts with.
 */

export type IntegrationFieldValues = Record<string, unknown>;

export type IntegrationFieldErrors = Record<string, string>;

/** Secret state of an existing connection, keyed by secret field key. */
export type IntegrationSecretFieldStates = Record<
  string,
  IntegrationSecretFieldState
>;

export type CollectedIntegrationFieldValues = {
  /** Non-secret values of the visible fields. */
  config: JsonObject;
  /**
   * Secrets of the visible fields: the non-empty values the user typed, and
   * "" for a stored secret the user removed (the API clears it). An omitted
   * secret keeps its stored value.
   */
  secrets: Record<string, string>;
};

export type ValidateIntegrationFieldsOptions = {
  /** When set, an empty secret whose stored value is set is valid (keep it). */
  secretFields?: IntegrationSecretFieldStates;
};

/**
 * Form value of a stored, optional secret the user chose to remove. It is
 * sent as "" on save, which clears the stored secret.
 */
export const REMOVED_SECRET_VALUE: null = null;

export type SecretReentryInput = {
  fields: readonly IntegrationFieldDescriptor[];
  values: IntegrationFieldValues;
  /** The stored, non-secret config of the connection being edited. */
  storedConfig: JsonObject;
  /** Secret state of the connection being edited. */
  secretFields: IntegrationSecretFieldStates;
  /** Config keys that decide where the credentials are sent (provider catalog). */
  credentialOriginFields: readonly string[];
};

/**
 * What the connection form renders while a credential origin field (e.g. the
 * Jira site URL) differs from the stored value: the stored secrets would go
 * to a new destination, so the API requires them again.
 */
export type SecretReentry = {
  /** The descriptors, with every secret to re-enter marked required. */
  fields: IntegrationFieldDescriptor[];
  /** The secret states, with every secret to re-enter shown as not set (empty no longer keeps it). */
  secretFields: IntegrationSecretFieldStates;
  /** Why each secret must be re-entered, keyed by secret field key. */
  hints: Record<string, string>;
};

export const REQUIRED_FIELD_MESSAGE = "This field is required";
export const INVALID_NUMBER_MESSAGE = "Enter a number";
export const INVALID_URL_MESSAGE = "Enter a valid http(s) URL";
export const INVALID_EMAIL_MESSAGE = "Enter a valid email address";

/** The empty value a field of each kind starts from when it has no default. */
export function getEmptyFieldValue(kind: IntegrationFieldKind): unknown {
  switch (kind) {
    case IntegrationFieldKind.Boolean:
      return false;
    case IntegrationFieldKind.MultiSelect:
    case IntegrationFieldKind.StringList:
      return [];
    case IntegrationFieldKind.Number:
      return undefined;
    default:
      return "";
  }
}

/** The value the form starts a field with: its descriptor default, else the kind's empty value. */
export function getFieldDefaultValue(
  field: IntegrationFieldDescriptor
): unknown {
  if (field.kind === IntegrationFieldKind.Secret) {
    return "";
  }
  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    return field.defaultValue;
  }
  return getEmptyFieldValue(field.kind);
}

/** The current value of a field: the stored value, or the default when the key is absent. */
export function readFieldValue(
  field: IntegrationFieldDescriptor,
  values: IntegrationFieldValues
): unknown {
  if (Object.hasOwn(values, field.key)) {
    return values[field.key];
  }
  return getFieldDefaultValue(field);
}

/**
 * Whether a field is shown, per its `showWhen` condition. The controlling
 * field's value is read through its own default, so a condition on a select
 * with a default holds before the user touches the select.
 */
export function isFieldVisible(
  field: IntegrationFieldDescriptor,
  values: IntegrationFieldValues,
  fields: readonly IntegrationFieldDescriptor[]
): boolean {
  if (!field.showWhen) {
    return true;
  }
  const controller = fields.find(
    (candidate) => candidate.key === field.showWhen?.field
  );
  const current = controller
    ? readFieldValue(controller, values)
    : values[field.showWhen.field];
  return matchesCondition(field.showWhen, current);
}

/** The fields currently shown, in descriptor order. */
export function getVisibleFields(
  fields: readonly IntegrationFieldDescriptor[],
  values: IntegrationFieldValues
): IntegrationFieldDescriptor[] {
  return fields.filter((field) => isFieldVisible(field, values, fields));
}

/**
 * Initial form values: every non-secret field from `existing` (or its default),
 * secrets always empty (they are write-only and never echoed back).
 */
export function buildFieldValues(
  fields: readonly IntegrationFieldDescriptor[],
  existing: JsonObject | IntegrationFieldValues = {}
): IntegrationFieldValues {
  const values: IntegrationFieldValues = {};
  for (const field of fields) {
    if (field.kind === IntegrationFieldKind.Secret) {
      values[field.key] = "";
      continue;
    }
    values[field.key] = Object.hasOwn(existing, field.key)
      ? existing[field.key]
      : getFieldDefaultValue(field);
  }
  return values;
}

/**
 * Client-side validation of the visible fields. Hidden fields are never
 * validated (their values are not submitted either). Server-side validation
 * still runs on save; the form shows its message inline and in a toast.
 */
export function validateFieldValues(
  fields: readonly IntegrationFieldDescriptor[],
  values: IntegrationFieldValues,
  options: ValidateIntegrationFieldsOptions = {}
): IntegrationFieldErrors {
  const errors: IntegrationFieldErrors = {};
  for (const field of getVisibleFields(fields, values)) {
    const error = validateField(field, readFieldValue(field, values), options);
    if (error) {
      errors[field.key] = error;
    }
  }
  return errors;
}

export function hasFieldErrors(errors: IntegrationFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The payload halves for the visible fields: `config` gets the non-secret
 * values (text trimmed, empty numbers dropped), `secrets` gets only the
 * secrets the user actually typed (or removed), so an untouched secret keeps
 * its stored value on update.
 */
export function collectFieldValues(
  fields: readonly IntegrationFieldDescriptor[],
  values: IntegrationFieldValues
): CollectedIntegrationFieldValues {
  const config: JsonObject = {};
  const secrets: Record<string, string> = {};
  for (const field of getVisibleFields(fields, values)) {
    const value = readFieldValue(field, values);
    if (field.kind === IntegrationFieldKind.Secret) {
      const secret = collectSecretValue(value);
      if (secret !== undefined) {
        secrets[field.key] = secret;
      }
      continue;
    }
    const normalized = normalizeFieldValue(field.kind, value);
    if (normalized !== undefined) {
      config[field.key] = normalized;
    }
  }
  return { config, secrets };
}

/**
 * The secrets to re-enter on edit: when a credential origin field differs from
 * the stored config, every stored secret of a visible field (except one being
 * removed) must be typed again, with a hint naming the changed field(s).
 * Both sides are compared after the same normalization as the submitted
 * config, so an untouched form never asks for anything.
 */
export function getSecretReentry(input: SecretReentryInput): SecretReentry {
  const hints = getSecretReentryHints(input);
  if (Object.keys(hints).length === 0) {
    return {
      fields: [...input.fields],
      secretFields: input.secretFields,
      hints,
    };
  }
  const secretFields: IntegrationSecretFieldStates = {
    ...input.secretFields,
  };
  for (const key of Object.keys(hints)) {
    secretFields[key] = { isSet: false, lastFour: null };
  }
  return {
    fields: input.fields.map((field) =>
      Object.hasOwn(hints, field.key) ? { ...field, required: true } : field
    ),
    secretFields,
    hints,
  };
}

/** Parses the raw text of a number input; empty or unparsable text is `undefined`. */
export function parseNumberInput(text: string): number | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Splits a typed tag entry on commas into trimmed, non-empty, de-duplicated items. */
export function splitStringListEntry(
  entry: string,
  existing: readonly string[]
): string[] {
  const next = [...existing];
  for (const part of entry.split(",")) {
    const item = part.trim();
    if (item && !next.includes(item)) {
      next.push(item);
    }
  }
  return next;
}

/** Reads a field value as a string list, tolerating a malformed stored value. */
export function toStringList(value: unknown): string[] {
  const parsed = stringListSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Reads a field value as text, tolerating a malformed stored value. */
export function toFieldText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

const stringListSchema = z.array(z.string());
const httpUrlSchema = z.url({ protocol: /^https?$/ });
const emailSchema = z.email();

function getSecretReentryHints(
  input: SecretReentryInput
): Record<string, string> {
  const hints: Record<string, string> = {};
  const changedLabels = getChangedOriginLabels(input);
  if (changedLabels.length === 0) {
    return hints;
  }
  const reason = joinLabels(changedLabels);
  for (const field of getVisibleFields(input.fields, input.values)) {
    if (needsSecretReentry(field, input)) {
      hints[field.key] = `Re-enter ${field.label} because ${reason} changed`;
    }
  }
  return hints;
}

function getChangedOriginLabels({
  fields,
  values,
  storedConfig,
  credentialOriginFields,
}: SecretReentryInput): string[] {
  if (credentialOriginFields.length === 0) {
    return [];
  }
  const current = collectFieldValues(fields, values).config;
  const stored = collectFieldValues(
    fields,
    buildFieldValues(fields, storedConfig)
  ).config;
  return credentialOriginFields
    .filter((key) => !isSameJsonValue(current[key], stored[key]))
    .map((key) => fields.find((field) => field.key === key)?.label ?? key);
}

function needsSecretReentry(
  field: IntegrationFieldDescriptor,
  { values, secretFields }: SecretReentryInput
): boolean {
  return (
    field.kind === IntegrationFieldKind.Secret &&
    secretFields[field.key]?.isSet === true &&
    readFieldValue(field, values) !== REMOVED_SECRET_VALUE
  );
}

function isSameJsonValue(
  a: JsonValue | undefined,
  b: JsonValue | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "A", "A and B", "A, B and C". */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels.join("");
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The submitted value of a secret input: "" to remove, undefined to keep. */
function collectSecretValue(value: unknown): string | undefined {
  if (value === REMOVED_SECRET_VALUE) {
    return "";
  }
  const secret = typeof value === "string" ? value.trim() : "";
  return secret === "" ? undefined : secret;
}

function matchesCondition(
  condition: IntegrationFieldCondition,
  current: unknown
): boolean {
  const accepted = Array.isArray(condition.equals)
    ? condition.equals
    : [condition.equals];
  if (Array.isArray(current)) {
    return current.some((item) => accepted.includes(item));
  }
  return accepted.some((value) => value === current);
}

function validateField(
  field: IntegrationFieldDescriptor,
  value: unknown,
  options: ValidateIntegrationFieldsOptions
): string | null {
  if (field.kind === IntegrationFieldKind.Secret) {
    return validateSecret(field, value, options);
  }
  if (isEmptyValue(field.kind, value)) {
    return field.required ? REQUIRED_FIELD_MESSAGE : null;
  }
  return validateFormat(field.kind, value);
}

function validateSecret(
  field: IntegrationFieldDescriptor,
  value: unknown,
  options: ValidateIntegrationFieldsOptions
): string | null {
  const typed = typeof value === "string" ? value.trim() : "";
  if (typed || !field.required) {
    return null;
  }
  return options.secretFields?.[field.key]?.isSet
    ? null
    : REQUIRED_FIELD_MESSAGE;
}

function validateFormat(
  kind: IntegrationFieldKind,
  value: unknown
): string | null {
  switch (kind) {
    case IntegrationFieldKind.Number:
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : INVALID_NUMBER_MESSAGE;
    case IntegrationFieldKind.Url:
      return httpUrlSchema.safeParse(toFieldText(value).trim()).success
        ? null
        : INVALID_URL_MESSAGE;
    case IntegrationFieldKind.Email:
      return emailSchema.safeParse(toFieldText(value).trim()).success
        ? null
        : INVALID_EMAIL_MESSAGE;
    default:
      return null;
  }
}

/**
 * Whether a value counts as "not provided" for a required check. A boolean is
 * always provided (false is an answer); lists must be non-empty; text must be
 * non-blank.
 */
function isEmptyValue(kind: IntegrationFieldKind, value: unknown): boolean {
  switch (kind) {
    case IntegrationFieldKind.Boolean:
      return false;
    case IntegrationFieldKind.MultiSelect:
    case IntegrationFieldKind.StringList:
      return toStringList(value).length === 0;
    case IntegrationFieldKind.Number:
      return value === undefined || value === null || value === "";
    default:
      return toFieldText(value).trim() === "";
  }
}

/**
 * The JSON value submitted for a field. An empty text value is `undefined`
 * (left out of the config) rather than `""`, so an optional URL or select the
 * user left blank reads as "unset" to the provider schema instead of failing
 * its format check.
 */
function normalizeFieldValue(
  kind: IntegrationFieldKind,
  value: unknown
): JsonValue | undefined {
  switch (kind) {
    case IntegrationFieldKind.Boolean:
      return value === true;
    case IntegrationFieldKind.MultiSelect:
    case IntegrationFieldKind.StringList:
      return toStringList(value);
    case IntegrationFieldKind.Number:
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    case IntegrationFieldKind.Textarea:
    case IntegrationFieldKind.Template:
      return emptyToUndefined(toFieldText(value));
    default:
      return emptyToUndefined(toFieldText(value).trim());
  }
}

function emptyToUndefined(text: string): string | undefined {
  return text.trim() === "" ? undefined : text;
}
