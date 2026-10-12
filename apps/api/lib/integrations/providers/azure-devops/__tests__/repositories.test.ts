import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  createActionContext,
  createAdoContext,
  createFakeAdo,
  type FakeRoute,
  runSnapshot,
  TEST_PAT,
  TEST_PROJECT,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import { ADO_TOKEN_REJECTED_MESSAGE } from "@/lib/integrations/providers/azure-devops/client";
import {
  runPipelineAction,
  runPipelineConfigSchema,
} from "@/lib/integrations/providers/azure-devops/pipeline-action";
import { adoRepositories } from "@/lib/integrations/providers/azure-devops/repositories";
import {
  HttpMethod,
  type RepositoryInfo,
  type RunRepositorySnapshot,
} from "@/lib/integrations/types";

const REPO_ID = "5febef5a-833d-4e14-b9c0-14cb638f91e6";
const OTHER_REPO_ID = "2f3d611a-f012-4b39-b157-8db63f380226";
const DISABLED_REPO_ID = "8a1c5b0e-0d3f-4d55-9a3e-7c2b1f0e9d44";
const REPO_WEB_URL = "https://dev.azure.com/contoso/Fabrikam%20Web/_git/shop";
const REPOSITORIES_PATH = "/contoso/_apis/git/repositories";
const PULL_REQUESTS_PATH = `/contoso/Fabrikam%20Web/_apis/git/repositories/${REPO_ID}/pullrequests`;
const PIPELINE_RUNS_PATH = "/contoso/Fabrikam%20Web/_apis/pipelines/12/runs";
const CONNECTION_ID = "5b0f9e1c-7c38-4d2c-9f61-1d9e0f3a2b7c";

