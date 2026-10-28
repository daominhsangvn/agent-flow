import { LoopStatus } from "@repo/api/src/types/loop";
import { readProjectRunnerIds } from "@repo/api/src/types/project-runners";
import { withDb } from "@repo/database";
import { z } from "zod";

/**
 * Which of a project's runners (Project → Repositories → Runners) a new loop
 * on one of its documents runs on. A project with runners only runs on them:
 * their toolchains match its repositories, so another computer is never
 * picked instead. The caller's own choice is kept when it is one of them;
 * otherwise the online runner with the most free capacity (loops waiting or
 * running against `maxInFlightCommands`) wins, the most recently seen among
 * equals. A loop that continues another (EXECUTE after PLAN) does not come
 * here: it stays on the runner holding its state.
 */

/** Loops a runner has accepted or is about to take. */
const ACTIVE_LOOP_STATUSES = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

export const ProjectRunnerChoiceKind = {
  /** The document's project has no runners: choose as before. */
  None: "none",
  Resolved: "resolved",
  /** The project has runners, but none the caller can use is online. */
  Unavailable: "unavailable",
} as const;

export type ProjectRunnerChoice =
  | { kind: typeof ProjectRunnerChoiceKind.None }
  | { kind: typeof ProjectRunnerChoiceKind.Resolved; computeTargetId: string }
  | { kind: typeof ProjectRunnerChoiceKind.Unavailable; message: string };

export type ChooseProjectRunnerInput = {
  organizationId: string;
  userId: string;
  /** Computer the caller asked for; kept when it is one of the runners. */
  preferredComputeTargetId?: string | null;
} & ProjectRunnerScope;

/**
 * Whose project's runners: a document's, or the project's own (a workflow run
 * before its documents exist).
 */
export type ProjectRunnerScope =
  | { documentId: string; projectId?: never }
  | { projectId: string; documentId?: never };

const capacitySchema = z.object({
  maxInFlightCommands: z.number().int().positive(),
});

export async function chooseProjectRunner(
  input: ChooseProjectRunnerInput
): Promise<ProjectRunnerChoice> {
  const { organizationId, userId } = input;
  const runnerIds = readProjectRunnerIds(await readProjectSettings(input));
  if (runnerIds.length === 0) {
    return { kind: ProjectRunnerChoiceKind.None };
  }
  const online = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        id: { in: runnerIds },
        organizationId,
        isCloudSentinel: false,
        isOnline: true,
        OR: [{ userId }, { isSharedWithOrg: true }],
      },
      select: { id: true, lastSeenAt: true, capabilities: true },
    })
  );
  if (online.length === 0) {
    return {
      kind: ProjectRunnerChoiceKind.Unavailable,
      message:
        "None of the project's runners is online and available to you. Start one, or change the project's runners.",
    };
  }
  const preferred = online.find(
    (target) => target.id === input.preferredComputeTargetId
  );
  if (preferred) {
    return {
      kind: ProjectRunnerChoiceKind.Resolved,
      computeTargetId: preferred.id,
    };
  }
  const active = await countActiveLoopsByTarget(
    organizationId,
    online.map((target) => target.id)
  );
  const [best] = online
    .map((target) => ({
      id: target.id,
      lastSeenAt: target.lastSeenAt.getTime(),
      load: (active.get(target.id) ?? 0) / capacityOf(target.capabilities),
    }))
    .sort((a, b) => a.load - b.load || b.lastSeenAt - a.lastSeenAt);
  return {
    kind: ProjectRunnerChoiceKind.Resolved,
    computeTargetId: best?.id ?? online[0].id,
  };
}

/** Loops waiting for or running on each of `computeTargetIds`. */
export async function countActiveLoopsByTarget(
  organizationId: string,
  computeTargetIds: string[]
): Promise<Map<string, number>> {
  if (computeTargetIds.length === 0) {
    return new Map();
  }
  const groups = await withDb((db) =>
    db.loop.groupBy({
      by: ["computeTargetId"],
      where: {
        organizationId,
        computeTargetId: { in: computeTargetIds },
        status: { in: ACTIVE_LOOP_STATUSES },
      },
      _count: { _all: true },
    })
  );
  return new Map(
    groups.flatMap((group) =>
      group.computeTargetId
        ? [[group.computeTargetId, group._count._all] as const]
        : []
    )
  );
}

/** Loops a runner runs at once; 1 when it did not report it. */
function capacityOf(capabilities: unknown): number {
  const parsed = capacitySchema.safeParse(capabilities);
  return parsed.success ? parsed.data.maxInFlightCommands : 1;
}

/** Settings of the project in scope (they list its runners). */
async function readProjectSettings(
  input: ChooseProjectRunnerInput
): Promise<unknown> {
  const { organizationId, projectId } = input;
  if (projectId !== undefined) {
    const project = await withDb((db) =>
      db.project.findFirst({
        where: { id: projectId, organizationId },
        select: { settings: true },
      })
    );
    return project?.settings;
  }
  const document = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: input.documentId, organizationId },
      select: { project: { select: { settings: true } } },
    })
  );
  return document?.project?.settings;
}
