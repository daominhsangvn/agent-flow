import { describe, expect, test } from "vitest";
import {
  ClaudeCodeVersionChannel,
  claudeCodeVersionSchema,
  ModelProviderMode,
  updateComputeTargetModelProviderInputSchema,
} from "./compute-target-model-provider";

describe("claudeCodeVersionSchema", () => {
  test("accepts latest and exact releases", () => {
    for (const value of [
      ClaudeCodeVersionChannel.Latest,
      "2.1.296",
      "10.0.1",
      "2.2.0-beta.1",
    ]) {
      expect(claudeCodeVersionSchema.parse(value)).toBe(value);
    }
    expect(claudeCodeVersionSchema.parse(" 2.1.290 ")).toBe("2.1.290");
  });

  test("refuses anything that is not an installer target or a plain file name", () => {
    for (const value of [
      "",
      "stable",
      "2.1",
      "v2.1.296",
      "2.1.296/../../bin",
      "../2.1.296",
      "2.1.296; rm -rf ~",
      "2.1.296 --force",
      "LATEST",
    ]) {
      expect(claudeCodeVersionSchema.safeParse(value).success, value).toBe(
        false
      );
    }
  });
});

describe("updateComputeTargetModelProviderInputSchema", () => {
  test("defaults the Claude Code version to latest", () => {
    const input = updateComputeTargetModelProviderInputSchema.parse({
      mode: ModelProviderMode.Machine,
    });

    expect(input.claudeCodeVersion).toBe(ClaudeCodeVersionChannel.Latest);
  });

  test("keeps an exact version and rejects an invalid one", () => {
    expect(
      updateComputeTargetModelProviderInputSchema.parse({
        mode: ModelProviderMode.Machine,
        claudeCodeVersion: "2.1.290",
      }).claudeCodeVersion
    ).toBe("2.1.290");
    expect(
      updateComputeTargetModelProviderInputSchema.safeParse({
        mode: ModelProviderMode.Machine,
        claudeCodeVersion: "2.1.290 && curl evil",
      }).success
    ).toBe(false);
  });
});
