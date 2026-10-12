"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import type { TiptapEditor } from "@repo/rich-text";
import { useCallback, useEffect, useRef, useState } from "react";

type UseEditorSessionConfig = {
  artifact: DocumentDetail;
  currentVersion: number;
  /**
   * Whether the server has real-time collaboration. `false` gives the
   * artifact no room: the editor shows and saves versions through the API.
   * `null` while unknown. Defaults to `true`.
   */
  collaborationEnabled?: boolean | null;
};

/**
 * Hook to manage the view/edit session lifecycle for collaborative artifact editors.
 *
 * Extracts the shared logic between PRD and Plan editors:
 * - Edit mode state (view by default, click to edit)
 * - Editor JSON snapshot for discard (preserving Liveblocks comment marks)
 * - Liveblocks room ID computation
 * - Content reset via augmented editor reference
 * - Thread count tracking
 *
 * @example
 * ```tsx
 * const session = useEditorSession({ artifact, currentVersion });
 *
 * <CollaborativeEditorBody
 *   readOnly={!session.isEditing}
 *   liveblocksRoomId={session.liveblocksRoomId}
 *   onEditorInstance={session.handleEditorInstance}
 * />
 * ```
 */
export function useEditorSession(config: UseEditorSessionConfig) {
  const { artifact, currentVersion, collaborationEnabled = true } = config;

  const [openThreadCount, setOpenThreadCount] = useState(0);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const editorRef = useRef<TiptapEditor | null>(null);

  const isViewingHistorical = currentVersion !== artifact.latestVersion;

  // Always derive the room ID from the artifact slug — there is one room per
  // artifact regardless of which version is being viewed. The room is cheap to
  // mount; the more expensive question is whether the editor reads its content
  // from the Y.Doc (latest version) or from the static value prop (historical).
  const liveblocksRoomId =
    artifact.slug && collaborationEnabled !== false
      ? generateDocumentRoomId(artifact.organizationId, artifact.slug)
      : null;

  // Editor uses the Liveblocks Tiptap extension for content sync only on the
  // latest version. On historical views, content comes from the version prop.
  const editorUsesLiveblocksContent =
    !isViewingHistorical && !!liveblocksRoomId;

  const handleEditorInstance = useCallback(
    (editor: TiptapEditor | null) => {
      editorRef.current = editor;

      if (editor !== null && !editorUsesLiveblocksContent) {
        // When the editor isn't reading from Y.Doc, content is set synchronously
        // from the value prop, so the editor is content-ready on creation.
        setIsEditorReady(true);
      }
    },
    [editorUsesLiveblocksContent]
  );
  // The editor can exist before the server said it has no collaboration
  // (while unknown it waits for the room's content): from then on it reads
  // the value prop, so it is content-ready already.
  useEffect(() => {
    if (!editorUsesLiveblocksContent && editorRef.current !== null) {
      setIsEditorReady(true);
    }
  }, [editorUsesLiveblocksContent]);
  const handleEditorReady = useCallback(() => {
    setIsEditorReady(true);
  }, []);

  const setEditorContent = useCallback((content: string) => {
    editorRef.current?.resetContent(content);
  }, []);

  return {
    editor: editorRef.current,
    handleEditorInstance,
    isEditorReady,
    handleEditorReady,
    setEditorContent,
    isViewingHistorical,
    liveblocksRoomId,
    editorUsesLiveblocksContent,
    openThreadCount,
    handleThreadCountChange: setOpenThreadCount,
  };
}
