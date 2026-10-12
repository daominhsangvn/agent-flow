import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { buildWebhookSetupInstructions } from "../setup-instructions";
import {
  INBOUND_URL,
  makeWebhookContext,
  SIGNING_SECRET,
} from "./webhook.test-helpers";

const BACKSLASH = String.fromCodePoint(92);

function instructions(inboundUrl = INBOUND_URL): string {
  const { connection } = makeWebhookContext();
  return buildWebhookSetupInstructions({
    connection,
    inboundSecret: SIGNING_SECRET,
    inboundUrl,
    deliveryMode: IntegrationDeliveryMode.Webhook,
  });
}

describe("buildWebhookSetupInstructions", () => {
  it("shows the inbound URL and secret", () => {
    const markdown = instructions();

    expect(markdown).toContain(`\`\`\`text\n${INBOUND_URL}\n\`\`\``);
    expect(markdown).toContain(`\`\`\`text\n${SIGNING_SECRET}\n\`\`\``);
  });

  it("documents every body field", () => {
    const markdown = instructions();

    for (const field of [
      "title",
      "description",
      "id",
      "key",
      "url",
      "type",
      "labels",
      "callbackUrl",
      "metadata",
    ]) {
      expect(markdown).toContain(`| \`${field}\` |`);
    }
  });

  it("explains which callbackUrl hosts are accepted", () => {
    const markdown = instructions();

    expect(markdown).toContain(
      "Its host must be one of the connection's allowed callback hosts; when none are listed, local and private addresses are refused."
    );
  });

  it("includes a curl example with the token header", () => {
    const markdown = instructions();

    expect(markdown.split("\n")).toContain(
      `curl -X POST '${INBOUND_URL}' ${BACKSLASH}`
    );
    expect(markdown).toContain(`-H 'X-AgentFlow-Token: ${SIGNING_SECRET}'`);
    expect(markdown).toContain(`-d '{"id":"evt-1","key":"REQ-7"`);
  });

  it("includes a Standard Webhooks signing example", () => {
    const markdown = instructions();

    expect(markdown).toContain(
      `const secret = ${JSON.stringify(SIGNING_SECRET)};`
    );
    expect(markdown).toContain('"webhook-id": id');
    expect(markdown).toContain('"webhook-timestamp": String(timestamp)');
    expect(markdown).toContain('"webhook-signature": "v1," + signature');
  });

  it("shell-quotes values containing single quotes", () => {
    const markdown = instructions("https://example.com/it's");

    expect(markdown).toContain(
      String.raw`curl -X POST 'https://example.com/it'\''s'`
    );
  });
});
