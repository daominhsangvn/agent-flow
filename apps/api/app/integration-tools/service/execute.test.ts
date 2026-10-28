import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readConnectionItem, readOperation } from "./execute";
import type { ToolSessionContext } from "./session-context";

/**
 * connection_get_item: the provider parses and loads the item, and the API
 * refuses it unless it belongs to the project connection's containers, so a
 * grant on one Jira project never reads another project of the same site.
 */

const mocks = vi.hoisted(() => ({
  loadRuntime: vi.fn(),
  fetchItem: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@/lib/integrations/project-connections", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/integrations/project-connections")
  >()),
  loadProjectConnectionRuntime: mocks.loadRuntime,
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));

const PROVIDER = {
  key: IntegrationProviderKey.Jira,
  project: {
    origin: () => "https://internal.atlassian.net",
    containers: (settings: { projectKeys?: string[] }) =>
      settings.projectKeys ?? [],
    normalizeContainer: (value: string) => value.toUpperCase(),
  },
  source: {
    fetchItem: mocks.fetchItem,
    parseItemReference: (_config: unknown, input: string) =>
      ISSUE_KEY_RE.test(input)
        ? Result.ok({ externalId: input, key: input.toUpperCase() })
        : Result.err("Enter a Jira issue key such as PROJ-123."),
  },
};

const ISSUE_KEY_RE = /^[A-Z]+-\d+$/i;

const PLAN = {
  kind: "read_item" as const,
  connection: {
    key: "jira-internal",
    name: "Internal Jira",
    provider: IntegrationProviderKey.Jira,
    projectConnectionId: "pc-1",
  },
  item: "OPS-12",
};

const CONTEXT = {
  session: { organizationId: "org-1" },
} as unknown as ToolSessionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadRuntime.mockResolvedValue({
    connection: {
      provider: PROVIDER,
      runtime: { config: {}, secrets: { apiToken: "s3cret" } },
    },
    settings: { projectKeys: ["OPS"] },
  });
  mocks.fetchItem.mockImplementation((_ctx, ref: { key: string }) =>
    Promise.resolve(item(ref.key, ref.key.split("-")[0] ?? ""))
  );
});

function item(key: string, container: string) {
  return {
    provider: IntegrationProviderKey.Jira,
    externalId: key,
    key,
    url: `https://internal.atlassian.net/browse/${key}`,
    title: "Flaky deploy",
    container,
    bodyMarkdown: "Steps",
    itemType: "Bug",
    status: "Open",
    priority: null,
    labels: [],
    reporter: null,
    assignee: null,
    sections: [],
    comments: [],
    attachments: [],
  };
}

describe("readConnectionItem", () => {
  it("reads an item of the project connection's projects", async () => {
    const outcome = await readConnectionItem(CONTEXT, PLAN);

    expect(outcome).toMatchObject({
      ok: true,
      output: { key: "OPS-12", status: "Open", title: "Flaky deploy" },
    });
    expect(mocks.loadRuntime).toHaveBeenCalledWith("org-1", "pc-1");
  });

  it("refuses an item of another project of the same site", async () => {
    const outcome = await readConnectionItem(CONTEXT, {
      ...PLAN,
      item: "HR-4",
    });

    expect(outcome).toEqual({
      ok: false,
      error:
        "Not allowed: HR-4 is not in the projects of `jira-internal` (OPS).",
      retryable: false,
    });
  });

  it("refuses what the provider cannot read as an item", async () => {
    const outcome = await readConnectionItem(CONTEXT, {
      ...PLAN,
      item: "drop table",
    });

    expect(outcome).toEqual({
      ok: false,
      error: "Enter a Jira issue key such as PROJ-123.",
      retryable: false,
    });
    expect(mocks.fetchItem).not.toHaveBeenCalled();
  });

  it("keeps the connection's secrets out of a provider error", async () => {
    mocks.fetchItem.mockRejectedValue(new Error("401 for token s3cret"));

    const outcome = await readConnectionItem(CONTEXT, PLAN);

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });
});

describe("readOperation", () => {
  const read = {
    key: "confluence.get_page",
    displayName: "Read a Confluence page",
    description: "",
    inputSchema: z.unknown(),
    inputFields: [],
    execute: mocks.read,
  };
  const READ_PLAN = {
    kind: "read_operation" as const,
    connection: { ...PLAN.connection, key: "wiki" },
    definition: read,
    input: { page: "123" },
  };

  it("runs the read with the project connection's runtime", async () => {
    mocks.read.mockResolvedValue({ ok: true, value: { title: "Plan" } });

    const outcome = await readOperation(CONTEXT, READ_PLAN);

    expect(outcome).toEqual({
      ok: true,
      output: { title: "Plan" },
      externalRef: null,
    });
    expect(mocks.read).toHaveBeenCalledWith(
      { connection: { config: {}, secrets: { apiToken: "s3cret" } } },
      { page: "123" }
    );
  });

  it("keeps secrets out of a failed read, and refuses a removed connection", async () => {
    mocks.read.mockResolvedValue({
      ok: false,
      error: "rejected s3cret",
      retryable: true,
    });

    const failed = await readOperation(CONTEXT, READ_PLAN);
    mocks.loadRuntime.mockResolvedValue(null);
    const removed = await readOperation(CONTEXT, READ_PLAN);

    expect(failed).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify(failed)).not.toContain("s3cret");
    expect(removed).toMatchObject({ ok: false, retryable: false });
  });
});
