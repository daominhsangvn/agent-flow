import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createIntegrationSessionOpener } from "../src/server/operations/integration-session-client.js";

/**
 * The runner exchanges an instruction's action run for the agent's
 * integration tool session, with its own API key and compute target.
 */

const ACTION_RUN_ID = "5b0c2f4e-7a51-4c3e-9d2a-1f6b8e9c0a11";
const GRANT = {
  token: "ist_abcdefghijklmnopqrstuvwxyz",
  expiresAt: "2026-10-13T09:00:00.000Z",
  mcpUrl: "http://localhost:3010/mcp",
};
const NOT_CONNECTED_RE = /not connected to AgentFlow/;
const ANSWERED_403_RE = /AgentFlow answered 403/;

function opener(
  fetchImpl: typeof fetch,
  overrides: { apiKey?: string | null; mcpUrlOverride?: string } = {}
) {
  return createIntegrationSessionOpener({
    getApiOrigin: () => "http://api.test/",
    getApiKey: () =>
      overrides.apiKey === undefined ? "sk_live_runner" : overrides.apiKey,
    getComputeTargetId: () => "ct-runner",
    fetchImpl,
    mcpUrlOverride: overrides.mcpUrlOverride,
  });
}

describe("createIntegrationSessionOpener", () => {
  test("asks the API as this computer and returns the session", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((url: URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(Response.json({ success: true, data: GRANT }));
    }) as typeof fetch;

    assert.deepEqual(await opener(fetchImpl)(ACTION_RUN_ID), {
      ...GRANT,
      filesUrl: "http://api.test/integration-tools/files",
    });
    assert.equal(
      requests[0]?.url,
      "http://api.test/desktop/integration-sessions?computeTargetId=ct-runner"
    );
    assert.equal(requests[0]?.init?.method, "POST");
    assert.deepEqual(requests[0]?.init?.headers, {
      Authorization: "Bearer sk_live_runner",
      "Content-Type": "application/json",
    });
    assert.equal(
      requests[0]?.init?.body,
      JSON.stringify({ actionRunId: ACTION_RUN_ID })
    );
  });

  test("hands the agent the runner's MCP address when one is set", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({ success: true, data: GRANT })
      )) as typeof fetch;

    const grant = await opener(fetchImpl, {
      mcpUrlOverride: "http://mcp:3010/mcp",
    })(ACTION_RUN_ID);

    assert.equal(grant.mcpUrl, "http://mcp:3010/mcp");
  });

  test("fails when the API refuses", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch;

    await assert.rejects(opener(fetchImpl)(ACTION_RUN_ID), ANSWERED_403_RE);
  });

  test("fails without an API key", async () => {
    const fetchImpl = (() => {
      throw new Error("must not be called");
    }) as typeof fetch;

    await assert.rejects(
      opener(fetchImpl, { apiKey: null })(ACTION_RUN_ID),
      NOT_CONNECTED_RE
    );
  });
});
