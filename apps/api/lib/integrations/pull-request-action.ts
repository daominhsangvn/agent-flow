import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import {
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import { truncateText } from "./markdown";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
  type IntegrationActionDefinition,
  type IntegrationRepositoriesDefinition,
  type RepositoryInfo,
  type RunRepositorySnapshot,
} from "./types";

/**
 * "Create pull request", shared by every provider with repositories. The
 * agent team only commits and pushes a branch to each project repository it
 * changed; this action opens a pull request from each of those branches in
 * the repositories its connection owns, and reports them back to the run
 * (`outputs.pullRequests`) so later actions see them as {{pr.url}} (the
 * first) and {{pr.urls}}.
 */

/** GitHub allows 256 characters; Azure DevOps a little more. */
export const PULL_REQUEST_TITLE_MAX = 256;
/** Azure DevOps rejects descriptions over 4000 characters. */
export const PULL_REQUEST_DESCRIPTION_MAX = 4000;
const TEMPLATE_MAX = 8000;
const BRANCH_NAME_MAX = 255;
const WHITESPACE_RE = /\s+/g;

export const DEFAULT_PULL_REQUEST_DESCRIPTION = [
  "Resolves {{source.key}}: {{source.url}}",
  "",
  "Implementation plan: {{plan.url}}",
  "AgentFlow run: {{run.url}}",
].join("\n");

export const createPullRequestConfigSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Enter the title")
    .max(TEMPLATE_MAX)
    .default(WORKFLOW_DEFAULT_TITLE_TEMPLATE),
  description: z
    .string()
    .max(TEMPLATE_MAX)
    .default(DEFAULT_PULL_REQUEST_DESCRIPTION),
  /** Empty: the branch the run started from (the repository's default branch). */
  targetBranch: z.string().trim().max(BRANCH_NAME_MAX).default(""),
  draft: z.boolean().default(false),
});
export type CreatePullRequestConfig = z.infer<
  typeof createPullRequestConfigSchema
>;

export type PullRequestActionOptions<TConnectionConfig, TSecrets> = {
  key: string;
  /** "GitHub", "Azure DevOps": used in the description and messages. */
  providerName: string;
  repositories: IntegrationRepositoriesDefinition<TConnectionConfig, TSecrets>;
};

export function definePullRequestAction<TConnectionConfig, TSecrets>(
  options: PullRequestActionOptions<TConnectionConfig, TSecrets>
): IntegrationActionDefinition<
  CreatePullRequestConfig,
  TConnectionConfig,
  TSecrets
> {
  return defineAction<CreatePullRequestConfig, TConnectionConfig, TSecrets>({
    key: options.key,
    displayName: "Create pull request",
    description: `Opens a ${options.providerName} pull request in each project repository the agent team pushed a branch to. Later actions can link them with {{pr.url}} (the first) or {{pr.urls}}.`,
    configSchema: createPullRequestConfigSchema,
    configFields: [
      {
        key: "title",
        label: "Title",
        kind: IntegrationFieldKind.Template,
        required: true,
        defaultValue: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
      },
      {
        key: "description",
        label: "Description",
        kind: IntegrationFieldKind.Template,
        defaultValue: DEFAULT_PULL_REQUEST_DESCRIPTION,
        description: "Markdown.",
      },
      {
        key: "targetBranch",
        label: "Target branch",
        kind: IntegrationFieldKind.Text,
        placeholder: "main",
        description:
          "Leave empty to merge into the branch the run started from (the repository's default branch).",
      },
      {
        key: "draft",
        label: "Open as draft",
        kind: IntegrationFieldKind.Boolean,
        defaultValue: false,
      },
    ],
    defaultEvents: [WorkflowRunEvent.Succeeded],
    execute: (ctx) => executeCreatePullRequest(ctx, options),
  });
}

type PullRequestContext<TConnectionConfig, TSecrets> = ActionContext<
  CreatePullRequestConfig,
  TConnectionConfig,
  TSecrets
>;

async function executeCreatePullRequest<TConnectionConfig, TSecrets>(
  ctx: PullRequestContext<TConnectionConfig, TSecrets>,
  options: PullRequestActionOptions<TConnectionConfig, TSecrets>
): Promise<ActionResult> {
  const targets = resolveTargets(ctx);
  if (!targets.ok) {
    return targets.result;
  }
  const outcomes: RepositoryOutcome[] = [];
  // One repository at a time: a run has a handful, and each is a few
  // provider calls.
  for (const repository of targets.repositories) {
    outcomes.push(await openPullRequest(ctx, options, repository));
  }
  return summarizeOutcomes(outcomes);
}

type RepositoryOutcome =
  | {
      kind: "opened";
      repository: RunRepositorySnapshot;
      branch: string;
      url: string;
      number: number;
      existing: boolean;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string; retryable: boolean };

type PushedRepository = RunRepositorySnapshot & { branch: string };

