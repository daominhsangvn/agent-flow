import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { Status } from "@repo/api/src/types/result";
import {
  RUNNER_CAPABILITIES_REFRESH_OPERATION_ID,
  RunnerCapabilitiesRefreshStatus,
  RunnerCapabilitiesSource,
  runnerCapabilitiesRefreshKey,
} from "@repo/api/src/types/runner-capabilities";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processToolkitChanged,
  REFRESH_COMMAND_WINDOW_MS,
  refreshRefusal,
  computeTargetCapabilitiesRefreshService as service,
} from "@/app/compute-targets/capabilities-refresh-service";
import { CurrentProcessKind } from "@/app/projects/project-process-service";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  owner: "0199a5f0-0000-7000-8000-0000000000a1",
  other: "0199a5f0-0000-7000-8000-0000000000a2",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
  target2: "0199a5f0-0000-7000-8000-0000000000c2",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  refresh: "0199a5f0-0000-7000-8000-0000000000e1",
  command: "cmd-1",
};

const CHECKOUT = {
  fullName: "workshop/leavedesk-knowledge",
  cloneUrl: "https://git.example.com/workshop/leavedesk-knowledge.git",
  defaultBranch: "main",
  connectionId: "conn-1",
};

const READY_CAPABILITIES = { toolkitCapabilitiesRefresh: true };

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  targets: {} as Record<string, Row>,
  storedCapabilities: null as Row | null,
  storedRows: [] as Row[],
  projectSettings: {} as Row,
  command: null as Row | null,
  events: [] as Row[],
  processToolkit: null as string | null,
  checkouts: [] as Row[],
  dispatch: vi.fn(),
  commandWhere: null as unknown,
  staleArgs: null as unknown,
  issued: vi.fn(),
  expire: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveProjectId: (id: string) =>
    Promise.resolve(id === "PRO-1" ? IDS.project : null),
}));

vi.mock("@repo/database", () => {
  const db = {
    project: {
      findFirst: vi.fn((args: { select: Row }) =>
        Promise.resolve(
          args.select.settings
            ? { settings: mocks.projectSettings }
            : { id: IDS.project }
        )
      ),
    },
    computeTargetCapabilities: {
      findUnique: vi.fn(() => Promise.resolve(mocks.storedCapabilities)),
      findMany: vi.fn((args: unknown) => {
        mocks.staleArgs = args;
        return Promise.resolve(mocks.storedRows);
      }),
    },
    desktopCommand: {
      findFirst: vi.fn((args: unknown) => {
        mocks.commandWhere = args;
        return Promise.resolve(mocks.command);
      }),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findById: (id: string) => Promise.resolve(mocks.targets[id] ?? null),
  },
}));

vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts: () => Promise.resolve(mocks.checkouts),
  findRepositoryCheckout: (list: Row[], name: string) =>
    list.find((c) => String(c.fullName).toLowerCase() === name.toLowerCase()),
  checkoutBaseBranch: (c: Row) => c.defaultBranch,
}));

vi.mock("@/app/projects/project-process-service", () => ({
  CurrentProcessKind: { None: "none", Found: "found", Invalid: "invalid" },
  projectProcessService: {
    findCurrent: () =>
      Promise.resolve(
        mocks.processToolkit
          ? {
              kind: "found",
              snapshot: {
                definition: { toolkit: { repository: mocks.processToolkit } },
              },
            }
          : { kind: "none" }
      ),
  },
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandEvents: () => Promise.resolve(mocks.events),
    markCommandExpired: (...args: unknown[]) => mocks.expire(...args),
  },
}));

vi.mock("@/lib/loops/loop-desktop", () => ({
  dispatchCapabilitiesRefresh: (input: unknown) => mocks.dispatch(input),
  isDispatchError: (e: unknown) =>
    e instanceof Error && e.name === "DispatchError",
  isCommandSigningRefusedError: (e: unknown) =>
    e instanceof Error && e.name === "CommandSigningRefusedError",
}));

vi.mock("@/lib/loops/loop-git-credential", () => ({
  matchesGitCredentialRequest: (cloneUrl: string, req: { host: string }) =>
    cloneUrl.includes(req.host),
  issueRepositoryGitCredential: (input: unknown) => mocks.issued(input),
}));

vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));

function target(overrides: Row = {}): Row {
  return {
    id: IDS.target,
    organizationId: IDS.org,
    machineName: "runner-1",
    isOnline: true,
    capabilities: READY_CAPABILITIES,
    ...overrides,
  };
}

