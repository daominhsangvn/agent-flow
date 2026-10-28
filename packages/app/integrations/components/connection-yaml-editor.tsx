"use client";

import { YamlCodeEditor } from "@repo/app/shared/components/yaml-code-editor";
import type { YamlCompletionResult } from "@repo/app/shared/lib/yaml-completion";
import type { YamlProblem } from "@repo/app/shared/lib/yaml-problems";
import { useRef } from "react";
import {
  type ConnectionYamlContext,
  connectionYamlProblems,
} from "../lib/connection-yaml";
import { connectionYamlCompletions } from "../lib/connection-yaml-completions";

export type ConnectionYamlEditorProps = {
  value: string;
  onChange: (text: string) => void;
  /** The provider whose settings are suggested and checked; read on every popup. */
  context: ConnectionYamlContext;
};

/**
 * A connection's settings as YAML in a code editor: the suggestion popup
 * offers the keys, the provider's settings and their allowed values, and the
 * problems are underlined as you type.
 */
export function ConnectionYamlEditor({
  value,
  onChange,
  context,
}: Readonly<ConnectionYamlEditorProps>) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const complete = useRef(
    (text: string, pos: number): YamlCompletionResult | null =>
      connectionYamlCompletions(text, pos, contextRef.current)
  ).current;
  const lint = useRef((text: string): YamlProblem[] =>
    connectionYamlProblems(text, contextRef.current)
  ).current;

  return (
    <YamlCodeEditor
      ariaLabel="Connection YAML"
      complete={complete}
      lint={lint}
      minHeight="12rem"
      onChange={onChange}
      testIdPrefix="connection-yaml"
      value={value}
    />
  );
}
