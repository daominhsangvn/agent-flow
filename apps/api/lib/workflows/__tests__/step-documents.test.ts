import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import {
  type AgentProcessStep,
  ProcessDocumentType,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import { WorkflowRunErrorCode } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRunDocuments,
  type PublishStepDocumentInput,
  publishStepDocument,
} from "@/lib/workflows/engine/step-documents";

/**
 * Documents the agent steps publish (engine/step-documents.ts): the first
 * loop of a step creates the document and its Issue -> document link tagged
 * with the run and the step, later loops add versions to that document, and
 * the run lists its documents from those links.
 */

const mocks = vi.hoisted(() => ({
  db: {
    artifactLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    artifact: { findFirst: vi.fn() },
  },
  createDocumentRecord: vi.fn(),
  updateDocument: vi.fn(),
  indexDocumentProjection: vi.fn(),
  getLatestVersion: vi.fn(),
  createNewVersion: vi.fn(),
  createDocumentRoom: vi.fn(),
  resetDocumentRoom: vi.fn(),
  captureArtifactCreation: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.db);
  return { withDb };
});
vi.mock("@/app/documents/document-service", () => ({
  createDocumentRecord: mocks.createDocumentRecord,
  documentService: { update: mocks.updateDocument },
  indexDocumentProjection: mocks.indexDocumentProjection,
}));
vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: mocks.getLatestVersion,
    createNewVersion: mocks.createNewVersion,
  },
}));
vi.mock("@/app/documents/room-utils", () => ({
  createDocumentRoom: mocks.createDocumentRoom,
  resetDocumentRoom: mocks.resetDocumentRoom,
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: mocks.captureArtifactCreation,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const RUN = "0199a5f0-0000-7000-8000-0000000000r1";
const ISSUE = "0199a5f0-0000-7000-8000-0000000000i1";
const PROJECT = "0199a5f0-0000-7000-8000-0000000000p1";
const USER = "0199a5f0-0000-7000-8000-0000000000u1";
const PRD_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const PRD_PATH = ".agentflow-ai/work/prd.md";
const PRD_CONTENT =
  "# PRD\n\n## Goals\n\nLock itinerary changes after Open for Sale.";

function prdStep(
  overrides: Partial<NonNullable<AgentProcessStep["document"]>> = {}
): AgentProcessStep {
  return {
    type: ProcessStepType.Agent,
    id: "prd",
    name: "Write the PRD",
    instruction: "Write the PRD of {{issue.key}}",
    questions: ProcessQuestionsPolicy.Continue,
    artifacts: [],
    reply: null,
    document: {
      type: ProcessDocumentType.Prd,
      path: PRD_PATH,
      title: "PRD: {{issue.title}}",
      ...overrides,
    },
    finish: ProcessStepFinish.None,
    timeoutMinutes: null,
  };
}

function input(
  overrides: Partial<PublishStepDocumentInput> = {}
): PublishStepDocumentInput {
  return {
    run: {
      id: RUN,
      organizationId: ORG,
      featureDocumentId: ISSUE,
      runAsUserId: USER,
    },
    projectId: PROJECT,
    step: prdStep(),
    files: [{ path: PRD_PATH, content: PRD_CONTENT, truncated: false }],
    variables: {
      "issue.key": "BREP-3002",
      "issue.title": "Lock itinerary changes",
      "issue.url": "https://jira.example.test/browse/BREP-3002",
    },
    ...overrides,
  };
}

const CREATED_PRD = {
  id: PRD_ID,
  organizationId: ORG,
  slug: "PRD-12",
  type: DocumentType.Prd,
  title: "PRD: Lock itinerary changes",
  status: DocumentStatus.Draft,
  latestVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.artifactLink.findFirst.mockResolvedValue(null);
  mocks.db.artifactLink.findMany.mockResolvedValue([]);
  mocks.db.artifactLink.create.mockResolvedValue({ id: "link-1" });
  mocks.db.artifact.findFirst.mockResolvedValue({
    name: "BREP-3002: Lock itinerary changes",
  });
  mocks.createDocumentRecord.mockResolvedValue(CREATED_PRD);
  mocks.createDocumentRoom.mockResolvedValue(undefined);
  mocks.getLatestVersion.mockResolvedValue({ content: PRD_CONTENT });
  mocks.createNewVersion.mockResolvedValue({
    ...CREATED_PRD,
    latestVersion: 2,
  });
  mocks.resetDocumentRoom.mockResolvedValue(undefined);
  mocks.updateDocument.mockResolvedValue(CREATED_PRD);
});

describe("publishStepDocument", () => {
  it("creates the document from the step's file, produced by the run's Issue and tagged with the run and step", async () => {
    const result = await publishStepDocument(input());

    expect(result).toEqual({
      ok: true,
      value: {
        id: PRD_ID,
        slug: "PRD-12",
        title: "PRD: Lock itinerary changes",
        type: ProcessDocumentType.Prd,
        stepId: "prd",
      },
    });
    expect(mocks.createDocumentRecord).toHaveBeenCalledWith(
      mocks.db,
      ORG,
      USER,
      {
        type: DocumentType.Prd,
        title: "PRD: Lock itinerary changes",
        content: PRD_CONTENT,
        projectId: PROJECT,
        status: DocumentStatus.Draft,
      }
    );
    expect(mocks.db.artifactLink.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        sourceId: ISSUE,
        targetId: PRD_ID,
        linkType: LinkType.Produces,
        metadata: { workflowRunId: RUN, stepId: "prd" },
      },
      select: { id: true },
    });
    expect(mocks.createDocumentRoom).toHaveBeenCalledWith(CREATED_PRD);
    expect(mocks.indexDocumentProjection).toHaveBeenCalledWith(
      CREATED_PRD,
      PRD_CONTENT
    );
    expect(mocks.captureArtifactCreation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, artifactId: PRD_ID })
    );
  });

  it("looks the step's document up by the Issue link of this run and step", async () => {
    await publishStepDocument(input());

    expect(mocks.db.artifactLink.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        sourceId: ISSUE,
        linkType: LinkType.Produces,
        AND: [
          { metadata: { path: ["workflowRunId"], equals: RUN } },
          { metadata: { path: ["stepId"], equals: "prd" } },
        ],
      },
      select: { target: { select: { id: true, name: true, slug: true } } },
    });
  });

  it("titles the document after the Issue when the step sets no title", async () => {
    await publishStepDocument(input({ step: prdStep({ title: "" }) }));

    expect(mocks.createDocumentRecord).toHaveBeenCalledWith(
      mocks.db,
      ORG,
      USER,
      expect.objectContaining({ title: "BREP-3002: Lock itinerary changes" })
    );
  });

  it("adds a version and renames when a later loop of the step changed the file", async () => {
    mocks.db.artifactLink.findFirst.mockResolvedValue({
      target: { id: PRD_ID, name: "PRD: old title", slug: "PRD-12" },
    });
    mocks.getLatestVersion.mockResolvedValue({ content: "# PRD (draft)" });

    const result = await publishStepDocument(input());

    expect(result.ok).toBe(true);
    expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
    expect(mocks.createNewVersion).toHaveBeenCalledWith(
      PRD_ID,
      ORG,
      USER,
      PRD_CONTENT
    );
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.resetDocumentRoom).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: 2 }),
      USER
    );
    expect(mocks.updateDocument).toHaveBeenCalledWith(PRD_ID, ORG, {
      title: "PRD: Lock itinerary changes",
    });
  });

  it("adds no version when the content did not change (a retried settlement)", async () => {
    mocks.db.artifactLink.findFirst.mockResolvedValue({
      target: {
        id: PRD_ID,
        name: "PRD: Lock itinerary changes",
        slug: "PRD-12",
      },
    });

    const result = await publishStepDocument(input());

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ id: PRD_ID, slug: "PRD-12" }),
    });
    expect(mocks.createNewVersion).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
    expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
  });

  it("publishes nothing for a step without a document or when the step did not write the file", async () => {
    const withoutDocument = await publishStepDocument(
      input({ step: { ...prdStep(), document: null } })
    );
    const withoutFile = await publishStepDocument(input({ files: [] }));
    const emptyFile = await publishStepDocument(
      input({ files: [{ path: PRD_PATH, content: "  \n", truncated: false }] })
    );

    expect(withoutDocument).toEqual({ ok: true, value: null });
    expect(withoutFile).toEqual({ ok: true, value: null });
    expect(emptyFile).toEqual({ ok: true, value: null });
    expect(mocks.db.artifactLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
  });

  it("fails without an Issue or project to add the document to", async () => {
    const result = await publishStepDocument(
      input({ run: { ...input().run, featureDocumentId: null } })
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe(
      WorkflowRunErrorCode.DocumentCreateFailed
    );
    expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
  });

  it("fails when the document could not be created, without a link", async () => {
    mocks.createDocumentRecord.mockResolvedValue(null);

    const result = await publishStepDocument(input());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain(
      'The document of the "Write the PRD" step could not be published'
    );
    expect(mocks.db.artifactLink.create).not.toHaveBeenCalled();
    expect(mocks.createDocumentRoom).not.toHaveBeenCalled();
  });

  it("reports a database error as a failure the engine retries", async () => {
    mocks.db.artifactLink.create.mockRejectedValue(new Error("deadlock"));

    const result = await publishStepDocument(input());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      code: WorkflowRunErrorCode.DocumentCreateFailed,
      message:
        'The document of the "Write the PRD" step could not be published: deadlock',
    });
  });
});

