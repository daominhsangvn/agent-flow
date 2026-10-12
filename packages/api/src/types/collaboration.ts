/**
 * Whether the server has real-time collaboration (Liveblocks) configured.
 * Self-hosted installs can run without it: document editors then read and
 * save versions through the API, without live co-editing, presence or inline
 * comment threads.
 */
export type CollaborationStatus = {
  enabled: boolean;
};
