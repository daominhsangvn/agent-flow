"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Input } from "@repo/design-system/components/ui/input";
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
 * blank items are ignored.
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

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul aria-label="Added values" className="flex flex-wrap gap-1.5">
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
      <Input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        id={id}
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Type a value and press Enter"}
        value={draft}
      />
    </div>
  );
}
