import { afterEach, describe, expect, it, vi } from "vitest";
import { toLocalInboundUrl } from "../integrations";

describe("toLocalInboundUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("re-targets a public inbound URL at the API under test", () => {
    vi.stubEnv("E2E_API_URL", "http://localhost:3002");

    expect(
      toLocalInboundUrl(
        "https://hooks.example.com/webhooks/integrations/key_123?probe=1"
      )
    ).toBe("http://localhost:3002/webhooks/integrations/key_123?probe=1");
  });

  it("drops a path prefix in front of the ingress route", () => {
    vi.stubEnv("E2E_API_URL", "http://127.0.0.1:3002/");

    expect(
      toLocalInboundUrl(
        "https://tunnel.example.com/agentflow/webhooks/integrations/key_123"
      )
    ).toBe("http://127.0.0.1:3002/webhooks/integrations/key_123");
  });
});
