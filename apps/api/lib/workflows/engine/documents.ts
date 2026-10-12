import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { resetDocumentRoom } from "@/app/documents/room-utils";
import {
  type ActivityActor,
  captureArtifactCreation,
} from "@/lib/artifact-activity-capture";
import { getIntegrationProvider } from "@/lib/integrations/registry";
import type { SourceItem } from "@/lib/integrations/types";
import { waitUntil } from "@/lib/wait-until";
import { runError } from "./errors";
import {
  buildIssueBody,
  buildIssueTitle,
  buildPrdBody,
} from "./issue-document";
import {
  deliveredSourceStatus,
  importedSourceStatus,
  sourceDocumentLabel,
  sourceDocumentType,
} from "./source-document";

/**
 * Source and implementation-plan documents of a run. The source item is
 * imported as an Issue (FEATURE), or as a PRD when the item is a product
 * requirement (source-document.ts); the plan is generated from it. Creation
 * is idempotent: ids already stored on the run are reused, so a retried
 * `ingesting` step never creates a second pair. On resume (cycle > 1) the
 * source document is refreshed from the item and the plan document is
 * reused. The plan document is only made for a process with a AgentFlow plan
 * step (the built-in flow always has one).
 */

export type RunDocumentsInput = {
  run: {
    id: string;
    organizationId: string;
    cycle: number;
    featureDocumentId: string | null;
    planDocumentId: string | null;
  };
  workflowName: string;
  projectId: string;
  runAsUserId: string;
  agent: WorkflowAgentConfig;
  item: SourceItem;
  /** The run's process has a AgentFlow plan step. */
  withPlanDocument: boolean;
};

export type RunDocuments = {
  featureDocumentId: string;
  /** Null for a process without a AgentFlow plan step. */
  planDocumentId: string | null;
};

export async function ensureRunDocuments(
  input: RunDocumentsInput
): Promise<Result<RunDocuments, WorkflowRunError>> {
  try {
    return await prepareRunDocuments(input);
  } catch (error) {
    log.warn("[workflows/documents] Could not prepare the run documents", {
      organizationId: input.run.organizationId,
      runId: input.run.id,
      error,
    });
    return Result.err(
      runError(
        WorkflowRunErrorCode.DocumentCreateFailed,
        `The run documents could not be prepared: ${parseError(error)}`
      )
    );
  }
}

/** Approves the plan so EXECUTE runs against an approved plan, like the UI flow. */
export async function approvePlanDocument(
  planDocumentId: string,
  organizationId: string
): Promise<void> {
  await documentService.update(planDocumentId, organizationId, {
    status: DocumentStatus.Approved,
  });
}

/**
 * Once the implementation PR is open: the Issue moves to in review, a PRD to
 * executed. Best effort.
 */
export async function markIssueInReview(
  featureDocumentId: string,
  organizationId: string
): Promise<void> {
  try {
    const source = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: featureDocumentId, organizationId },
        select: { subtype: true },
      })
    );
    if (!source) {
      return;
    }
    await documentService.update(featureDocumentId, organizationId, {
      status: deliveredSourceStatus(source.subtype),
    });
  } catch (error) {
    log.warn(
      "[workflows/documents] Could not mark the source document delivered",
      { organizationId, featureDocumentId, error }
    );
  }
}

/** Engine-created documents are attributed to an agent in the activity feed. */
const ENGINE_ACTOR_AUTH_METHOD: ActivityActor["authMethod"] = "api_key";

