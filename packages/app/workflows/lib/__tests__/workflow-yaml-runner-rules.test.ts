import { YamlProblemSeverity } from "@repo/app/shared/lib/yaml-problems";
import { describe, expect, it } from "vitest";
import {
  JIRA_ISSUE_ASSIGNED,
  makeProjectConnections,
  PROVIDERS,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  COMPUTE_TARGET_ID,
  makeWorkflow,
  PROJECT_ID,
  RUN_AS_USER_ID,
} from "../../__tests__/workflow-fixtures";
import { parseWorkflowYaml } from "../workflow-yaml";
import type { WorkflowYamlCatalog } from "../workflow-yaml-schema";
import { workflowToYaml } from "../workflow-yaml-write";

const AN_RUNNER_ID = "34343434-3434-4343-8343-343434343434";
const BINH_RUNNER_ID = "56565656-5656-4565-8565-565656565656";
const AN_CONDITION = 'source.assignee_email == "an@acme.dev"';

const CATALOG: WorkflowYamlCatalog = {
  providers: PROVIDERS,
  projectConnections: makeProjectConnections(PROJECT_ID),
  projects: [{ id: PROJECT_ID, name: "Web" }],
  users: [{ id: RUN_AS_USER_ID, name: "Ada Admin", email: "ada@acme.dev" }],
  runners: [
    { id: COMPUTE_TARGET_ID, label: "runner-1", isOnline: true },
    { id: AN_RUNNER_ID, label: "an-PRO-1", isOnline: true },
    { id: BINH_RUNNER_ID, label: "binh-PRO-1", isOnline: false },
  ],
};

function workflowYaml(runners: string): string {
  return `name: Dev
project: Web
triggers:
  - connection: acme-jira
    type: ${JIRA_ISSUE_ASSIGNED}
    config:
      projectKeys: [PROJ]
      label: ai
agent:
  runner: runner-1
${runners}`;
}

describe("agent.runners", () => {
  it("turns each rule's runner name into its id and keeps the condition", () => {
    const { input, problems } = parseWorkflowYaml(
      workflowYaml(`  runners:
    - runner: an-PRO-1
      condition: ${AN_CONDITION}
    - runner: binh-PRO-1
      condition: source.labels contains "qa"
`),
      CATALOG
    );

    expect(problems).toEqual([
      expect.objectContaining({
        line: 14,
        severity: YamlProblemSeverity.Warning,
      }),
    ]);
    expect(input?.agent.computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(input?.agent.runners).toEqual([
      { computeTargetId: AN_RUNNER_ID, condition: AN_CONDITION },
      {
        computeTargetId: BINH_RUNNER_ID,
        condition: 'source.labels contains "qa"',
      },
    ]);
  });

  it("reports an unknown runner, a broken condition and an unknown key on their lines", () => {
    const { input, problems } = parseWorkflowYaml(
      workflowYaml(`  runners:
    - runner: nobody
      condition: ${AN_CONDITION}
    - runner: an-PRO-1
      condition: source.user == "x"
      when: always
`),
      CATALOG
    );

    expect(input).toBeNull();
    expect(problems.map((problem) => problem.line)).toEqual(
      expect.arrayContaining([12, 15, 16])
    );
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      'Unknown field "source.user"'
    );
  });

  it("without rules saves none", () => {
    const { input } = parseWorkflowYaml(workflowYaml(""), CATALOG);

    expect(input?.agent.runners).toEqual([]);
  });

  it("writes the rules with runner names and reads them back", () => {
    const base = makeWorkflow();
    const workflow = {
      ...base,
      agent: {
        ...base.agent,
        runners: [{ computeTargetId: AN_RUNNER_ID, condition: AN_CONDITION }],
      },
    };

    const text = workflowToYaml(workflow, CATALOG);

    expect(text).toContain("  runners:\n    - runner: an-PRO-1\n");
    const { input } = parseWorkflowYaml(text, CATALOG, workflow);
    expect(input?.agent.runners).toEqual([
      { computeTargetId: AN_RUNNER_ID, condition: AN_CONDITION },
    ]);
  });
});
