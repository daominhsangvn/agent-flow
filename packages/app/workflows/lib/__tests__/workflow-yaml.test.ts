import {
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "@repo/api/src/types/orchestrator";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type Workflow,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { WORKFLOW_EMAIL_ACTION_TYPE } from "@repo/api/src/types/workflow-email";
import { YamlProblemSeverity } from "@repo/app/shared/lib/yaml-problems";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  JIRA_ISSUE_LABELED,
  JIRA_ISSUE_STATUS_CHANGED,
  JIRA_KEY,
  JIRA_TRANSITION_ISSUE,
  makeProjectConnections,
  PROVIDERS,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  ACTION_ID,
  COMPUTE_TARGET_ID,
  makeSaveWorkflowInput,
  makeWorkflow,
  PRE_ACTION_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
  TRIGGER_ID,
} from "../../__tests__/workflow-fixtures";
import { parseWorkflowYaml } from "../workflow-yaml";
import {
  BUILT_IN_HTTP_REFERENCE,
  type WorkflowYamlCatalog,
} from "../workflow-yaml-schema";
import { newWorkflowYaml, workflowToYaml } from "../workflow-yaml-write";

const RUNNER_NAME = "runner-1";
const OTHER_PROJECT_ID = "12121212-1212-4121-8121-121212121212";

const CATALOG: WorkflowYamlCatalog = {
  providers: PROVIDERS,
  projectConnections: makeProjectConnections(PROJECT_ID),
  projects: [{ id: PROJECT_ID, name: "Web" }],
  users: [{ id: RUN_AS_USER_ID, name: "Ada Admin", email: "ada@acme.dev" }],
  runners: [{ id: COMPUTE_TARGET_ID, label: RUNNER_NAME, isOnline: true }],
};

/** A valid workflow YAML; tests change one line of it. */
const VALID_YAML = `name: Implement Jira requirements
project: Web
triggers:
  - connection: acme-jira
    type: ${JIRA_ISSUE_ASSIGNED}
    config:
      projectKeys: [PROJ]
      label: ai
agent:
  runner: ${RUNNER_NAME}
  mode: plan
actions:
  - on: workflow.triggered
    connection: acme-jira
    type: ${JIRA_TRANSITION_ISSUE}
    continueOnError: true
    config:
      transition: In Progress
  - on: [workflow.failed, workflow.completed]
    connection: delivery
    type: ${TEAMS_POST_MESSAGE}
`;

function problemsOf(text: string, catalog = CATALOG) {
  return parseWorkflowYaml(text, catalog).problems.map((problem) => ({
    line: problem.line,
    message: problem.message,
    severity: problem.severity,
  }));
}

