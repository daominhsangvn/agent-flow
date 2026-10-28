import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  INTEGRATION_MCP_SERVER_NAME,
  INTEGRATION_TOOLS_CALL_ROUTE,
  INTEGRATION_TOOLS_SESSION_ROUTE,
  type IntegrationToolSessionDescriptor,
} from "@repo/api/src/types/integration-tools.js";
import {
  ORCHESTRATOR_TOOLS_CALL_ROUTE,
  ORCHESTRATOR_TOOLS_SESSION_ROUTE,
} from "@repo/api/src/types/orchestrator.js";
import { describe, expect, it, vi } from "vitest";
import {
  createIntegrationMcpServer,
  createIntegrationToolApi,
  extractIntegrationToken,
  type IntegrationToolApi,
} from "../integration-session.js";

/**
 * An instruction agent's integration session sees exactly the tools the API
 * lists for its token, with the API's instructions, and every call goes to
 * the API with that token; a refusal comes back as a tool error the agent
 * can read.
 */

const TOKEN = "ist_abcdefghijklmnopqrstuvwxyz0123";
const ORCHESTRATOR_TOKEN = "ost_abcdefghijklmnopqrstuvwxyz0123";

const DESCRIPTOR: IntegrationToolSessionDescriptor = {
  instructions: "You may write only through: source_item_comment.",
  tools: [
    {
      name: "source_item_comment",
      title: "Comment on the run's source item",
      description: "Post a comment on the item this run started from.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Comment." } },
        required: ["message"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ],
};

async function connect(api: IntegrationToolApi) {
  const server = createIntegrationMcpServer(TOKEN, DESCRIPTOR, api);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function fakeApi(
  call: IntegrationToolApi["call"] = vi.fn()
): IntegrationToolApi {
  return { describe: vi.fn(), call };
}

describe("extractIntegrationToken", () => {
  it("reads an integration session token", () => {
    expect(extractIntegrationToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    undefined,
    "Bearer sk_live_abc",
    "Bearer mcp_at_abc",
    TOKEN,
  ])("ignores %s", (header) => {
    expect(extractIntegrationToken(header)).toBeNull();
  });
});

describe("createIntegrationMcpServer", () => {
  it("offers only the session's tools with the API's instructions", async () => {
    const client = await connect(fakeApi());

    expect(client.getServerVersion()?.name).toBe(INTEGRATION_MCP_SERVER_NAME);
    expect(client.getInstructions()).toBe(DESCRIPTOR.instructions);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: "source_item_comment",
        description: "Post a comment on the item this run started from.",
        inputSchema: DESCRIPTOR.tools[0]?.inputSchema,
        annotations: expect.objectContaining({ readOnlyHint: false }),
      }),
    ]);
  });

  it("forwards a call with the session's token and returns the output", async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      output: { done: true, reference: "10042" },
    });
    const client = await connect(fakeApi(call));

    const result = await client.callTool({
      name: "source_item_comment",
      arguments: { message: "Done." },
    });

    expect(call).toHaveBeenCalledWith(TOKEN, "source_item_comment", {
      message: "Done.",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ done: true, reference: "10042" }, null, 2),
      },
    ]);
  });

  it("returns a refusal as a tool error", async () => {
    const client = await connect(
      fakeApi(
        vi.fn().mockResolvedValue({
          ok: false,
          error: "Not allowed: there is no tool jira_create_issue.",
          retryable: false,
        })
      )
    );

    const result = await client.callTool({
      name: "jira_create_issue",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Not allowed: there is no tool jira_create_issue.",
      },
    ]);
  });
});

describe("createIntegrationToolApi", () => {
  it("reads the descriptor with the token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: DESCRIPTOR }));
    const api = createIntegrationToolApi("http://api.test", fetchImpl);

    expect(await api.describe(TOKEN)).toEqual(DESCRIPTOR);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://api.test${INTEGRATION_TOOLS_SESSION_ROUTE}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      })
    );
  });

  it("has no descriptor for a token the API rejects", async () => {
    const api = createIntegrationToolApi(
      "http://api.test",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    );

    expect(await api.describe(TOKEN)).toBeNull();
  });

  it("tells the agent its session ended when a call is rejected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const api = createIntegrationToolApi("http://api.test", fetchImpl);

    expect(await api.call(TOKEN, "source_item_get", {})).toEqual({
      ok: false,
      error: expect.stringContaining("This session has ended"),
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://api.test${INTEGRATION_TOOLS_CALL_ROUTE}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tool: "source_item_get", input: {} }),
      })
    );
  });
});

describe("an orchestrator turn's token", () => {
  it("is read from the Authorization header", () => {
    expect(extractIntegrationToken(`Bearer ${ORCHESTRATOR_TOKEN}`)).toBe(
      ORCHESTRATOR_TOKEN
    );
  });

  it("reads its tools and calls them on the orchestrator routes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: DESCRIPTOR }))
      .mockResolvedValueOnce(
        Response.json({ success: true, data: { ok: true, output: "done" } })
      );
    const api = createIntegrationToolApi("http://api.test", fetchImpl);

    await api.describe(ORCHESTRATOR_TOKEN);
    await api.call(ORCHESTRATOR_TOKEN, "case_get", {});

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `http://api.test${ORCHESTRATOR_TOOLS_SESSION_ROUTE}`,
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `http://api.test${ORCHESTRATOR_TOOLS_CALL_ROUTE}`,
      expect.objectContaining({ method: "POST" })
    );
  });
});
