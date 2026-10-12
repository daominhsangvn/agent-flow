import {
  saveWorkflowInputSchema,
  WORKFLOW_ACTIONS_MAX,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  type WorkflowAction,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_CONNECTION_ID,
  JIRA_ISSUE_ASSIGNED,
  JIRA_TRANSITION_ISSUE,
  PROVIDERS,
  TEAMS_CONNECTION_ID,
  TEAMS_POST_MESSAGE,
} from "../../../integrations/__tests__/integration-fixtures";
import { REQUIRED_FIELD_MESSAGE } from "../../../integrations/lib/integration-field-values";
import {
  ACTION_ID,
  COMPUTE_TARGET_ID,
  makeWorkflow,
  PRE_ACTION_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
  TRIGGER_ID,
} from "../../__tests__/workflow-fixtures";
import {
  countWorkflowActions,
  createEmptyWorkflowFormValues,
  createPostActionDraft,
  createPreActionDraft,
  getDefaultActionEvents,
  getPostActionEvents,
  hasWorkflowConfigErrors,
  RUN_AS_SAVER,
  sortRunEvents,
  toSaveWorkflowInput,
  validateWorkflowConfigs,
  WORKFLOW_FORM_MESSAGES,
  type WorkflowFormValues,
  type WorkflowPostActionDraft,
  type WorkflowPreActionDraft,
  workflowFormSchema,
  workflowToFormValues,
} from "../workflow-form";

const SECOND_PRE_ACTION_ID = "12121212-1212-4212-8212-121212121212";
const SECOND_POST_ACTION_ID = "13131313-1313-4313-8313-131313131313";

