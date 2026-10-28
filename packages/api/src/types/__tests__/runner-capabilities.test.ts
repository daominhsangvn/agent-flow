import { describe, expect, it } from "vitest";
import {
  parseRunnerCapabilitiesMarkdown,
  RunnerCommandMode,
  runnerCapabilitiesGitCredentialPath,
  runnerCapabilitiesRefreshRequestSchema,
  runnerCapabilitiesRefreshResultSchema,
} from "../runner-capabilities";

const NOT_YAML_RE = /not valid YAML/;
const NAME_PROBLEM_RE = /^commands\.0\.name: /;
const ATTACH_PROBLEM_RE = /^commands\.0\.attach\.0: /;
const MODE_PROBLEM_RE = /^commands\.0\.mode: /;

const FILE = `---
runner: Dev (LeaveDesk)
commands:
  - name: /plan-ticket
    args: <ticket-key>
    mode: write
    produces: plan
    needs: [prd]
    asks: true
  - name: /explain-code
    mode: read
    produces: answer
skills:
  - tdd
  - name: systematic-debugging
    description: Find the root cause first
---

# Dev runner

## /plan-ticket
Writes the plan.
`;

describe("parseRunnerCapabilitiesMarkdown", () => {
  it("reads the commands, skills and body", () => {
    const result = parseRunnerCapabilitiesMarkdown(FILE);
    expect(result).toEqual({
      ok: true,
      value: {
        runner: "Dev (LeaveDesk)",
        toolkit: null,
        commands: [
          {
            name: "/plan-ticket",
            args: "<ticket-key>",
            mode: RunnerCommandMode.Write,
            produces: "plan",
            needs: ["prd"],
            asks: true,
          },
          {
            name: "/explain-code",
            mode: RunnerCommandMode.Read,
            produces: "answer",
          },
        ],
        skills: [
          { name: "tdd" },
          {
            name: "systematic-debugging",
            description: "Find the root cause first",
          },
        ],
      },
      body: "# Dev runner\n\n## /plan-ticket\nWrites the plan.",
    });
  });

  it("accepts a front matter without commands", () => {
    const result = parseRunnerCapabilitiesMarkdown("---\nskills: [tdd]\n---\n");
    expect(result.ok && result.value.commands).toEqual([]);
  });

  it("refuses a file without front matter", () => {
    const result = parseRunnerCapabilitiesMarkdown("# Dev runner\n");
    expect(result.ok).toBe(false);
  });

  it("refuses YAML that does not parse", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      "---\ncommands: [\n---\nbody"
    );
    expect(!result.ok && result.problems[0]).toMatch(NOT_YAML_RE);
  });

  it("names the field of a schema problem", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      "---\ncommands:\n  - name: plan-ticket\n    mode: maybe\n---\n"
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toEqual([
      expect.stringMatching(NAME_PROBLEM_RE),
      expect.stringMatching(MODE_PROBLEM_RE),
    ]);
  });

  it("refuses a command listed twice", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      "---\ncommands:\n  - { name: /a, mode: read }\n  - { name: /a, mode: write }\n---\n"
    );
    expect(!result.ok && result.problems).toEqual([
      "commands: /a is listed twice",
    ]);
  });

  it("reads an auto runner's toolkit", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      "---\ntoolkit:\n  repository: workshop/leavedesk-knowledge\n  mounts: [.claude/agents, .claude/skills]\ncommands:\n  - { name: /ba-requirement, mode: read }\n---\n"
    );
    expect(result.ok && result.value.toolkit).toEqual({
      repository: "workshop/leavedesk-knowledge",
      mounts: [".claude/agents", ".claude/skills"],
    });
  });

  it("keeps the attach globs of a command", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      '---\ncommands:\n  - { name: /a, mode: write, attach: ["PRD-*.md", "evidence-*/*.png"] }\n---\n'
    );
    expect(result.ok && result.value.commands[0]?.attach).toEqual([
      "PRD-*.md",
      "evidence-*/*.png",
    ]);
  });

  it.each(["../x.md", "/abs.md"])("refuses the attach glob %s", (glob) => {
    const result = parseRunnerCapabilitiesMarkdown(
      `---\ncommands:\n  - { name: /a, mode: write, attach: ["${glob}"] }\n---\n`
    );
    expect(!result.ok && result.problems).toEqual([
      expect.stringMatching(ATTACH_PROBLEM_RE),
    ]);
  });

  it("refuses a toolkit mount outside the repository", () => {
    const result = parseRunnerCapabilitiesMarkdown(
      "---\ntoolkit:\n  repository: workshop/kb\n  mounts: [../secrets]\n---\n"
    );
    expect(result.ok).toBe(false);
  });
});

describe("capabilities refresh contract", () => {
  const request = {
    refreshId: "0b6f4f3e-5a52-4c3a-8d3e-0d6a8f1d2c11",
    projectId: "1c7a5a4f-6b63-4d4b-9e4f-1e7b9a2e3d22",
    repository: "workshop/leavedesk-knowledge",
    cloneUrl: "https://git.example.com/workshop/leavedesk-knowledge.git",
    defaultBranch: "main",
  };

  it("parses a valid request", () => {
    expect(
      runnerCapabilitiesRefreshRequestSchema.safeParse(request).success
    ).toBe(true);
  });

  it("rejects a non-uuid refreshId", () => {
    expect(
      runnerCapabilitiesRefreshRequestSchema.safeParse({
        ...request,
        refreshId: "nope",
      }).success
    ).toBe(false);
  });

  it("parses both result branches", () => {
    expect(
      runnerCapabilitiesRefreshResultSchema.safeParse({
        type: "result",
        ok: true,
        contentHash: "abc",
        warningCount: 0,
      }).success
    ).toBe(true);
    expect(
      runnerCapabilitiesRefreshResultSchema.safeParse({
        type: "result",
        ok: false,
        error: "boom",
      }).success
    ).toBe(true);
  });

  it("encodes the git credential path", () => {
    expect(runnerCapabilitiesGitCredentialPath("a b", "c")).toBe(
      "/compute-targets/a%20b/capabilities/refresh/c/git-credential"
    );
  });
});