async function prepareRunDocuments(
  input: RunDocumentsInput
): Promise<Result<RunDocuments, WorkflowRunError>> {
  const title = buildIssueTitle(
    input.agent.titleTemplate,
    input.item,
    input.workflowName
  );
  const bodyContext = {
    item: input.item,
    providerDisplayName:
      getIntegrationProvider(input.item.provider)?.displayName ??
      input.item.provider,
    workflowName: input.workflowName,
    instructions: input.agent.instructions,
  };
  const type = sourceDocumentType(input.item);
  const content =
    type === DocumentType.Prd
      ? buildPrdBody(bodyContext)
      : buildIssueBody(bodyContext);

  const featureDocumentId = await resolveFeatureDocument(input, title, content);
  if (!featureDocumentId) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.DocumentCreateFailed,
        `The ${sourceDocumentLabel(type)} document could not be created in the workflow project.`
      )
    );
  }

  if (!input.withPlanDocument) {
    return Result.ok({
      featureDocumentId,
      planDocumentId: input.run.planDocumentId,
    });
  }
  const planDocumentId =
    input.run.planDocumentId ??
    (await createPlanDocument(input, featureDocumentId, title));
  if (!planDocumentId) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.DocumentCreateFailed,
        "The implementation plan document could not be created in the workflow project."
      )
    );
  }
  return Result.ok({ featureDocumentId, planDocumentId });
}

async function resolveFeatureDocument(
  input: RunDocumentsInput,
  title: string,
  content: string
): Promise<string | null> {
  const existingId = input.run.featureDocumentId;
  if (!existingId) {
    return await createFeatureDocument(input, title, content);
  }
  if (input.run.cycle > 1) {
    await refreshFeatureDocument(input, existingId, title, content);
  }
  return existingId;
}

async function createFeatureDocument(
  input: RunDocumentsInput,
  title: string,
  content: string
): Promise<string | null> {
  const repository = input.agent.repository;
  const type = sourceDocumentType(input.item);
  const document = await documentService.create(
    input.run.organizationId,
    input.runAsUserId,
    {
      type,
      title,
      content,
      projectId: input.projectId,
      status: importedSourceStatus(type),
      ...(repository
        ? {
            repositorySelection: {
              primary: {
                fullName: repository.fullName,
                branch: repository.branch,
              },
            },
          }
        : {}),
    }
  );
  if (!document) {
    return null;
  }
  await saveRunDocumentIds(input.run.id, { featureDocumentId: document.id });
  recordCreation(input, document.id, document.status, document.title);
  return document.id;
}

async function createPlanDocument(
  input: RunDocumentsInput,
  featureDocumentId: string,
  issueTitle: string
): Promise<string | null> {
  const document = await documentService.create(
    input.run.organizationId,
    input.runAsUserId,
    {
      type: DocumentType.ImplementationPlan,
      title: `Plan: ${issueTitle}`,
      content: "",
      sourceId: featureDocumentId,
      projectId: input.projectId,
      status: DocumentStatus.Draft,
    }
  );
  if (!document) {
    return null;
  }
  await saveRunDocumentIds(input.run.id, { planDocumentId: document.id });
  recordCreation(input, document.id, document.status, document.title);
  return document.id;
}

/** Resume: new title and a new content version from the re-fetched item. */
async function refreshFeatureDocument(
  input: RunDocumentsInput,
  featureDocumentId: string,
  title: string,
  content: string
): Promise<void> {
  const organizationId = input.run.organizationId;
  await documentService.update(featureDocumentId, organizationId, { title });
  const detail = await documentVersionService.createNewVersion(
    featureDocumentId,
    organizationId,
    input.runAsUserId,
    content
  );
  if (detail) {
    // Clear the collaborative room so editors re-seed from the new version.
    waitUntil(resetDocumentRoom(detail, input.runAsUserId));
  }
}

async function saveRunDocumentIds(
  runId: string,
  data: { featureDocumentId?: string; planDocumentId?: string }
): Promise<void> {
  await withDb((db) =>
    db.workflowRun.updateMany({ where: { id: runId }, data })
  );
}

function recordCreation(
  input: RunDocumentsInput,
  artifactId: string,
  status: string,
  title: string
): void {
  captureArtifactCreation({
    organizationId: input.run.organizationId,
    artifactId,
    actor: {
      userId: input.runAsUserId,
      authMethod: ENGINE_ACTOR_AUTH_METHOD,
    },
    after: { status, title },
  });
}
