import { describe, expect, it } from "vitest";
import { caseSourceProvider } from "../case-source";

describe("caseSourceProvider", () => {
  it("returns the part before the first colon", () => {
    expect(caseSourceProvider("jira:LD-5")).toBe("jira");
    expect(caseSourceProvider("teams:a:b")).toBe("teams");
  });

  it("returns null without a usable prefix", () => {
    expect(caseSourceProvider(null)).toBeNull();
    expect(caseSourceProvider("LD-5")).toBeNull();
    expect(caseSourceProvider(":LD-5")).toBeNull();
  });
});
