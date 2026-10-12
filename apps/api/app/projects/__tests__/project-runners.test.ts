import { LoopStatus } from "@repo/api/src/types/loop";
import { readProjectRunnerIds } from "@repo/api/src/types/project-runners";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseProjectRunner,
  ProjectRunnerChoiceKind,
} from "@/app/projects/project-runner-selection";
import { projectRunnersService } from "@/app/projects/project-runners-service";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const USER_ID = "0199a5f0-0000-7000-8000-00000000000b";
const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const DOCUMENT_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const DOTNET = "0199a5f0-0000-7000-8000-0000000000c1";
const NODE = "0199a5f0-0000-7000-8000-0000000000c2";
const BIG = "0199a5f0-0000-7000-8000-0000000000c3";

type Target = {
  id: string;
  machineName: string;
  userId: string;
  isOnline: boolean;
  isSharedWithOrg: boolean;
  lastSeenAt: Date;
  capabilities: unknown;
  user: { firstName: string; lastName: string } | null;
};

type Where = {
  id: { in: string[] };
  isOnline?: boolean;
  OR?: Array<{ userId?: string; isSharedWithOrg?: boolean }>;
};

const mocks = vi.hoisted(() => ({
  settings: null as unknown,
  targets: [] as Target[],
  /** computeTargetId → loops waiting or running. */
  active: {} as Record<string, number>,
  loopWhere: null as unknown,
  executeRaw: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      artifact: {
        findFirst: () =>
          Promise.resolve({ project: { settings: mocks.settings } }),
      },
      project: {
        findFirst: () => Promise.resolve({ settings: mocks.settings }),
      },
      computeTarget: {
        findMany: ({ where }: { where: Where }) =>
          Promise.resolve(
            mocks.targets.filter(
              (target) =>
                where.id.in.includes(target.id) &&
                (where.isOnline === undefined ||
                  target.isOnline === where.isOnline) &&
                (!where.OR ||
                  where.OR.some(
                    (option) =>
                      option.userId === target.userId ||
                      option.isSharedWithOrg === target.isSharedWithOrg
                  ))
            )
          ),
      },
      loop: {
        groupBy: (args: { where: unknown }) => {
          mocks.loopWhere = args.where;
          return Promise.resolve(
            Object.entries(mocks.active).map(([computeTargetId, count]) => ({
              computeTargetId,
              _count: { _all: count },
            }))
          );
        },
      },
      $executeRaw: mocks.executeRaw,
    }),
}));

function target(id: string, overrides: Partial<Target> = {}): Target {
  return {
    id,
    machineName: `runner-${id.slice(-2)}`,
    userId: "someone-else",
    isOnline: true,
    isSharedWithOrg: true,
    lastSeenAt: new Date("2026-10-06T10:00:00.000Z"),
    capabilities: { maxInFlightCommands: 2 },
    user: { firstName: "Ops", lastName: "Team" },
    ...overrides,
  };
}

function choose(preferredComputeTargetId?: string) {
  return chooseProjectRunner({
    organizationId: ORG_ID,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    preferredComputeTargetId,
  });
}

beforeEach(() => {
  mocks.settings = { runnerIds: [DOTNET, NODE, BIG] };
  mocks.targets = [target(DOTNET), target(NODE), target(BIG)];
  mocks.active = {};
  mocks.loopWhere = null;
  mocks.executeRaw.mockReset();
  mocks.executeRaw.mockResolvedValue(1);
});

describe("readProjectRunnerIds", () => {
  it("reads runnerIds and is empty otherwise", () => {
    expect(readProjectRunnerIds({ runnerIds: [DOTNET] })).toEqual([DOTNET]);
    expect(readProjectRunnerIds({ agentInstructions: "x" })).toEqual([]);
    expect(readProjectRunnerIds(null)).toEqual([]);
  });
});

