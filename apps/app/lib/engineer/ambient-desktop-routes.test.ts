import { describe, expect, it } from "vitest";
import { shouldRunAmbientDesktopBootstrap } from "./ambient-desktop-routes";

describe("shouldRunAmbientDesktopBootstrap", () => {
  it("disables ambient desktop probing on insights routes", () => {
    expect(shouldRunAmbientDesktopBootstrap("/agentflow-ai/insights")).toBe(
      false
    );
    expect(
      shouldRunAmbientDesktopBootstrap("/agentflow-ai/insights/delivery")
    ).toBe(false);
  });

  it("keeps ambient desktop probing enabled on execution-oriented routes", () => {
    expect(shouldRunAmbientDesktopBootstrap("/agentflow-ai/build/123")).toBe(
      true
    );
    expect(
      shouldRunAmbientDesktopBootstrap("/agentflow-ai/implementation-plans")
    ).toBe(true);
    expect(shouldRunAmbientDesktopBootstrap(null)).toBe(true);
  });
});
