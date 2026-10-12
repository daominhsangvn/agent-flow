"use client";

import { WORKFLOW_TEMPLATE_VARIABLES } from "@repo/api/src/types/workflow";
import { Button } from "@repo/design-system/components/ui/button";
import { BracesIcon } from "lucide-react";
import { useId, useState } from "react";

export type TemplateVariablesHelperProps = {
  /** Called with the placeholder text to insert, e.g. `{{source.key}}`. */
  onInsert: (placeholder: string) => void;
  disabled?: boolean;
};

/**
 * Collapsible list of the `{{variable}}` placeholders a template field
 * accepts (`WORKFLOW_TEMPLATE_VARIABLES`). Clicking one inserts it at the
 * caret of the template textarea it belongs to.
 */
export function TemplateVariablesHelper({
  onInsert,
  disabled = false,
}: Readonly<TemplateVariablesHelperProps>) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <div className="space-y-2">
      <Button
        aria-controls={listId}
        aria-expanded={open}
        className="h-7 px-2 text-xs"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <BracesIcon className="size-3.5" />
        {open ? "Hide variables" : "Variables"}
      </Button>
      {open ? (
        <ul
          aria-label="Template variables"
          className="flex flex-wrap gap-1.5"
          id={listId}
        >
          {WORKFLOW_TEMPLATE_VARIABLES.map((variable) => (
            <li key={variable.name}>
              <button
                aria-label={`Insert ${variable.name}: ${variable.description}`}
                className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs hover:bg-muted disabled:opacity-50"
                disabled={disabled}
                onClick={() => onInsert(toPlaceholder(variable.name))}
                title={variable.description}
                type="button"
              >
                {toPlaceholder(variable.name)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `{{name}}` placeholder text for a template variable. */
export function toPlaceholder(name: string): string {
  return `{{${name}}}`;
}

/**
 * Inserts `text` into `value` over the `[start, end)` selection and returns
 * the new value plus the caret position right after the inserted text.
 */
export function insertAtSelection(
  value: string,
  text: string,
  start: number | null,
  end: number | null
): { value: string; caret: number } {
  const from = clampIndex(start ?? value.length, value.length);
  const to = clampIndex(end ?? from, value.length);
  const next = `${value.slice(0, from)}${text}${value.slice(Math.max(from, to))}`;
  return { value: next, caret: from + text.length };
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}