function validValues(overrides: Partial<WorkflowFormValues> = {}) {
  return {
    ...createEmptyWorkflowFormValues(),
    name: "  Jira to PR  ",
    projectId: PROJECT_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    triggers: [
      {
        connectionId: JIRA_CONNECTION_ID,
        type: JIRA_ISSUE_ASSIGNED,
        config: { label: "ai" },
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function preAction(
  overrides: Partial<WorkflowPreActionDraft> = {}
): WorkflowPreActionDraft {
  return {
    ...createPreActionDraft(JIRA_CONNECTION_ID),
    type: JIRA_TRANSITION_ISSUE,
    config: { transition: "In Progress" },
    ...overrides,
  };
}

function postAction(
  overrides: Partial<WorkflowPostActionDraft> = {}
): WorkflowPostActionDraft {
  return {
    ...createPostActionDraft(TEAMS_CONNECTION_ID),
    type: TEAMS_POST_MESSAGE,
    events: [WorkflowRunEvent.Succeeded],
    ...overrides,
  };
}

/** A stored workflow with two pre and two post actions, deliberately out of order. */
function makeWorkflowWithOrderedActions() {
  const base = makeWorkflow();
  const [teamsPost, transitionPre] = base.actions as [
    WorkflowAction,
    WorkflowAction,
  ];
  return makeWorkflow({
    actions: [
      { ...teamsPost, position: 1 },
      { ...transitionPre, position: 1 },
      {
        id: SECOND_POST_ACTION_ID,
        connectionId: JIRA_CONNECTION_ID,
        type: JIRA_ADD_COMMENT,
        config: { body: "PR: {{pr.url}}" },
        builtInHttp: false,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
        position: 0,
      },
      {
        id: SECOND_PRE_ACTION_ID,
        connectionId: TEAMS_CONNECTION_ID,
        type: TEAMS_POST_MESSAGE,
        config: { message: "Picked up {{source.key}}" },
        builtInHttp: false,
        stage: WorkflowActionStage.Pre,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: false,
        enabled: false,
        position: 0,
      },
    ],
  });
}

describe("createEmptyWorkflowFormValues", () => {
  it("starts in plan-and-implement mode with one empty trigger, no actions and the default title", () => {
    const values = createEmptyWorkflowFormValues();
    expect(values.mode).toBe(WorkflowAgentMode.PlanAndExecute);
    expect(values.stopOnOpenQuestions).toBe(true);
    expect(values.runAsUserId).toBe(RUN_AS_SAVER);
    expect(values.titleTemplate).toBe(WORKFLOW_DEFAULT_TITLE_TEMPLATE);
    expect(values.triggers).toHaveLength(1);
    expect(values.preActions).toEqual([]);
    expect(values.postActions).toEqual([]);
  });

  it("creates pre actions that stop the run on failure by default", () => {
    expect(createPreActionDraft(JIRA_CONNECTION_ID)).toEqual({
      connectionId: JIRA_CONNECTION_ID,
      type: "",
      config: {},
      continueOnError: false,
      enabled: true,
    });
  });
});

describe("workflowFormSchema", () => {
  it("requires name, project, compute target and at least one trigger", () => {
    const result = workflowFormSchema.safeParse({
      ...createEmptyWorkflowFormValues(),
      triggers: [],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        WORKFLOW_FORM_MESSAGES.nameRequired,
        WORKFLOW_FORM_MESSAGES.projectRequired,
        WORKFLOW_FORM_MESSAGES.computeTargetRequired,
        WORKFLOW_FORM_MESSAGES.triggersRequired,
      ])
    );
  });

  it("requires repository and branch only when overriding the repository", () => {
    const result = workflowFormSchema.safeParse(
      validValues({ overrideRepository: true })
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "repositoryFullName",
      "repositoryBranch",
    ]);
    expect(workflowFormSchema.safeParse(validValues()).success).toBe(true);
  });

  it("requires an event for every post action", () => {
    const result = workflowFormSchema.safeParse(
      validValues({ postActions: [postAction({ events: [] })] })
    );
    expect(result.error?.issues[0]?.message).toBe(
      WORKFLOW_FORM_MESSAGES.eventsRequired
    );
  });

  it("keeps run.triggered for pre actions only", () => {
    const result = workflowFormSchema.safeParse(
      validValues({
        postActions: [postAction({ events: [WorkflowRunEvent.Triggered] })],
      })
    );
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      WORKFLOW_FORM_MESSAGES.triggeredEventReserved,
    ]);
  });

  it("accepts pre actions without events", () => {
    expect(
      workflowFormSchema.safeParse(validValues({ preActions: [preAction()] }))
        .success
    ).toBe(true);
  });

  it("limits pre and post actions together", () => {
    const half = WORKFLOW_ACTIONS_MAX / 2;
    const atLimit = validValues({
      preActions: Array.from({ length: half }, () => preAction()),
      postActions: Array.from({ length: half }, () => postAction()),
    });
    expect(countWorkflowActions(atLimit)).toBe(WORKFLOW_ACTIONS_MAX);
    expect(workflowFormSchema.safeParse(atLimit).success).toBe(true);

    const result = workflowFormSchema.safeParse({
      ...atLimit,
      preActions: [...atLimit.preActions, preAction()],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      WORKFLOW_FORM_MESSAGES.actionsMax,
    ]);
  });
});

