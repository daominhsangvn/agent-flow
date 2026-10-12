import type { CollaborationStatus } from "@repo/api/src/types/collaboration";
import { success } from "@repo/api/src/types/common";
import { isCollaborationConfigured } from "@repo/collaboration/server/auth";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

/**
 * Whether real-time collaboration is configured (LIVEBLOCKS_SECRET). Clients
 * ask before joining a document room: without it the room's auth can only
 * fail, so editors work on the saved versions instead.
 */
export const GET = withAnyAuth<CollaborationStatus, "/collaboration/status">(
  () =>
    Promise.resolve(
      NextResponse.json(success({ enabled: isCollaborationConfigured() }))
    )
);