function activeCommand(): Row {
  return {
    id: IDS.command,
    status: DesktopCommandStatus.Running,
    error: null,
    createdAt: new Date(),
    requestPayload: {
      body: {
        refreshId: IDS.refresh,
        projectId: IDS.project,
        repository: CHECKOUT.fullName,
        cloneUrl: CHECKOUT.cloneUrl,
        defaultBranch: "main",
      },
    },
  };
}

beforeEach(() => {
  mocks.targets = { [IDS.target]: target() };
  mocks.storedCapabilities = null;
  mocks.storedRows = [];
  mocks.projectSettings = {};
  mocks.command = null;
  mocks.events = [];
  mocks.processToolkit = null;
  mocks.checkouts = [CHECKOUT];
  mocks.expire = vi.fn((..._args: unknown[]) => Promise.resolve());
  mocks.dispatch = vi.fn(() => Promise.resolve(IDS.command));
  mocks.issued = vi.fn(() =>
    Promise.resolve({ ok: true, value: { username: "u", password: "p" } })
  );
});

describe("refreshRefusal", () => {
  it("refuses a personal runner", () => {
    const refusal = refreshRefusal({
      machineName: "an-PRO-1",
      isOnline: true,
      capabilities: {
        ...READY_CAPABILITIES,
        personalRunner: { projectKey: "x" },
      },
    });
    expect(refusal?.status).toBe(Status.BadRequest);
    expect(refusal?.message).toContain("personal runner");
  });

  it("refuses a runner without the flag with the update message", () => {
    const refusal = refreshRefusal({
      machineName: "old",
      isOnline: true,
      capabilities: {},
    });
    expect(refusal?.status).toBe(Status.Conflict);
    expect(refusal?.message).toContain("Update the runner");
  });

  it("refuses an offline runner", () => {
    const refusal = refreshRefusal({
      machineName: "runner-1",
      isOnline: false,
      capabilities: READY_CAPABILITIES,
    });
    expect(refusal?.message).toBe("runner-1 is offline.");
  });

  it("accepts an online runner with the flag", () => {
    expect(
      refreshRefusal({
        machineName: "r",
        isOnline: true,
        capabilities: READY_CAPABILITIES,
      })
    ).toBeNull();
  });
});

describe("request", () => {
  it("uses the explicit repository and dispatches with the idempotency-key id", async () => {
    mocks.processToolkit = "other/ignored";
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
      repository: CHECKOUT.fullName,
    });
    expect(result.ok).toBe(true);
    const call = mocks.dispatch.mock.calls[0][0];
    expect(call.computeTargetId).toBe(IDS.target);
    expect(call.request).toMatchObject({
      projectId: IDS.project,
      repository: CHECKOUT.fullName,
      cloneUrl: CHECKOUT.cloneUrl,
      defaultBranch: "main",
    });
    expect(result.ok && result.value).toMatchObject({
      refreshId: call.request.refreshId,
      status: RunnerCapabilitiesRefreshStatus.Pending,
      error: null,
    });
    expect(runnerCapabilitiesRefreshKey(call.request.refreshId)).toBe(
      `capabilities_refresh:${call.request.refreshId}`
    );
  });

  it("falls back to the toolkit of the stored file", async () => {
    mocks.storedCapabilities = {
      organizationId: IDS.org,
      capabilities: {
        runner: null,
        toolkit: { repository: CHECKOUT.fullName, mounts: [".claude"] },
        commands: [],
        skills: [],
      },
    };
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
    });
    expect(result.ok && result.value.repository).toBe(CHECKOUT.fullName);
  });

  it("falls back to the process toolkit", async () => {
    mocks.processToolkit = CHECKOUT.fullName;
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
    });
    expect(result.ok && result.value.repository).toBe(CHECKOUT.fullName);
  });

  it("asks to name the repository when none is known", async () => {
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
    });
    expect(!result.ok && result.error.status).toBe(Status.BadRequest);
    expect(!result.ok && result.error.message).toContain(
      "Name the toolkit repository"
    );
  });

  it("refuses a repository outside the project", async () => {
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
      repository: "x/other",
    });
    expect(!result.ok && result.error.message).toContain(
      "not one of the project's repositories"
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown project or a runner of another org", async () => {
    const noProject = await service.request(IDS.org, IDS.target, {
      project: "X-9",
    });
    expect(!noProject.ok && noProject.error.status).toBe(Status.NotFound);
    mocks.targets[IDS.target] = target({ organizationId: "other-org" });
    const noRunner = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
    });
    expect(!noRunner.ok && noRunner.error.message).toBe("Runner not found");
  });

  it("maps a dispatch failure to a bad gateway", async () => {
    mocks.dispatch = vi.fn(() => {
      const err = Object.assign(new Error("not delivered"), {
        name: "DispatchError",
        commandId: IDS.command,
      });
      return Promise.reject(err);
    });
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
      repository: CHECKOUT.fullName,
    });
    expect(!result.ok && result.error.status).toBe(Status.BadGateway);
    expect(mocks.expire.mock.calls[0][0]).toBe(IDS.command);
  });

  it("maps the signing refusal to a conflict with its message", async () => {
    mocks.dispatch = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("only accepts signed commands"), {
          name: "CommandSigningRefusedError",
        })
      )
    );
    const result = await service.request(IDS.org, IDS.target, {
      project: "PRO-1",
      repository: CHECKOUT.fullName,
    });
    expect(!result.ok && result.error).toEqual({
      status: Status.Conflict,
      message: "only accepts signed commands",
    });
  });
});

