"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import { XIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { splitStringListEntry } from "../lib/integration-field-values";

export type StringListInputProps = {
  id: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
};

/**
 * Tags input for `string_list` fields: Enter or a comma adds the typed text
 * (comma-separated text adds several items at once), blurring the input keeps
 * what was typed, and each chip has its own remove button. Duplicates and
 * blank items are ignored. Chips and input share one box, like the other
 * inputs of a form.
 */
export function StringListInput({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  invalid = false,
  describedBy,
}: Readonly<StringListInputProps>) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    if (draft.trim() === "") {
      setDraft("");
      return;
    }
    onChange(splitStringListEntry(draft, value));
    setDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  // One box holds the chips and the input, so committing the typed text on
  // blur (e.g. when the form's submit button is pressed) does not move what
  // is below: a chip appearing above the input used to push the button away
  // between mousedown and mouseup, and the click never submitted.
  return (
    <div
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input-border bg-input px-2 py-1 shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      {value.length > 0 ? (
        <ul aria-label="Added values" className="contents">
          {value.map((item) => (
            <li key={item}>
              <Badge className="gap-1 pr-1" variant="neutral">
                <span className="max-w-[16rem] truncate">{item}</span>
                <button
                  aria-label={`Remove ${item}`}
                  className="rounded-sm opacity-70 hover:opacity-100 disabled:pointer-events-none"
                  disabled={disabled}
                  onClick={() =>
                    onChange(value.filter((existing) => existing !== item))
                  }
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        disabled={disabled}
        id={id}
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          value.length > 0
            ? ""
            : (placeholder ?? "Type a value and press Enter")
        }
        value={draft}
      />
    </div>
  );
}
