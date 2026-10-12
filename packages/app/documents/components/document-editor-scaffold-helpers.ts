import type { DocumentDetail } from "@repo/api/src/types/document";

/**
 * Returns the content that attachment deletion warnings should inspect.
 * Historical views must use the saved latest version carried by the API, not
 * the selected historical `document.version.content` body.
 */
export function getLatestContentForAttachmentWarnings({
  currentVersion,
  document,
  latestDraftContent,
}: {
  currentVersion: number;
  document: Pick<
    DocumentDetail,
    "latestVersion" | "latestVersionContent" | "version"
  >;
  latestDraftContent: string;
}): string {
  if (currentVersion === document.latestVersion) {
    return latestDraftContent;
  }

  return document.latestVersionContent ?? "";
}

/**
 * Resolves the Liveblocks room id the editor should actually connect to
 * (FEA-2404). The room is only joined once the user/org context is ready
 * (`/me` resolved), so its auth callback never races page mount and exhausts
 * Liveblocks' 10s auth timeout, and once the server confirmed it has
 * collaboration at all (a server without it can only fail the room's auth).
 * Until ready, returns `null` — the already supported room-less state —
 * regardless of the artifact's room id. Passing `null` also keeps the editor
 * body / feed out of room-hook mode while there is no RoomProvider.
 */
export function resolveActiveRoomId({
  liveblocksRoomId,
  isUserLoading,
  hasCurrentUser,
  collaborationEnabled,
}: {
  liveblocksRoomId: string | null;
  isUserLoading: boolean;
  hasCurrentUser: boolean;
  /** Server has collaboration; `null` while unknown. */
  collaborationEnabled: boolean | null;
}): string | null {
  const collaborationReady =
    collaborationEnabled === true && !isUserLoading && hasCurrentUser;
  return collaborationReady ? liveblocksRoomId : null;
}
