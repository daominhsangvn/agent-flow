"use client";

import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  type IntegrationSecretFieldState,
} from "@repo/api/src/types/integration";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useRef } from "react";
import {
  getVisibleFields,
  type IntegrationFieldErrors,
  type IntegrationFieldValues,
  type IntegrationSecretFieldStates,
  parseNumberInput,
  REMOVED_SECRET_VALUE,
  readFieldValue,
  toFieldText,
  toStringList,
} from "../lib/integration-field-values";
import { StringListInput } from "./string-list-input";
import {
  insertAtSelection,
  TemplateVariablesHelper,
} from "./template-variables-helper";

export type IntegrationFieldFormProps = {
  /** Descriptors served by the provider catalog (`GET /integrations/providers`). */
  fields: readonly IntegrationFieldDescriptor[];
  values: IntegrationFieldValues;
  onChange: (values: IntegrationFieldValues) => void;
  /** Per-field messages, keyed by descriptor key. */
  errors?: IntegrationFieldErrors;
  disabled?: boolean;
  /**
   * Secret state of an existing connection. When a secret is already set, its
   * input shows the last four characters and an empty value keeps it; an
   * optional one can also be removed.
   */
  secretFields?: IntegrationSecretFieldStates;
  /** Per-field notes shown under the control (e.g. why a secret must be re-entered). */
  notices?: Record<string, string>;
  /** Prefix for element ids, unique per form instance on the page. */
  idPrefix: string;
};

/**
 * Generic, descriptor-driven config form for integration connections,
 * workflow triggers and pre/post actions. Renders one control per
 * `IntegrationFieldKind`, honors `required`, `description`, `placeholder`,
 * `defaultValue` and `showWhen`, and edits a flat value map. Nothing here
 * knows about a specific provider.
 */
export function IntegrationFieldForm({
  fields,
  values,
  onChange,
  errors = {},
  disabled = false,
  secretFields,
  notices = {},
  idPrefix,
}: Readonly<IntegrationFieldFormProps>) {
  const visibleFields = getVisibleFields(fields, values);
  if (visibleFields.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {visibleFields.map((field) => (
        <IntegrationFieldRow
          disabled={disabled}
          error={errors[field.key]}
          field={field}
          inputId={`${idPrefix}-${field.key}`}
          key={field.key}
          notice={notices[field.key]}
          onValueChange={(next) => onChange({ ...values, [field.key]: next })}
          secretState={secretFields?.[field.key]}
          value={readFieldValue(field, values)}
        />
      ))}
    </div>
  );
}

type FieldControlProps = {
  field: IntegrationFieldDescriptor;
  inputId: string;
  value: unknown;
  onValueChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  secretState: IntegrationSecretFieldState | undefined;
};

type IntegrationFieldRowProps = Omit<
  FieldControlProps,
  "invalid" | "describedBy"
> & {
  error: string | undefined;
  notice: string | undefined;
};

