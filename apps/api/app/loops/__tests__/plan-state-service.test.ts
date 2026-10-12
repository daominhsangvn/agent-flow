import { LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../service", () => ({
  loopsService: { findById: vi.fn() },
}));

vi.mock("@/lib/loops/loop-state", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/loops/loop-state")>();
  return {
    getPlanStateKeys: actual.getPlanStateKeys,
    loopStateObjectExists: vi.fn(),
    generateDownloadUrl: vi.fn((key: string) =>
      Promise.resolve(`https://storage/get/${key}`)
    ),
    generateUploadUrl: vi.fn((key: string) =>
      Promise.resolve(`https://storage/put/${key}`)
    ),
  };
});

import { loopStateObjectExists } from "@/lib/loops/loop-state";
import { planStateService } from "../plan-state-service";
import { loopsService } from "../service";

const ORG = "org-1";

function withLoop(command: LoopCommand, documentId: string | null = "plan-1") {
  vi.mocked(loopsService.findById).mockResolvedValue({
    id: "loop-1",
    command,
    documentId,
  } as Awaited<ReturnType<typeof loopsService.findById>>);
}

beforeEach(() => {
  vi.mocked(loopsService.findById).mockReset();
  vi.mocked(loopStateObjectExists).mockReset();
});

describe("planStateService.latestDownloadUrl", () => {
  it("presigns the plan's latest state when one was saved", async () => {
    withLoop(LoopCommand.Execute);
    vi.mocked(loopStateObjectExists).mockResolvedValue(true);
    await expect(
      planStateService.latestDownloadUrl("loop-1", ORG)
    ).resolves.toBe("https://storage/get/org-1/plans/plan-1/state.json.gz");
    expect(loopsService.findById).toHaveBeenCalledWith("loop-1", ORG);
  });

  it("is null before the plan has a saved state", async () => {
    withLoop(LoopCommand.Execute);
    vi.mocked(loopStateObjectExists).mockResolvedValue(false);
    await expect(
      planStateService.latestDownloadUrl("loop-1", ORG)
    ).resolves.toBeNull();
  });

  it("is null for a loop without a plan", async () => {
    withLoop(LoopCommand.Execute, null);
    await expect(
      planStateService.latestDownloadUrl("loop-1", ORG)
    ).resolves.toBeNull();
    expect(loopStateObjectExists).not.toHaveBeenCalled();
  });
});

describe("planStateService.uploadUrls", () => {
  it("presigns the loop's copy and the plan's latest state", async () => {
    withLoop(LoopCommand.Plan);
    await expect(
      planStateService.uploadUrls("loop-1", ORG, true)
    ).resolves.toEqual([
      "https://storage/put/org-1/plans/plan-1/loops/loop-1.json.gz",
      "https://storage/put/org-1/plans/plan-1/state.json.gz",
    ]);
  });

  it("presigns only the loop's copy when it must not become the latest", async () => {
    withLoop(LoopCommand.Plan);
    await expect(
      planStateService.uploadUrls("loop-1", ORG, false)
    ).resolves.toEqual([
      "https://storage/put/org-1/plans/plan-1/loops/loop-1.json.gz",
    ]);
  });

  it("refuses loops that do not work on a plan", async () => {
    withLoop(LoopCommand.Step);
    await expect(
      planStateService.uploadUrls("loop-1", ORG, true)
    ).resolves.toBeNull();
    withLoop(LoopCommand.Execute, null);
    await expect(
      planStateService.uploadUrls("loop-1", ORG, true)
    ).resolves.toBeNull();
  });
});
