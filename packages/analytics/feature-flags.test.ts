import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("./server");
  vi.unstubAllEnvs();
});

describe("isFeatureFlagEnabledForDistinctId", () => {
  it("uses the Next server analytics client and only accepts exact true", async () => {
    const isFeatureEnabled = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("enabled-flag", "user-1")
    ).resolves.toBe(true);
    await expect(
      isFeatureFlagEnabledForDistinctId("disabled-flag", "user-1")
    ).resolves.toBe(false);
    expect(isFeatureEnabled).toHaveBeenNthCalledWith(
      1,
      "enabled-flag",
      "user-1"
    );
  });

  it("returns null when the available analytics client cannot evaluate flags", async () => {
    vi.doMock("./server", () => ({ analytics: {} }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("flag", "user-1")
    ).resolves.toBeNull();
  });

  it("lets the deployment force a flag on or off without asking PostHog", async () => {
    vi.stubEnv(
      "AGENTFLOW_FEATURE_FLAGS",
      "desktop-agent-session-sync, emergent -process-form-editor"
    );
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("emergent", "user-1")
    ).resolves.toBe(true);
    await expect(
      isFeatureFlagEnabledForDistinctId("process-form-editor", "user-1")
    ).resolves.toBe(false);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
    // Keys not listed are evaluated by PostHog as usual.
    await expect(
      isFeatureFlagEnabledForDistinctId("other-flag", "user-1")
    ).resolves.toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith("other-flag", "user-1");
  });
});

describe("parseFeatureFlagOverrides", () => {
  it("reads keys separated by commas or spaces, with - forcing one off", async () => {
    const { parseFeatureFlagOverrides } = await import(
      "./feature-flag-overrides"
    );
    expect([...parseFeatureFlagOverrides(" a,b  -c,, - ").entries()]).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    expect(parseFeatureFlagOverrides(undefined).size).toBe(0);
  });
});
