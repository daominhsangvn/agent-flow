// A pull request AgentFlow listed on a session itself (a workflow's pull
// request action, lib/workflows/engine/run-session-pull-requests.ts) keeps the
// page it was recorded with, so the Sessions page links it on any provider.

import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const PR_URL = "http://localhost:3300/workshop/calculator-app/pulls/2";

async function listedPullRequests(pullRequests: unknown) {
  installDb({
    sessionDetail: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          buildSessionListRecord({ branch: "symphony/pln-2", pullRequests }),
        ]),
      count: vi.fn().mockResolvedValue(1),
    },
  });
  const result = await agentSessionsService.findSessions({
    organizationId: "org-1",
    filters: {},
  });
  return result.items[0]?.prs;
}

describe("agentSessionsService pull request pages recorded by AgentFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the page a workflow action recorded with the pull request", async () => {
    await expect(
      listedPullRequests([
        {
          num: 2,
          title: "CALC-2: Add an MIT license",
          status: SessionPrLifecycleStatus.Open,
          url: PR_URL,
        },
      ])
    ).resolves.toEqual([
      {
        num: 2,
        title: "CALC-2: Add an MIT license",
        status: SessionPrLifecycleStatus.Open,
        url: PR_URL,
      },
    ]);
  });

  it("never serves a stored page that is not http(s)", async () => {
    await expect(
      listedPullRequests([
        {
          num: 2,
          title: "CALC-2: Add an MIT license",
          status: SessionPrLifecycleStatus.Open,
          url: "javascript:alert(1)",
        },
      ])
    ).resolves.toEqual([]);
  });
});
