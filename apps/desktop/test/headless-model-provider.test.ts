import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ModelProviderMode } from "@repo/api/src/types/compute-target-model-provider";
import { createRunnerModelProviderLookup } from "../src/headless/headless-model-provider.js";

const API_URL = "http://api.test:3002/";
const API_KEY = "sk_live_runner";
const TARGET_ID = "01a12f8a-6873-70f0-b22f-cb2061a27c88";
const PROXY_BASE_URL = "https://claude-proxy.example.com/anthropic";

type Call = { url: string; init: RequestInit | undefined };

function lookup(
  respond: () => Response,
  computeTargetId: string | null = TARGET_ID
) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return {
    calls,
    read: createRunnerModelProviderLookup({
      apiUrl: API_URL,
      apiKey: API_KEY,
      getComputeTargetId: () => computeTargetId,
      fetchImpl,
    }),
  };
}

function providerResponse(data: Record<string, unknown>): Response {
  return Response.json({ success: true, data });
}

describe("createRunnerModelProviderLookup", () => {
  test("reads the runner's own model provider as the API key's owner", async () => {
    const { calls, read } = lookup(() =>
      providerResponse({
        mode: ModelProviderMode.Custom,
        baseUrl: PROXY_BASE_URL,
        model: null,
        env: {},
        token: { isSet: false, lastFour: null },
      })
    );

    assert.deepEqual(await read(), { host: "claude-proxy.example.com" });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      `http://api.test:3002/compute-targets/${TARGET_ID}/model-provider`
    );
    assert.deepEqual(calls[0]?.init?.headers, {
      Authorization: `Bearer ${API_KEY}`,
    });
  });

  test("answers null for the computer's own Claude account", async () => {
    const { read } = lookup(() =>
      providerResponse({ mode: ModelProviderMode.Machine, baseUrl: null })
    );

    assert.equal(await read(), null);
  });

  test("answers null when the API refuses or answers something else", async () => {
    const refused = lookup(() => Response.json({}, { status: 404 }));
    const garbled = lookup(() => new Response("<html>"));
    const badUrl = lookup(() =>
      providerResponse({ mode: ModelProviderMode.Custom, baseUrl: "not a url" })
    );

    assert.equal(await refused.read(), null);
    assert.equal(await garbled.read(), null);
    assert.equal(await badUrl.read(), null);
  });

  test("does not ask before the runner has registered", async () => {
    const { calls, read } = lookup(
      () => providerResponse({ mode: ModelProviderMode.Custom }),
      null
    );

    assert.equal(await read(), null);
    assert.equal(calls.length, 0);
  });
});
