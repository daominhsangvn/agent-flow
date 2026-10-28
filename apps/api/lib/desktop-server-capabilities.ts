import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";

/**
 * Builds the additive Desktop server-capability payload shared by hello acks.
 * Agent-session sync is always on (no flag or org policy gates it), so its
 * capabilities are always advertised.
 */
export function buildDesktopServerCapabilities(input: {
  commandSigningSupported: boolean;
}): ComputeTargetServerCapabilities {
  return {
    ...(input.commandSigningSupported ? { computeTargetSigning: true } : {}),
    agentSessionSync: true,
    // FEA-4138: gzip decompression on the sync ingest route ships with this
    // server build. It is a server-version capability — the desktop only
    // compresses when it sees this flag, so an older server that never emits
    // it keeps receiving uncompressed bodies (skew-safe).
    agentSessionSyncCompression: true,
    // ISS-4541: this server build merges a paginated multi-part activity-segment
    // tiling additively (delete-replace on chunk 0, append-idempotent on later
    // chunks — see persistSessionActivitySegments). Like the flag above it is a
    // server-version capability: the desktop only paginates the tiling across
    // chunks when it sees this flag, so an older server that never emits it
    // keeps receiving the full tiling replicated in the base payload
    // (skew-safe — the old REPLACE-ALL-per-chunk path stays correct).
    agentSessionSyncActivityChunking: true,
    agentSessionSyncMonitoredActivity: true,
  };
}
