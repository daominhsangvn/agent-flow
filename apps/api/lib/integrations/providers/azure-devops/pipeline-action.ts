import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
  HttpMethod,
} from "../../types";
import { ADO_API_VERSION, adoRequest, projectSegment } from "./client";
import { AzureDevOpsActionType } from "./constants";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoPipelineRunSchema,
} from "./schemas";

/**
 * "Run a pipeline": queues an Azure Pipelines run, by default on the branch
 * the agent team pushed when the run's repository belongs to this
 * connection. Needs the Build (Read & execute) scope on the token.
 */

const REFS_HEADS = "refs/heads/";
/** HTTP statuses that prove the run was not queued, so a retry cannot start a second run. */
const NOT_QUEUED_STATUSES = new Set([429, 503]);

export const runPipelineConfigSchema = z.object({
  /** Empty: the project of the run's repository, else of the work item. */
  project: z.string().trim().max(256).default(""),
  pipelineId: z.coerce
    .number()
    .int("Enter the pipeline id")
    .positive("Enter the pipeline id"),
  /** Template; empty: the branch the agent team pushed, else the pipeline's default branch. */
  branch: z.string().trim().max(1000).default(""),
});
export type RunPipelineConfig = z.infer<typeof runPipelineConfigSchema>;

type PipelineActionContext = ActionContext<
  RunPipelineConfig,
  AdoConnectionConfig,
  AdoSecrets
>;

export const runPipelineAction = defineAction<
  RunPipelineConfig,
  AdoConnectionConfig,
  AdoSecrets
>({
  key: AzureDevOpsActionType.RunPipeline,
  displayName: "Run a pipeline",
  description:
    "Queues an Azure Pipelines run, by default on the branch the agent team pushed.",
  configSchema: runPipelineConfigSchema,
  configFields: [
    {
      key: "pipelineId",
      label: "Pipeline id",
      kind: IntegrationFieldKind.Number,
      required: true,
      description:
        "The number in the pipeline's URL (…/_build?definitionId=12 → 12).",
    },
    {
      key: "project",
      label: "Project",
      kind: IntegrationFieldKind.Text,
      placeholder: "Fabrikam Web",
      description:
        "Leave empty to use the project of the run's repository, or of the work item that started the run.",
    },
    {
      key: "branch",
      label: "Branch",
      kind: IntegrationFieldKind.Template,
      description:
        "Leave empty to use the branch the agent team pushed (or the pipeline's default branch when there is none).",
    },
  ],
  defaultEvents: [WorkflowRunEvent.Succeeded],
  execute: executeRunPipeline,
});

async function executeRunPipeline(
  ctx: PipelineActionContext
): Promise<ActionResult> {
  const project = resolveProject(ctx);
  if (!project) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      reason:
        "No Azure DevOps project: set the project of the action, or start the run from an Azure DevOps work item",
    };
  }
  const branch = resolveBranch(ctx);
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: `${projectSegment(project)}/_apis/pipelines/${ctx.config.pipelineId}/runs`,
      query: { "api-version": ADO_API_VERSION },
      body: branch
        ? { resources: { repositories: { self: { refName: toRef(branch) } } } }
        : {},
    },
    adoPipelineRunSchema
  );
  if (!result.ok) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: `Could not run pipeline ${ctx.config.pipelineId}: ${result.error.message}`,
      retryable: NOT_QUEUED_STATUSES.has(result.error.status),
    };
  }
  const run = result.value;
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: run._links?.web?.href ?? String(run.id),
    detail: `Queued pipeline run ${run.name ?? run.id}${branch ? ` on ${branch}` : ""}`,
  };
}

function resolveProject(ctx: PipelineActionContext): string | null {
  if (ctx.config.project) {
    return ctx.config.project;
  }
  const repository = ownRepository(ctx);
  if (repository) {
    const namespace = repository.fullName.slice(
      0,
      repository.fullName.lastIndexOf("/")
    );
    return namespace.slice(namespace.indexOf("/") + 1) || null;
  }
  return ctx.run.source.provider === ctx.connection.provider
    ? ctx.run.source.container
    : null;
}

function resolveBranch(ctx: PipelineActionContext): string | null {
  const rendered = ctx.config.branch
    ? ctx.render(ctx.config.branch).trim()
    : "";
  return rendered || ownRepository(ctx)?.branch || null;
}

/**
 * The run's first repository in this connection's organization that the
 * agent team pushed to, else its first one there.
 */
function ownRepository(ctx: PipelineActionContext) {
  const own = ctx.run.repositories.filter(
    (repository) => repository.connectionId === ctx.connection.id
  );
  return own.find((repository) => repository.branch) ?? own[0] ?? null;
}

function toRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `${REFS_HEADS}${branch}`;
}
