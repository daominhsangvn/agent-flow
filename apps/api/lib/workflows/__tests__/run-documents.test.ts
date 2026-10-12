import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  type WorkflowAgentConfig,
  workflowAgentConfigSchema,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceItem } from "@/lib/integrations/types";
import {
  ensureRunDocuments,
  markIssueInReview,
  type RunDocumentsInput,
} from "@/lib/workflows/engine/documents";
import {
  deliveredSourceStatus,
  isPrdItemType,
  sourceDocumentType,
} from "@/lib/workflows/engine/source-document";

/**
 * The run's source document (engine/documents.ts): a product requirement is
 * imported as a PRD the plan is generated from; anything else as an Issue.
 */

const mocks = vi.hoisted(() => ({
  db: {
    workflowRun: { updateMany: vi.fn() },
    artifact: { findFirst: vi.fn() },
  },
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  createNewVersion: vi.fn(),
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
  documentService: {
    create: mocks.createDocument,
    update: mocks.updateDocument,
  },
}));
vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { createNewVersion: mocks.createNewVersion },
}));
vi.mock("@/app/documents/room-utils", () => ({
  resetDocumentRoom: mocks.resetDocumentRoom,
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: mocks.captureArtifactCreation,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const RUN = "0199a5f0-0000-7000-8000-0000000000r1";
const PROJECT = "0199a5f0-0000-7000-8000-0000000000p1";
const USER = "0199a5f0-0000-7000-8000-0000000000u1";
const SOURCE_ID = "0199a5f0-0000-7000-8000-0000000000s1";
const PLAN_ID = "0199a5f0-0000-7000-8000-0000000000l1";
const PRD_MARKDOWN = "# PRD CALC-1: Memory keys\n\n## Goals\n\nM+, M-, MR, MC.";

const agent: WorkflowAgentConfig = workflowAgentConfigSchema.parse({
  computeTargetId: "0199a5f0-0000-7000-8000-0000000000c1",
  titleTemplate: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
});

function item(
  itemType: string | null,
  bodyMarkdown = PRD_MARKDOWN
): SourceItem {
  return {
    provider: IntegrationProviderKey.Webhook,
    externalId: "CALC-1",
    key: "CALC-1",
    url: null,
    title: "Memory keys",
    container: null,
    bodyMarkdown,
    itemType,
    status: null,
    priority: null,
    labels: [],
    reporter: null,
    assignee: null,
    sections: [],
    comments: [],
    attachments: [],
  };
}

function input(source: SourceItem): RunDocumentsInput {
  return {
    run: {
      id: RUN,
      organizationId: ORG,
      cycle: 1,
      featureDocumentId: null,
      planDocumentId: null,
    },
    workflowName: "Calculator PRDs",
    projectId: PROJECT,
    runAsUserId: USER,
    agent,
    item: source,
    withPlanDocument: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDocument.mockImplementation(
    (
      _org: string,
      _user: string,
      data: { type: string; title: string; status: string }
    ) =>
      Promise.resolve({
        id: data.type === DocumentType.ImplementationPlan ? PLAN_ID : SOURCE_ID,
        title: data.title,
        status: data.status,
      })
  );
  mocks.db.workflowRun.updateMany.mockResolvedValue({ count: 1 });
});

describe("source item type", () => {
  it("names a PRD whatever its spelling", () => {
    for (const type of [
      "prd",
      "PRD",
      "Product Requirements Document",
      "product-requirement",
    ]) {
      expect(isPrdItemType(type)).toBe(true);
    }
    for (const type of [
      null,
      "",
      "Bug",
      "Story",
      "New Feature",
      "prd-review",
    ]) {
      expect(isPrdItemType(type)).toBe(false);
    }
  });

  it("imports a PRD as a PRD and anything else as an Issue", () => {
    expect(sourceDocumentType(item("prd"))).toBe(DocumentType.Prd);
    expect(sourceDocumentType(item("Bug"))).toBe(DocumentType.Feature);
    expect(sourceDocumentType(item(null))).toBe(DocumentType.Feature);
  });
});

describe("ensureRunDocuments", () => {
  it("imports a product requirement as an approved PRD and plans from it", async () => {
    const result = await ensureRunDocuments(input(item("prd")));

    expect(result).toEqual({
      ok: true,
      value: { featureDocumentId: SOURCE_ID, planDocumentId: PLAN_ID },
    });
    const [source, plan] = mocks.createDocument.mock.calls.map(
      (call) => call[2]
    );
    expect(source).toMatchObject({
      type: DocumentType.Prd,
      status: DocumentStatus.Approved,
      projectId: PROJECT,
      title: "CALC-1: Memory keys",
    });
    // The requirement is the document itself, below the import notice.
    expect(source.content).toContain(PRD_MARKDOWN);
    expect(source.content).not.toContain("## Description");
    expect(plan).toMatchObject({
      type: DocumentType.ImplementationPlan,
      sourceId: SOURCE_ID,
      status: DocumentStatus.Draft,
    });
  });

  it("imports a bug as an Issue in progress, as before", async () => {
    await ensureRunDocuments(input(item("Bug", "Total is wrong")));

    const source = mocks.createDocument.mock.calls[0]?.[2];
    expect(source).toMatchObject({
      type: DocumentType.Feature,
      status: IssueStatus.InProgress,
    });
    expect(source.content).toContain("## Description\n\nTotal is wrong");
  });
});

describe("markIssueInReview", () => {
  it("executes a PRD and moves an Issue to in review once the PR is open", async () => {
    mocks.db.artifact.findFirst.mockResolvedValueOnce({
      subtype: DocumentType.Prd,
    });
    await markIssueInReview(SOURCE_ID, ORG);
    expect(mocks.updateDocument).toHaveBeenLastCalledWith(SOURCE_ID, ORG, {
      status: DocumentStatus.Executed,
    });

    mocks.db.artifact.findFirst.mockResolvedValueOnce({
      subtype: DocumentType.Feature,
    });
    await markIssueInReview(SOURCE_ID, ORG);
    expect(mocks.updateDocument).toHaveBeenLastCalledWith(SOURCE_ID, ORG, {
      status: IssueStatus.InReview,
    });
  });

  it("does nothing for a source document outside the organization", async () => {
    mocks.db.artifact.findFirst.mockResolvedValueOnce(null);
    await markIssueInReview(SOURCE_ID, ORG);
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it("keeps legacy rows without a subtype on the Issue lifecycle", () => {
    expect(deliveredSourceStatus(null)).toBe(IssueStatus.InReview);
  });
});
