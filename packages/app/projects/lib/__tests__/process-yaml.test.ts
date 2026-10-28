import {
  ProcessDocumentType,
  ProcessStepType,
  type ProjectProcessInput,
} from "@repo/api/src/types/project-process";
import { YamlProblemSeverity } from "@repo/app/shared/lib/yaml-problems";
import { describe, expect, it } from "vitest";
import {
  parseProcessYaml,
  processToYaml,
  processYamlProblems,
  processYamlText,
  withoutProcessSource,
} from "../process-yaml";

const DRAFT: ProjectProcessInput = {
  toolkit: {
    repository: "brenock/ip-okf",
    mounts: [".claude/commands"],
    instructions: "",
  },
  steps: [
    {
      type: ProcessStepType.Agent,
      id: "analyze",
      name: "Analyze",
      instruction: "Read {{issue.file}}.\nWrite the analysis.",
      questions: "ask",
      artifacts: [],
      reply: null,
      document: {
        type: ProcessDocumentType.Doc,
        path: ".agentflow-ai/work/analysis.md",
        title: "",
      },
      finish: "none",
      timeoutMinutes: null,
    },
    {
      type: ProcessStepType.Approval,
      id: "review",
      name: "Review",
      show: ["analyze"],
    },
  ],
};

describe("processToYaml", () => {
  it("writes keys in a readable order, leaves defaults and empty values out, and keeps long text as a block", () => {
    expect(processToYaml(DRAFT)).toBe(
      [
        "toolkit:",
        "  repository: brenock/ip-okf",
        "  mounts:",
        "    - .claude/commands",
        "steps:",
        "  - type: agent",
        "    id: analyze",
        "    name: Analyze",
        "    instruction: |-",
        "      Read {{issue.file}}.",
        "      Write the analysis.",
        "    questions: ask",
        "    document:",
        "      type: DOC",
        "      path: .agentflow-ai/work/analysis.md",
        "    finish: none",
        "  - type: approval",
        "    id: review",
        "    name: Review",
        "    show:",
        "      - analyze",
        "",
      ].join("\n")
    );
  });

  it("round-trips: the YAML parses back to the same process", () => {
    const parsed = parseProcessYaml(processToYaml(DRAFT));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && processYamlProblems(processToYaml(DRAFT))).toEqual([]);
  });
});

describe("parseProcessYaml", () => {
  it("returns the draft with the text as its source", () => {
    const text =
      "# The BA flow\nsteps:\n  - type: agentflow.execute\n    id: run\n    name: Run\n";

    expect(parseProcessYaml(text)).toEqual({
      ok: true,
      draft: {
        steps: [{ type: "agentflow.execute", id: "run", name: "Run" }],
        source: text,
      },
    });
  });

  it("reports a syntax error with its line, without the library's position tail", () => {
    const parsed = parseProcessYaml(
      "steps:\n  - type: agent\n    id: a\n  bad: ["
    );

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toMatchObject({
      line: 4,
      severity: YamlProblemSeverity.Error,
      message: "All mapping items must start at the same column",
    });
  });

  it("refuses a document that is not a mapping", () => {
    const parsed = parseProcessYaml("- just a list");

    expect(!parsed.ok && parsed.problem.message).toContain(
      "mapping with steps:"
    );
  });
});

