import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunLoopComputeTarget } from "@/app/documents/[id]/run-loop/run-loop-helpers";

const mocks = vi.hoisted(() => ({
  chooseProjectRunner: vi.fn(),
  resolveComputeTargetForRoute: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/app/projects/project-runner-selection", () => ({
  ProjectRunnerChoiceKind: {
    None: "none",
    Resolved: "resolved",
    Unavailable: "unavailable",
  },
  chooseProjectRunner: mocks.chooseProjectRunner,
}));
vi.mock("@/lib/loops/compute-target-route-helpers", () => ({
  resolveComputeTargetForRoute: mocks.resolveComputeTargetForRoute,
}));

const RUNNER = "0199a5f0-0000-7000-8000-0000000000c1";
const LAPTOP = "0199a5f0-0000-7000-8000-0000000000c9";
const PROJECT = { documentId: "doc-1", continuesParent: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chooseProjectRunner.mockResolvedValue({ kind: "none" });
  mocks.resolveComputeTargetForRoute.mockImplementation(
    (_org: string, _user: string, id: string | undefined) =>
      Promise.resolve({ computeTargetId: id })
  );
});

describe("resolveRunLoopComputeTarget on a project with runners", () => {
  it("runs a new loop on the runner the project picks over the user's computer", async () => {
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: "resolved",
      computeTargetId: RUNNER,
    });

    const result = await resolveRunLoopComputeTarget(
      "org-1",
      "user-1",
      LAPTOP,
      undefined,
      PROJECT
    );

    expect(result).toEqual({ computeTargetId: RUNNER });
    expect(mocks.chooseProjectRunner).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      documentId: "doc-1",
      preferredComputeTargetId: LAPTOP,
    });
  });

  it("answers 409 when none of the project's runners is online", async () => {
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: "unavailable",
      message: "None of the project's runners is online",
    });

    const result = await resolveRunLoopComputeTarget(
      "org-1",
      "user-1",
      LAPTOP,
      undefined,
      PROJECT
    );

    expect("errorResponse" in result && result.errorResponse.status).toBe(409);
    expect(mocks.resolveComputeTargetForRoute).not.toHaveBeenCalled();
  });

  it("keeps the requested computer for a loop that continues another", async () => {
    const result = await resolveRunLoopComputeTarget(
      "org-1",
      "user-1",
      LAPTOP,
      undefined,
      { documentId: "doc-1", continuesParent: true }
    );

    expect(result).toEqual({ computeTargetId: LAPTOP });
    expect(mocks.chooseProjectRunner).not.toHaveBeenCalled();
  });

  it("keeps the requested computer on a project without runners", async () => {
    const result = await resolveRunLoopComputeTarget(
      "org-1",
      "user-1",
      LAPTOP,
      undefined,
      PROJECT
    );

    expect(result).toEqual({ computeTargetId: LAPTOP });
  });
});
