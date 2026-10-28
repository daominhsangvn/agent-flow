import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import {
  type ActionRunsDbFake,
  createActionRunsDbFake,
} from "@/lib/workflows/__tests__/support/action-runs-db.test-fake";
import { drainActionRuns } from "@/lib/workflows/engine/actions";

/**
 * An action the run gives several connections (a pull request action left
 * without a connection, its repositories on two connections) runs once per
 * connection, and its row settles with what all of them did.
 */

const mocks = vi.hoisted(() => ({
  fake: null as ActionRunsDbFake | null,
  execute: vi.fn(),
  resolveActionConnection: vi.fn(),
  buildRunSnapshot: vi.fn(),
  recordActionOutputs: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (client: unknown) => unknown) => fn(mocks.fake?.db),
  Prisma: { DbNull: null },
}));
vi.mock("@/lib/workflows/engine/action-connection", () => ({
  resolveActionConnection: mocks.resolveActionConnection,
}));
vi.mock("@/lib/workflows/engine/instruction-action", () => ({
  startInstruction: vi.fn(),
  readInstructionProgress: vi.fn(),
  summarizeInstruction: vi.fn(),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/integrations/registry", () => ({
  findActionDefinition: (_provider: string, type: string) =>
    type === PR_TYPE
      ? {
          key: PR_TYPE,
          configSchema: z.object({ title: z.string().default("PR") }),
          repositoryScoped: true,
          execute: mocks.execute,
        }
      : null,
}));
vi.mock("@/lib/workflows/engine/snapshot", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/snapshot")>();
  return { ...original, buildRunSnapshot: mocks.buildRunSnapshot };
});
vi.mock("@/lib/workflows/engine/run-repository", () => ({
  recordActionOutputs: mocks.recordActionOutputs,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));

const PR_TYPE = "local_git.create_pull_request";
const NOW = new Date("2026-10-13T09:00:00.000Z");

let fake: ActionRunsDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createActionRunsDbFake();
  mocks.fake = fake;
  fake.addAction({ id: "action-1", type: PR_TYPE, connectionId: null });
  fake.addActionRun({
    actionType: PR_TYPE,
    nextAttemptAt: new Date(NOW.getTime() - 1000),
  });
  mocks.resolveActionConnection.mockResolvedValue({
    ok: true,
    connections: [
      connection("conn-web", "token-web"),
      connection("conn-api", "token-api"),
    ],
  });
  mocks.buildRunSnapshot.mockResolvedValue({
    id: "run-1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    source: { key: "PROJ-7" },
  } as WorkflowRunSnapshot);
});

function connection(id: string, token: string) {
  return {
    record: { id, name: id, status: IntegrationConnectionStatus.Active },
    provider: { key: "local_git", displayName: "Local Git" },
    runtime: { id, secrets: { token }, config: {} },
  };
}

function opened(repositoryId: string): ActionResult {
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: `https://git.test/${repositoryId}/pulls/1`,
    outputs: {
      pullRequests: [
        {
          repositoryId,
          url: `https://git.test/${repositoryId}/pulls/1`,
          number: 1,
          branch: "b",
        },
      ],
    },
  };
}

describe("an action on several connections", () => {
  it("runs once per connection and records every pull request", async () => {
    mocks.execute
      .mockResolvedValueOnce(opened("web"))
      .mockResolvedValueOnce(opened("api"));

    await drainActionRuns({ now: NOW });

    expect(
      mocks.execute.mock.calls.map(
        (call) =>
          (call[0] as ActionContext<unknown, unknown, unknown>).connection
      )
    ).toEqual([
      expect.objectContaining({ id: "conn-web" }),
      expect.objectContaining({ id: "conn-api" }),
    ]);
    expect(mocks.recordActionOutputs).toHaveBeenCalledWith("run-1", {
      pullRequests: [
        expect.objectContaining({ repositoryId: "web" }),
        expect.objectContaining({ repositoryId: "api" }),
      ],
    });
    expect(fake.actionRuns[0]).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "https://git.test/web/pulls/1",
    });
  });

  it("retries the row when one connection failed, with every connection's secrets scrubbed", async () => {
    mocks.execute.mockResolvedValueOnce(opened("web")).mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Failed,
      error: "push rejected with token-api",
      retryable: true,
    });

    await drainActionRuns({ now: NOW });

    expect(fake.actionRuns[0]).toMatchObject({
      status: WorkflowActionRunStatus.Pending,
      attempts: 1,
    });
    expect(String(fake.actionRuns[0]?.lastError)).not.toContain("token-api");
    expect(mocks.recordActionOutputs).toHaveBeenCalledWith("run-1", {
      pullRequests: [expect.objectContaining({ repositoryId: "web" })],
    });
  });
});
