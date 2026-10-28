import type { JsonObject } from "@repo/api/src/types/common";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createPullRequestConfigSchema,
  definePullRequestAction,
  PULL_REQUEST_DESCRIPTION_MAX,
  PULL_REQUEST_TITLE_MAX,
} from "@/lib/integrations/pull-request-action";
import type {
  ActionContext,
  IntegrationRepositoriesDefinition,
  PullRequestRequest,
  RepositoryInfo,
  RunRepositorySnapshot,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";

const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const OTHER_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e2";

const repositoryInfo: RepositoryInfo = {
  externalId: "123456",
  fullName: "contoso/shop",
  name: "shop",
  namespace: "contoso",
  defaultBranch: "main",
  webUrl: "https://github.com/contoso/shop",
  isPrivate: true,
  cloneUrl: "https://github.com/contoso/shop.git",
};

const runRepository: RunRepositorySnapshot = {
  id: "0199a5f0-0000-7000-8000-0000000000f1",
  connectionId: CONNECTION_ID,
  provider: "github",
  externalId: repositoryInfo.externalId,
  fullName: repositoryInfo.fullName,
  webUrl: repositoryInfo.webUrl,
  cloneUrl: repositoryInfo.cloneUrl,
  defaultBranch: "main",
  branch: "feat/csv-export",
  baseBranch: "develop",
  pullRequest: null,
};

const apiRepositoryInfo: RepositoryInfo = {
  ...repositoryInfo,
  externalId: "123457",
  fullName: "contoso/api",
  name: "api",
  webUrl: "https://github.com/contoso/api",
  cloneUrl: "https://github.com/contoso/api.git",
};

const apiRunRepository: RunRepositorySnapshot = {
  ...runRepository,
  id: "0199a5f0-0000-7000-8000-0000000000f2",
  externalId: apiRepositoryInfo.externalId,
  fullName: apiRepositoryInfo.fullName,
  webUrl: apiRepositoryInfo.webUrl,
  cloneUrl: apiRepositoryInfo.cloneUrl,
  branch: "feat/csv-export-api",
  baseBranch: "main",
};

function createRepositories(
  overrides: Partial<
    IntegrationRepositoriesDefinition<JsonObject, JsonObject>
  > = {}
) {
  return {
    list: vi.fn(() => Promise.resolve([repositoryInfo])),
    get: vi.fn(() => Promise.resolve<RepositoryInfo | null>(repositoryInfo)),
    gitCredential: vi.fn(() =>
      Promise.resolve({ username: "x", password: "y", expiresAt: null })
    ),
    createPullRequest: vi.fn((_ctx: unknown, _request: PullRequestRequest) =>
      Promise.resolve({
        ok: true as const,
        value: {
          url: "https://github.com/contoso/shop/pull/42",
          number: 42,
          externalId: "987654",
          existing: false,
        },
      })
    ),
    ...overrides,
  };
}

function runSnapshot(
  overrides: Partial<WorkflowRunSnapshot> = {}
): WorkflowRunSnapshot {
  return {
    id: "0199a5f0-0000-7000-8000-0000000000a1",
    url: "https://agentflow.example.com/contoso/workflows/w1/runs/r1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "w1", name: "Jira to PR" },
    trigger: null,
    source: {
      provider: "jira",
      externalId: "10042",
      key: "SHOP-42",
      url: "https://contoso.atlassian.net/browse/SHOP-42",
      title: "Export orders as CSV",
      container: "SHOP",
    },
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: null,
    pullRequests: [],
    repositories: [runRepository],
    repository: runRepository,
    error: null,
    step: null,
    reply: null,
    documents: [],
    releaseNotes: null,
    stepReplies: {},
    summaryMarkdown: "done",
    startedAt: "2026-10-05T10:00:00.000Z",
    completedAt: "2026-10-05T11:00:00.000Z",
    ...overrides,
  };
}

function actionContext(
  run: WorkflowRunSnapshot,
  config: JsonObject = {}
): ActionContext<
  ReturnType<typeof createPullRequestConfigSchema.parse>,
  JsonObject,
  JsonObject
> {
  return {
    connection: {
      id: CONNECTION_ID,
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: "github",
      name: "GitHub",
      config: {},
      secrets: {},
      account: null,
    },
    http: createProviderHttp(vi.fn()),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-05T11:00:00.000Z"),
    config: createPullRequestConfigSchema.parse(config),
    run,
    actionRunId: "0199a5f0-0000-7000-8000-0000000000b1",
    attempt: 1,
    render: (template) =>
      template
        .replaceAll("{{source.key}}", run.source.key)
        .replaceAll("{{source.title}}", run.source.title ?? "")
        .replaceAll("{{source.url}}", run.source.url ?? "")
        .replaceAll("{{plan.url}}", "")
        .replaceAll("{{run.url}}", run.url),
  };
}

function defineAction(repositories = createRepositories()) {
  return {
    repositories,
    action: definePullRequestAction<JsonObject, JsonObject>({
      key: "github.create_pull_request",
      providerName: "GitHub",
      repositories,
    }),
  };
}

describe("create pull request action", () => {
  it("opens a pull request from the pushed branch into the run's base branch", async () => {
    const { action, repositories } = defineAction();

    const result = await action.execute(actionContext(runSnapshot()));

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "https://github.com/contoso/shop/pull/42",
      detail: "Opened pull request contoso/shop#42",
      outputs: {
        pullRequests: [
          {
            repositoryId: runRepository.id,
            url: "https://github.com/contoso/shop/pull/42",
            number: 42,
            branch: "feat/csv-export",
            title: "SHOP-42: Export orders as CSV",
          },
        ],
      },
    });
    expect(repositories.get).toHaveBeenCalledWith(
      expect.anything(),
      repositoryInfo.externalId
    );
    expect(
      vi.mocked(repositories.createPullRequest).mock.calls[0]?.[1]
    ).toEqual({
      repository: repositoryInfo,
      sourceBranch: "feat/csv-export",
      targetBranch: "develop",
      title: "SHOP-42: Export orders as CSV",
      description: [
        "Resolves SHOP-42: https://contoso.atlassian.net/browse/SHOP-42",
        "",
        "Implementation plan: ",
        "AgentFlow run: https://agentflow.example.com/contoso/workflows/w1/runs/r1",
      ].join("\n"),
      draft: false,
    });
  });

  it("uses the configured target branch and draft flag, and bounds title and description", async () => {
    const { action, repositories } = defineAction();
    const run = runSnapshot({
      source: { ...runSnapshot().source, title: "x".repeat(400) },
    });

    await action.execute(
      actionContext(run, {
        targetBranch: "release/2026.10",
        draft: true,
        description:
          "{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}{{source.title}}",
      })
    );

    const request = vi.mocked(repositories.createPullRequest).mock
      .calls[0]?.[1];
    expect(request?.targetBranch).toBe("release/2026.10");
    expect(request?.draft).toBe(true);
    expect(request?.title.length).toBeLessThanOrEqual(PULL_REQUEST_TITLE_MAX);
    expect(request?.description.length).toBeLessThanOrEqual(
      PULL_REQUEST_DESCRIPTION_MAX
    );
  });

  it("falls back to the repository's default branch", async () => {
    const { action, repositories } = defineAction();

    await action.execute(
      actionContext(
        runSnapshot({ repositories: [{ ...runRepository, baseBranch: "" }] })
      )
    );

    expect(
      vi.mocked(repositories.createPullRequest).mock.calls[0]?.[1].targetBranch
    ).toBe("main");
  });

  it("reports a pull request that was already open", async () => {
    const { action } = defineAction(
      createRepositories({
        createPullRequest: vi.fn(() =>
          Promise.resolve({
            ok: true as const,
            value: {
              url: "https://github.com/contoso/shop/pull/41",
              number: 41,
              externalId: "987653",
              existing: true,
            },
          })
        ),
      })
    );

    const result = await action.execute(actionContext(runSnapshot()));

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: "Pull request contoso/shop#41 was already open",
    });
  });

  it("opens a pull request in every repository of its connection that was pushed", async () => {
    const repositories = createRepositories({
      get: vi.fn((_ctx: unknown, externalId: string) =>
        Promise.resolve(
          externalId === apiRepositoryInfo.externalId
            ? apiRepositoryInfo
            : repositoryInfo
        )
      ),
      createPullRequest: vi.fn((_ctx: unknown, request: PullRequestRequest) =>
        Promise.resolve({
          ok: true as const,
          value: {
            url: `${request.repository.webUrl}/pull/7`,
            number: 7,
            externalId: "1",
            existing: false,
          },
        })
      ),
    });
    const { action } = defineAction(repositories);
    const run = runSnapshot({
      repositories: [
        runRepository,
        {
          ...runRepository,
          id: "unchanged",
          fullName: "contoso/docs",
          branch: null,
        },
        apiRunRepository,
        {
          ...apiRunRepository,
          id: "elsewhere",
          connectionId: OTHER_CONNECTION_ID,
        },
      ],
    });

    const result = await action.execute(actionContext(run));

    expect(
      vi
        .mocked(repositories.createPullRequest)
        .mock.calls.map(([, request]) => [
          request.repository.fullName,
          request.sourceBranch,
          request.targetBranch,
        ])
    ).toEqual([
      ["contoso/shop", "feat/csv-export", "develop"],
      ["contoso/api", "feat/csv-export-api", "main"],
    ]);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "https://github.com/contoso/shop/pull/7",
      detail:
        "Opened pull request contoso/shop#7; Opened pull request contoso/api#7",
      outputs: {
        pullRequests: [
          {
            repositoryId: runRepository.id,
            url: "https://github.com/contoso/shop/pull/7",
            number: 7,
            branch: "feat/csv-export",
            title: "SHOP-42: Export orders as CSV",
          },
          {
            repositoryId: apiRunRepository.id,
            url: "https://github.com/contoso/api/pull/7",
            number: 7,
            branch: "feat/csv-export-api",
            title: "SHOP-42: Export orders as CSV",
          },
        ],
      },
    });
  });

  it("reports the pull requests it opened when another repository fails", async () => {
    const { action } = defineAction(
      createRepositories({
        get: vi.fn((_ctx: unknown, externalId: string) =>
          Promise.resolve(
            externalId === apiRepositoryInfo.externalId ? null : repositoryInfo
          )
        ),
      })
    );

    const result = await action.execute(
      actionContext(
        runSnapshot({ repositories: [runRepository, apiRunRepository] })
      )
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "contoso/api no longer exists or the connection cannot access it",
      retryable: false,
      outputs: {
        pullRequests: [
          {
            repositoryId: runRepository.id,
            url: "https://github.com/contoso/shop/pull/42",
            number: 42,
            branch: "feat/csv-export",
            title: "SHOP-42: Export orders as CSV",
          },
        ],
      },
    });
  });

  it.each([
    [
      "the run has no repository",
      runSnapshot({ repositories: [] }),
      "The run has no repository yet. Run this action on workflow.completed.",
    ],
    [
      "the repositories belong to another connection",
      runSnapshot({
        repositories: [{ ...runRepository, connectionId: OTHER_CONNECTION_ID }],
      }),
      "The run's repositories belong to other connections",
    ],
    [
      "no branch was pushed",
      runSnapshot({ repositories: [{ ...runRepository, branch: null }] }),
      "The agent team did not push a branch",
    ],
    [
      "every pushed repository already has a pull request",
      runSnapshot({
        repositories: [
          {
            ...runRepository,
            pullRequest: {
              url: "https://github.com/contoso/shop/pull/40",
              number: 40,
            },
          },
        ],
      }),
      "The run already has its pull requests: https://github.com/contoso/shop/pull/40",
    ],
    [
      "the agent team pushed to the target branch",
      runSnapshot({
        repositories: [{ ...runRepository, branch: "develop" }],
      }),
      "contoso/shop: the agent team pushed to develop, the target branch itself",
    ],
  ])("skips when %s", async (_case, run, reason) => {
    const { action, repositories } = defineAction();

    const result = await action.execute(actionContext(run));

    expect(result).toEqual({ status: WorkflowActionRunStatus.Skipped, reason });
    expect(repositories.createPullRequest).not.toHaveBeenCalled();
  });

  it("fails without retry when the repository is gone", async () => {
    const { action } = defineAction(
      createRepositories({ get: vi.fn(() => Promise.resolve(null)) })
    );

    const result = await action.execute(actionContext(runSnapshot()));

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "contoso/shop no longer exists or the connection cannot access it",
      retryable: false,
      outputs: { pullRequests: [] },
    });
  });

  it("passes the provider's retryable flag through and never throws", async () => {
    const rejected = defineAction(
      createRepositories({
        createPullRequest: vi.fn(() =>
          Promise.resolve({
            ok: false as const,
            error: "GitHub is unavailable (HTTP 502)",
            retryable: true,
          })
        ),
      })
    );
    const throwing = defineAction(
      createRepositories({
        get: vi.fn(() => Promise.reject(new Error("socket hang up"))),
      })
    );

    const failed = await rejected.action.execute(actionContext(runSnapshot()));
    const crashed = await throwing.action.execute(actionContext(runSnapshot()));

    expect(failed).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "contoso/shop: could not open the pull request: GitHub is unavailable (HTTP 502)",
      retryable: true,
      outputs: { pullRequests: [] },
    });
    expect(crashed).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: "Could not read contoso/shop: socket hang up",
      retryable: true,
      outputs: { pullRequests: [] },
    });
  });
});
