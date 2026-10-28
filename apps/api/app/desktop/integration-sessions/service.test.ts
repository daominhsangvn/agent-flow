import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIntegrationSessionService } from "./service";

/** Only a computer the caller owns can ask for an agent's session token. */

const mocks = vi.hoisted(() => ({
  findOwnedById: vi.fn(),
  issueForComputer: vi.fn(),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));
vi.mock("@/app/integration-tools/integration-tool-session-service", () => ({
  integrationToolSessionService: { issueForComputer: mocks.issueForComputer },
}));

const INPUT = {
  organizationId: "org-1",
  userId: "user-1",
  clerkUserId: null,
  computeTargetId: "ct-1",
  request: { actionRunId: "0199a5f0-0000-7000-8000-0000000000a1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.issueForComputer.mockResolvedValue(
    Result.ok({ token: "ist_x", expiresAt: "", mcpUrl: "http://mcp" })
  );
});

describe("desktopIntegrationSessionService.issue", () => {
  it("issues for a computer the caller owns", async () => {
    mocks.findOwnedById.mockResolvedValue({ id: "ct-1" });

    expect((await desktopIntegrationSessionService.issue(INPUT)).ok).toBe(true);
    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      "ct-1",
      "org-1",
      "user-1",
      null
    );
    expect(mocks.issueForComputer).toHaveBeenCalledWith(INPUT);
  });

  it("refuses a computer the caller does not own", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    expect(await desktopIntegrationSessionService.issue(INPUT)).toEqual({
      ok: false,
      error: Status.Forbidden,
    });
    expect(mocks.issueForComputer).not.toHaveBeenCalled();
  });
});
