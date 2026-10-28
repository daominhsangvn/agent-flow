import {
  LOOP_STEP_WORK_DIR,
  type LoopStepCollectedFile,
  LoopStepFile,
} from "@agentflow-ai/loops-api/loop-step";
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  type AgentProcessStep,
  ProcessDocumentType,
  type ProcessStep,
  type ProcessStepDocument,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
  type WorkflowRunPublishedDocument,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  createDocumentRecord,
  documentService,
  indexDocumentProjection,
} from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import {
  createDocumentRoom,
  resetDocumentRoom,
} from "@/app/documents/room-utils";
import {
  type ActivityActor,
  captureArtifactCreation,
} from "@/lib/artifact-activity-capture";
import { waitUntil } from "@/lib/wait-until";
import {
  renderTemplate,
  type TemplateVariables,
} from "@/lib/workflows/template";
import { runError } from "./errors";

/**
 * Documents the agent steps of a process publish (AgentProcessStep.document,
 * docs/workflows.md "Project process"): when a step's loop ends, one of the
 * files it collected becomes a document of the workflow's project (a PRD,
 * an Implementation Plan, a general document), produced by the run's Issue.
 * The Issue -> document link carries the run and the step, so later loops of
 * the step (after answers, after a rejection, in a later cycle) add versions
 * to the same document instead of creating another one.
 */

export type PublishStepDocumentInput = {
  run: {
    id: string;
    organizationId: string;
    featureDocumentId: string | null;
    runAsUserId: string | null;
  };
  projectId: string | null;
  step: AgentProcessStep;
  /** Files the step's loop collected. */
  files: readonly LoopStepCollectedFile[];
  /** {{issue.key}}, {{issue.title}}, {{issue.url}} for the title. */
  variables: TemplateVariables;
};

/**
 * Creates or versions the step's document. Ok(null) when the step publishes
 * none or did not write its file (e.g. it only asked questions this time).
 */
export async function publishStepDocument(
  input: PublishStepDocumentInput
): Promise<Result<WorkflowRunPublishedDocument | null, WorkflowRunError>> {
  const target = input.step.document;
  if (!target) {
    return Result.ok(null);
  }
  return await publishDocumentFile(input, target, input.step.id);
}

/** The documents the run's steps published, oldest first. */
export async function listRunDocuments(run: {
  id: string;
  organizationId: string;
  featureDocumentId: string | null;
}): Promise<WorkflowRunPublishedDocument[]> {
  const issueId = run.featureDocumentId;
  if (!issueId) {
    return [];
  }
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId: run.organizationId,
        sourceId: issueId,
        linkType: LinkType.Produces,
        metadata: { path: [RUN_ID_KEY], equals: run.id },
      },
      select: {
        metadata: true,
        target: { select: { id: true, name: true, slug: true, subtype: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  );
  return links.flatMap((link) => {
    const metadata = linkMetadataSchema.safeParse(link.metadata);
    const type = documentTypeSchema.safeParse(link.target.subtype);
    if (!(metadata.success && type.success)) {
      return [];
    }
    return [
      {
        id: link.target.id,
        slug: link.target.slug,
        title: link.target.name,
        type: type.data,
        stepId: metadata.data.stepId,
      },
    ];
  });
}

type PublishContext = {
  organizationId: string;
  runId: string;
  issueId: string;
  userId: string;
  projectId: string;
  stepId: string;
  target: ProcessStepDocument;
  content: string;
};

type ExistingDocument = { id: string; name: string; slug: string | null };

/** Keys of the Issue -> document link's metadata. */
const RUN_ID_KEY = "workflowRunId";
const STEP_ID_KEY = "stepId";

const linkMetadataSchema = z.object({
  [RUN_ID_KEY]: z.string(),
  [STEP_ID_KEY]: z.string(),
});

const documentTypeSchema = z.enum(ProcessDocumentType);

/** Engine-published documents are attributed to an agent in the activity feed. */
const ENGINE_ACTOR_AUTH_METHOD: ActivityActor["authMethod"] = "api_key";

async function resolveTitle(
  context: PublishContext,
  variables: TemplateVariables
): Promise<string> {
  const rendered = renderTemplate(context.target.title, variables).trim();
  if (rendered) {
    return rendered;
  }
  const issue = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: context.issueId, organizationId: context.organizationId },
      select: { name: true },
    })
  );
  return issue?.name ?? context.stepId;
}

