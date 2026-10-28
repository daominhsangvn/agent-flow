/**
 * Unit tests for projectsService.findByOrganization and projectsService.update.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  PROJECT_COMPLETION_ARTIFACT_TYPE,
  ProjectStatus,
} from "@repo/api/src/types/project";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const indexAfterCommit = vi.hoisted(() => vi.fn());

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("PRO-1"),
}));

vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: { indexAfterCommit, removeAfterCommit: vi.fn() },
  };
});

// Import after mocking
import { withDb } from "@repo/database";
import { projectsService } from "../service";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;

describe("projectsService.findByOrganization", () => {
  const TEST_ORG_ID = "org-456";

  // Mock project data
  const MOCK_PROJECT = {
    id: "project-1",
    name: "Test Project",
    organizationId: TEST_ORG_ID,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    artifacts: [],
    owner: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Prisma with take: 3 and sortOrder/createdAt ordering when limit is provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByOrganization(TEST_ORG_ID, { limit: 3 });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: TEST_ORG_ID,
      },
      include: expect.any(Object),
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      take: 3,
    });
  });

  it("calls Prisma without take and with sortOrder/createdAt ordering when no limit provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByOrganization(TEST_ORG_ID);

    const callArgs = mockFindMany.mock.calls[0][0];

    expect(callArgs).toEqual({
      where: {
        organizationId: TEST_ORG_ID,
      },
      include: expect.any(Object),
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });

    // Explicitly verify take is not present
    expect(callArgs).not.toHaveProperty("take");
  });

  it("always includes multi-tenant WHERE clause with organizationId regardless of limit", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    // Test with limit
    await projectsService.findByOrganization(TEST_ORG_ID, { limit: 5 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: TEST_ORG_ID,
        }),
      })
    );

    mockFindMany.mockClear();

    // Test without limit
    await projectsService.findByOrganization(TEST_ORG_ID);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: TEST_ORG_ID,
        }),
      })
    );
  });

  it("applies status inclusion filters when provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByOrganization(TEST_ORG_ID, {
      status: [ProjectStatus.Archived],
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [ProjectStatus.Archived] },
        }),
      })
    );
  });

  it("applies status exclusion filters when provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByOrganization(TEST_ORG_ID, {
      excludeStatus: [ProjectStatus.Archived],
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: [ProjectStatus.Archived] },
        }),
      })
    );
  });

  // ISS-4636: the artifacts feeding `completionPercentage` are the completion
  // population — documents — not every artifact of the project. The UI copy
  // names this same population via PROJECT_COMPLETION_POPULATION_NOUN.
  it("selects only the completion population's artifacts for completionPercentage", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByOrganization(TEST_ORG_ID);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          artifacts: expect.objectContaining({
            where: { type: PROJECT_COMPLETION_ARTIFACT_TYPE },
          }),
        }),
      })
    );
  });

  // ISS-4679 / version-skew: the wire field stays numeric for old clients; the
  // empty population is signalled by the additive optional flag, omitted when
  // the population is non-empty.
  it("serializes an empty population as completionPercentage 0 + completionPopulationEmpty true", async () => {
    const mockFindMany = vi
      .fn()
      .mockResolvedValue([{ ...MOCK_PROJECT, artifacts: [] }]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = { project: { findMany: mockFindMany } };
      return callback(mockDb);
    });

    const [project] = await projectsService.findByOrganization(TEST_ORG_ID);

    expect(project.completionPercentage).toBe(0);
    expect(project.completionPopulationEmpty).toBe(true);
  });

  it("omits completionPopulationEmpty for a non-empty population", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        ...MOCK_PROJECT,
        artifacts: [{ status: DocumentStatus.Draft, subtype: null }],
      },
    ]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = { project: { findMany: mockFindMany } };
      return callback(mockDb);
    });

    const [project] = await projectsService.findByOrganization(TEST_ORG_ID);

    expect(typeof project.completionPercentage).toBe("number");
    // Additive optional field: absent (not `false`/`null`) so old clients that
    // ignore it degrade to the legacy 0% behavior.
    expect("completionPopulationEmpty" in project).toBe(false);
  });
});

describe("projectsService.calculateStatus", () => {
  it("returns null for an empty population (no documents/issues to complete)", () => {
    // ISS-4679: an empty population has no percentage; `null` distinguishes it
    // from a real 0-of-N so the ring can render an empty-state track.
    expect(projectsService.calculateStatus([])).toBeNull();
  });

  it("returns 0 (not null) when all document artifacts have non-terminal statuses", () => {
    const artifacts = [
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
      { status: DocumentStatus.ChangesRequested, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(0);
  });

  it("returns 100 when all documents are in a terminal status (Approved/Executed/Obsolete)", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Obsolete, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 100 when all features are terminal (Done/Canceled)", () => {
    const artifacts = [
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Canceled, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 50 for a mix of 2-of-4 terminal across documents and features", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: IssueStatus.Backlog, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });

  it("treats per-subtype terminal sets independently: a feature Approved-string is not terminal", () => {
    // APPROVED is terminal for documents but not part of the feature vocabulary,
    // so a feature carrying it counts as non-terminal.
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Feature },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Triage, subtype: DocumentType.Feature },
      { status: IssueStatus.InProgress, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(25);
  });

  it("regression: document EXECUTED and APPROVED are both terminal post-PRD-495", () => {
    const artifacts = [
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });
});

describe("projectsService.update", () => {
  const PROJECT_ID = "project-1";
  const ORG_ID = "org-456";

  const UPDATED_PROJECT = {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Renamed",
    slug: "PRO-1",
    description: null,
    assigneeId: null,
    status: ProjectStatus.InProgress,
    priority: null,
    updatedAt: new Date("2026-08-14T00:00:00.000Z"),
  };

  let projectUpdate: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    projectUpdate = vi.fn().mockResolvedValue(UPDATED_PROJECT);
    mockWithDb.mockImplementation((callback: any) =>
      callback({ project: { update: projectUpdate } })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes the update to the organization and passes the input as data", async () => {
    await projectsService.update(PROJECT_ID, ORG_ID, { name: "Renamed" });

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: { name: "Renamed" },
    });
  });

  it("re-indexes the project projection after the update", async () => {
    await projectsService.update(PROJECT_ID, ORG_ID, { name: "Renamed" });

    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: PROJECT_ID,
        title: "Renamed",
        slug: "PRO-1",
      })
    );
  });
});
