"use client";

import { YamlCodeEditor } from "@repo/app/shared/components/yaml-code-editor";
import type { YamlCompletionResult } from "@repo/app/shared/lib/yaml-completion";
import { YamlCursorKind } from "@repo/app/shared/lib/yaml-cursor";
import { useRef } from "react";
import { processYamlProblems } from "../lib/process-yaml";
import {
  type ProcessCompletionData,
  processYamlCompletions,
  yamlCursorContext,
} from "../lib/process-yaml-completions";

export type ProcessYamlEditorProps = {
  value: string;
  onChange: (text: string) => void;
  /** Repositories and step ids the suggestions offer; read on every popup. */
  completionData: ProcessCompletionData;
  readOnly?: boolean;
};

/**
 * The process as YAML in a code editor: syntax colors, line numbers, the
 * suggestion popup (keys of the mapping under the cursor, allowed values,
 * the project's repositories, step ids, instruction variables, step
 * snippets; Ctrl+Space opens it anywhere) and the problems underlined as
 * you type. The editor owns its text; `value` replaces it only when it
 * changes from outside (a preset, a restored version).
 */
export function ProcessYamlEditor({
  value,
  onChange,
  completionData,
  readOnly = false,
}: Readonly<ProcessYamlEditorProps>) {
  const dataRef = useRef(completionData);
  dataRef.current = completionData;
  const complete = useRef(
    (text: string, pos: number): YamlCompletionResult | null => {
      const cursor = yamlCursorContext(text, pos);
      if (!cursor) {
        return null;
      }
      return {
        from: cursor.from,
        options: processYamlCompletions(cursor, dataRef.current),
        variable: cursor.kind === YamlCursorKind.Variable,
      };
    }
  ).current;

  return (
    <YamlCodeEditor
      ariaLabel="Process YAML"
      complete={complete}
      lint={processYamlProblems}
      onChange={onChange}
      readOnly={readOnly}
      testIdPrefix="process-yaml"
      value={value}
    />
  );
}
