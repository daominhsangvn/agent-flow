import { describe, expect, it } from "vitest";
import { getProjectSettings } from "./project.ts";

describe("getProjectSettings", () => {
  it("keeps a valid repository override", () => {
    expect(
      getProjectSettings({
        repositoryOverrides: {
          selectedRepoIds: ["primary", "secondary"],
          primaryRepoId: "primary",
        },
      })
    ).toEqual({
      repositoryOverrides: {
        selectedRepoIds: ["primary", "secondary"],
        primaryRepoId: "primary",
      },
    });
  });

  it("drops an override whose primary is not selected", () => {
    expect(
      getProjectSettings({
        repositoryOverrides: {
          selectedRepoIds: ["secondary"],
          primaryRepoId: "primary",
        },
      })
    ).toEqual({});
  });
});