describe("status", () => {
  it("is null for an unknown refresh", async () => {
    expect(await service.status(IDS.org, IDS.target, IDS.refresh)).toBeNull();
  });

  it("is pending while the command runs", async () => {
    mocks.command = activeCommand();
    const status = await service.status(IDS.org, IDS.target, IDS.refresh);
    expect(status).toMatchObject({
      status: RunnerCapabilitiesRefreshStatus.Pending,
      repository: CHECKOUT.fullName,
    });
    expect(mocks.commandWhere).toMatchObject({
      where: { operationId: RUNNER_CAPABILITIES_REFRESH_OPERATION_ID },
    });
  });

  it("succeeds on an ok result", async () => {
    mocks.command = { ...activeCommand(), status: DesktopCommandStatus.Done };
    mocks.events = [
      {
        eventType: "result",
        data: { type: "result", ok: true, contentHash: "ab", warningCount: 0 },
      },
    ];
    const status = await service.status(IDS.org, IDS.target, IDS.refresh);
    expect(status?.status).toBe(RunnerCapabilitiesRefreshStatus.Succeeded);
  });

  it("fails with the runner's error on an ok:false result", async () => {
    mocks.command = { ...activeCommand(), status: DesktopCommandStatus.Done };
    mocks.events = [
      {
        eventType: "result",
        data: { type: "result", ok: false, error: "no AGENTFLOW.md" },
      },
    ];
    const status = await service.status(IDS.org, IDS.target, IDS.refresh);
    expect(status).toMatchObject({
      status: RunnerCapabilitiesRefreshStatus.Failed,
      error: "no AGENTFLOW.md",
    });
  });

  it("fails and expires a command that is overdue", async () => {
    mocks.command = {
      ...activeCommand(),
      createdAt: new Date(Date.now() - REFRESH_COMMAND_WINDOW_MS - 1000),
    };
    const status = await service.status(IDS.org, IDS.target, IDS.refresh);
    expect(status?.status).toBe(RunnerCapabilitiesRefreshStatus.Failed);
    expect(mocks.expire.mock.calls[0][0]).toBe(IDS.command);
  });

  it("fails when the command expired", async () => {
    mocks.command = {
      ...activeCommand(),
      status: DesktopCommandStatus.Expired,
    };
    const status = await service.status(IDS.org, IDS.target, IDS.refresh);
    expect(status).toMatchObject({
      status: RunnerCapabilitiesRefreshStatus.Failed,
      error: "The runner did not read the toolkit (expired).",
    });
  });
});

