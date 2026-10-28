/**
 * Unit tests for `getProjectSettings` in `@repo/api/src/types/project`:
 * parsing of `settings.repositoryOverrides`.
 */

import { getProjectSettings } from "@repo/api/src/types/project";
import { describe, expect, it } from "vitest";

describe("getProjectSettings", () => {
  it("parses repositoryOverrides", () => {
    const settings = getProjectSettings({
      repositoryOverrides: {
        selectedRepoIds: ["a", "b"],
        primaryRepoId: "a",
      },
    });

    expect(settings.repositoryOverrides).toEqual({
      selectedRepoIds: ["a", "b"],
      primaryRepoId: "a",
    });
  });

  it("drops repositoryOverrides when primaryRepoId is not in selectedRepoIds", () => {
    const settings = getProjectSettings({
      repositoryOverrides: {
        selectedRepoIds: ["a"],
        primaryRepoId: "b",
      },
    });

    expect(settings.repositoryOverrides).toBeUndefined();
  });

  it("ignores unknown keys without erroring", () => {
    const settings = getProjectSettings({
      unknownKey: "value",
      repositoryOverrides: {
        selectedRepoIds: ["a"],
        primaryRepoId: "a",
      },
    });

    expect(settings.repositoryOverrides).toEqual({
      selectedRepoIds: ["a"],
      primaryRepoId: "a",
    });
  });
});