async function findStepDocument(
  context: PublishContext
): Promise<ExistingDocument | null> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        organizationId: context.organizationId,
        sourceId: context.issueId,
        linkType: LinkType.Produces,
        AND: [
          { metadata: { path: [RUN_ID_KEY], equals: context.runId } },
          { metadata: { path: [STEP_ID_KEY], equals: context.stepId } },
        ],
      },
      select: { target: { select: { id: true, name: true, slug: true } } },
    })
  );
  return link?.target ?? null;
}

/** The document and its Issue link in one transaction; the room and search after it. */
async function createStepDocument(
  context: PublishContext,
  title: string
): Promise<WorkflowRunPublishedDocument | null> {
  const document = await withDb.tx(async (tx) => {
    const created = await createDocumentRecord(
      tx,
      context.organizationId,
      context.userId,
      {
        type: context.target.type,
        title,
        content: context.content,
        projectId: context.projectId,
        status: DocumentStatus.Draft,
      }
    );
    if (!created) {
      return null;
    }
    await tx.artifactLink.create({
      data: {
        organizationId: context.organizationId,
        sourceId: context.issueId,
        targetId: created.id,
        linkType: LinkType.Produces,
        metadata: {
          [RUN_ID_KEY]: context.runId,
          [STEP_ID_KEY]: context.stepId,
        },
      },
      select: { id: true },
    });
    return created;
  });
  if (!document) {
    return null;
  }
  await createDocumentRoom(document);
  indexDocumentProjection(document, context.content);
  captureArtifactCreation({
    organizationId: context.organizationId,
    artifactId: document.id,
    actor: { userId: context.userId, authMethod: ENGINE_ACTOR_AUTH_METHOD },
    after: { status: document.status, title: document.title },
  });
  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    type: context.target.type,
    stepId: context.stepId,
  };
}

/** A new version when the content changed (none on a retried settlement), and the title. */
async function updateStepDocument(
  context: PublishContext,
  existing: ExistingDocument,
  title: string
): Promise<WorkflowRunPublishedDocument> {
  const latest = await documentVersionService.getLatest(existing.id);
  if (latest?.content !== context.content) {
    const detail = await documentVersionService.createNewVersion(
      existing.id,
      context.organizationId,
      context.userId,
      context.content
    );
    if (detail) {
      // Clear the collaborative room so editors re-seed from the new version.
      waitUntil(resetDocumentRoom(detail, context.userId));
    }
  }
  if (existing.name !== title) {
    await documentService.update(existing.id, context.organizationId, {
      title,
    });
  }
  return {
    id: existing.id,
    slug: existing.slug,
    title,
    type: context.target.type,
    stepId: context.stepId,
  };
}

function publishError(step: PublishingStep, reason: string): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.DocumentCreateFailed,
    `The document of the "${step.name}" step could not be published: ${reason}`
  );
}

/** Where an implement step writes its release notes (docs/workflows.md "Step roles"). */
export const STEP_RELEASE_NOTES_FILE = `${LOOP_STEP_WORK_DIR}/${LoopStepFile.ReleaseNotes}`;

/**
 * Release notes are linked under the step id plus this suffix, so they never
 * collide with the step's own document (step ids have no dots).
 */
const RELEASE_NOTES_LINK_SUFFIX = ".release-notes";

const RELEASE_NOTES_TARGET: ProcessStepDocument = {
  type: ProcessDocumentType.Doc,
  path: STEP_RELEASE_NOTES_FILE,
  title: "Release notes: {{issue.key}} {{issue.title}}",
};

function releaseNotesLinkStepId(stepId: string): string {
  return `${stepId}${RELEASE_NOTES_LINK_SUFFIX}`;
}

/**
 * The release notes of an implement step as a general document of the
 * project: created on the first round, a new version on every later one.
 * Ok(null) when the step did not write them.
 */
