import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import type { TiptapEditor } from "@repo/rich-text";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useEditorSession } from "../use-editor-session";

const fakeEditor = { resetContent: () => undefined } as unknown as TiptapEditor;

describe("useEditorSession collaboration", () => {
  test("gives the artifact a room when the server has collaboration", () => {
    const { result } = renderHook(() =>
      useEditorSession({
        artifact: createArtifact(),
        currentVersion: 2,
        collaborationEnabled: true,
      })
    );

    expect(result.current.liveblocksRoomId).not.toBeNull();
    expect(result.current.editorUsesLiveblocksContent).toBe(true);
  });

  test("has no room on a server without collaboration, and the editor is ready once created", () => {
    const { result } = renderHook(() =>
      useEditorSession({
        artifact: createArtifact(),
        currentVersion: 2,
        collaborationEnabled: false,
      })
    );

    expect(result.current.liveblocksRoomId).toBeNull();
    expect(result.current.editorUsesLiveblocksContent).toBe(false);
    act(() => result.current.handleEditorInstance(fakeEditor));
    expect(result.current.isEditorReady).toBe(true);
  });

  test("an editor created while the status was unknown becomes ready when the server has no collaboration", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean | null }) =>
        useEditorSession({
          artifact: createArtifact(),
          currentVersion: 2,
          collaborationEnabled: enabled,
        }),
      { initialProps: { enabled: null as boolean | null } }
    );

    // Unknown: the editor waits for the room's content.
    act(() => result.current.handleEditorInstance(fakeEditor));
    expect(result.current.isEditorReady).toBe(false);

    rerender({ enabled: false });
    expect(result.current.isEditorReady).toBe(true);
  });
});

function createArtifact(): DocumentDetail {
  const now = new Date("2026-10-09T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.ImplementationPlan,
    title: "Plan",
    slug: "PLN-17",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 2,
    latestVersionContent: "# Plan",
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: "none",
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: "version-2",
      documentId: "document-1",
      version: 2,
      content: "# Plan",
      createdById: "user-1",
      createdAt: now,
    },
  };
}
