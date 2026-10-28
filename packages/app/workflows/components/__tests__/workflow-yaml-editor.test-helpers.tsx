import type { WorkflowYamlEditorProps } from "../workflow-yaml-editor";

/**
 * The workflow YAML editor as a plain textarea for jsdom tests: CodeMirror
 * needs a layout engine jsdom does not have. The real editor (suggestion
 * popup, underlined problems) is covered by e2e/workflow-yaml-editor.spec.ts.
 * Mock with:
 * vi.mock("<path>/workflow-yaml-editor", async () =>
 *   (await import("<path>/workflow-yaml-editor.test-helpers")).workflowYamlEditorModule)
 */
export function WorkflowYamlEditorStub({
  value,
  onChange,
  readOnly,
}: Readonly<WorkflowYamlEditorProps>) {
  return (
    <textarea
      aria-label="Workflow YAML"
      onChange={(event) => onChange(event.target.value)}
      readOnly={readOnly}
      value={value}
    />
  );
}

export const workflowYamlEditorModule = {
  WorkflowYamlEditor: WorkflowYamlEditorStub,
};
