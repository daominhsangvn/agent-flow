import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { ProcessDocumentType } from "@repo/api/src/types/project-process";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraTriggerType } from "@/lib/integrations/providers/jira/constants";
import {
  buildRunSnapshot,
  buildSummaryMarkdown,
  type SummaryInput,
  snapshotTemplateVariables,
} from "@/lib/workflows/engine/snapshot";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getLatest: vi.fn(),
  findLatestRunLoop: vi.fn(),
  listRunLoops: vi.fn(),
  listRunDocuments: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ workflowRun: { findUnique: mocks.findUnique } }),
}));
vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: mocks.getLatest },
}));
vi.mock("@/lib/workflows/engine/step-documents", () => ({
  listRunDocuments: mocks.listRunDocuments,
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-loops")>();
  return {
    ...original,
    findLatestRunLoop: mocks.findLatestRunLoop,
    listRunLoops: mocks.listRunLoops,
  };
});

const RUN_URL = "https://app.example.test/acme/workflows/wf-1/runs/run-1";
const PLAN_URL = "https://app.example.test/acme/implementation-plans/PLN-1";

const baseSummary: SummaryInput = {
  event: WorkflowRunEvent.Started,
  key: "PROJ-7",
  title: "Add CSV export",
  runUrl: RUN_URL,
  planUrl: PLAN_URL,
  planExcerpt: "## Plan\nDo it",
  openQuestions: ["Which format?", "Max rows?"],
  pullRequest: null,
  pullRequests: [],
  errorMessage: null,
  planOnly: false,
};

describe("buildSummaryMarkdown", () => {
  it("run.triggered names the item and links the run", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Triggered,
      })
    ).toBe(
      `🤖 AgentFlow received **PROJ-7** (Add CSV export) and is about to start working on it. Follow the run: ${RUN_URL}`
    );
  });

  it("run.triggered without a title leaves the parentheses out", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Triggered,
        title: null,
      })
    ).toBe(
      `🤖 AgentFlow received **PROJ-7** and is about to start working on it. Follow the run: ${RUN_URL}`
    );
  });

  it("run.started links the run", () => {
    expect(buildSummaryMarkdown(baseSummary)).toBe(
      `🤖 AgentFlow picked up **PROJ-7** and started planning. Follow the run: ${RUN_URL}`
    );
  });

  it("run.plan_ready links the plan and appends the excerpt", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.PlanReady,
      })
    ).toBe(
      `📝 The implementation plan for **PROJ-7** is ready: ${PLAN_URL}\n\n## Plan\nDo it`
    );
  });

  it("run.needs_input lists the open questions", () => {
    const summary = buildSummaryMarkdown({
      ...baseSummary,
      event: WorkflowRunEvent.NeedsInput,
    });
    expect(summary).toContain(
      "❓ The plan for **PROJ-7** has open questions that need an answer before implementation:"
    );
    expect(summary).toContain("- Which format?\n- Max rows?");
    expect(summary).toContain(`Plan: ${PLAN_URL}`);
    expect(summary).toContain(
      "Answer them on the ticket and assign it to the bot again, or approve the plan in AgentFlow."
    );
  });

  it("run.needs_input names the process step and its questions", () => {
    const summary = buildSummaryMarkdown({
      ...baseSummary,
      event: WorkflowRunEvent.NeedsInput,
      step: {
        id: "clarify",
        name: "Clarify",
        questions: ["Hex or RGB?", "Keep a history?"],
        awaitingApproval: false,
      },
    });

    expect(summary).toBe(
      [
        '❓ The "Clarify" step for **PROJ-7** has questions that need an answer:',
        "- Hex or RGB?\n- Keep a history?",
        `Answer them on the ticket and assign it to the bot again, or answer in AgentFlow: ${RUN_URL}`,
      ].join("\n\n")
    );
  });

  it("run.needs_input of an approval step links the run", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.NeedsInput,
        step: {
          id: "review",
          name: "Review the spec",
          questions: [],
          awaitingApproval: true,
        },
      })
    ).toBe(
      `🛂 The "Review the spec" step for **PROJ-7** waits for an approval in AgentFlow: ${RUN_URL}`
    );
  });

  it("run.succeeded with a pull request names the PR and branch", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Succeeded,
        pullRequest: {
          url: "https://github.com/acme/app/pull/12",
          branch: "feat/csv",
        },
      })
    ).toBe(
      "✅ **PROJ-7** is done. Pull request: https://github.com/acme/app/pull/12 (branch feat/csv)."
    );
  });

  it("run.succeeded with several pull requests lists each with its repository", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Succeeded,
        pullRequest: {
          url: "https://github.com/acme/app/pull/12",
          branch: "feat/csv",
        },
        pullRequests: [
          {
            url: "https://github.com/acme/app/pull/12",
            number: 12,
            branch: "feat/csv",
            repository: "acme/app",
          },
          {
            url: "https://github.com/acme/api/pull/3",
            number: 3,
            branch: "feat/csv",
            repository: "acme/api",
          },
        ],
      })
    ).toBe(
      [
        "✅ **PROJ-7** is done. Pull requests:",
        "- acme/app: https://github.com/acme/app/pull/12",
        "- acme/api: https://github.com/acme/api/pull/3",
      ].join("\n")
    );
  });

  it("run.succeeded in plan mode links the plan", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Succeeded,
        planOnly: true,
      })
    ).toBe(`✅ **PROJ-7** is done. Implementation plan: ${PLAN_URL}`);
  });

  it("run.failed gives the reason and the run link", () => {
    expect(
      buildSummaryMarkdown({
        ...baseSummary,
        event: WorkflowRunEvent.Failed,
        errorMessage: "The compute target is offline",
      })
    ).toBe(
      `⚠️ AgentFlow could not complete **PROJ-7**: The compute target is offline. Details: ${RUN_URL}`
    );
  });
});

