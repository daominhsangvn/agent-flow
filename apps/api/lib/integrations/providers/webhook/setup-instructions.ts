import { INBOUND_TOKEN_HEADER_DISPLAY } from "../../inbound-auth";
import type { InboundSetupContext } from "../../types";
import type { WebhookConnectionConfig } from "./connection";

/**
 * Markdown shown to the admin next to the inbound URL and secret: how to
 * authenticate, the accepted body, and copy-paste examples.
 */

const EXAMPLE_BODY = {
  id: "evt-1",
  key: "REQ-7",
  title: "Add CSV export",
  description: "Users need to export the monthly report as CSV.",
  url: "https://tracker.example.com/REQ-7",
  type: "feature",
  labels: ["reports"],
  callbackUrl: "https://example.com/hooks/agentflow",
};

/** Shell line continuation (space, backslash, newline, indent); 92 is the backslash code point. */
const SHELL_LINE_CONTINUATION = ` ${String.fromCodePoint(92)}\n  `;

const BODY_FIELDS_TABLE = [
  "| Field | Type | Notes |",
  "|---|---|---|",
  "| `title` | string, required | Title of the imported issue (max 300 characters). |",
  "| `description` | string | Markdown body of the requirement (max 100 000 characters). |",
  "| `id` | string | Your id for this occurrence (max 255). The same `id` starts at most one run per workflow. |",
  "| `key` | string | Short key shown in AgentFlow, e.g. `REQ-7` (max 120). A workflow runs one item key at a time. |",
  "| `url` | URL | Link back to the item in your system. |",
  '| `type` | string | Matched by the trigger\'s "Types" filter, e.g. `feature`. |',
  "| `labels` | string[] | Up to 50 labels. |",
  '| `callbackUrl` | URL | Run events for this request are posted here by "Call an HTTPS endpoint" actions. Its host must be one of the connection\'s allowed callback hosts; when none are listed, local and private addresses are refused. Redirects are not followed. |',
  "| `metadata` | object | Free-form JSON, added to the imported issue. |",
].join("\n");

export function buildWebhookSetupInstructions(
  context: InboundSetupContext<WebhookConnectionConfig>
): string {
  return [
    "Send a `POST` request with a JSON body to the inbound URL, authenticated in one of two ways:",
    "",
    "- **Standard Webhooks signature** (recommended): sign the request with the inbound secret and send the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers. Any Standard Webhooks library works. Signatures older than 5 minutes are rejected.",
    `- **Token header**: send the inbound secret in the \`${INBOUND_TOKEN_HEADER_DISPLAY}\` header. Never put it in \`Authorization: Bearer\`.`,
    "",
    'Authenticated requests are answered with `200 {"ok":true}`. Requests whose body does not match the schema below are recorded as ignored deliveries on the connection, with the reason.',
    "",
    "**Inbound URL**",
    "",
    fenced("text", context.inboundUrl),
    "",
    "**Inbound secret**",
    "",
    fenced("text", context.inboundSecret),
    "",
    "## Body",
    "",
    BODY_FIELDS_TABLE,
    "",
    fenced("json", JSON.stringify(EXAMPLE_BODY, null, 2)),
    "",
    "## Example: token header",
    "",
    fenced("bash", curlExample(context)),
    "",
    "## Example: Standard Webhooks signature (Node.js 18+)",
    "",
    fenced("js", signedNodeExample(context)),
  ].join("\n");
}

function curlExample(
  context: InboundSetupContext<WebhookConnectionConfig>
): string {
  const body = JSON.stringify({
    id: EXAMPLE_BODY.id,
    key: EXAMPLE_BODY.key,
    title: EXAMPLE_BODY.title,
    description: EXAMPLE_BODY.description,
  });
  const tokenHeader = `${INBOUND_TOKEN_HEADER_DISPLAY}: ${context.inboundSecret}`;
  return [
    `curl -X POST ${shellQuote(context.inboundUrl)}`,
    "-H 'content-type: application/json'",
    `-H ${shellQuote(tokenHeader)}`,
    `-d ${shellQuote(body)}`,
  ].join(SHELL_LINE_CONTINUATION);
}

function signedNodeExample(
  context: InboundSetupContext<WebhookConnectionConfig>
): string {
  return [
    'import { createHmac, randomUUID } from "node:crypto";',
    "",
    `const url = ${JSON.stringify(context.inboundUrl)};`,
    `const secret = ${JSON.stringify(context.inboundSecret)};`,
    `const body = JSON.stringify(${JSON.stringify({ id: EXAMPLE_BODY.id, key: EXAMPLE_BODY.key, title: EXAMPLE_BODY.title })});`,
    "",
    "const id = randomUUID();",
    "const timestamp = Math.floor(Date.now() / 1000);",
    'const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");',
    'const signature = createHmac("sha256", key)',
    '  .update(id + "." + timestamp + "." + body)',
    '  .digest("base64");',
    "",
    "const response = await fetch(url, {",
    '  method: "POST",',
    "  headers: {",
    '    "content-type": "application/json",',
    '    "webhook-id": id,',
    '    "webhook-timestamp": String(timestamp),',
    '    "webhook-signature": "v1," + signature,',
    "  },",
    "  body,",
    "});",
    "console.log(response.status);",
  ].join("\n");
}

function fenced(language: string, content: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

/** POSIX single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
