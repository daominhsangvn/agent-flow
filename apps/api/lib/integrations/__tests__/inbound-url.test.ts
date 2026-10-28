import { describe, expect, it } from "vitest";
import { inboundUrlWarning } from "../inbound-url";

const PATH = "/webhooks/integrations/key-1";

describe("inboundUrlWarning", () => {
  it("accepts a public HTTPS URL", () => {
    expect(inboundUrlWarning(`https://agentflow.example.com${PATH}`)).toBe(
      null
    );
    expect(inboundUrlWarning(`https://hooks.example.test:8443${PATH}`)).toBe(
      null
    );
  });

  it("flags the default local API URL and private addresses", () => {
    for (const base of [
      "http://localhost:3002",
      "https://localhost",
      "https://192.168.1.20",
      "https://10.0.0.5",
      "https://agentflow.local",
      "https://api",
      "https://[::1]",
    ]) {
      const warning = inboundUrlWarning(`${base}${PATH}`);
      expect(warning, base).toContain("local or private address");
      expect(warning, base).toContain("PUBLIC_WEBHOOK_BASE_URL");
    }
  });

  it("flags plain HTTP on a public host", () => {
    expect(inboundUrlWarning(`http://agentflow.example.com${PATH}`)).toContain(
      "only deliver to HTTPS URLs, and this one uses http"
    );
  });

  it("flags a URL that does not parse", () => {
    expect(inboundUrlWarning("not a url")).toContain("not a valid URL");
  });
});
