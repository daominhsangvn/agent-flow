import { parseRunnerCapabilitiesMarkdown } from "@repo/api/src/types/runner-capabilities";
import { describe, expect, it } from "vitest";
import { serverCapabilityWarnings } from "@/app/compute-targets/capabilities-warnings";

const CLEAN =
  '---\ncommands:\n  - { name: /ba-requirement, mode: read, args: "<ticket-key>", attach: ["PRD-*.md"] }\n---\n# Dev\n';

function warn(content: string): string[] {
  return serverCapabilityWarnings(
    content,
    parseRunnerCapabilitiesMarkdown(content)
  );
}

describe("serverCapabilityWarnings", () => {
  it("names the line of a GitHub token, never the value", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const warnings = warn(`${CLEAN}\nnote: ${token}\n`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("line 7");
    expect(warnings[0]).toContain("(gh");
    expect(warnings[0]).not.toContain(token);
  });

  it("flags a generic credential assignment", () => {
    expect(warn(`${CLEAN}password: hunter2hunter2x\n`)[0]).toContain(
      "(credential)"
    );
  });

  it("stays silent for env references and plain words", () => {
    expect(warn(`${CLEAN}secret: process.env.GITHUB_WEBHOOK_SECRET\n`)).toEqual(
      []
    );
    expect(warn(`${CLEAN}token: $GITHUB_TOKEN_VALUE_X\n`)).toEqual([]);
    expect(warn(`${CLEAN}token: \${GITHUB_TOKEN_VALUE}\n`)).toEqual([]);
    expect(warn(`${CLEAN}token: enabled_for_all_repos\n`)).toEqual([]);
  });

  it("still flags a real-looking secret value", () => {
    expect(warn(`${CLEAN}api_key: Zx9fQ2mK7pL4vB8nR3tY\n`)[0]).toContain(
      "(credential)"
    );
  });

  it("flags a private key header", () => {
    expect(warn(`${CLEAN}-----BEGIN OPENSSH PRIVATE KEY-----\n`)[0]).toContain(
      "(private key)"
    );
  });

  it("has no warning for a clean file", () => {
    expect(warn(CLEAN)).toEqual([]);
  });

  it("warns when a read command declares push", () => {
    const content =
      "---\ncommands:\n  - { name: /look, mode: read, push: true }\n---\n";
    expect(warn(content)).toEqual([
      "/look: push is ignored for a read command (mode: read changes nothing).",
    ]);
  });

  it("caps the secret warnings at 10", () => {
    const lines = Array.from(
      { length: 15 },
      () => "password: hunter2hunter2x"
    ).join("\n");
    expect(warn(lines)).toHaveLength(10);
  });
});