/** GitRepository as REST 7.1 returns it. */
function gitRepository(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name,
    url: `https://dev.azure.com/contoso/_apis/git/repositories/${id}`,
    project: {
      id: "be9b3917-87e6-42a4-a549-2bc06a7a878f",
      name: TEST_PROJECT,
      state: "wellFormed",
      visibility: "private",
    },
    defaultBranch: "refs/heads/main",
    size: 1024,
    remoteUrl: `https://contoso@dev.azure.com/contoso/Fabrikam%20Web/_git/${name}`,
    sshUrl: `git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/${name}`,
    webUrl: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/${name}`,
    isDisabled: false,
    ...overrides,
  };
}

const repositoryList: FakeRoute = {
  method: HttpMethod.Get,
  path: REPOSITORIES_PATH,
  json: {
    value: [
      gitRepository(REPO_ID, "shop"),
      gitRepository(OTHER_REPO_ID, "api", { defaultBranch: undefined }),
      gitRepository(DISABLED_REPO_ID, "legacy", { isDisabled: true }),
      { id: "not-a-repository" },
    ],
    count: 4,
  },
};

const shopRepository: RepositoryInfo = {
  externalId: REPO_ID,
  fullName: `contoso/${TEST_PROJECT}/shop`,
  name: "shop",
  namespace: `contoso/${TEST_PROJECT}`,
  defaultBranch: "main",
  webUrl: REPO_WEB_URL,
  isPrivate: true,
  cloneUrl: "https://dev.azure.com/contoso/Fabrikam%20Web/_git/shop",
};

describe("adoRepositories.list", () => {
  it("lists enabled repositories as organization/project/name, sorted", async () => {
    const fake = createFakeAdo([repositoryList]);

    const repositories = await adoRepositories.list(createAdoContext(fake), {
      query: null,
      limit: 100,
    });

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      `contoso/${TEST_PROJECT}/api`,
      `contoso/${TEST_PROJECT}/shop`,
    ]);
    expect(repositories[1]).toEqual(shopRepository);
    expect(repositories[0]?.defaultBranch).toBeNull();
    const [request] = fake.requestsTo(HttpMethod.Get, REPOSITORIES_PATH);
    expect(request?.url.searchParams.get("api-version")).toBe("7.1");
  });

  it("filters by name and applies the limit", async () => {
    const fake = createFakeAdo([repositoryList]);
    const ctx = createAdoContext(fake);

    const filtered = await adoRepositories.list(ctx, {
      query: "SHOP",
      limit: 100,
    });
    const limited = await adoRepositories.list(ctx, { query: null, limit: 1 });

    expect(filtered.map((repository) => repository.name)).toEqual(["shop"]);
    expect(limited).toHaveLength(1);
  });

  it("throws a message pointing at the Code scope when the token is refused", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: REPOSITORIES_PATH, status: 401 },
    ]);

    await expect(
      adoRepositories.list(createAdoContext(fake), { query: null, limit: 10 })
    ).rejects.toThrow(
      `${ADO_TOKEN_REJECTED_MESSAGE}. Grant the personal access token the Code (Read & write) scope.`
    );
  });
});

describe("adoRepositories.get", () => {
  it("reads one repository by id", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: `${REPOSITORIES_PATH}/${REPO_ID}`,
        json: gitRepository(REPO_ID, "shop"),
      },
    ]);

    await expect(
      adoRepositories.get(createAdoContext(fake), REPO_ID)
    ).resolves.toEqual(shopRepository);
  });

  it("returns null for unknown, disabled and malformed ids", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: `${REPOSITORIES_PATH}/${REPO_ID}`,
        status: 404,
        json: { message: "TF401019: The Git repository does not exist." },
      },
      {
        method: HttpMethod.Get,
        path: `${REPOSITORIES_PATH}/${DISABLED_REPO_ID}`,
        json: gitRepository(DISABLED_REPO_ID, "legacy", { isDisabled: true }),
      },
    ]);
    const ctx = createAdoContext(fake);

    await expect(adoRepositories.get(ctx, REPO_ID)).resolves.toBeNull();
    await expect(
      adoRepositories.get(ctx, DISABLED_REPO_ID)
    ).resolves.toBeNull();
    await expect(adoRepositories.get(ctx, "../_apis/wit")).resolves.toBeNull();
    expect(fake.requests).toHaveLength(2);
  });
});

describe("adoRepositories.gitCredential", () => {
  it("issues the PAT with a placeholder user name", async () => {
    const fake = createFakeAdo([]);

    await expect(
      adoRepositories.gitCredential(createAdoContext(fake), shopRepository)
    ).resolves.toEqual({
      username: "agentflow",
      password: TEST_PAT,
      expiresAt: null,
    });
  });
});

describe("adoRepositories.createPullRequest", () => {
  const request = {
    repository: shopRepository,
    sourceBranch: "feat/csv-export",
    targetBranch: "main",
    title: "#4321: Export orders as CSV",
    description: "Resolves #4321",
    draft: true,
  };

  it("opens a pull request from the pushed branch", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: PULL_REQUESTS_PATH,
        json: { value: [], count: 0 },
      },
      {
        method: HttpMethod.Post,
        path: PULL_REQUESTS_PATH,
        status: 201,
        json: { pullRequestId: 77, status: "active" },
      },
    ]);

    const result = await adoRepositories.createPullRequest(
      createAdoContext(fake),
      request
    );

    expect(result).toEqual({
      ok: true,
      value: {
        url: `${REPO_WEB_URL}/pullrequest/77`,
        number: 77,
        externalId: "77",
        existing: false,
      },
    });
    const [search] = fake.requestsTo(HttpMethod.Get, PULL_REQUESTS_PATH);
    expect(search?.url.searchParams.get("searchCriteria.sourceRefName")).toBe(
      "refs/heads/feat/csv-export"
    );
    expect(search?.url.searchParams.get("searchCriteria.status")).toBe(
      "active"
    );
    const [create] = fake.requestsTo(HttpMethod.Post, PULL_REQUESTS_PATH);
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      sourceRefName: "refs/heads/feat/csv-export",
      targetRefName: "refs/heads/main",
      title: request.title,
      description: request.description,
      isDraft: true,
    });
  });

  it("returns the active pull request of the branch instead of opening another", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: PULL_REQUESTS_PATH,
        json: { value: [{ pullRequestId: 76 }], count: 1 },
      },
    ]);

    const result = await adoRepositories.createPullRequest(
      createAdoContext(fake),
      request
    );

    expect(result.ok && result.value).toMatchObject({
      number: 76,
      existing: true,
    });
    expect(fake.requestsTo(HttpMethod.Post, PULL_REQUESTS_PATH)).toHaveLength(
      0
    );
  });

  it("reports a rejected pull request as a non-retryable error", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: PULL_REQUESTS_PATH,
        json: { value: [] },
      },
      {
        method: HttpMethod.Post,
        path: PULL_REQUESTS_PATH,
        status: 400,
        json: {
          message:
            "TF401398: The pull request cannot be activated because the source and/or the target branch no longer exists.",
        },
      },
    ]);

    const result = await adoRepositories.createPullRequest(
      createAdoContext(fake),
      request
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Azure DevOps rejected the request (HTTP 400): TF401398: The pull request cannot be activated because the source and/or the target branch no longer exists.",
      retryable: false,
    });
  });
});

describe("azure_devops.run_pipeline", () => {
  const repository: RunRepositorySnapshot = {
    id: "0199a5f0-0000-7000-8000-0000000000f9",
    connectionId: CONNECTION_ID,
    provider: "azure_devops",
    externalId: REPO_ID,
    fullName: `contoso/${TEST_PROJECT}/shop`,
    webUrl: REPO_WEB_URL,
    cloneUrl: shopRepository.cloneUrl,
    defaultBranch: "main",
    branch: "feat/csv-export",
    baseBranch: "main",
    pullRequest: null,
  };
  const pipelineRun: FakeRoute = {
    method: HttpMethod.Post,
    path: PIPELINE_RUNS_PATH,
    json: {
      id: 1203,
      name: "20261005.1",
      state: "inProgress",
      _links: {
        web: {
          href: "https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=1203",
        },
      },
    },
  };

  it("runs the pipeline on the branch the agent team pushed", async () => {
    const fake = createFakeAdo([pipelineRun]);
    const config = runPipelineConfigSchema.parse({ pipelineId: "12" });

    const result = await runPipelineAction.execute(
      createActionContext(
        fake,
        config,
        runSnapshot({ repositories: [repository] })
      )
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef:
        "https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=1203",
      detail: "Queued pipeline run 20261005.1 on feat/csv-export",
    });
    const [request] = fake.requestsTo(HttpMethod.Post, PIPELINE_RUNS_PATH);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      resources: {
        repositories: { self: { refName: "refs/heads/feat/csv-export" } },
      },
    });
  });

  it("uses the work item's project and the default branch without a repository", async () => {
    const fake = createFakeAdo([pipelineRun]);
    const config = runPipelineConfigSchema.parse({ pipelineId: 12 });

    const result = await runPipelineAction.execute(
      createActionContext(fake, config, runSnapshot())
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    const [request] = fake.requestsTo(HttpMethod.Post, PIPELINE_RUNS_PATH);
    expect(JSON.parse(request?.body ?? "null")).toEqual({});
  });

  it("skips when no project can be determined", async () => {
    const fake = createFakeAdo([]);
    const config = runPipelineConfigSchema.parse({ pipelineId: 12 });
    const run = runSnapshot({
      source: { ...runSnapshot().source, provider: "jira", container: "SHOP" },
    });

    const result = await runPipelineAction.execute(
      createActionContext(fake, config, run)
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(fake.requests).toHaveLength(0);
  });

  it("retries only failures that prove the run was not queued", async () => {
    const config = runPipelineConfigSchema.parse({ pipelineId: 12 });
    const unavailable = createFakeAdo([
      { method: HttpMethod.Post, path: PIPELINE_RUNS_PATH, status: 503 },
    ]);
    const serverError = createFakeAdo([
      { method: HttpMethod.Post, path: PIPELINE_RUNS_PATH, status: 500 },
    ]);

    const retried = await runPipelineAction.execute(
      createActionContext(
        unavailable,
        config,
        runSnapshot({ repositories: [repository] })
      )
    );
    const final = await runPipelineAction.execute(
      createActionContext(
        serverError,
        config,
        runSnapshot({ repositories: [repository] })
      )
    );

    expect(retried).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: true,
    });
    expect(final).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
    });
  });
});
