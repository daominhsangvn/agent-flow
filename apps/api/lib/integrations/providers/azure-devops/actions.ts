import {
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import { truncateText } from "../../markdown";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
  HttpMethod,
  type WorkflowRunSnapshot,
} from "../../types";
import {
  ADO_API_VERSION,
  ADO_COMMENTS_API_VERSION,
  type AdoContext,
  type AdoError,
  AdoErrorKind,
  adoRequest,
  JSON_PATCH_CONTENT_TYPE,
  projectSegment,
} from "./client";
import {
  AdoField,
  AdoTextFormat,
  AzureDevOpsActionType,
  JsonPatchOperation,
} from "./constants";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoCreatedCommentSchema,
  adoWorkItemSchema,
  parseWorkItemId,
  readWorkItemFields,
  urlBelongsToOrganization,
} from "./schemas";

/**
 * Actions on the work item that started the run, usable as pre actions
 * (run.triggered, before the agent team: no plan or pull request yet) and as
 * post actions. Both skip runs whose source is not an Azure DevOps work item
 * of this connection's organization, and never throw: every failure maps to
 * an ActionResult.
 */

export const DEFAULT_COMMENT_TEMPLATE = "{{summary}}";
export const ADO_COMMENT_MAX_LENGTH = 100_000;

export const addCommentConfigSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Enter the comment")
    .max(ADO_COMMENT_MAX_LENGTH)
    .default(DEFAULT_COMMENT_TEMPLATE),
});
export type AddCommentConfig = z.infer<typeof addCommentConfigSchema>;

export const updateStateConfigSchema = z.object({
  state: z.string().trim().min(1, "Enter the state").max(128),
});
export type UpdateStateConfig = z.infer<typeof updateStateConfigSchema>;

type AdoActionContext<TConfig> = ActionContext<
  TConfig,
  AdoConnectionConfig,
  AdoSecrets
>;

export const addCommentAction = defineAction<
  AddCommentConfig,
  AdoConnectionConfig,
  AdoSecrets
>({
  key: AzureDevOpsActionType.AddComment,
  displayName: "Comment on the work item",
  description:
    "Adds a markdown comment, written by the bot account, to the Azure DevOps work item that started the run.",
  configSchema: addCommentConfigSchema,
  configFields: [
    {
      key: "message",
      label: "Comment",
      kind: IntegrationFieldKind.Template,
      required: true,
      defaultValue: DEFAULT_COMMENT_TEMPLATE,
      description:
        "Markdown. {{summary}} is a ready-made message for each run event (pull request link, open questions, failure reason).",
    },
  ],
  defaultEvents: [
    WorkflowRunEvent.Started,
    WorkflowRunEvent.NeedsInput,
    WorkflowRunEvent.Succeeded,
    WorkflowRunEvent.Failed,
  ],
  execute: executeAddComment,
});

export const updateStateAction = defineAction<
  UpdateStateConfig,
  AdoConnectionConfig,
  AdoSecrets
>({
  key: AzureDevOpsActionType.UpdateState,
  displayName: "Change the work item state",
  description:
    "Moves the Azure DevOps work item that started the run to a state, e.g. Resolved or In Review.",
  configSchema: updateStateConfigSchema,
  configFields: [
    {
      key: "state",
      label: "State",
      kind: IntegrationFieldKind.Text,
      required: true,
      placeholder: "Resolved",
      description:
        "Name of a state of the work item's type in its process (for example Active, Resolved, Done).",
    },
  ],
  defaultEvents: [WorkflowRunEvent.Succeeded],
  execute: executeUpdateState,
});

type ActionTarget = { workItemId: number; project: string | null };

