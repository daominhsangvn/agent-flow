import { describe, expect, it } from "vitest";
import { buildDesktopServerCapabilities } from "./desktop-server-capabilities";

describe("buildDesktopServerCapabilities", () => {
  it("always advertises the session sync lane and its payload capabilities", () => {
    expect(
      buildDesktopServerCapabilities({ commandSigningSupported: false })
    ).toEqual({
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      agentSessionSyncMonitoredActivity: true,
    });
  });

  it("adds command signing when it is supported", () => {
    expect(
      buildDesktopServerCapabilities({ commandSigningSupported: true })
    ).toEqual({
      computeTargetSigning: true,
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      agentSessionSyncMonitoredActivity: true,
    });
  });
});
