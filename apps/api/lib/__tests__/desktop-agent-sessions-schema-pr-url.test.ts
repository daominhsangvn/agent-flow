/**
 * A session's pull request page (`SessionPR.url`) is set only by AgentFlow
 * itself (lib/workflows/engine/run-session-pull-requests.ts): the sync payload
 * schema drops it, so a desktop cannot make the Sessions page link elsewhere.
 * Pure schema assertions.
 */
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

describe("parseDesktopAgentSessionsPayload — pull request pages", () => {
  it("drops a pull request's page from a synced session", () => {
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prs: [
            {
              num: 2,
              title: "Add an MIT license",
              status: "open",
              url: "https://example.com/not-the-pull-request",
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0]?.prs).toEqual([
        { num: 2, title: "Add an MIT license", status: "open" },
      ]);
    }
  });
});