describe("buildRunSnapshot", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRunLoops.mockResolvedValue([]);
    mocks.listRunDocuments.mockResolvedValue([]);
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test/";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("builds links, plan, PR and template variables from the run", async () => {
    mocks.findUnique.mockResolvedValue(runRow());
    mocks.getLatest.mockResolvedValue({ content: "# Plan\n\n\n\nStep 1" });
    mocks.findLatestRunLoop.mockImplementation((_runId, command) =>
      Promise.resolve(
        command === LoopCommand.Plan
          ? {
              status: LoopStatus.Completed,
              uploadedArtifacts: {
                plan: { raw: { openQuestions: [{ question: "Which?" }] } },
              },
            }
          : { status: LoopStatus.Completed, prNumber: 42 }
      )
    );

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot).toMatchObject({
      id: "run-1",
      url: RUN_URL,
      status: WorkflowRunStatus.Succeeded,
      workflow: { id: "wf-1", name: "Jira to PR" },
      trigger: {
        id: "trg-1",
        type: JiraTriggerType.IssueAssigned,
        connectionId: "c-1",
      },
      source: { key: "PROJ-7", provider: IntegrationProviderKey.Jira },
      sourceExtras: { callbackUrl: "https://cb.test" },
      feature: {
        id: "feat-1",
        url: "https://app.example.test/acme/issues/ISS-1",
      },
      plan: {
        id: "plan-1",
        url: PLAN_URL,
        excerpt: "# Plan\n\nStep 1",
        openQuestions: ["Which?"],
      },
      pullRequest: {
        url: "https://github.com/acme/app/pull/42",
        number: 42,
        branch: "feat/csv",
      },
    });
    expect(snapshot?.summaryMarkdown).toContain("Pull request:");

    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["pr.number"]).toBe("42");
    expect(variables["plan.openQuestions"]).toBe("Which?");
    expect(variables["source.url"]).toBe(
      "https://acme.atlassian.net/browse/PROJ-7"
    );
    expect(variables["error.message"]).toBe("");
  });

  it("parses the PR number from the URL when the loop has none", async () => {
    mocks.findUnique.mockResolvedValue({ ...runRow(), planDocument: null });
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.pullRequest?.number).toBe(42);
    expect(snapshot?.plan).toBeNull();
  });

  it("parses the number of an Azure DevOps pull request URL", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      planDocument: null,
      prUrl: "https://dev.azure.com/contoso/Shop/_git/web/pullrequest/77",
    });
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.pullRequest?.number).toBe(77);
  });

  it("reads a run recorded with one repository, whose branch is the run's", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      planDocument: null,
      prUrl: null,
      repository: {
        id: "repo-1",
        connectionId: "c-2",
        provider: IntegrationProviderKey.GitHub,
        externalId: "1296269",
        fullName: "acme/app",
        webUrl: "https://github.com/acme/app",
        cloneUrl: "https://github.com/acme/app.git",
        defaultBranch: "main",
        branch: null,
        baseBranch: "develop",
      },
    });
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.pullRequest).toBeNull();
    expect(snapshot?.repository).toMatchObject({
      fullName: "acme/app",
      branch: "feat/csv",
      baseBranch: "develop",
    });
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["repository.name"]).toBe("acme/app");
    expect(variables["repository.branch"]).toBe("feat/csv");
    expect(variables["repository.baseBranch"]).toBe("develop");
  });

  it("exposes every repository with its own branch and pull request", async () => {
    const repository = {
      connectionId: "c-2",
      provider: IntegrationProviderKey.GitHub,
      defaultBranch: "main",
      baseBranch: "main",
    };
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      planDocument: null,
      repository: [
        {
          ...repository,
          id: "repo-docs",
          externalId: "1",
          fullName: "acme/docs",
          webUrl: "https://github.com/acme/docs",
          cloneUrl: "https://github.com/acme/docs.git",
          branch: null,
          pullRequest: null,
        },
        {
          ...repository,
          id: "repo-app",
          externalId: "2",
          fullName: "acme/app",
          webUrl: "https://github.com/acme/app",
          cloneUrl: "https://github.com/acme/app.git",
          branch: "feat/csv-app",
          pullRequest: {
            url: "https://github.com/acme/app/pull/42",
            number: 42,
          },
        },
        {
          ...repository,
          id: "repo-api",
          externalId: "3",
          fullName: "acme/api",
          webUrl: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
          branch: "feat/csv-api",
          pullRequest: { url: "https://github.com/acme/api/pull/5", number: 5 },
        },
      ],
    });
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.repositories.map((repo) => repo.branch)).toEqual([
      null,
      "feat/csv-app",
      "feat/csv-api",
    ]);
    expect(snapshot?.repository?.fullName).toBe("acme/app");
    expect(snapshot?.pullRequests).toEqual([
      {
        url: "https://github.com/acme/app/pull/42",
        number: 42,
        branch: "feat/csv-app",
        repository: "acme/app",
      },
      {
        url: "https://github.com/acme/api/pull/5",
        number: 5,
        branch: "feat/csv-api",
        repository: "acme/api",
      },
    ]);
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["pr.urls"]).toBe(
      "https://github.com/acme/app/pull/42\nhttps://github.com/acme/api/pull/5"
    );
    expect(snapshot?.summaryMarkdown).toContain(
      "- acme/api: https://github.com/acme/api/pull/5"
    );
  });

  it("reads a malformed stored repository as none", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      repository: { fullName: "acme/app" },
    });
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.repository).toBeNull();
    expect(snapshot?.repositories).toEqual([]);
  });

  it("shows pre actions the run before the agent team: no documents, no PR", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      status: WorkflowRunStatus.PreActions,
      completedAt: null,
    });

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Triggered
    );

    expect(snapshot).toMatchObject({
      status: WorkflowRunStatus.PreActions,
      event: WorkflowRunEvent.Triggered,
      sourceExtras: { callbackUrl: "https://cb.test" },
      feature: null,
      plan: null,
      pullRequest: null,
      step: null,
      summaryMarkdown: `🤖 AgentFlow received **PROJ-7** (Add CSV export) and is about to start working on it. Follow the run: ${RUN_URL}`,
    });
    expect(mocks.getLatest).not.toHaveBeenCalled();
    expect(mocks.findLatestRunLoop).not.toHaveBeenCalled();
  });

  it("exposes the process step the run waits on, with its questions", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      status: WorkflowRunStatus.NeedsInput,
      planDocument: null,
      prUrl: null,
      process: {
        version: 2,
        definition: {
          toolkit: null,
          steps: [
            {
              type: "agent",
              id: "clarify",
              name: "Clarify",
              instruction: "/clarify",
            },
          ],
        },
      },
      stepId: "clarify",
      stepState: {
        waiting: {
          stepId: "clarify",
          loopId: "loop-1",
          questions: [{ id: "q1", question: "Hex or RGB?" }],
          askedAt: "2026-10-01T00:30:00.000Z",
        },
      },
    });

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.NeedsInput
    );

    expect(snapshot?.step).toEqual({
      id: "clarify",
      name: "Clarify",
      questions: ["Hex or RGB?"],
      awaitingApproval: false,
    });
    expect(snapshot?.summaryMarkdown).toContain('The "Clarify" step');
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["step.name"]).toBe("Clarify");
    expect(variables["step.questions"]).toBe("Hex or RGB?");
  });

  it("has no step on the built-in flow", async () => {
    mocks.findUnique.mockResolvedValue(runRow());
    mocks.getLatest.mockResolvedValue(null);
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.step).toBeNull();
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["step.name"]).toBe("");
  });

  it("hands post actions the reply file of the latest step that wrote one", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      status: WorkflowRunStatus.Succeeded,
      planDocument: null,
      prUrl: null,
      process: {
        version: 1,
        source: "workflow",
        definition: {
          toolkit: null,
          steps: [
            {
              type: "agent",
              id: "answer",
              name: "Answer",
              instruction: "Answer the question",
              reply: ".agentflow-ai/work/answer.md",
            },
            {
              type: "agent",
              id: "check",
              name: "Check",
              instruction: "Check the answer",
            },
          ],
        },
      },
      stepId: "check",
      stepState: null,
    });
    mocks.listRunLoops.mockResolvedValue([
      stepLoop("loop-1", "answer", [
        { path: ".agentflow-ai/work/answer.md", content: "First draft" },
      ]),
      stepLoop("loop-2", "answer", [
        { path: "notes.md", content: "not the reply" },
        { path: ".agentflow-ai/work/answer.md", content: "  Final answer  " },
      ]),
      stepLoop("loop-3", "check", [
        {
          path: ".agentflow-ai/work/answer.md",
          content: "ignored: no reply file on this step",
        },
      ]),
    ]);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.reply).toBe("Final answer");
    expect(snapshot?.stepReplies).toEqual({ answer: "Final answer" });
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables.reply).toBe("Final answer");
    expect(variables["steps.answer.reply"]).toBe("Final answer");
    expect(variables["steps.check.reply"]).toBeUndefined();
  });

  it("links the documents the process steps published, as steps.<id>.document variables", async () => {
    mocks.findUnique.mockResolvedValue({
      ...runRow(),
      organizationId: "org-1",
      planDocument: null,
      prUrl: null,
      process: {
        version: 1,
        source: "workflow",
        definition: {
          toolkit: null,
          steps: [
            {
              type: "agent",
              id: "prd",
              name: "PRD",
              instruction: "Write the PRD",
              document: { type: ProcessDocumentType.Prd, path: "prd.md" },
            },
          ],
        },
      },
      stepId: "prd",
    });
    mocks.listRunDocuments.mockResolvedValue([
      {
        id: "prd-1",
        slug: "PRD-12",
        title: "PRD: Add CSV export",
        type: ProcessDocumentType.Prd,
        stepId: "prd",
      },
      {
        id: "doc-1",
        slug: null,
        title: "Notes",
        type: ProcessDocumentType.Doc,
        stepId: "notes",
      },
    ]);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(mocks.listRunDocuments).toHaveBeenCalledWith({
      id: "run-1",
      organizationId: "org-1",
      featureDocumentId: "feat-1",
    });
    expect(snapshot?.documents).toEqual([
      {
        stepId: "prd",
        type: ProcessDocumentType.Prd,
        title: "PRD: Add CSV export",
        url: "https://app.example.test/acme/prds/PRD-12",
      },
      // Without a slug the run page is the link.
      {
        stepId: "notes",
        type: ProcessDocumentType.Doc,
        title: "Notes",
        url: RUN_URL,
      },
    ]);
    const variables = snapshotTemplateVariables(
      snapshot ?? expect.fail("snapshot expected")
    );
    expect(variables["steps.prd.document.url"]).toBe(
      "https://app.example.test/acme/prds/PRD-12"
    );
    expect(variables["steps.prd.document.title"]).toBe("PRD: Add CSV export");
  });

  it("has no documents on the built-in flow", async () => {
    mocks.findUnique.mockResolvedValue(runRow());
    mocks.getLatest.mockResolvedValue(null);
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.documents).toEqual([]);
    expect(mocks.listRunDocuments).not.toHaveBeenCalled();
  });

  it("has no reply on the built-in flow", async () => {
    mocks.findUnique.mockResolvedValue(runRow());
    mocks.getLatest.mockResolvedValue(null);
    mocks.findLatestRunLoop.mockResolvedValue(null);

    const snapshot = await buildRunSnapshot(
      "run-1",
      WorkflowRunEvent.Succeeded
    );

    expect(snapshot?.reply).toBeNull();
    expect(mocks.listRunLoops).not.toHaveBeenCalled();
  });

  it("returns null for a missing run", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(
      buildRunSnapshot("missing", WorkflowRunEvent.Failed)
    ).resolves.toBeNull();
  });
});