describe("parseWorkflowYaml", () => {
  it("turns names into the ids of the save body", () => {
    const { input, problems } = parseWorkflowYaml(VALID_YAML, CATALOG);

    expect(problems).toEqual([]);
    expect(input).toEqual({
      name: "Implement Jira requirements",
      description: "",
      enabled: true,
      projectId: PROJECT_ID,
      agent: {
        mode: WorkflowAgentMode.Plan,
        stopOnOpenQuestions: true,
        computeTargetId: COMPUTE_TARGET_ID,
        runners: [],
        repository: null,
        prd: { instruction: null },
        instructions: "",
        titleTemplate: "{{source.key}}: {{source.title}}",
        process: null,
      },
      triggers: [
        {
          connectionKey: JIRA_KEY,
          type: JIRA_ISSUE_ASSIGNED,
          config: { projectKeys: ["PROJ"], label: "ai" },
          enabled: true,
        },
      ],
      actions: [
        {
          connectionKey: JIRA_KEY,
          automaticConnection: false,
          type: JIRA_TRANSITION_ISSUE,
          config: { transition: "In Progress" },
          stage: WorkflowActionStage.Pre,
          events: [],
          continueOnError: true,
          enabled: true,
        },
        {
          connectionKey: TEAMS_KEY,
          automaticConnection: false,
          type: TEAMS_POST_MESSAGE,
          config: { message: "{{summary}}" },
          stage: WorkflowActionStage.Post,
          // Lifecycle order, whatever order the YAML lists them in.
          events: [WorkflowRunEvent.Succeeded, WorkflowRunEvent.Failed],
          continueOnError: false,
          enabled: true,
        },
      ],
    });
  });

  it("accepts ids, names in any case, and the run-as user's email", () => {
    const text = VALID_YAML.replace(
      "project: Web",
      `project: ${PROJECT_ID}`
    ).replace(
      `runner: ${RUNNER_NAME}`,
      "runner: RUNNER-1\n  runAs: ADA@acme.dev"
    );

    const { input } = parseWorkflowYaml(text, CATALOG);

    expect(input?.projectId).toBe(PROJECT_ID);
    expect(input?.runAsUserId).toBe(RUN_AS_USER_ID);
    expect(input?.agent.computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(input?.actions[1]?.connectionKey).toBe(TEAMS_KEY);
  });

  it("places each reference problem on its line and lists what exists", () => {
    const slack = VALID_YAML.replace(
      "connection: delivery",
      "connection: Slack"
    );
    const mobile = VALID_YAML.replace("project: Web", "project: Mobile");

    expect(problemsOf(slack)).toEqual([
      {
        line: 20,
        message:
          'Web has no action connection "Slack". Keys: http, acme-jira, delivery. Add connections on the project\'s Integrations tab.',
        severity: YamlProblemSeverity.Error,
      },
    ]);
    expect(problemsOf(mobile)[0]).toEqual({
      line: 2,
      message: 'No project "Mobile". Available: Web',
      severity: YamlProblemSeverity.Error,
    });
    expect(parseWorkflowYaml(slack, CATALOG).input).toBeNull();
  });

  it("resolves keys in a trigger's own project", () => {
    const catalog: WorkflowYamlCatalog = {
      ...CATALOG,
      projects: [...CATALOG.projects, { id: OTHER_PROJECT_ID, name: "Shop" }],
    };
    const text = VALID_YAML.replace(
      "  - connection: acme-jira\n    type: jira.issue_assigned",
      "  - project: Shop\n    connection: acme-jira\n    type: jira.issue_assigned"
    );

    expect(problemsOf(text, catalog)[0]?.message).toBe(
      'Shop has no trigger connection "acme-jira". Keys: http. Add connections on the project\'s Integrations tab.'
    );
    const withShop = {
      ...catalog,
      projectConnections: [
        ...catalog.projectConnections,
        ...makeProjectConnections(OTHER_PROJECT_ID),
      ],
    };
    expect(parseWorkflowYaml(text, withShop).input?.triggers[0]).toMatchObject({
      projectId: OTHER_PROJECT_ID,
      connectionKey: JIRA_KEY,
    });
  });

  it("only accepts the types the connection's provider offers", () => {
    // The key names the connection in messages.
    const text = VALID_YAML.replace(
      `type: ${JIRA_ISSUE_ASSIGNED}`,
      `type: ${TEAMS_POST_MESSAGE}`
    );

    expect(problemsOf(text)).toEqual([
      {
        line: 5,
        message: `${TEAMS_POST_MESSAGE} is not a trigger of ${JIRA_KEY} (Jira). Types: ${JIRA_ISSUE_ASSIGNED}, ${JIRA_ISSUE_STATUS_CHANGED}, ${JIRA_ISSUE_LABELED}`,
        severity: YamlProblemSeverity.Error,
      },
    ]);
  });

  it("checks the options against the type's fields", () => {
    const text = VALID_YAML.replace("      label: ai\n", "      labels: [ai]\n")
      .replace("projectKeys: [PROJ]", "projectKeys: PROJ")
      .replace("      transition: In Progress\n", "");

    const problems = problemsOf(text);

    expect(problems).toEqual(
      expect.arrayContaining([
        {
          line: 7,
          message: "projectKeys is a list, e.g. [value]",
          severity: YamlProblemSeverity.Error,
        },
        {
          line: 8,
          message: 'Unknown option "labels". Options: projectKeys, label',
          severity: YamlProblemSeverity.Warning,
        },
        {
          line: 6,
          message:
            "Add the option label (Required label): This field is required",
          severity: YamlProblemSeverity.Error,
        },
        {
          line: 17,
          message:
            "Add the option transition (Transition): This field is required",
          severity: YamlProblemSeverity.Error,
        },
      ])
    );
  });

  it("runs workflow.triggered alone and asks for an event", () => {
    const mixed = VALID_YAML.replace(
      "on: [workflow.failed, workflow.completed]",
      "on: [workflow.triggered, workflow.failed]"
    );
    const withoutOn = VALID_YAML.replace(
      "  - on: [workflow.failed, workflow.completed]\n    connection:",
      "  - connection:"
    );

    expect(problemsOf(mixed)).toEqual([
      {
        line: 19,
        message:
          "workflow.triggered runs before the agent team: give it its own action",
        severity: YamlProblemSeverity.Error,
      },
    ]);
    expect(problemsOf(withoutOn)[0]?.message).toBe(
      "Write the run event, or a list of them, e.g. execute.completed or [workflow.completed, workflow.failed]"
    );
  });

  it("still reads the old run.* event names", () => {
    const text = VALID_YAML.replace(
      "on: [workflow.failed, workflow.completed]",
      "on: [run.failed, run.succeeded]"
    );

    const { input, problems } = parseWorkflowYaml(text, CATALOG);

    expect(problems).toEqual([]);
    expect(input?.actions[1]?.events).toEqual([
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
  });

  it("reads instructions, and actions that leave the connection to the run", () => {
    const text = VALID_YAML.replace(
      "actions:\n",
      `actions:
  - on: workflow.triggered
    instruction: Move {{source.key}} to In Progress.
  - on: execute.completed
    instruction: |
      Summarize what was implemented
      and comment on the issue.
    connections:
      source: [comment]
  - on: workflow.completed
    type: ${JIRA_ADD_COMMENT}
`
    );

    const { input, problems } = parseWorkflowYaml(text, CATALOG);

    expect(problems).toEqual([]);
    expect(input?.actions.slice(0, 3)).toEqual([
      {
        connectionKey: null,
        automaticConnection: true,
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        config: { instruction: "Move {{source.key}} to In Progress." },
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: false,
        enabled: true,
      },
      {
        connectionKey: null,
        automaticConnection: true,
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        config: {
          instruction:
            "Summarize what was implemented\nand comment on the issue.",
          connections: { source: ["comment"] },
        },
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.ExecuteCompleted],
        continueOnError: false,
        enabled: true,
      },
      {
        connectionKey: null,
        automaticConnection: true,
        type: JIRA_ADD_COMMENT,
        config: { body: "{{summary}}" },
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
      },
    ]);
  });

  it("reads an email action, sent without a connection", () => {
    const text = VALID_YAML.replace(
      "actions:\n",
      `actions:
  - on: input.needed
    type: ${WORKFLOW_EMAIL_ACTION_TYPE}
    config:
      to: [ada@acme.dev]
      subject: "{{source.key}} needs you"
`
    );

    const { input, problems } = parseWorkflowYaml(text, CATALOG);

    expect(problems).toEqual([]);
    expect(input?.actions[0]).toEqual({
      connectionKey: null,
      automaticConnection: true,
      type: WORKFLOW_EMAIL_ACTION_TYPE,
      config: {
        to: ["ada@acme.dev"],
        cc: [],
        subject: "{{source.key}} needs you",
      },
      stage: WorkflowActionStage.Post,
      events: [WorkflowRunEvent.NeedsInput],
      continueOnError: false,
      enabled: true,
    });
  });

  it("marks an email's connection, missing recipients and invalid addresses", () => {
    const email = (lines: string) =>
      VALID_YAML.replace(
        "actions:\n",
        `actions:\n  - on: input.needed\n    type: ${WORKFLOW_EMAIL_ACTION_TYPE}\n${lines}`
      );

    expect(
      problemsOf(
        email(
          "    connection: acme-jira\n    config:\n      to: [ada@acme.dev]\n"
        )
      )[0]?.message
    ).toBe("AgentFlow sends the email itself: leave out connection:");
    expect(
      problemsOf(email("    config:\n      subject: Hi\n"))[0]?.message
    ).toContain("Add the option to (To)");
    expect(
      problemsOf(email("    config:\n      to: [ada]\n"))[0]
    ).toMatchObject({
      line: 16,
      message: "Write each recipient as an email address",
    });
  });

  it("asks for an instruction or a type, and keeps instructions off the HTTPS call", () => {
    const both = VALID_YAML.replace(
      "  - on: workflow.triggered\n",
      "  - on: workflow.triggered\n    instruction: Do it.\n"
    );
    const onHttp = VALID_YAML.replace(
      "actions:\n",
      `actions:\n  - on: workflow.failed\n    connection: ${BUILT_IN_HTTP_REFERENCE}\n    instruction: Tell someone.\n`
    );

    expect(problemsOf(both).map((problem) => problem.message)).toContain(
      "Give the action an instruction, or a type with its config (not both)"
    );
    expect(problemsOf(onHttp)[0]?.message).toBe(
      "An instruction works on the run's source item: list other connections under connections:"
    );
  });

  it("still reads preActions and postActions, with a warning", () => {
    const text = `${VALID_YAML.replace(ACTIONS_LIST_RE, "")}preActions:
  - connection: acme-jira
    type: ${JIRA_TRANSITION_ISSUE}
    config:
      transition: In Progress
postActions:
  - connection: delivery
    type: ${TEAMS_POST_MESSAGE}
    events: [run.succeeded]
`;

    const { input, problems } = parseWorkflowYaml(text, CATALOG);

    expect(problems.map((problem) => problem.severity)).toEqual([
      YamlProblemSeverity.Warning,
      YamlProblemSeverity.Warning,
    ]);
    expect(problems[0]?.message).toBe(
      "preActions is the older form: write these under actions: with on: workflow.triggered"
    );
    expect(input?.actions.map((action) => action.stage)).toEqual([
      WorkflowActionStage.Pre,
      WorkflowActionStage.Post,
    ]);
  });

  it("warns about unknown keys with the closest known one", () => {
    const text = VALID_YAML.replace("  mode: plan", "  mdoe: plan");

    expect(problemsOf(text)).toEqual([
      {
        line: 11,
        message: 'Unknown key "mdoe" in agent - did you mean "mode"?',
        severity: YamlProblemSeverity.Warning,
      },
    ]);
    // A warning does not stop the save; the default mode applies.
    expect(parseWorkflowYaml(text, CATALOG).input?.agent.mode).toBe(
      WorkflowAgentMode.PlanAndExecute
    );
  });

  it("reads the PRD instruction; without one every item is an Issue", () => {
    const prdOf = (lines: string) =>
      parseWorkflowYaml(withAgentLines(lines), CATALOG).input?.agent.prd;

    expect(
      prdOf("  prd:\n    instruction: PRD when the item is labelled PRD.\n")
    ).toEqual({ instruction: "PRD when the item is labelled PRD." });
    expect(
      prdOf(
        "  prd:\n    instruction: |\n      PRD when the type is Feature\n      and it has the label PRD.\n"
      )
    ).toEqual({
      instruction: "PRD when the type is Feature\nand it has the label PRD.",
    });
    // An empty prd: or instruction: is no instruction.
    expect(prdOf("  prd:\n")).toEqual({ instruction: null });
    expect(prdOf("  prd:\n    instruction:\n")).toEqual({ instruction: null });
  });

  it("checks the PRD instruction and the keys of agent.prd", () => {
    const text = withAgentLines(
      "  prd:\n    instruction: [PRD]\n    instrution: PRD\n"
    );

    expect(problemsOf(text)).toEqual([
      {
        line: 13,
        message: "Write the instruction as text",
        severity: YamlProblemSeverity.Error,
      },
      {
        line: 14,
        message:
          'Unknown key "instrution" in agent.prd - did you mean "instruction"?',
        severity: YamlProblemSeverity.Warning,
      },
    ]);
  });

  it("reports YAML syntax errors where they are", () => {
    const problems = problemsOf("name: [unclosed\ntriggers:\n  - x\n");

    expect(problems[0]?.severity).toBe(YamlProblemSeverity.Error);
    expect(parseWorkflowYaml("name: [unclosed", CATALOG).input).toBeNull();
  });

  it("asks for the agent mapping and a trigger", () => {
    const messages = problemsOf("name: Empty\ntriggers: []\n").map(
      (problem) => problem.message
    );

    // In text order: a missing mapping is marked at the top of the document.
    expect(messages).toEqual([
      "Add the agent: mapping (runner, mode, …)",
      "Add at least one trigger",
    ]);
  });

  it("warns when the runner is offline, without blocking the save", () => {
    const catalog = {
      ...CATALOG,
      runners: [{ id: COMPUTE_TARGET_ID, label: RUNNER_NAME, isOnline: false }],
    };

    const result = parseWorkflowYaml(VALID_YAML, catalog);

    expect(result.problems).toEqual([
      expect.objectContaining({
        line: 10,
        severity: YamlProblemSeverity.Warning,
        message: `${RUNNER_NAME} is offline: runs start only while it is online`,
      }),
    ]);
    expect(result.input).not.toBeNull();
  });

  it("validates the workflow's own process like a project's", () => {
    const valid = `${VALID_YAML.replace(
      "  mode: plan\n",
      "  mode: plan\n  process:\n    steps:\n      - type: agent\n        id: answer\n        name: Answer\n        instruction: Reply\n"
    )}`;
    const invalid = valid.replace(
      "        id: answer\n",
      "        id: Bad Id\n"
    );

    expect(
      parseWorkflowYaml(valid, CATALOG).input?.agent.process?.steps
    ).toEqual([expect.objectContaining({ id: "answer", name: "Answer" })]);
    const problems = problemsOf(invalid);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      line: 15,
      severity: YamlProblemSeverity.Error,
    });
  });

  it("names a connection the built-in http, which starts no connection", () => {
    const text = VALID_YAML.replace(
      `  - connection: acme-jira\n    type: ${JIRA_ISSUE_ASSIGNED}\n    config:\n      projectKeys: [PROJ]\n      label: ai\n`,
      `  - connection: ${BUILT_IN_HTTP_REFERENCE}\n    type: ${WEBHOOK_REQUEST}\n`
    );

    expect(parseWorkflowYaml(text, CATALOG).input?.triggers).toEqual([
      { connectionKey: null, type: WEBHOOK_REQUEST, config: {}, enabled: true },
    ]);
  });
});

