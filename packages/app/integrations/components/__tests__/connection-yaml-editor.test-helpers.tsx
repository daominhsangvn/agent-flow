import type { ConnectionYamlEditorProps } from "../connection-yaml-editor";

/**
 * The connection YAML editor as a plain textarea for jsdom tests: CodeMirror
 * needs a layout engine jsdom does not have. Mock with:
 * vi.mock("<path>/connection-yaml-editor", async () =>
 *   (await import("<path>/connection-yaml-editor.test-helpers")).connectionYamlEditorModule)
 */
export function ConnectionYamlEditorStub({
  value,
  onChange,
}: Readonly<ConnectionYamlEditorProps>) {
  return (
    <textarea
      aria-label="Connection YAML"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  );
}

export const connectionYamlEditorModule = {
  ConnectionYamlEditor: ConnectionYamlEditorStub,
};
