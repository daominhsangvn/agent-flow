/**
 * Unit tests for the ChecklistItemId const in @repo/api/src/types/onboarding.
 *
 * Verifies the removed rows stay removed and the remaining checklist item IDs
 * are present with their correct string values.
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { describe, expect, it } from "vitest";

describe("ChecklistItemId", () => {
  it("does not contain a ConnectLinear entry", () => {
    expect(Object.keys(ChecklistItemId)).not.toContain("ConnectLinear");
    expect(Object.values(ChecklistItemId)).not.toContain("CONNECT_LINEAR");
  });

  // Runners replaced the desktop download, and the GitHub and Anthropic key
  // rows went with the settings cards they pointed at: repositories come from
  // integration connections, and Claude credentials from each runner's model
  // provider.
  it("does not contain the desktop, GitHub or Anthropic key rows", () => {
    expect(Object.keys(ChecklistItemId)).not.toContain("DownloadDesktop");
    expect(Object.values(ChecklistItemId)).not.toContain("DOWNLOAD_DESKTOP");
    expect(Object.values(ChecklistItemId)).not.toContain("CONNECT_GITHUB");
    expect(Object.values(ChecklistItemId)).not.toContain("ADD_ANTHROPIC_KEY");
  });

  it("contains the four expected checklist item IDs", () => {
    expect(Object.keys(ChecklistItemId)).toHaveLength(4);
    expect(Object.keys(ChecklistItemId)).toEqual(
      expect.arrayContaining([
        "CreateProject",
        "InstallRunner",
        "ConnectGoogle",
        "InviteMembers",
      ])
    );
  });

  it("maps each key to the correct string value", () => {
    expect(ChecklistItemId.CreateProject).toBe("CREATE_PROJECT");
    expect(ChecklistItemId.InstallRunner).toBe("INSTALL_RUNNER");
    expect(ChecklistItemId.ConnectGoogle).toBe("CONNECT_GOOGLE");
    expect(ChecklistItemId.InviteMembers).toBe("INVITE_MEMBERS");
  });
});