export async function publishReleaseNotes(
  input: PublishReleaseNotesInput
): Promise<Result<WorkflowRunPublishedDocument | null, WorkflowRunError>> {
  return await publishDocumentFile(
    input,
    RELEASE_NOTES_TARGET,
    releaseNotesLinkStepId(input.step.id)
  );
}

/** True for the link step id of release notes (releaseNotesLinkStepId). */
export function isReleaseNotesLinkStepId(stepId: string): boolean {
  return stepId.endsWith(RELEASE_NOTES_LINK_SUFFIX);
}

/**
 * A plan step's plan as a new version of the run's plan document (when it
 * changed), so the plan is the same document an AgentFlow plan step writes.
 */
export async function publishRunPlanVersion(input: {
  run: {
    id: string;
    organizationId: string;
    planDocumentId: string;
    runAsUserId: string;
  };
  step: AgentProcessStep;
  file: LoopStepCollectedFile;
}): Promise<Result<null, WorkflowRunError>> {
  const { run, file } = input;
  if (file.truncated) {
    log.warn("[workflows/step-documents] Keeping a truncated plan", {
      organizationId: run.organizationId,
      runId: run.id,
      stepId: input.step.id,
    });
  }
  try {
    const latest = await documentVersionService.getLatest(run.planDocumentId);
    if (latest?.content !== file.content) {
      const detail = await documentVersionService.createNewVersion(
        run.planDocumentId,
        run.organizationId,
        run.runAsUserId,
        file.content
      );
      if (detail) {
        // Clear the collaborative room so editors re-seed from the new version.
        waitUntil(resetDocumentRoom(detail, run.runAsUserId));
      }
    }
    return Result.ok(null);
  } catch (error) {
    log.warn("[workflows/step-documents] Could not keep the step's plan", {
      organizationId: run.organizationId,
      runId: run.id,
      stepId: input.step.id,
      error,
    });
    return Result.err(
      runError(
        WorkflowRunErrorCode.DocumentCreateFailed,
        `The plan of the "${input.step.name}" step could not be kept: ${parseError(error)}`
      )
    );
  }
}

/** Creates or versions the document of one of the step's files. */
async function publishDocumentFile(
  input: PublishReleaseNotesInput,
  target: ProcessStepDocument,
  linkStepId: string
): Promise<Result<WorkflowRunPublishedDocument | null, WorkflowRunError>> {
  const file = input.files.find((candidate) => candidate.path === target.path);
  if (!file?.content.trim()) {
    return Result.ok(null);
  }
  const { run } = input;
  if (!(run.featureDocumentId && run.runAsUserId && input.projectId)) {
    return Result.err(
      publishError(input.step, "the run has no Issue or project to add it to")
    );
  }
  if (file.truncated) {
    log.warn("[workflows/step-documents] Publishing a truncated step file", {
      organizationId: run.organizationId,
      runId: run.id,
      stepId: input.step.id,
      path: file.path,
    });
  }
  const context: PublishContext = {
    organizationId: run.organizationId,
    runId: run.id,
    issueId: run.featureDocumentId,
    userId: run.runAsUserId,
    projectId: input.projectId,
    stepId: linkStepId,
    target,
    content: file.content,
  };
  try {
    const title = await resolveTitle(context, input.variables);
    const existing = await findStepDocument(context);
    const published = existing
      ? await updateStepDocument(context, existing, title)
      : await createStepDocument(context, title);
    return published
      ? Result.ok(published)
      : Result.err(
          publishError(input.step, "the document could not be created")
        );
  } catch (error) {
    log.warn("[workflows/step-documents] Could not publish a step document", {
      organizationId: run.organizationId,
      runId: run.id,
      stepId: input.step.id,
      error,
    });
    return Result.err(publishError(input.step, parseError(error)));
  }
}

/** The step a document is published for: an agent step or AgentFlow's implement step. */
type PublishingStep = Pick<ProcessStep, "id" | "name">;

export type PublishReleaseNotesInput = Omit<
  PublishStepDocumentInput,
  "step"
> & {
  step: PublishingStep;
};