describe("listRunDocuments", () => {
  it("lists the documents of the run's steps from the Issue links of the run", async () => {
    mocks.db.artifactLink.findMany.mockResolvedValue([
      {
        metadata: { workflowRunId: RUN, stepId: "prd" },
        target: {
          id: PRD_ID,
          name: "PRD: Lock itinerary changes",
          slug: "PRD-12",
          subtype: DocumentType.Prd,
        },
      },
      {
        // Not a type a step publishes: skipped.
        metadata: { workflowRunId: RUN, stepId: "other" },
        target: {
          id: "x",
          name: "x",
          slug: "ISS-1",
          subtype: DocumentType.Feature,
        },
      },
      {
        // Metadata of another shape: skipped.
        metadata: { note: "linked by hand" },
        target: {
          id: "y",
          name: "y",
          slug: "DOC-1",
          subtype: DocumentType.Doc,
        },
      },
    ]);

    const documents = await listRunDocuments({
      id: RUN,
      organizationId: ORG,
      featureDocumentId: ISSUE,
    });

    expect(documents).toEqual([
      {
        id: PRD_ID,
        slug: "PRD-12",
        title: "PRD: Lock itinerary changes",
        type: ProcessDocumentType.Prd,
        stepId: "prd",
      },
    ]);
    expect(mocks.db.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          sourceId: ISSUE,
          linkType: LinkType.Produces,
          metadata: { path: ["workflowRunId"], equals: RUN },
        },
      })
    );
  });

  it("lists nothing for a run without an Issue", async () => {
    const documents = await listRunDocuments({
      id: RUN,
      organizationId: ORG,
      featureDocumentId: null,
    });

    expect(documents).toEqual([]);
    expect(mocks.db.artifactLink.findMany).not.toHaveBeenCalled();
  });
});