async function openPullRequest<TConnectionConfig, TSecrets>(
  ctx: PullRequestContext<TConnectionConfig, TSecrets>,
  options: PullRequestActionOptions<TConnectionConfig, TSecrets>,
  repository: PushedRepository
): Promise<RepositoryOutcome> {
  const { branch } = repository;
  const info = await readRepository(ctx, options, repository);
  if (!info.ok) {
    return info.outcome;
  }
  const targetBranch =
    ctx.config.targetBranch ||
    repository.baseBranch ||
    info.repository.defaultBranch;
  if (!targetBranch) {
    return {
      kind: "failed",
      error: `${repository.fullName} has no default branch; set the target branch of the action`,
      retryable: false,
    };
  }
  if (targetBranch === branch) {
    return {
      kind: "skipped",
      reason: `${repository.fullName}: the agent team pushed to ${branch}, the target branch itself`,
    };
  }
  try {
    const result = await options.repositories.createPullRequest(ctx, {
      repository: info.repository,
      sourceBranch: branch,
      targetBranch,
      title: renderTitle(ctx),
      description: truncateText(
        ctx.render(ctx.config.description).trim(),
        PULL_REQUEST_DESCRIPTION_MAX
      ),
      draft: ctx.config.draft,
    });
    if (!result.ok) {
      return {
        kind: "failed",
        error: `${repository.fullName}: could not open the pull request: ${result.error}`,
        retryable: result.retryable,
      };
    }
    return {
      kind: "opened",
      repository,
      branch,
      url: result.value.url,
      number: result.value.number,
      existing: result.value.existing,
    };
  } catch (error) {
    return {
      kind: "failed",
      error: `${repository.fullName}: could not open the pull request: ${errorMessage(error)}`,
      retryable: true,
    };
  }
}

/**
 * One result for the action: succeeded when every pushed repository has its
 * pull request, failed (retryable when any failure is) as soon as one could
 * not be opened. The pull requests that were opened are reported either way,
 * so a retry finds them already open and the run links them.
 */
function summarizeOutcomes(outcomes: RepositoryOutcome[]): ActionResult {
  const opened = outcomes.filter((outcome) => outcome.kind === "opened");
  const failures = outcomes.filter((outcome) => outcome.kind === "failed");
  const outputs = {
    pullRequests: opened.map((outcome) => ({
      repositoryId: outcome.repository.id,
      url: outcome.url,
      number: outcome.number,
      branch: outcome.branch,
    })),
  };
  if (failures.length > 0) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: failures.map((failure) => failure.error).join("; "),
      retryable: failures.some((failure) => failure.retryable),
      outputs,
    };
  }
  const [first] = opened;
  if (!first) {
    return skipped(
      outcomes
        .map((outcome) => (outcome.kind === "skipped" ? outcome.reason : ""))
        .filter(Boolean)
        .join("; ")
    );
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: first.url,
    detail: opened.map(describeOpened).join("; "),
    outputs,
  };
}

function describeOpened(
  outcome: Extract<RepositoryOutcome, { kind: "opened" }>
): string {
  const name = `${outcome.repository.fullName}#${outcome.number}`;
  return outcome.existing
    ? `Pull request ${name} was already open`
    : `Opened pull request ${name}`;
}

type TargetResolution =
  | { ok: true; repositories: PushedRepository[] }
  | { ok: false; result: ActionResult };

/**
 * The run's repositories this connection owns that the agent team pushed a
 * branch to and that have no pull request yet.
 */
function resolveTargets<TConnectionConfig, TSecrets>(
  ctx: PullRequestContext<TConnectionConfig, TSecrets>
): TargetResolution {
  const { repositories } = ctx.run;
  if (repositories.length === 0) {
    return {
      ok: false,
      result: skipped(
        "The run has no repository yet. Run this action on run.succeeded."
      ),
    };
  }
  const own = repositories.filter(
    (repository) => repository.connectionId === ctx.connection.id
  );
  if (own.length === 0) {
    return {
      ok: false,
      result: skipped("The run's repositories belong to other connections"),
    };
  }
  const pushed = own.filter(
    (repository): repository is PushedRepository =>
      Boolean(repository.branch) && !repository.pullRequest
  );
  if (pushed.length === 0) {
    const withPullRequest = own.find((repository) => repository.pullRequest);
    return {
      ok: false,
      result: skipped(
        withPullRequest?.pullRequest
          ? `The run already has its pull requests: ${withPullRequest.pullRequest.url}`
          : "The agent team did not push a branch"
      ),
    };
  }
  return { ok: true, repositories: pushed };
}

type RepositoryRead =
  | { ok: true; repository: RepositoryInfo }
  | { ok: false; outcome: RepositoryOutcome };

async function readRepository<TConnectionConfig, TSecrets>(
  ctx: PullRequestContext<TConnectionConfig, TSecrets>,
  options: PullRequestActionOptions<TConnectionConfig, TSecrets>,
  repository: RunRepositorySnapshot
): Promise<RepositoryRead> {
  try {
    const info = await options.repositories.get(ctx, repository.externalId);
    if (!info) {
      return {
        ok: false,
        outcome: {
          kind: "failed",
          error: `${repository.fullName} no longer exists or the connection cannot access it`,
          retryable: false,
        },
      };
    }
    return { ok: true, repository: info };
  } catch (error) {
    return {
      ok: false,
      outcome: {
        kind: "failed",
        error: `Could not read ${repository.fullName}: ${errorMessage(error)}`,
        retryable: true,
      },
    };
  }
}

function renderTitle<TConnectionConfig, TSecrets>(
  ctx: PullRequestContext<TConnectionConfig, TSecrets>
): string {
  const title = ctx
    .render(ctx.config.title)
    .replaceAll(WHITESPACE_RE, " ")
    .trim();
  return truncateText(title || ctx.run.source.key, PULL_REQUEST_TITLE_MAX);
}

function skipped(reason: string): ActionResult {
  return { status: WorkflowActionRunStatus.Skipped, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
