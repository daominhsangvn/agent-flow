import { describe, expect, it } from "vitest";
import {
  checkoutBaseBranch,
  findRepositoryCheckout,
  type ProjectRepositoryCheckout,
  toLoopRepositorySelection,
} from "@/app/projects/project-repository-checkouts";

function checkout(
  fullName: string,
  overrides: Partial<ProjectRepositoryCheckout> = {}
): ProjectRepositoryCheckout {
  return {
    id: fullName,
    connectionId: "conn",
    provider: "github",
    externalId: fullName,
    fullName,
    name: fullName.split("/").at(-1) ?? fullName,
    defaultBranch: "main",
    webUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    isPrimary: false,
    ...overrides,
  };
}

const api = checkout("acme/api", { isPrimary: true });
const web = checkout("acme/web", { defaultBranch: "develop" });
const docs = checkout("acme/docs", { defaultBranch: null });

describe("toLoopRepositorySelection", () => {
  it("uses the project's primary repository and mounts the others", () => {
    expect(toLoopRepositorySelection([api, web, docs])).toEqual({
      primary: { fullName: "acme/api", branch: "main" },
      additional: [
        { fullName: "acme/web", branch: "develop" },
        { fullName: "acme/docs", branch: "main" },
      ],
    });
  });

  it("puts the requested repository first, case-insensitively", () => {
    expect(toLoopRepositorySelection([api, web], "ACME/Web")).toEqual({
      primary: { fullName: "acme/web", branch: "develop" },
      additional: [{ fullName: "acme/api", branch: "main" }],
    });
  });

  it("is null for a project without repositories", () => {
    expect(toLoopRepositorySelection([])).toBeNull();
  });
});

describe("findRepositoryCheckout / checkoutBaseBranch", () => {
  it("finds by full name and falls back to main without a default branch", () => {
    expect(findRepositoryCheckout([api, docs], "acme/docs")).toBe(docs);
    expect(findRepositoryCheckout([api], "acme/other")).toBeUndefined();
    expect(findRepositoryCheckout([api], null)).toBeUndefined();
    expect(checkoutBaseBranch(docs)).toBe("main");
  });
});
