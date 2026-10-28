import { LoopStatus } from "@repo/api/src/types/loop";
import {
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { WorkflowRunErrorCode } from "@repo/api/src/types/workflow";
import { type Mock, vi } from "vitest";

/**
 * Shared mock state and vi.mock factories for the orchestrator task tests
 * (tasks.test.ts, tasks-inputs.test.ts).
 */

export type Row = Record<string, unknown>;

export const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  case: "0199a5f0-0000-7000-8000-0000000000b1",
  conversation: "0199a5f0-0000-7000-8000-0000000000b2",
  turn: "0199a5f0-0000-7000-8000-0000000000b3",
  ba: "0199a5f0-0000-7000-8000-0000000000c1",
  dev: "0199a5f0-0000-7000-8000-0000000000c2",
  owner: "0199a5f0-0000-7000-8000-0000000000a1",
};

export const taskMocks = {
  tasks: [] as Row[],
  loops: new Map<string, Row>(),
  busy: false,
  onBusyCheck: null as (() => void) | null,
  online: true,
  createLoop: vi.fn() as Mock,
  createDocument: vi.fn() as Mock,
  dispatch: vi.fn() as Mock,
  cancel: vi.fn() as Mock,
  settled: true,
  baToolkit: null as null | { repository: string; mounts: string[] },
  baAttach: undefined as string[] | undefined,
  stored: new Map<string, Uint8Array>(),
  runnerCapabilities: { loopStepForkSession: true } as Record<string, unknown>,
};

export function databaseModule() {
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object") {
        const filter = value as Row;
        if ("not" in filter) {
          return row[key] !== filter.not;
        }
        if ("in" in filter) {
          return (filter.in as unknown[]).includes(row[key]);
        }
      }
      return row[key] === value;
    });
  const withCase = (row: Row) => ({
    ...row,
    case: { projectId: IDS.project, title: "LD-7: Half-day leave" },
    computeTarget: {
      userId: IDS.owner,
      machineName: row.computeTargetId === IDS.ba ? "runner-1" : "an-PRO-1",
      capabilities: taskMocks.runnerCapabilities,
      isOnline: taskMocks.online,
    },
  });
  const db = {
    orchestratorTask: {
      create: (args: { data: Row }) => {
        const row = {
          id: `task-${taskMocks.tasks.length + 1}`,
          loopId: null,
          documentId: null,
          createdAt: new Date(2026, 9, 23, 9, 0, taskMocks.tasks.length),
          ...args.data,
        };
        taskMocks.tasks.push(row);
        return Promise.resolve(row);
      },
      findUnique: (args: { where: { id: string } }) => {
        const row = taskMocks.tasks.find((task) => task.id === args.where.id);
        return Promise.resolve(row ? withCase(row) : null);
      },
      findFirst: (args: { where: Row }) =>
        Promise.resolve(
          taskMocks.tasks.find((task) => match(task, args.where)) ?? null
        ),
      findMany: (args: { where: Row }) =>
        Promise.resolve(
          taskMocks.tasks.filter((task) => match(task, args.where))
        ),
      count: (args: { where: Row }) =>
        Promise.resolve(
          taskMocks.tasks.filter((task) => match(task, args.where)).length
        ),
      update: (args: { where: { id: string }; data: Row }) => {
        const row = taskMocks.tasks.find((task) => task.id === args.where.id);
        Object.assign(row ?? {}, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const rows = taskMocks.tasks.filter((task) => match(task, args.where));
        for (const row of rows) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      },
    },
    user: {
      findFirst: () => Promise.resolve({ id: IDS.owner, clerkId: "clerk-1" }),
    },
    loop: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(taskMocks.loops.get(args.where.id) ?? null),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
}

export function capabilitiesModule() {
  return {
    computeTargetCapabilitiesService: {
      listForProject: () =>
        Promise.resolve([
          {
            computeTargetId: IDS.ba,
            runnerName: "runner-1",
            source: RunnerCapabilitiesSource.Toolkit,
            capabilities: {
              runner: "BA",
              toolkit: taskMocks.baToolkit,
              commands: [
                {
                  name: "/ba-requirement",
                  mode: RunnerCommandMode.Read,
                  asks: true,
                  attach: taskMocks.baAttach,
                },
              ],
              skills: [],
            },
          },
          {
            computeTargetId: IDS.dev,
            runnerName: "an-PRO-1",
            source: RunnerCapabilitiesSource.Personal,
            capabilities: {
              runner: "Dev",
              commands: [
                {
                  name: "/executing-plans",
                  mode: RunnerCommandMode.Write,
                  push: true,
                },
              ],
              skills: [],
            },
          },
        ]),
    },
  };
}

export function loopStateModule() {
  return {
    getLoopPrefix: (org: string, loop: string) => `${org}/loops/${loop}/`,
    getLoopAttachment: (key: string) => {
      const bytes = taskMocks.stored.get(key);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error("gone"));
    },
  };
}