describe("chooseProjectRunner", () => {
  it("leaves the choice to the caller on a project without runners", async () => {
    mocks.settings = {};

    expect(await choose(DOTNET)).toEqual({
      kind: ProjectRunnerChoiceKind.None,
    });
  });

  it("keeps the requested computer when it is one of the runners", async () => {
    mocks.active = { [NODE]: 2 };

    expect(await choose(NODE)).toEqual({
      kind: ProjectRunnerChoiceKind.Resolved,
      computeTargetId: NODE,
    });
  });

  it("picks the runner with the most free capacity otherwise", async () => {
    mocks.targets = [
      target(DOTNET),
      target(NODE),
      target(BIG, { capabilities: { maxInFlightCommands: 8 } }),
    ];
    mocks.active = { [DOTNET]: 1, [BIG]: 3 };

    // NODE is idle: 0/2 beats BIG at 3/8 and DOTNET at 1/2.
    expect(await choose("not-a-runner")).toEqual({
      kind: ProjectRunnerChoiceKind.Resolved,
      computeTargetId: NODE,
    });
    expect(mocks.loopWhere).toMatchObject({
      organizationId: ORG_ID,
      status: {
        in: [LoopStatus.Pending, LoopStatus.Claimed, LoopStatus.Running],
      },
    });

    mocks.active = { [DOTNET]: 1, [NODE]: 1, [BIG]: 3 };
    // BIG at 3/8 now beats 1/2 on the others.
    expect(await choose()).toMatchObject({ computeTargetId: BIG });
  });

  it("prefers the most recently seen runner among equally busy ones", async () => {
    mocks.targets = [
      target(DOTNET),
      target(NODE, { lastSeenAt: new Date("2026-10-06T10:05:00.000Z") }),
    ];

    expect(await choose()).toMatchObject({ computeTargetId: NODE });
  });

  it("never falls back to another computer when no runner can take the loop", async () => {
    mocks.targets = [
      target(DOTNET, { isOnline: false }),
      target(NODE, { isSharedWithOrg: false }),
    ];

    const choice = await choose(BIG);

    expect(choice.kind).toBe(ProjectRunnerChoiceKind.Unavailable);
  });
});

describe("projectRunnersService", () => {
  it("lists the runners in order with their load and tools", async () => {
    mocks.settings = { runnerIds: [NODE, "deleted-runner", DOTNET] };
    mocks.targets = [
      target(DOTNET, {
        isOnline: false,
        capabilities: {
          versions: { git: "git version 2.39.5" },
          toolchains: { dotnet: "8.0.404" },
        },
        user: null,
      }),
      target(NODE),
    ];
    mocks.active = { [NODE]: 1 };

    expect(await projectRunnersService.get(ORG_ID, PROJECT_ID)).toEqual({
      runners: [
        {
          id: NODE,
          machineName: "runner-c2",
          isOnline: true,
          isSharedWithOrg: true,
          ownerName: "Ops Team",
          capacity: 2,
          activeLoops: 1,
          tools: {},
        },
        {
          id: DOTNET,
          machineName: "runner-c1",
          isOnline: false,
          isSharedWithOrg: true,
          ownerName: null,
          capacity: null,
          activeLoops: 0,
          tools: { git: "git version 2.39.5", dotnet: "8.0.404" },
        },
      ],
    });
  });

  it("stores the runners with a single jsonb update", async () => {
    const result = await projectRunnersService.update(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { runnerIds: [NODE, DOTNET, NODE] }
    );

    expect(result.ok).toBe(true);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("'{runnerIds}'");
    expect(values[0]).toBe(JSON.stringify([NODE, DOTNET]));
  });

  it("refuses a computer the caller cannot dispatch to", async () => {
    mocks.targets = [target(DOTNET, { isSharedWithOrg: false })];

    const result = await projectRunnersService.update(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { runnerIds: [DOTNET] }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("reports a missing project", async () => {
    mocks.executeRaw.mockResolvedValue(0);

    const result = await projectRunnersService.update(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { runnerIds: [] }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
  });
});
