import {
  IntegrationFieldKind,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import {
  PROCESS_INSTRUCTION_VARIABLES,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  WORKFLOW_TEMPLATE_VARIABLES,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  JIRA_KEY,
  JIRA_TRANSITION_ISSUE,
  LOCAL_GIT_CREATE_PULL_REQUEST,
  localGitPullRequestProvider,
  makeProjectConnection,
  makeProjectConnections,
  PROVIDERS,
  serverLocalGitConnection,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import { PROCESS_YAML_KEYS } from "../../../projects/lib/process-yaml";
import { PROCESS_YAML_KEY_DOCS } from "../../../projects/lib/process-yaml-completions";
import { PROJECT_ID } from "../../__tests__/workflow-fixtures";
import {
  WORKFLOW_RUN_EVENT_DESCRIPTIONS,
  WORKFLOW_RUN_EVENT_ORDER,
} from "../../lib/workflow-labels";
import {
  WORKFLOW_ACTION_EXAMPLES,
  WORKFLOW_ACTION_KEY_DOCS,
  WORKFLOW_CONNECTION_CHOICE_GUIDE,
  WORKFLOW_INSTRUCTION_GUIDE,
  WORKFLOW_PROCESS_GUIDE,
  WORKFLOW_RUN_GUIDE,
  WORKFLOW_TRIGGER_KEY_DOCS,
  WORKFLOW_YAML_KEY_DOCS,
} from "../../lib/workflow-yaml-docs";
import {
  BUILT_IN_HTTP_REFERENCE,
  WORKFLOW_YAML_KEYS,
} from "../../lib/workflow-yaml-schema";
import { WorkflowConfigurationGuide } from "../workflow-configuration-guide";

describe("WorkflowConfigurationGuide", () => {
  it("starts closed when editing a saved workflow and opens on request", async () => {
    const user = userEvent.setup();
    renderGuide({ defaultOpen: false });

    expect(screen.queryByRole("tab", { name: "Workflow" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Configuration guide" })
    );

    expect(screen.getByRole("tab", { name: "Workflow" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("opens on how a run goes and every key of the workflow, its triggers and its agent", () => {
    renderGuide();

    const workflow = screen.getByRole("tabpanel");
    for (const item of WORKFLOW_RUN_GUIDE) {
      expect(within(workflow).getByText(item)).toBeInTheDocument();
    }
    const triggers = keyBlock(workflow, "Keys of an item of triggers");
    for (const key of WORKFLOW_YAML_KEYS.trigger) {
      expect(
        within(triggers).getByText(WORKFLOW_TRIGGER_KEY_DOCS[key]?.info ?? "")
      ).toBeInTheDocument();
    }
    const agent = keyBlock(workflow, "Keys of agent");
    for (const key of ["runAs", "runner", "mode", "prd", "process"]) {
      expect(
        within(agent).getByText(key, { selector: "dt code" })
      ).toBeInTheDocument();
    }
    expect(
      within(agent).getByText(WORKFLOW_YAML_KEY_DOCS.mode?.info ?? "")
    ).toBeInTheDocument();
    expect(
      within(keyBlock(workflow, "Top-level keys")).queryByText("preActions", {
        selector: "dt code",
      })
    ).toBeNull();
    expect(
      within(agent).queryByText("project", { selector: "dt code" })
    ).toBeNull();
  });

  it("lists every run event with when it fires", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Run events" }));

    const events = screen.getByRole("tabpanel");
    for (const event of WORKFLOW_RUN_EVENT_ORDER) {
      expect(within(events).getByText(event)).toBeInTheDocument();
      expect(
        within(events).getByText(WORKFLOW_RUN_EVENT_DESCRIPTIONS[event], {
          exact: false,
        })
      ).toBeInTheDocument();
    }
    expect(
      within(events).getByText(WorkflowRunEvent.PlanStarted)
    ).toBeInTheDocument();
    expect(
      within(events).getByText(WorkflowRunEvent.ExecuteStarted)
    ).toBeInTheDocument();
    expect(
      within(events).getByText("before the agent team")
    ).toBeInTheDocument();
  });

  it("explains the keys of an action, instructions, the connection choice and the order", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Actions" }));

    const actions = screen.getByRole("tabpanel");
    for (const key of WORKFLOW_YAML_KEYS.action) {
      expect(
        within(actions).getByText(key, { selector: "dt code" })
      ).toBeInTheDocument();
      expect(
        within(actions).getByText(WORKFLOW_ACTION_KEY_DOCS[key]?.info ?? "")
      ).toBeInTheDocument();
    }
    for (const item of [
      ...WORKFLOW_INSTRUCTION_GUIDE,
      ...WORKFLOW_CONNECTION_CHOICE_GUIDE,
    ]) {
      expect(within(actions).getByText(item)).toBeInTheDocument();
    }
    expect(
      within(actions).getByRole("heading", { name: "Order" })
    ).toBeInTheDocument();
  });

  it("explains the process steps with the keys of each type", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Process" }));

    const process = screen.getByRole("tabpanel");
    for (const item of WORKFLOW_PROCESS_GUIDE) {
      expect(within(process).getByText(item)).toBeInTheDocument();
    }
    const agentStep = keyBlock(process, `Step type ${ProcessStepType.Agent}`);
    for (const key of PROCESS_YAML_KEYS.steps[ProcessStepType.Agent]) {
      expect(
        within(agentStep).getByText(key, { selector: "dt code" })
      ).toBeInTheDocument();
    }
    const plan = keyBlock(
      process,
      `Step type ${ProcessStepType.AgentFlowPlan}`
    );
    expect(
      within(plan).getByText(PROCESS_YAML_KEY_DOCS.recommendations?.info ?? "")
    ).toBeInTheDocument();
    const document = keyBlock(process, "Keys of an agent step's document");
    expect(
      within(document).getByText(
        PROCESS_YAML_KEY_DOCS["steps/#/document/type"]?.info ?? ""
      )
    ).toBeInTheDocument();
    for (const variable of PROCESS_INSTRUCTION_VARIABLES) {
      expect(
        within(process).getByText(`{{${variable.name}}}`)
      ).toBeInTheDocument();
    }
  });

  it("lists the project connections by key with their types and options", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Connections" }));

    const http = connectionEntry(BUILT_IN_HTTP_REFERENCE);
    expect(within(http).getByText("Webhook (HTTPS)")).toBeInTheDocument();
    expect(within(http).getByText(WEBHOOK_REQUEST)).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Web" })).toBeInTheDocument();
    const jira = connectionEntry(JIRA_KEY);
    expect(within(jira).getByText(JIRA_ISSUE_ASSIGNED)).toBeInTheDocument();
    expect(within(jira).getByText(JIRA_ADD_COMMENT)).toBeInTheDocument();
    expect(within(jira).getByText(JIRA_TRANSITION_ISSUE)).toBeInTheDocument();
    expect(
      within(jira).getByText(
        '(template, required, default "{{summary}}"): Comment.'
      )
    ).toBeInTheDocument();
    expect(
      within(jira).getByText("(text, required): Transition.")
    ).toBeInTheDocument();

    const teams = connectionEntry(TEAMS_KEY);
    expect(within(teams).getByText(TEAMS_POST_MESSAGE)).toBeInTheDocument();

    const git = connectionEntry("local-git");
    const pullRequest = within(git)
      .getByText(LOCAL_GIT_CREATE_PULL_REQUEST)
      .closest("details");
    expect(pullRequest).not.toBeNull();
    expect(
      within(pullRequest as HTMLElement).getByText("every pushed repository")
    ).toBeInTheDocument();
    expect(
      within(pullRequest as HTMLElement).getByText(
        "(text): Target branch. Leave empty to merge into the branch the run started from."
      )
    ).toBeInTheDocument();
    expect(
      within(pullRequest as HTMLElement).getByText(
        '(select, default "merge"): Merge method. One of: merge, squash.'
      )
    ).toBeInTheDocument();
    expect(within(http).getByText("No options.")).toBeInTheDocument();
    expect(within(jira).queryByText("every pushed repository")).toBeNull();
  });

  it("says where to add connections when the org has none", async () => {
    const user = userEvent.setup();
    renderGuide({ projectConnections: [] });

    await user.click(screen.getByRole("tab", { name: "Connections" }));

    expect(
      screen.getByText(
        "No project connections yet: add Jira, Azure DevOps or Microsoft Teams in a project's Integrations tab (the organization connection comes from Settings → Integrations)."
      )
    ).toBeInTheDocument();
    expect(connectionEntry(BUILT_IN_HTTP_REFERENCE)).toBeInTheDocument();
  });

  it("lists the template variables", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Variables" }));

    for (const variable of WORKFLOW_TEMPLATE_VARIABLES) {
      const row = screen.getByText(`{{${variable.name}}}`).closest("div");
      expect(row).not.toBeNull();
      expect(
        within(row as HTMLElement).getByText(
          `Has a value: ${variable.available}`
        )
      ).toBeInTheDocument();
    }
  });

  it("shows the examples to copy", async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByRole("tab", { name: "Examples" }));

    for (const example of WORKFLOW_ACTION_EXAMPLES) {
      expect(screen.getByText(example.title)).toBeInTheDocument();
      expect(screen.getByText(example.description)).toBeInTheDocument();
    }
  });
});

/** Local Git's pull request action, with an option that has choices. */
const localGitProvider: IntegrationProviderSummary = {
  ...localGitPullRequestProvider,
  actions: localGitPullRequestProvider.actions.map((action) => ({
    ...action,
    configFields: [
      ...action.configFields,
      {
        key: "mergeMethod",
        label: "Merge method",
        kind: IntegrationFieldKind.Select,
        defaultValue: "merge",
        options: [
          { value: "merge", label: "Merge" },
          { value: "squash", label: "Squash" },
        ],
      },
    ],
  })),
};

function renderGuide(
  options: {
    defaultOpen?: boolean;
    projectConnections?: ProjectConnection[];
  } = {}
) {
  render(
    <WorkflowConfigurationGuide
      catalog={{
        providers: [...PROVIDERS, localGitProvider],
        projects: [{ id: PROJECT_ID, name: "Web" }],
        projectConnections: options.projectConnections ?? [
          ...makeProjectConnections(PROJECT_ID),
          makeProjectConnection(PROJECT_ID, {
            connectionId: serverLocalGitConnection.id,
            provider: serverLocalGitConnection.provider,
            key: "local-git",
            name: serverLocalGitConnection.name,
            settings: {},
          }),
        ],
      }}
      defaultOpen={options.defaultOpen ?? true}
    />
  );
}

/** The entry of a connection: its name, provider and types. */
function connectionEntry(name: string): HTMLElement {
  const entry = screen
    .getAllByText(name, { selector: "code" })
    .map((element) => element.closest("div.rounded-md"))
    .find((element) => element !== null);
  if (!(entry instanceof HTMLElement)) {
    throw new Error(`No connection entry for ${name}`);
  }
  return entry;
}

/** The guide block under a heading. */
function keyBlock(panel: HTMLElement, title: string): HTMLElement {
  const heading = within(panel).getByRole("heading", { name: title });
  return heading.parentElement as HTMLElement;
}