export function documentServiceModule() {
  return { documentService: { create: taskMocks.createDocument } };
}

export function loopsServiceModule() {
  return { loopsService: { create: taskMocks.createLoop } };
}

export function checkoutsModule() {
  return {
    listProjectRepositoryCheckouts: () => Promise.resolve([{}]),
    findRepositoryCheckout: (_checkouts: unknown, fullName: string) =>
      fullName === "workshop/leavedesk-knowledge" ? {} : undefined,
    toLoopRepositorySelection: () => ({
      primary: { fullName: "workshop/leavedesk-app", branch: "main" },
      additional: [],
    }),
  };
}

export function launchHarnessModule() {
  return { resolveLaunchHarness: () => Promise.resolve(undefined) };
}

export function dispatchUtilsModule() {
  return { dispatchAndClassify: taskMocks.dispatch };
}

export function engineLaunchModule() {
  return {
    checkCommandSigning: () => Promise.resolve({ ok: true, value: null }),
    cancelBlockedLoop: taskMocks.cancel,
    mapLoopCreateError: (error: { code?: string; message: string }) =>
      error.code === WorkflowRunErrorCode.LoopAlreadyActive
        ? {
            code: WorkflowRunErrorCode.LoopAlreadyActive,
            message: error.message,
          }
        : null,
  };
}

export function personalRunnerQueueModule() {
  return {
    personalRunnerBusy: () => {
      taskMocks.onBusyCheck?.();
      return Promise.resolve(
        taskMocks.busy
          ? { code: "runner_busy", message: "Waiting for an-PRO-1: busy." }
          : null
      );
    },
  };
}

export function runLoopsModule() {
  return { isLoopSettled: () => Promise.resolve(taskMocks.settled) };
}

export function caseRenderModule() {
  return { renderCase: () => Promise.resolve("# LD-7") };
}

export const BASE = {
  organizationId: IDS.org,
  projectId: IDS.project,
  caseId: IDS.case,
  conversationId: IDS.conversation,
  turnId: IDS.turn,
  args: "LD-7",
  prompt: "Does the policy allow half days for part-timers?",
  mode: null,
  resumeTaskId: null,
  fork: false,
  files: [],
  replyTo: null,
};

export function resetTaskMocks() {
  vi.clearAllMocks();
  taskMocks.tasks = [];
  taskMocks.loops = new Map();
  taskMocks.busy = false;
  taskMocks.onBusyCheck = null;
  taskMocks.online = true;
  taskMocks.settled = true;
  taskMocks.baToolkit = null;
  taskMocks.baAttach = undefined;
  taskMocks.stored = new Map();
  taskMocks.runnerCapabilities = { loopStepForkSession: true };
  taskMocks.createDocument.mockResolvedValue({ id: "doc-1" });
  taskMocks.createLoop.mockResolvedValue({
    loopId: "loop-1",
    status: LoopStatus.Pending,
  });
  taskMocks.dispatch.mockResolvedValue({ ok: true });
}
