import {
  AgentFlowStepId,
  PROCESS_PRESETS,
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CurrentProcessKind,
  projectProcessService,
} from "@/app/projects/project-process-service";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const USER_ID = "0199a5f0-0000-7000-8000-00000000000b";
const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";

type Row = {
  version: number;
  definition: unknown;
  createdAt: Date;
  createdById: string;
};

const mocks = vi.hoisted(() => ({
  /** Stands in for Prisma.JsonNull (a JSON null written to the column). */
  jsonNull: "__json_null__",
  projectExists: true,
  rows: [] as Row[],
  /** Versions a concurrent save takes just before ours. */
  stolenVersions: [] as number[],
  checkouts: [] as Array<{ id: string; fullName: string }>,
}));

vi.mock("@repo/database", () => {
  const latest = () =>
    [...mocks.rows].sort((a, b) => b.version - a.version)[0] ?? null;
  const toSelected = (row: Row) => ({
    version: row.version,
    definition: row.definition,
    createdAt: row.createdAt,
    createdBy: { id: row.createdById, firstName: "Ada", lastName: "Admin" },
  });
  const db = {
    project: {
      findFirst: () =>
        Promise.resolve(mocks.projectExists ? { id: PROJECT_ID } : null),
    },
    projectProcessVersion: {
      findFirst: () => {
        const row = latest();
        return Promise.resolve(row ? toSelected(row) : null);
      },
      findMany: () =>
        Promise.resolve(
          [...mocks.rows].sort((a, b) => b.version - a.version).map(toSelected)
        ),
      create: ({
        data,
      }: {
        data: { version: number; definition: unknown; createdById: string };
      }) => {
        const stolen = mocks.stolenVersions.shift();
        if (stolen !== undefined) {
          mocks.rows.push({
            version: stolen,
            definition: null,
            createdAt: new Date(),
            createdById: "other",
          });
        }
        if (mocks.rows.some((row) => row.version === data.version)) {
          return Promise.reject(
            Object.assign(new Error("unique"), { code: "P2002" })
          );
        }
        const row: Row = {
          version: data.version,
          definition:
            data.definition === mocks.jsonNull ? null : data.definition,
          createdAt: new Date("2026-10-07T00:00:00.000Z"),
          createdById: data.createdById,
        };
        mocks.rows.push(row);
        return Promise.resolve(toSelected(row));
      },
    },
  };
  const withDb = (fn: (client: unknown) => unknown) => fn(db);
  withDb.tx = (fn: (client: unknown) => unknown) => fn(db);
  return { withDb, Prisma: { JsonNull: mocks.jsonNull } };
});

vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts: () => Promise.resolve(mocks.checkouts),
  findRepositoryCheckout: (
    checkouts: Array<{ fullName: string }>,
    fullName: string
  ) =>
    checkouts.find(
      (checkout) => checkout.fullName.toLowerCase() === fullName.toLowerCase()
    ),
}));

const SPEC_KIT = PROCESS_PRESETS.find((preset) => preset.key === "spec-kit");
const specKit = (repository: string): ProjectProcessInput => ({
  ...SPEC_KIT?.process,
  steps: SPEC_KIT?.process.steps ?? [],
  toolkit: SPEC_KIT?.process.toolkit
    ? { ...SPEC_KIT.process.toolkit, repository }
    : null,
});

beforeEach(() => {
  mocks.projectExists = true;
  mocks.rows = [];
  mocks.stolenVersions = [];
  mocks.checkouts = [
    { id: "r1", fullName: "contoso/shop" },
    { id: "r2", fullName: "contoso/speckit" },
  ];
});

describe("projectProcessService", () => {
  it("reports the built-in flow when the project has no process", async () => {
    expect(await projectProcessService.get(ORG_ID, PROJECT_ID)).toEqual({
      current: null,
      invalidVersion: null,
    });
    expect(await projectProcessService.findCurrent(ORG_ID, PROJECT_ID)).toEqual(
      { kind: CurrentProcessKind.None }
    );
  });

  it("saves numbered versions, the latest one current, with who saved it", async () => {
    await projectProcessService.save(ORG_ID, USER_ID, PROJECT_ID, {
      process: PROCESS_PRESETS[0]?.process ?? null,
    });
    const saved = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { process: specKit("Contoso/SpecKit") }
    );

    expect(saved.ok).toBe(true);
    const state = saved.ok ? saved.value : null;
    expect(state?.current?.version).toBe(2);
    expect(state?.current?.createdBy).toEqual({
      id: USER_ID,
      name: "Ada Admin",
    });
    expect(state?.current?.definition?.toolkit?.repository).toBe(
      "Contoso/SpecKit"
    );
    const current = await projectProcessService.findCurrent(ORG_ID, PROJECT_ID);
    expect(current).toMatchObject({
      kind: CurrentProcessKind.Found,
      snapshot: { version: 2 },
    });
    const versions = await projectProcessService.listVersions(
      ORG_ID,
      PROJECT_ID
    );
    expect(versions?.versions.map((version) => version.version)).toEqual([
      2, 1,
    ]);
  });

  it("goes back to the built-in flow with a reset version, keeping the history", async () => {
    await projectProcessService.save(ORG_ID, USER_ID, PROJECT_ID, {
      process: specKit("contoso/speckit"),
    });
    const reset = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { process: null }
    );

    expect(reset).toEqual({
      ok: true,
      value: { current: null, invalidVersion: null },
    });
    expect(await projectProcessService.findCurrent(ORG_ID, PROJECT_ID)).toEqual(
      { kind: CurrentProcessKind.None }
    );
    const versions = await projectProcessService.listVersions(
      ORG_ID,
      PROJECT_ID
    );
    expect(
      versions?.versions.map((version) => [
        version.version,
        version.definition === null,
      ])
    ).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("rejects a toolkit that is not one of the project's repositories", async () => {
    const result = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { process: specKit("contoso/elsewhere") }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: expect.stringContaining("contoso/elsewhere"),
      },
    });
    expect(mocks.rows).toHaveLength(0);
  });

  it("rejects a process that does not validate", async () => {
    const result = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      {
        process: {
          toolkit: null,
          steps: [
            {
              type: ProcessStepType.AgentFlowExecute,
              id: AgentFlowStepId.Execute,
              name: "Implement",
            },
          ],
        },
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
  });

  it("takes the next number when a concurrent save took one first", async () => {
    mocks.stolenVersions = [1];
    const result = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { process: specKit("contoso/speckit") }
    );

    expect(result.ok && result.value.current?.version).toBe(2);
  });

  it("does not save for a project of another organization", async () => {
    mocks.projectExists = false;
    const result = await projectProcessService.save(
      ORG_ID,
      USER_ID,
      PROJECT_ID,
      { process: null }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
    expect(await projectProcessService.get(ORG_ID, PROJECT_ID)).toBeNull();
  });

  it("reports a stored version this build cannot read", async () => {
    mocks.rows = [
      {
        version: 3,
        definition: { steps: [{ type: "future.step", id: "x", name: "X" }] },
        createdAt: new Date(),
        createdById: USER_ID,
      },
    ];

    expect(await projectProcessService.get(ORG_ID, PROJECT_ID)).toEqual({
      current: null,
      invalidVersion: 3,
    });
  });

  it("keeps the presets valid processes", () => {
    expect(
      projectProcessSchema.safeParse(specKit("contoso/speckit")).success
    ).toBe(true);
  });
});
