"use client";

import { YamlCodeEditor } from "@repo/app/shared/components/yaml-code-editor";
import type { YamlCompletionResult } from "@repo/app/shared/lib/yaml-completion";
import type { YamlProblem } from "@repo/app/shared/lib/yaml-problems";
import { useRef } from "react";
import { workflowYamlProblems } from "../lib/workflow-yaml";
import {
  type WorkflowCompletionData,
  workflowYamlCompletions,
} from "../lib/workflow-yaml-completions";

export type WorkflowYamlEditorProps = {
  value: string;
  onChange: (text: string) => void;
  /** What the suggestions offer and the problems resolve against; read on every popup. */
  completionData: WorkflowCompletionData;
  readOnly?: boolean;
};

/**
 * The workflow as YAML in a code editor: the suggestion popup offers what
 * fits where the cursor is (keys, connections, trigger and action types and
 * their options, projects, runners, users, run events, template variables)
 * and the problems are underlined as you type.
 */
export function WorkflowYamlEditor({
  value,
  onChange,
  completionData,
  readOnly = false,
}: Readonly<WorkflowYamlEditorProps>) {
  const dataRef = useRef(completionData);
  dataRef.current = completionData;
  const complete = useRef(
    (text: string, pos: number): YamlCompletionResult | null =>
      workflowYamlCompletions(text, pos, dataRef.current)
  ).current;
  const lint = useRef((text: string): YamlProblem[] =>
    workflowYamlProblems(text, dataRef.current)
  ).current;

  return (
    <YamlCodeEditor
      ariaLabel="Workflow YAML"
      complete={complete}
      lint={lint}
      minHeight="28rem"
      onChange={onChange}
      readOnly={readOnly}
      testIdPrefix="workflow-yaml"
      value={value}
    />
  );
}