describe("toSaveWorkflowInput", () => {
  it("produces a body the SaveWorkflowInput contract accepts, pre actions first", () => {
    const input = toSaveWorkflowInput(
      validValues({
        overrideRepository: true,
        repositoryFullName: " acme/web ",
        repositoryBranch: " main ",
        runAsUserId: RUN_AS_USER_ID,
        preActions: [
          preAction({ continueOnError: true }),
          preAction({
            connectionId: TEAMS_CONNECTION_ID,
            type: TEAMS_POST_MESSAGE,
            config: {},
          }),
        ],
        postActions: [
          postAction({
            config: {},
            events: [WorkflowRunEvent.Failed, WorkflowRunEvent.Started],
          }),
        ],
      }),
      PROVIDERS
    );

    expect(saveWorkflowInputSchema.parse(input)).toEqual(input);
    expect(input).toEqual({
      name: "Jira to PR",
      description: "",
      enabled: true,
      projectId: PROJECT_ID,
      runAsUserId: RUN_AS_USER_ID,
      agent: {
        mode: WorkflowAgentMode.PlanAndExecute,
        stopOnOpenQuestions: true,
        computeTargetId: COMPUTE_TARGET_ID,
        repository: { fullName: "acme/web", branch: "main" },
        instructions: "",
        titleTemplate: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
        process: null,
      },
      triggers: [
        {
          connectionId: JIRA_CONNECTION_ID,
          type: JIRA_ISSUE_ASSIGNED,
          // The descriptor default for the absent string list is applied.
          config: { projectKeys: [], label: "ai" },
          enabled: true,
        },
      ],
      actions: [
        {
          connectionId: JIRA_CONNECTION_ID,
          type: JIRA_TRANSITION_ISSUE,
          config: { transition: "In Progress" },
          stage: WorkflowActionStage.Pre,
          events: [],
          continueOnError: true,
          enabled: true,
        },
        {
          connectionId: TEAMS_CONNECTION_ID,
          type: TEAMS_POST_MESSAGE,
          config: { message: "{{summary}}" },
          stage: WorkflowActionStage.Pre,
          events: [],
          continueOnError: false,
          enabled: true,
        },
        {
          connectionId: TEAMS_CONNECTION_ID,
          type: TEAMS_POST_MESSAGE,
          config: { message: "{{summary}}" },
          stage: WorkflowActionStage.Post,
          events: [WorkflowRunEvent.Started, WorkflowRunEvent.Failed],
          continueOnError: false,
          enabled: true,
        },
      ],
    });
  });

  it("omits runAsUserId for 'run as whoever saves' and the repository when not overridden", () => {
    const input = toSaveWorkflowInput(validValues(), PROVIDERS);
    expect(input).not.toHaveProperty("runAsUserId");
    expect(input.agent.repository).toBeNull();
    expect(input.actions).toEqual([]);
  });

  it("never sends run.triggered for a post action", () => {
    const input = toSaveWorkflowInput(
      validValues({
        postActions: [
          postAction({
            events: [WorkflowRunEvent.Triggered, WorkflowRunEvent.Failed],
          }),
        ],
      }),
      PROVIDERS
    );
    expect(input.actions[0]?.events).toEqual([WorkflowRunEvent.Failed]);
  });

  it("keeps server ids so existing triggers and actions stay linked", () => {
    const input = toSaveWorkflowInput(
      workflowToFormValues(makeWorkflow()),
      PROVIDERS
    );
    expect(input.triggers[0]?.id).toBe(TRIGGER_ID);
    expect(input.actions.map((action) => action.id)).toEqual([
      PRE_ACTION_ID,
      ACTION_ID,
    ]);
    expect(saveWorkflowInputSchema.safeParse(input).success).toBe(true);
  });

  it("passes through the config of a type the catalog no longer knows", () => {
    const values = validValues({
      triggers: [
        {
          connectionId: JIRA_CONNECTION_ID,
          type: "legacy.trigger",
          config: { keep: "me" },
          enabled: true,
        },
      ],
      preActions: [preAction({ type: "legacy.action", config: { a: 1 } })],
    });
    const input = toSaveWorkflowInput(values, PROVIDERS);
    expect(input.triggers[0]?.config).toEqual({ keep: "me" });
    expect(input.actions[0]?.config).toEqual({ a: 1 });
  });
});