async function executeAddComment(
  ctx: AdoActionContext<AddCommentConfig>
): Promise<ActionResult> {
  const target = resolveTarget(ctx.run, ctx.connection.config.organizationUrl);
  if (!target.ok) {
    return target.error;
  }
  const text = truncateText(
    ctx.render(ctx.config.message).trim(),
    ADO_COMMENT_MAX_LENGTH
  );
  if (!text) {
    return skipped("The comment is empty after rendering the template");
  }
  const project = await resolveProject(ctx, target.value);
  if (!project.ok) {
    return failed(project.error, "Could not find the work item's project");
  }
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: `${projectSegment(project.value)}/_apis/wit/workItems/${target.value.workItemId}/comments`,
      query: {
        format: AdoTextFormat.Markdown,
        "api-version": ADO_COMMENTS_API_VERSION,
      },
      body: { text },
    },
    adoCreatedCommentSchema
  );
  if (!result.ok) {
    return failed(result.error, "Could not add the comment");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: String(result.value.id),
    detail: `Comment added to #${target.value.workItemId}`,
  };
}

async function executeUpdateState(
  ctx: AdoActionContext<UpdateStateConfig>
): Promise<ActionResult> {
  const target = resolveTarget(ctx.run, ctx.connection.config.organizationUrl);
  if (!target.ok) {
    return target.error;
  }
  const { state } = ctx.config;
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Patch,
      path: `_apis/wit/workitems/${target.value.workItemId}`,
      query: { "api-version": ADO_API_VERSION },
      body: [
        {
          op: JsonPatchOperation.Add,
          path: `/fields/${AdoField.State}`,
          value: state,
        },
      ],
      contentType: JSON_PATCH_CONTENT_TYPE,
    },
    adoWorkItemSchema
  );
  if (!result.ok) {
    return failed(result.error, `Could not set the state to "${state}"`);
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: workItemRevisionRef(target.value.workItemId, result.value.rev),
    detail: `State of #${target.value.workItemId} set to "${state}"`,
  };
}

function resolveTarget(
  run: WorkflowRunSnapshot,
  organizationUrl: string
): Result<ActionTarget, ActionResult> {
  if (run.source.provider !== IntegrationProviderKey.AzureDevOps) {
    return Result.err(
      skipped("The run's source is not an Azure DevOps work item")
    );
  }
  if (
    run.source.url &&
    !urlBelongsToOrganization(run.source.url, organizationUrl)
  ) {
    return Result.err(
      skipped(
        "The work item belongs to a different Azure DevOps organization than this connection"
      )
    );
  }
  const workItemId = parseWorkItemId(run.source.externalId);
  if (workItemId === null) {
    return Result.err({
      status: WorkflowActionRunStatus.Failed,
      error: `Invalid Azure DevOps work item id "${run.source.externalId}"`,
      retryable: false,
    });
  }
  return Result.ok({ workItemId, project: run.source.container });
}

/** The Comments API needs the project in the path; older runs may not carry it. */
async function resolveProject(
  ctx: AdoContext,
  target: ActionTarget
): Promise<Result<string, AdoError>> {
  if (target.project) {
    return Result.ok(target.project);
  }
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `_apis/wit/workitems/${target.workItemId}`,
      query: { "api-version": ADO_API_VERSION },
    },
    adoWorkItemSchema
  );
  if (!result.ok) {
    return result;
  }
  const project = readWorkItemFields(result.value.fields)[AdoField.TeamProject];
  if (project) {
    return Result.ok(project);
  }
  return Result.err({
    kind: AdoErrorKind.InvalidResponse,
    status: 200,
    message: "Azure DevOps returned no project for the work item",
    retryable: false,
  });
}

function skipped(reason: string): ActionResult {
  return { status: WorkflowActionRunStatus.Skipped, reason };
}

function failed(error: AdoError, context: string): ActionResult {
  return {
    status: WorkflowActionRunStatus.Failed,
    error: `${context}: ${error.message}`,
    retryable: error.retryable,
  };
}

function workItemRevisionRef(
  workItemId: number,
  rev: number | null | undefined
): string {
  return rev ? `${workItemId}:rev:${rev}` : String(workItemId);
}