describe("workflowToYaml", () => {
  it("round-trips agent.orchestrator of an orchestrated workflow", () => {
    const workflow = makeWorkflow();
    const orchestrator = {
      concurrency: OrchestratorConcurrency.Queue,
      debounceSeconds: 5,
      turnTimeoutMinutes: 3,
      cancelOn: [OrchestratorTicketChange.StatusChanged],
    };
    const custom = makeWorkflow({
      agent: {
        ...workflow.agent,
        mode: WorkflowAgentMode.Orchestrated,
        orchestrator,
      },
    });

    const text = workflowToYaml(custom, CATALOG);

    expect(text).toContain("  orchestrator:\n    concurrency: queue\n");
    expect(
      parseWorkflowYaml(text, CATALOG, custom).input?.agent.orchestrator
    ).toEqual(orchestrator);
  });

  it("writes the defaults for an orchestrated workflow without the mapping", () => {
    const workflow = makeWorkflow();
    const custom = makeWorkflow({
      agent: {
        ...workflow.agent,
        mode: WorkflowAgentMode.Orchestrated,
        orchestrator: undefined,
      },
    });

    const text = workflowToYaml(custom, CATALOG);

    expect(text).toContain("    concurrency: supersede\n");
    expect(text).toContain("    debounceSeconds: 20\n");
    expect(text).toContain("    turnTimeoutMinutes: 10\n");
    expect(text).toContain("cancelOn:");
    expect(text).toContain(OrchestratorTicketChange.StatusChanged);
    expect(text).toContain(OrchestratorTicketChange.LabelRemoved);
  });

  it("reports an invalid cancelOn value", () => {
    const text = VALID_YAML.replace(
      "  mode: plan\n",
      "  mode: orchestrated\n  orchestrator:\n    cancelOn: [comment]\n"
    );

    expect(problemsOf(text).length).toBeGreaterThan(0);
  });

  it("reads the status and labeled trigger options", () => {
    const text = VALID_YAML.replace(
      `    type: ${JIRA_ISSUE_ASSIGNED}\n    config:\n      projectKeys: [PROJ]\n      label: ai\n`,
      `    type: ${JIRA_ISSUE_STATUS_CHANGED}\n    config:\n      to: [Ready for Dev]\n      from: [PRD Review]\n  - connection: acme-jira\n    type: ${JIRA_ISSUE_LABELED}\n    config:\n      label: ai\n      change: removed\n`
    );

    const { input, problems } = parseWorkflowYaml(text, CATALOG);

    expect(problems).toEqual([]);
    expect(input?.triggers.map((trigger) => trigger.config)).toEqual([
      { to: ["Ready for Dev"], from: ["PRD Review"], projectKeys: [] },
      { label: "ai", change: "removed" },
    ]);
  });

  it("reports an unknown option of the status trigger", () => {
    const text = VALID_YAML.replace(
      `    type: ${JIRA_ISSUE_ASSIGNED}\n    config:\n      projectKeys: [PROJ]\n      label: ai\n`,
      `    type: ${JIRA_ISSUE_STATUS_CHANGED}\n    config:\n      status: [Done]\n`
    );

    expect(problemsOf(text).map((problem) => problem.message)).toContain(
      'Unknown option "status". Options: from, to, projectKeys'
    );
  });

  it("writes no orchestrator for a process workflow", () => {
    expect(workflowToYaml(makeWorkflow(), CATALOG)).not.toContain(
      "orchestrator:"
    );
  });

  it("reports an unknown key under agent.orchestrator", () => {
    const text = VALID_YAML.replace(
      "  mode: plan\n",
      "  mode: orchestrated\n  orchestrator:\n    debounceSecond: 5\n"
    );

    expect(problemsOf(text).map((problem) => problem.message)).toContain(
      'Unknown key "debounceSecond" in agent.orchestrator - did you mean "debounceSeconds"?'
    );
  });

  it("writes the PRD instruction only when there is one", () => {
    const workflow = makeWorkflow();
    const instruction =
      "PRD when the type is Feature\nand it has the label PRD.";
    const custom = makeWorkflow({
      agent: { ...workflow.agent, prd: { instruction } },
    });

    const text = workflowToYaml(custom, CATALOG);

    expect(workflowToYaml(workflow, CATALOG)).not.toContain("prd:");
    expect(text).toContain(
      "  prd:\n    instruction: |-\n      PRD when the type is Feature\n      and it has the label PRD.\n"
    );
    expect(parseWorkflowYaml(text, CATALOG, custom).input?.agent.prd).toEqual({
      instruction,
    });
  });

  it("writes a saved workflow with names, and reads back the same workflow", () => {
    const workflow = makeWorkflow();

    const text = workflowToYaml(workflow, CATALOG);

    expect(text).toContain("  - connection: acme-jira\n");
    expect(text).toContain("      projectKeys: [ PROJ ]\n");
    expect(text).toContain("  - on: workflow.triggered\n");
    expect(text).toContain("  - on: [ workflow.completed, workflow.failed ]\n");
    expect(text).not.toContain("preActions:");
    expect(text).toContain("\nproject: Web\n");
    expect(text).toContain("  runAs: ada@acme.dev\n");
    expect(text).toContain(`  runner: ${RUNNER_NAME}\n`);
    const { input, problems } = parseWorkflowYaml(text, CATALOG, workflow);
    expect(problems).toEqual([]);
    expect(input).toMatchObject({
      name: workflow.name,
      description: workflow.description,
      runAsUserId: RUN_AS_USER_ID,
      agent: { instructions: "Use pnpm.", computeTargetId: COMPUTE_TARGET_ID },
    });
  });

  it("saves a workflow's YAML unchanged as the workflow it came from", () => {
    const workflow = makeWorkflow();

    const { input } = parseWorkflowYaml(
      workflowToYaml(workflow, CATALOG),
      CATALOG,
      workflow
    );

    expect(input).toEqual(makeSaveWorkflowInput());
  });

  it("keeps the ids of triggers and actions still there, so their runs stay linked", () => {
    const workflow = makeWorkflow();
    const text = workflowToYaml(workflow, CATALOG);

    const { input } = parseWorkflowYaml(text, CATALOG, workflow);

    expect(input?.triggers.map((trigger) => trigger.id)).toEqual([TRIGGER_ID]);
    expect(input?.actions.map((action) => action.id)).toEqual([
      PRE_ACTION_ID,
      ACTION_ID,
    ]);
  });

  it("leaves a new item without an id", () => {
    const workflow = makeWorkflow();
    const text = workflowToYaml(workflow, CATALOG).replace(
      "actions:\n",
      `actions:\n  - on: plan.completed\n    connection: acme-jira\n    type: ${JIRA_ADD_COMMENT}\n`
    );

    const { input } = parseWorkflowYaml(text, CATALOG, workflow);

    expect(input?.actions.map((action) => action.id)).toEqual([
      undefined,
      PRE_ACTION_ID,
      ACTION_ID,
    ]);
  });

  it("gives a saved id to one action only when two of its type follow", () => {
    const workflow = makeWorkflow();
    const text = workflowToYaml(workflow, CATALOG);
    // The saved workflow has one Teams post action; the YAML lists it twice.
    const posted = text.slice(text.indexOf("  - on: [ workflow.completed"));

    const { input } = parseWorkflowYaml(`${text}${posted}`, CATALOG, workflow);

    expect(input?.actions.map((action) => action.id)).toEqual([
      PRE_ACTION_ID,
      ACTION_ID,
      undefined,
    ]);
  });

  it("writes an instruction without a connection and reads it back with its id", () => {
    const workflow = makeWorkflow();
    const withInstruction: Workflow = {
      ...workflow,
      actions: [
        ...workflow.actions,
        {
          id: "instruction-1",
          connectionKey: null,
          connectionId: null,
          automaticConnection: true,
          builtInHttp: false,
          type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
          config: { instruction: "Summarize the work.\nComment on the issue." },
          stage: WorkflowActionStage.Post,
          events: [WorkflowRunEvent.ExecuteCompleted],
          continueOnError: false,
          enabled: true,
          position: 2,
        },
      ],
    };

    const text = workflowToYaml(withInstruction, CATALOG);
    const { input, problems } = parseWorkflowYaml(
      text,
      CATALOG,
      withInstruction
    );

    expect(text).toContain(
      "  - on: execute.completed\n    instruction: |-\n      Summarize the work.\n      Comment on the issue.\n"
    );
    expect(problems).toEqual([]);
    expect(input?.actions.at(-1)).toMatchObject({
      id: "instruction-1",
      connectionKey: null,
      automaticConnection: true,
      config: { instruction: "Summarize the work.\nComment on the issue." },
    });
  });

  it("keeps an id where a name is unknown or shared", () => {
    const workflow: Workflow = makeWorkflow();
    const catalog = {
      ...CATALOG,
      runners: [
        { id: COMPUTE_TARGET_ID, label: RUNNER_NAME, isOnline: true },
        { id: "other-runner", label: RUNNER_NAME, isOnline: true },
      ],
    };

    const text = workflowToYaml(workflow, catalog);

    expect(text).toContain(`  runner: ${COMPUTE_TARGET_ID}\n`);
    expect(text).toContain(`  - connection: ${JIRA_KEY}\n`);
  });
});

