import {
  type ComputeTargetCapabilities,
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchItem: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ orchestratorConversation: { findFirst: mocks.findFirst } }),
}));
vi.mock("@/lib/integrations/project-connections", () => ({
  loadProjectConnectionRuntime: async () => ({
    connection: {
      runtime: {},
      provider: { source: { fetchItem: mocks.fetchItem } },
    },
  }),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: () => ({}),
}));

import { checkTaskCommand, checkTaskNeeds, missingNeeds } from "../task-guards";

function file(
  commands: NonNullable<ComputeTargetCapabilities["capabilities"]>["commands"]
): ComputeTargetCapabilities {
  return {
    id: "cap-1",
    computeTargetId: "ct-1",
    isOnline: true,
    projectId: "proj-1",
    contentHash: "h",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    runnerName: "runner-1",
    source: RunnerCapabilitiesSource.Toolkit,
    content: "",
    capabilities: { commands } as ComputeTargetCapabilities["capabilities"],
    problems: [],
    warnings: [],
  };
}

const ba = {
  name: "/ba-requirement",
  mode: RunnerCommandMode.Read,
  produces: "prd",
  attach: ["PRD-*.md"],
};
const dev = {
  name: "/dev-code",
  mode: RunnerCommandMode.Write,
  needs: ["prd"],
};
const runner = file([ba, dev]);

describe("checkTaskCommand", () => {
  it("refuses an unparsed file", () => {
    const bad = { ...runner, capabilities: null, problems: ["bad yaml"] };
    const result = checkTaskCommand(bad, "/dev-code", null);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("does not parse (bad yaml)"),
    });
  });

  it("refuses an undeclared command and lists the declared ones", () => {
    const result = checkTaskCommand(runner, "/qa-test", null);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("/ba-requirement, /dev-code"),
    });
  });

  it("refuses write mode for a read command", () => {
    const result = checkTaskCommand(
      runner,
      "/ba-requirement",
      RunnerCommandMode.Write
    );
    expect(result.ok).toBe(false);
  });

  it("allows read mode on a write command and defaults to the declared mode", () => {
    const read = checkTaskCommand(runner, "/dev-code", RunnerCommandMode.Read);
    expect(read).toMatchObject({
      ok: true,
      value: { mode: RunnerCommandMode.Read },
    });
    const fallback = checkTaskCommand(runner, "/dev-code", null);
    expect(fallback).toMatchObject({
      ok: true,
      value: { mode: RunnerCommandMode.Write },
    });
  });
});

describe("missingNeeds", () => {
  it("is met by a passed file matching the producer's attach", () => {
    expect(missingNeeds([runner], dev, ["PRD-LD-7.md"])).toEqual([]);
  });

  it("reports an unmet need", () => {
    const gaps = missingNeeds([runner], dev, ["notes.txt"]);
    expect(gaps).toEqual([
      {
        need: "prd",
        patterns: ["PRD-*.md"],
        producers: ["/ba-requirement on runner-1"],
      },
    ]);
  });

  it("skips a need whose producer has no attach, or with no producer", () => {
    const noAttach = file([
      { name: "/ba", mode: RunnerCommandMode.Read, produces: "prd" },
    ]);
    expect(missingNeeds([noAttach], dev, [])).toEqual([]);
    expect(missingNeeds([file([dev])], dev, [])).toEqual([]);
  });
});

describe("checkTaskNeeds", () => {
  const base = {
    organizationId: "org-1",
    conversationId: "conv-1",
    files: [runner],
    declared: dev,
  };

  beforeEach(() => {
    mocks.fetchItem.mockReset();
    mocks.findFirst.mockReset();
    mocks.findFirst.mockResolvedValue({
      projectConnectionId: "pc-1",
      channel: {
        item: {
          provider: "jira",
          externalId: "1",
          key: "LD-7",
          url: null,
          title: null,
          container: null,
        },
        parentId: null,
        extras: null,
      },
    });
  });

  it("is met by a ticket attachment", async () => {
    mocks.fetchItem.mockResolvedValue({
      attachments: [{ name: "PRD-LD-7.md" }],
    });
    const result = await checkTaskNeeds({ ...base, inputNames: [] });
    expect(result.ok).toBe(true);
  });

  it("refuses when neither inputs nor the ticket have it", async () => {
    mocks.fetchItem.mockResolvedValue({ attachments: [{ name: "other.png" }] });
    const result = await checkTaskNeeds({ ...base, inputNames: [] });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(
        "/dev-code needs prd (PRD-*.md, produced by /ba-requirement on runner-1)"
      ),
    });
  });

  it("passes when the ticket cannot be read", async () => {
    mocks.fetchItem.mockRejectedValue(new Error("down"));
    const result = await checkTaskNeeds({ ...base, inputNames: [] });
    expect(result.ok).toBe(true);
  });

  it("does not fetch the ticket when the inputs meet the need", async () => {
    const result = await checkTaskNeeds({
      ...base,
      inputNames: ["PRD-LD-7.md"],
    });
    expect(result.ok).toBe(true);
    expect(mocks.fetchItem).not.toHaveBeenCalled();
  });
});
