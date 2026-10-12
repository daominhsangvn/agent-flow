import { describe, expect, it } from "vitest";
import {
  checkTeamsWebhookUrl,
  TEAMS_HTTPS_REQUIRED_ERROR,
  TEAMS_INVALID_URL_ERROR,
  TEAMS_RETIRED_CONNECTOR_ERROR,
} from "../webhook-url";
import { TEAMS_WEBHOOK_URL } from "./teams.test-helpers";

describe("checkTeamsWebhookUrl", () => {
  it.each([
    TEAMS_WEBHOOK_URL,
    "https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=xyz",
    "http://localhost:4010/teams",
    "http://127.0.0.1:4010/teams",
  ])("accepts %s", (url) => {
    const result = checkTeamsWebhookUrl(url);

    expect(result.ok).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = checkTeamsWebhookUrl(`  ${TEAMS_WEBHOOK_URL}\n`);

    expect(result).toEqual({ ok: true, value: new URL(TEAMS_WEBHOOK_URL) });
  });

  it.each([
    "https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456",
    "https://outlook.office.com/webhook/abc@def/IncomingWebhook/123/456",
    "https://outlook.office365.com/webhook/abc/IncomingWebhook/123",
    "https://CONTOSO.WEBHOOK.OFFICE.COM/webhookb2/abc",
    "http://contoso.webhook.office.com/webhookb2/abc",
  ])("rejects the retired Office 365 connector URL %s", (url) => {
    expect(checkTeamsWebhookUrl(url)).toEqual({
      ok: false,
      error: TEAMS_RETIRED_CONNECTOR_ERROR,
    });
  });

  it("explains the retirement and how to create a Workflows webhook", () => {
    expect(TEAMS_RETIRED_CONNECTOR_ERROR).toContain("retired");
    expect(TEAMS_RETIRED_CONNECTOR_ERROR).toContain("2026");
    expect(TEAMS_RETIRED_CONNECTOR_ERROR).toContain("Workflows");
    expect(TEAMS_RETIRED_CONNECTOR_ERROR).toContain(
      "Send webhook alerts to a channel"
    );
  });

  it.each([
    "http://prod-12.westus.logic.azure.com/workflows/abc",
    "ftp://example.com/hook",
  ])("requires https for %s", (url) => {
    expect(checkTeamsWebhookUrl(url)).toEqual({
      ok: false,
      error: TEAMS_HTTPS_REQUIRED_ERROR,
    });
  });

  it.each([
    "",
    "not a url",
    "example.com/hook",
    null,
    undefined,
  ])("rejects the malformed value %j", (value) => {
    expect(checkTeamsWebhookUrl(value)).toEqual({
      ok: false,
      error: TEAMS_INVALID_URL_ERROR,
    });
  });
});
