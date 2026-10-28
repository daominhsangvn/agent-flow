import { LOOP_STEP_ARTIFACT_KEY } from "@agentflow-ai/loops-api/loop-step";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/loops/loop-state", () => ({
  getLoopPrefix: (org: string, loop: string) => `${org}/loops/${loop}/`,
  putLoopAttachment: vi.fn(),
}));

import { putLoopAttachment } from "@/lib/loops/loop-state";
import { storeStepAttachments } from "./step-attachments";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const run = (attachments: unknown[]) =>
  storeStepAttachments({
    organizationId: "org",
    loopId: "loop",
    artifacts: { [LOOP_STEP_ARTIFACT_KEY]: { files: [], attachments } },
  });
const attachmentsOf = (result: Record<string, unknown>) =>
  (result[LOOP_STEP_ARTIFACT_KEY] as { attachments: Record<string, unknown>[] })
    .attachments;

describe("storeStepAttachments", () => {
  beforeEach(() => {
    vi.mocked(putLoopAttachment).mockReset();
  });

  it("stores bytes under the loop prefix and drops data", async () => {
    const result = await run([
      { path: "PRD-1.md", size: 2, data: b64("hi") },
      { path: "ev/a.png", size: 3, data: b64("png") },
    ]);
    const [md, png] = attachmentsOf(result);
    expect(md).toEqual({
      path: "PRD-1.md",
      size: 2,
      storageKey: "org/loops/loop/step-attachments/0-PRD-1.md",
    });
    expect(png?.storageKey).toBe("org/loops/loop/step-attachments/1-a.png");
    expect(png).not.toHaveProperty("data");
    const calls = vi.mocked(putLoopAttachment).mock.calls;
    expect(calls[0]?.[0].contentType).toBe("text/markdown");
    expect(calls[1]?.[0].contentType).toBe("image/png");
    expect(Buffer.from(calls[0]?.[0].bytes ?? []).toString()).toBe("hi");
  });

  it("keeps already skipped entries", async () => {
    const entry = { path: "big.zip", size: 9, skipped: "too large" };
    const result = await run([entry]);
    expect(attachmentsOf(result)).toEqual([entry]);
    expect(putLoopAttachment).not.toHaveBeenCalled();
  });

  it("drops a storageKey the runner sent", async () => {
    const result = await run([
      { path: "a.md", size: 1, storageKey: "other-org/loops/x/secret" },
      { path: "b.md", size: 1, skipped: "too large", storageKey: "forged" },
    ]);
    expect(attachmentsOf(result)).toEqual([
      { path: "a.md", size: 1, skipped: "not collected" },
      { path: "b.md", size: 1, skipped: "too large" },
    ]);
  });

  it("enforces the 5 MB total", async () => {
    const part = Buffer.alloc(3 * 1024 * 1024).toString("base64");
    const result = await run([
      { path: "a.bin", size: 1, data: part },
      { path: "b.bin", size: 1, data: part },
    ]);
    const [first, second] = attachmentsOf(result);
    expect(first?.storageKey).toBeDefined();
    expect(second?.skipped).toBe("over the 5 MB of all attached files");
    expect(putLoopAttachment).toHaveBeenCalledTimes(1);
  });

  it("never persists data when the step does not parse", async () => {
    const result = await storeStepAttachments({
      organizationId: "org",
      loopId: "loop",
      artifacts: {
        [LOOP_STEP_ARTIFACT_KEY]: {
          files: [],
          attachments: [{ path: "x".repeat(600), size: 1, data: b64("hi") }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(b64("hi"));
    expect(putLoopAttachment).not.toHaveBeenCalled();
  });

  it("skips oversized decoded bytes", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
    const result = await run([{ path: "a.bin", size: 1, data: big }]);
    expect(attachmentsOf(result)[0]?.skipped).toBe("larger than 4 MB");
    expect(putLoopAttachment).not.toHaveBeenCalled();
  });

  it("continues after a failed put", async () => {
    vi.mocked(putLoopAttachment).mockRejectedValueOnce(new Error("boom"));
    const result = await run([
      { path: "a.md", size: 1, data: b64("a") },
      { path: "b.md", size: 1, data: b64("b") },
    ]);
    const [first, second] = attachmentsOf(result);
    expect(first?.skipped).toBe("could not be stored");
    expect(second?.storageKey).toBe("org/loops/loop/step-attachments/1-b.md");
  });

  it("returns artifacts unchanged without step attachments", async () => {
    const plain = { plan: { content: "x" } };
    const none = { [LOOP_STEP_ARTIFACT_KEY]: { files: [] } };
    expect(
      await storeStepAttachments({
        organizationId: "o",
        loopId: "l",
        artifacts: plain,
      })
    ).toBe(plain);
    expect(
      await storeStepAttachments({
        organizationId: "o",
        loopId: "l",
        artifacts: none,
      })
    ).toBe(none);
  });
});