function stepLoop(
  loopId: string,
  stepId: string,
  files: Array<{ path: string; content: string }>
) {
  return {
    loopId,
    command: LoopCommand.Step,
    adopted: false,
    stepId,
    linkedAt: new Date("2026-10-01T00:00:00.000Z"),
    status: LoopStatus.Completed,
    computeTargetId: null,
    prUrl: null,
    prNumber: null,
    branchName: null,
    error: null,
    uploadedArtifacts: {
      step: {
        stepId,
        questions: [],
        files: files.map((file) => ({ ...file, truncated: false })),
        questionsError: null,
      },
    },
    revivalCount: 0,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
  };
}

function runRow() {
  return {
    id: "run-1",
    workflowId: "wf-1",
    status: WorkflowRunStatus.Succeeded,
    sourceKey: "jira:PROJ-7",
    source: {
      item: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10001",
        key: "PROJ-7",
        url: "https://acme.atlassian.net/browse/PROJ-7",
        title: "Add CSV export",
        container: "PROJ",
      },
      inlineItem: null,
      actor: null,
      attributes: {},
      extras: { callbackUrl: "https://cb.test" },
      occurredAt: "2026-10-01T00:00:00.000Z",
    },
    agentConfig: { mode: WorkflowAgentMode.PlanAndExecute },
    prUrl: "https://github.com/acme/app/pull/42",
    branchName: "feat/csv",
    repository: null as unknown,
    error: null,
    process: null as unknown,
    stepId: null as string | null,
    stepState: null as unknown,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    completedAt: new Date("2026-10-01T01:00:00.000Z"),
    workflow: { id: "wf-1", name: "Jira to PR" },
    trigger: {
      id: "trg-1",
      type: JiraTriggerType.IssueAssigned,
      connectionId: "c-1",
    },
    organization: { slug: "acme" },
    featureDocument: {
      id: "feat-1",
      name: "PROJ-7: Add CSV export",
      slug: "ISS-1",
    },
    planDocument: { id: "plan-1", name: "Plan: PROJ-7", slug: "PLN-1" },
  };
}
