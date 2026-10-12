import { readProjectAgentInstructions } from "@repo/api/src/types/project-agent-instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectAgentInstructionsService } from "@/app/projects/project-agent-instructions-service";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000p1";

const mocks = vi.hoisted(() => ({
  project: null as { settings: unknown } | null,
  executeRaw: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      project: { findFirst: () => Promise.resolve(mocks.project) },
      $executeRaw: mocks.executeRaw,
    }),
}));

/** The SQL text of a tagged-template `$executeRaw` call, with its values. */
function sqlOf(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join("?"), values };
}

beforeEach(() => {
  mocks.project = { settings: { repositoryOverrides: { x: 1 } } };
  mocks.executeRaw.mockReset();
  mocks.executeRaw.mockResolvedValue(1);
});

describe("readProjectAgentInstructions", () => {
  it("reads the agentInstructions key and is empty otherwise", () => {
    expect(readProjectAgentInstructions({ agentInstructions: "- a" })).toBe(
      "- a"
    );
    expect(readProjectAgentInstructions({})).toBe("");
    expect(readProjectAgentInstructions(null)).toBe("");
    expect(readProjectAgentInstructions({ agentInstructions: 3 })).toBe("");
  });
});

describe("projectAgentInstructionsService", () => {
  it("returns the instructions, or null for a missing project", async () => {
    mocks.project = { settings: { agentInstructions: "## Repos" } };
    expect(
      await projectAgentInstructionsService.get(ORG_ID, PROJECT_ID)
    ).toEqual({ instructions: "## Repos" });

    mocks.project = null;
    expect(
      await projectAgentInstructionsService.get(ORG_ID, PROJECT_ID)
    ).toBeNull();
  });

  it("sets only the agentInstructions key of the settings", async () => {
    const saved = await projectAgentInstructionsService.update(
      ORG_ID,
      PROJECT_ID,
      { instructions: "## Repos" }
    );

    expect(saved).toEqual({ instructions: "## Repos" });
    const { sql, values } = sqlOf(mocks.executeRaw.mock.calls[0]);
    expect(sql).toContain("jsonb_set");
    expect(sql).toContain("{agentInstructions}");
    expect(values).toEqual(["## Repos", PROJECT_ID, ORG_ID]);
  });

  it("removes the key for blank instructions and reports a missing project", async () => {
    expect(
      await projectAgentInstructionsService.update(ORG_ID, PROJECT_ID, {
        instructions: "  \n ",
      })
    ).toEqual({ instructions: "" });
    expect(sqlOf(mocks.executeRaw.mock.calls[0]).sql).toContain(
      "- 'agentInstructions'"
    );

    mocks.executeRaw.mockResolvedValue(0);
    expect(
      await projectAgentInstructionsService.update(ORG_ID, PROJECT_ID, {
        instructions: "x",
      })
    ).toBeNull();
  });
});