function IntegrationFieldRow({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  error,
  notice,
  secretState,
}: Readonly<IntegrationFieldRowProps>) {
  const descriptionId = `${inputId}-description`;
  const noticeId = `${inputId}-notice`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [
      notice ? noticeId : null,
      field.description ? descriptionId : null,
      error ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const controlProps: FieldControlProps = {
    field,
    inputId,
    value,
    onValueChange,
    disabled,
    invalid: Boolean(error),
    describedBy,
    secretState,
  };
  const labelId = `${inputId}-label`;

  return (
    <div className="space-y-2" data-field-key={field.key}>
      {field.kind === IntegrationFieldKind.Boolean ? (
        <div className="flex items-center justify-between gap-4">
          <FieldLabel field={field} htmlFor={inputId} id={labelId} />
          <BooleanControl {...controlProps} />
        </div>
      ) : (
        <>
          <FieldLabel
            field={field}
            htmlFor={
              field.kind === IntegrationFieldKind.MultiSelect
                ? undefined
                : inputId
            }
            id={labelId}
          />
          <FieldControl {...controlProps} labelId={labelId} />
        </>
      )}
      {notice ? (
        <p
          className="font-medium text-warning-foreground text-xs"
          id={noticeId}
        >
          {notice}
        </p>
      ) : null}
      {field.description ? (
        <p className="text-muted-foreground text-xs" id={descriptionId}>
          {field.description}
        </p>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FieldLabel({
  field,
  htmlFor,
  id,
}: Readonly<{
  field: IntegrationFieldDescriptor;
  htmlFor: string | undefined;
  id: string;
}>) {
  return (
    <Label htmlFor={htmlFor} id={id}>
      {field.label}
      {field.required ? (
        <span aria-hidden="true" className="text-destructive">
          *
        </span>
      ) : null}
    </Label>
  );
}

function FieldControl(
  props: Readonly<FieldControlProps & { labelId: string }>
) {
  switch (props.field.kind) {
    case IntegrationFieldKind.Textarea:
      return <TextareaControl {...props} />;
    case IntegrationFieldKind.Template:
      return <TemplateControl {...props} />;
    case IntegrationFieldKind.Secret:
      return <SecretControl {...props} />;
    case IntegrationFieldKind.Number:
      return <NumberControl {...props} />;
    case IntegrationFieldKind.Select:
      return <SelectControl {...props} />;
    case IntegrationFieldKind.MultiSelect:
      return <MultiSelectControl {...props} />;
    case IntegrationFieldKind.StringList:
      return (
        <StringListInput
          describedBy={props.describedBy}
          disabled={props.disabled}
          id={props.inputId}
          invalid={props.invalid}
          onChange={props.onValueChange}
          placeholder={props.field.placeholder}
          value={toStringList(props.value)}
        />
      );
    default:
      return <TextControl {...props} />;
  }
}

function TextControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
}: Readonly<FieldControlProps>) {
  return (
    <Input
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      id={inputId}
      onChange={(event) => onValueChange(event.target.value)}
      placeholder={field.placeholder}
      type={TEXT_INPUT_TYPES.get(field.kind) ?? "text"}
      value={toFieldText(value)}
    />
  );
}

function TextareaControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
}: Readonly<FieldControlProps>) {
  return (
    <Textarea
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      id={inputId}
      onChange={(event) => onValueChange(event.target.value)}
      placeholder={field.placeholder}
      rows={4}
      value={toFieldText(value)}
    />
  );
}

function TemplateControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
}: Readonly<FieldControlProps>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The last caret/selection the user placed in the textarea. Null until they
  // interact with it, so a variable picked first is appended at the end rather
  // than prepended at the browser's default caret position 0.
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const text = toFieldText(value);

  const handleInsert = (placeholder: string) => {
    const selection = selectionRef.current;
    const next = insertAtSelection(
      text,
      placeholder,
      selection?.start ?? null,
      selection?.end ?? null
    );
    selectionRef.current = { start: next.caret, end: next.caret };
    onValueChange(next.value);
    // Restore the caret after React commits the new value.
    const element = textareaRef.current;
    globalThis.requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="space-y-1">
      <Textarea
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="font-mono text-sm"
        disabled={disabled}
        id={inputId}
        onChange={(event) => onValueChange(event.target.value)}
        onSelect={(event) => {
          selectionRef.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        placeholder={field.placeholder}
        ref={textareaRef}
        rows={5}
        value={text}
      />
      <TemplateVariablesHelper disabled={disabled} onInsert={handleInsert} />
    </div>
  );
}

/**
 * Write-only input. A stored secret shows its last four characters and an
 * empty input keeps it; a stored optional secret can also be removed, which
 * the form submits as "" (see `REMOVED_SECRET_VALUE`).
 */
function SecretControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
  secretState,
}: Readonly<FieldControlProps>) {
  const isStored = secretState?.isSet === true;
  const masked = `•••• ${secretState?.lastFour ?? ""}`;
  const canRemove = isStored && !field.required;

  if (canRemove && value === REMOVED_SECRET_VALUE) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
        <p className="text-muted-foreground text-xs">
          <span className="font-mono">{masked}</span> will be removed when you
          save.
        </p>
        <Button
          aria-label={`Keep ${field.label}`}
          disabled={disabled}
          onClick={() => onValueChange("")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Keep
        </Button>
      </div>
    );
  }

  const storedHint = isStored ? `${masked} - leave empty to keep` : undefined;
  return (
    <div className="space-y-1">
      <Input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="new-password"
        disabled={disabled}
        id={inputId}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={storedHint ?? field.placeholder}
        type="password"
        value={toFieldText(value)}
      />
      {storedHint ? (
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-muted-foreground text-xs">
            {storedHint}
          </p>
          {canRemove ? (
            <Button
              aria-label={`Remove ${field.label}`}
              className="h-7 px-2 text-xs"
              disabled={disabled}
              onClick={() => onValueChange(REMOVED_SECRET_VALUE)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NumberControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
}: Readonly<FieldControlProps>) {
  return (
    <Input
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      id={inputId}
      inputMode="numeric"
      onChange={(event) => onValueChange(parseNumberInput(event.target.value))}
      placeholder={field.placeholder}
      type="number"
      value={toFieldText(value)}
    />
  );
}

function BooleanControl({
  inputId,
  value,
  onValueChange,
  disabled,
  describedBy,
}: Readonly<FieldControlProps>) {
  return (
    <Switch
      aria-describedby={describedBy}
      checked={value === true}
      disabled={disabled}
      id={inputId}
      onCheckedChange={(checked) => onValueChange(checked)}
    />
  );
}

function SelectControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  invalid,
  describedBy,
}: Readonly<FieldControlProps>) {
  const selected = toFieldText(value);

  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        // Radix echoes "" from its hidden native select when a value and its
        // option appear in the same commit; options never have an empty value.
        if (next !== "") {
          onValueChange(next);
        }
      }}
      // Radix treats "" as "no selection" only through `undefined`.
      value={selected === "" ? undefined : selected}
    >
      <SelectTrigger
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="w-full"
        id={inputId}
      >
        <SelectValue placeholder={field.placeholder ?? "Select..."} />
      </SelectTrigger>
      <SelectContent>
        {(field.options ?? []).map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiSelectControl({
  field,
  inputId,
  value,
  onValueChange,
  disabled,
  describedBy,
  labelId,
}: Readonly<FieldControlProps & { labelId: string }>) {
  const selected = toStringList(value);
  const toggle = (optionValue: string, checked: boolean) => {
    const next = checked
      ? [...selected, optionValue]
      : selected.filter((item) => item !== optionValue);
    // Keep the descriptor's option order regardless of click order.
    const order = (field.options ?? []).map((option) => option.value);
    onValueChange(
      order
        .filter((item) => next.includes(item))
        .concat(next.filter((item) => !order.includes(item)))
    );
  };

  return (
    <fieldset
      aria-describedby={describedBy}
      aria-labelledby={labelId}
      className="m-0 grid min-w-0 gap-2 border-0 p-0 sm:grid-cols-2"
    >
      {(field.options ?? []).map((option) => {
        const optionId = `${inputId}-${option.value}`;
        return (
          <div className="flex items-center gap-2" key={option.value}>
            <Checkbox
              checked={selected.includes(option.value)}
              disabled={disabled}
              id={optionId}
              onCheckedChange={(checked) =>
                toggle(option.value, checked === true)
              }
            />
            <Label className="font-normal" htmlFor={optionId}>
              {option.label}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

const TEXT_INPUT_TYPES = new Map<IntegrationFieldKind, string>([
  [IntegrationFieldKind.Url, "url"],
  [IntegrationFieldKind.Email, "email"],
]);