describe("processYamlProblems", () => {
  it("places a schema error on the value it is about", () => {
    const text =
      "steps:\n  - type: agent\n    id: a\n    name: A\n    instruction: x\n    questions: maybe\n";

    const [problem, ...rest] = processYamlProblems(text);

    expect(rest).toEqual([]);
    expect(problem).toMatchObject({
      line: 6,
      severity: YamlProblemSeverity.Error,
    });
    expect(text.slice(problem?.from, problem?.to)).toBe("maybe");
  });

  it("places a missing key on the first line of its step", () => {
    const text = "steps:\n  - type: agent\n    id: a\n    name: A\n";

    const problems = processYamlProblems(text);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(2);
    expect(problems[0]?.message).toBeTruthy();
  });

  it("warns about unknown keys the schema would drop, with the closest known key", () => {
    const text =
      "steps:\n  - type: agent\n    id: a\n    name: A\n    instrcution: x\n    instruction: y\n    document:\n      type: PRD\n      file: prd.md\n";

    const problems = processYamlProblems(text);

    expect(
      problems.map((problem) => [problem.severity, problem.message])
    ).toEqual([
      // document.path is missing
      [YamlProblemSeverity.Error, expect.any(String)],
      [
        YamlProblemSeverity.Warning,
        'Unknown key "instrcution" in step 1 - did you mean "instruction"?',
      ],
      [
        YamlProblemSeverity.Warning,
        'Unknown key "file" in the document of step 1',
      ],
    ]);
  });

  it("knows the plan and implement step's agent decisions, and rejects other values", () => {
    const process = (recommendations: string, review: string) =>
      `steps:\n  - type: agentflow.plan\n    id: plan\n    name: Plan\n    recommendations: ${recommendations}\n  - type: agentflow.execute\n    id: execute\n    name: Implement\n    review: ${review}\n`;

    expect(processYamlProblems(process("suggest", "fast"))).toEqual([]);
    expect(
      processYamlProblems(process("maybe", "quick")).map(
        (problem) => problem.severity
      )
    ).toEqual([YamlProblemSeverity.Error, YamlProblemSeverity.Error]);
  });

  it("knows an agent step's grant and keeps it in the draft", () => {
    const text =
      "steps:\n  - type: agent\n    id: triage\n    name: Triage\n    instruction: Triage the ticket.\n    connections:\n      source: [comment]\n      teams-release:\n        allow: [microsoft_teams.post_message]\n        approval: required\n";

    expect(processYamlProblems(text)).toEqual([]);
    const parsed = parseProcessYaml(text);
    expect(parsed.ok && parsed.draft.steps[0]).toMatchObject({
      connections: {
        source: ["comment"],
        "teams-release": {
          allow: ["microsoft_teams.post_message"],
          approval: "required",
        },
      },
    });
  });

  it("has no problems for a valid process", () => {
    expect(
      processYamlProblems(
        "steps:\n  - type: agentflow.plan\n    id: plan\n    name: Plan\n"
      )
    ).toEqual([]);
  });
});

describe("processYamlText", () => {
  it("shows the user's own YAML, comments kept, while it describes the draft", () => {
    const text = `# Requirement analysis\n${processToYaml(DRAFT)}`;
    const parsed = parseProcessYaml(text);
    if (!parsed.ok) {
      throw new Error("valid YAML expected");
    }

    expect(processYamlText(parsed.draft)).toBe(text);
  });

  it("keeps a text that does not parse, so the user can finish fixing it", () => {
    const broken = "steps:\n  - type: [";

    expect(processYamlText({ ...DRAFT, source: broken })).toBe(broken);
  });

  it("regenerates the YAML once the form changed the draft", () => {
    const text = `# old\n${processToYaml(DRAFT)}`;
    const renamed: ProjectProcessInput = {
      ...DRAFT,
      steps: DRAFT.steps.map((step) => ({ ...step, name: `${step.name}!` })),
      source: text,
    };

    expect(processYamlText(renamed)).toBe(
      processToYaml(withoutProcessSource(renamed))
    );
  });

  it("treats omitted defaults as equal to written ones", () => {
    const text =
      "steps:\n  - type: agentflow.plan\n    id: plan\n    name: Plan\n";
    const withDefault: ProjectProcessInput = {
      toolkit: null,
      steps: [
        {
          type: ProcessStepType.AgentFlowPlan,
          id: "plan",
          name: "Plan",
          questions: "ask",
        },
      ],
      source: text,
    };

    expect(processYamlText(withDefault)).toBe(text);
  });
});
