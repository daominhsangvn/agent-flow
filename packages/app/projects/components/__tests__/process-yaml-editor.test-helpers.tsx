import type { ProcessYamlEditorProps } from "../process-yaml-editor";

/**
 * The process YAML editor as a plain textarea for jsdom tests: CodeMirror
 * needs a layout engine jsdom does not have. The real editor (suggestion
 * popup, underlined problems) is covered by e2e/project-process.spec.ts.
 * Mock with:
 * vi.mock("<path>/process-yaml-editor", async () =>
 *   (await import("<path>/process-yaml-editor.test-helpers")).processYamlEditorModule)
 */
export function ProcessYamlEditorStub({
  value,
  onChange,
}: Readonly<ProcessYamlEditorProps>) {
  return (
    <textarea
      aria-label="Process YAML"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  );
}

export const processYamlEditorModule = {
  ProcessYamlEditor: ProcessYamlEditorStub,
};