describe("newWorkflowYaml", () => {
  it("starts from the workflow's own HTTP endpoint with the only project and runner", () => {
    const text = newWorkflowYaml(CATALOG);

    expect(text.startsWith("# A workflow:")).toBe(true);
    const { input, problems } = parseWorkflowYaml(text, CATALOG);
    expect(problems).toEqual([]);
    expect(input).toMatchObject({
      name: "New workflow",
      projectId: PROJECT_ID,
      agent: {
        computeTargetId: COMPUTE_TARGET_ID,
        mode: WorkflowAgentMode.PlanAndExecute,
      },
      triggers: [{ connectionKey: null, type: WEBHOOK_REQUEST }],
      actions: [],
    });
  });

  it("leaves the project and runner for the admin to choose when there are several", () => {
    const catalog = {
      ...CATALOG,
      projects: [...CATALOG.projects, { id: "p-2", name: "Mobile" }],
    };

    const messages = problemsOf(newWorkflowYaml(catalog), catalog).map(
      (problem) => problem.message
    );

    expect(messages).toEqual([
      "Name the project the workflow's runs belong to (project:)",
    ]);
  });
});

/** VALID_YAML with lines added to the agent, after its mode. */
function withAgentLines(lines: string): string {
  return VALID_YAML.replace("  mode: plan\n", `  mode: plan\n${lines}`);
}

/** The `actions:` list to the end of VALID_YAML. */
const ACTIONS_LIST_RE = /actions:\n[\s\S]*$/;