describe("workflowToFormValues", () => {
  it("maps a saved workflow, sorting triggers/actions by position and events by lifecycle", () => {
    const workflow = makeWorkflow({
      agent: {
        ...makeWorkflow().agent,
        repository: { fullName: "acme/api", branch: "develop" },
      },
    });
    const values = workflowToFormValues(workflow);
    expect(values).toMatchObject({
      name: workflow.name,
      projectId: PROJECT_ID,
      runAsUserId: RUN_AS_USER_ID,
      overrideRepository: true,
      repositoryFullName: "acme/api",
      repositoryBranch: "develop",
    });
    expect(values.triggers[0]).toEqual({
      serverId: TRIGGER_ID,
      connectionId: JIRA_CONNECTION_ID,
      type: JIRA_ISSUE_ASSIGNED,
      config: { projectKeys: ["PROJ"], label: "ai" },
      enabled: true,
    });
    expect(values.postActions[0]?.events).toEqual([
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
  });

  it("splits stored actions into pre and post lists by stage, each in position order", () => {
    const values = workflowToFormValues(makeWorkflowWithOrderedActions());
    expect(values.preActions).toEqual([
      {
        serverId: SECOND_PRE_ACTION_ID,
        connectionId: TEAMS_CONNECTION_ID,
        type: TEAMS_POST_MESSAGE,
        config: { message: "Picked up {{source.key}}" },
        continueOnError: false,
        enabled: false,
      },
      {
        serverId: PRE_ACTION_ID,
        connectionId: JIRA_CONNECTION_ID,
        type: JIRA_TRANSITION_ISSUE,
        config: { transition: "In Progress" },
        continueOnError: true,
        enabled: true,
      },
    ]);
    expect(values.postActions.map((action) => action.serverId)).toEqual([
      SECOND_POST_ACTION_ID,
      ACTION_ID,
    ]);
  });

  it("falls back to 'run as whoever saves' and an empty project when they are gone", () => {
    const values = workflowToFormValues(
      makeWorkflow({ project: null, runAsUser: null })
    );
    expect(values.projectId).toBe("");
    expect(values.runAsUserId).toBe(RUN_AS_SAVER);
  });
});

describe("stored workflow -> form -> SaveWorkflowInput", () => {
  it("keeps stage, order, continueOnError, events and the run-as user", () => {
    const workflow = makeWorkflowWithOrderedActions();
    const input = toSaveWorkflowInput(
      workflowToFormValues(workflow),
      PROVIDERS
    );

    expect(saveWorkflowInputSchema.parse(input)).toEqual(input);
    expect(input.runAsUserId).toBe(RUN_AS_USER_ID);
    expect(
      input.actions.map((action) => ({
        id: action.id,
        stage: action.stage,
        events: action.events,
        continueOnError: action.continueOnError,
        enabled: action.enabled,
      }))
    ).toEqual([
      {
        id: SECOND_PRE_ACTION_ID,
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: false,
        enabled: false,
      },
      {
        id: PRE_ACTION_ID,
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: true,
        enabled: true,
      },
      {
        id: SECOND_POST_ACTION_ID,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
      },
      {
        id: ACTION_ID,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded, WorkflowRunEvent.Failed],
        continueOnError: false,
        enabled: true,
      },
    ]);
  });
});

describe("validateWorkflowConfigs", () => {
  it("reports descriptor errors per list and row index", () => {
    const errors = validateWorkflowConfigs(
      {
        triggers: [
          {
            connectionId: JIRA_CONNECTION_ID,
            type: JIRA_ISSUE_ASSIGNED,
            config: {},
            enabled: true,
          },
        ],
        preActions: [preAction(), preAction({ config: {} })],
        postActions: [
          postAction({
            connectionId: JIRA_CONNECTION_ID,
            type: JIRA_ADD_COMMENT,
            config: { body: "" },
          }),
        ],
      },
      PROVIDERS
    );
    expect(errors).toEqual({
      triggers: { 0: { label: REQUIRED_FIELD_MESSAGE } },
      preActions: { 1: { transition: REQUIRED_FIELD_MESSAGE } },
      postActions: { 0: { body: REQUIRED_FIELD_MESSAGE } },
    });
    expect(hasWorkflowConfigErrors(errors)).toBe(true);
  });

  it("is clean for valid configs and unknown types", () => {
    const errors = validateWorkflowConfigs(
      {
        triggers: [
          {
            connectionId: JIRA_CONNECTION_ID,
            type: "unknown.type",
            config: {},
            enabled: true,
          },
        ],
        preActions: [preAction()],
        postActions: [],
      },
      PROVIDERS
    );
    expect(hasWorkflowConfigErrors(errors)).toBe(false);
  });
});

describe("events helpers", () => {
  it("keeps only known post action default events, in lifecycle order", () => {
    expect(
      getDefaultActionEvents([
        WorkflowRunEvent.Failed,
        "run.unknown_event",
        WorkflowRunEvent.Triggered,
        WorkflowRunEvent.Started,
      ])
    ).toEqual([WorkflowRunEvent.Started, WorkflowRunEvent.Failed]);
  });

  it("de-duplicates and sorts events, trigger first", () => {
    expect(
      sortRunEvents([
        WorkflowRunEvent.Succeeded,
        WorkflowRunEvent.PlanReady,
        WorkflowRunEvent.Triggered,
        WorkflowRunEvent.Succeeded,
      ])
    ).toEqual([
      WorkflowRunEvent.Triggered,
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.Succeeded,
    ]);
  });

  it("drops run.triggered from post action events", () => {
    expect(
      getPostActionEvents([
        WorkflowRunEvent.Triggered,
        WorkflowRunEvent.NeedsInput,
      ])
    ).toEqual([WorkflowRunEvent.NeedsInput]);
  });
});