describe("issueGitCredential", () => {
  const request = { protocol: "https", host: "git.example.com", path: null };

  it("issues for the repository the running refresh names", async () => {
    mocks.command = activeCommand();
    const result = await service.issueGitCredential(
      IDS.org,
      IDS.owner,
      IDS.target,
      IDS.refresh,
      request
    );
    expect(result.ok).toBe(true);
    expect(mocks.issued.mock.calls[0][0]).toMatchObject({
      organizationId: IDS.org,
      repository: CHECKOUT,
    });
    expect(mocks.commandWhere).toMatchObject({
      where: {
        status: {
          in: [
            DesktopCommandStatus.Queued,
            DesktopCommandStatus.Accepted,
            DesktopCommandStatus.Running,
          ],
        },
        createdAt: { gte: expect.any(Date) },
        computeTarget: { organizationId: IDS.org, userId: IDS.owner },
      },
    });
  });

  it("only looks at commands younger than the refresh window", async () => {
    mocks.command = activeCommand();
    await service.issueGitCredential(
      IDS.org,
      IDS.owner,
      IDS.target,
      IDS.refresh,
      request
    );
    const where = (
      mocks.commandWhere as { where: { createdAt: { gte: Date } } }
    ).where;
    const age = Date.now() - where.createdAt.gte.getTime();
    expect(Math.abs(age - REFRESH_COMMAND_WINDOW_MS)).toBeLessThan(5000);
  });

  it("is refused when no active command matches (other user or finished)", async () => {
    mocks.command = null;
    const result = await service.issueGitCredential(
      IDS.org,
      IDS.other,
      IDS.target,
      IDS.refresh,
      request
    );
    expect(!result.ok && result.error.status).toBe(Status.NotFound);
    expect(mocks.issued).not.toHaveBeenCalled();
  });

  it("is refused for a repository the command does not name", async () => {
    mocks.command = activeCommand();
    mocks.checkouts = [{ ...CHECKOUT, fullName: "workshop/another" }];
    const result = await service.issueGitCredential(
      IDS.org,
      IDS.owner,
      IDS.target,
      IDS.refresh,
      request
    );
    expect(result.ok).toBe(false);
  });

  it("is refused on a host mismatch", async () => {
    mocks.command = activeCommand();
    const result = await service.issueGitCredential(
      IDS.org,
      IDS.owner,
      IDS.target,
      IDS.refresh,
      {
        ...request,
        host: "evil.example.org",
      }
    );
    expect(result.ok).toBe(false);
    expect(mocks.issued).not.toHaveBeenCalled();
  });
});

describe("refreshProject", () => {
  it("unions stored rows and project runners, counting refusals as skipped", async () => {
    mocks.targets = {
      [IDS.target]: target(),
      [IDS.target2]: target({ id: IDS.target2, capabilities: {} }),
    };
    mocks.storedRows = [{ computeTargetId: IDS.target }];
    mocks.projectSettings = { runnerIds: [IDS.target, IDS.target2] };
    mocks.storedCapabilities = null;
    mocks.processToolkit = CHECKOUT.fullName;
    const counts = await service.refreshProject(IDS.org, IDS.project);
    expect(counts).toEqual({ dispatched: 1, skipped: 1 });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("refreshProject with an unexpected failure", () => {
  it("skips the runner that throws and continues with the rest", async () => {
    mocks.targets = {
      [IDS.target]: target(),
      [IDS.target2]: target({ id: IDS.target2 }),
    };
    mocks.projectSettings = { runnerIds: [IDS.target, IDS.target2] };
    mocks.processToolkit = CHECKOUT.fullName;
    mocks.dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(IDS.command);
    const counts = await service.refreshProject(IDS.org, IDS.project);
    expect(counts).toEqual({ dispatched: 1, skipped: 1 });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("refreshStale", () => {
  it("queries toolkit rows older than 20 hours, at most 100", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    mocks.storedRows = [];
    await service.refreshStale(now);
    expect(mocks.staleArgs).toMatchObject({
      where: {
        source: RunnerCapabilitiesSource.Toolkit,
        uploadedAt: { lt: new Date("2026-10-25T16:00:00Z") },
      },
      take: 100,
    });
  });

  it("dispatches for each stale row", async () => {
    mocks.storedRows = [
      {
        organizationId: IDS.org,
        computeTargetId: IDS.target,
        projectId: IDS.project,
      },
    ];
    mocks.processToolkit = CHECKOUT.fullName;
    const counts = await service.refreshStale(new Date());
    expect(counts.dispatched).toBe(1);
  });
});

describe("processToolkitChanged", () => {
  const found = (toolkit: Row | null) => ({
    kind: CurrentProcessKind.Found,
    snapshot: { definition: toolkit ? { toolkit } : {} },
  });
  const afterSave = (toolkit: Row | null) => ({
    current: { definition: toolkit ? { toolkit } : {} },
    invalidVersion: null,
  });

  it("is true when the repository or mounts change", () => {
    expect(
      processToolkitChanged(
        found({ repository: "a/b", mounts: [] }) as never,
        afterSave({ repository: "a/c", mounts: [] }) as never
      )
    ).toBe(true);
    expect(
      processToolkitChanged(
        found({ repository: "a/b", mounts: [] }) as never,
        afterSave({ repository: "a/b", mounts: [".claude"] }) as never
      )
    ).toBe(true);
  });

  it("is false for an identical toolkit (case-insensitive) and when both are null", () => {
    expect(
      processToolkitChanged(
        found({ repository: "A/b", mounts: [] }) as never,
        afterSave({ repository: "a/B", mounts: [] }) as never
      )
    ).toBe(false);
    expect(
      processToolkitChanged(
        { kind: CurrentProcessKind.None } as never,
        afterSave(null) as never
      )
    ).toBe(false);
  });
});
