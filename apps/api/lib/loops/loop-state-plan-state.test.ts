/**
 * The plan-state keys and the existence probe in `loop-state.ts`: a plan's
 * saved state lives under the plan, outside every loop prefix the retention
 * sweep removes, and a missing object reads as absent rather than an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  function MockHeadObjectCommand(params: Record<string, unknown>) {
    return { _type: "HeadObjectCommand", ...params };
  }
  return { ...actual, HeadObjectCommand: MockHeadObjectCommand };
});

vi.mock("@repo/storage/client", () => ({
  getStorageClient: () => ({ send: mockSend }),
  getPresignClient: () => ({ send: mockSend }),
  coldStorageClassInput: () => ({}),
}));

import {
  getLoopPrefix,
  getPlanStateKeys,
  loopStateObjectExists,
  validateKeyBelongsToLoop,
} from "./loop-state";

beforeEach(() => {
  mockSend.mockReset();
  vi.stubEnv("LOOP_STATE_BUCKET", "loop-state");
});

describe("getPlanStateKeys", () => {
  it("keeps the latest state and each loop's copy under the plan", () => {
    expect(getPlanStateKeys("org-1", "plan-1", "loop-1")).toEqual({
      latest: "org-1/plans/plan-1/state.json.gz",
      loop: "org-1/plans/plan-1/loops/loop-1.json.gz",
    });
  });

  it("is outside the loop prefix the retention sweep removes", () => {
    const keys = getPlanStateKeys("org-1", "plan-1", "loop-1");
    for (const key of [keys.latest, keys.loop]) {
      expect(key.startsWith(getLoopPrefix("org-1", "loop-1"))).toBe(false);
      expect(validateKeyBelongsToLoop(key, "org-1", "loop-1")).toBe(false);
    }
  });
});

describe("loopStateObjectExists", () => {
  it("is true when the object is there", async () => {
    mockSend.mockResolvedValueOnce({ ContentLength: 10 });
    await expect(
      loopStateObjectExists("org-1/plans/p/state.json.gz")
    ).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _type: "HeadObjectCommand",
        Bucket: "loop-state",
        Key: "org-1/plans/p/state.json.gz",
      })
    );
  });

  it("is false for a missing object", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("NotFound"), { name: "NotFound" })
    );
    await expect(loopStateObjectExists("k")).resolves.toBe(false);
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("Unknown"), {
        $metadata: { httpStatusCode: 404 },
      })
    );
    await expect(loopStateObjectExists("k")).resolves.toBe(false);
  });

  it("rethrows any other storage failure", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } })
    );
    await expect(loopStateObjectExists("k")).rejects.toThrow("denied");
  });
});
