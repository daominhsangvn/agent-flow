import { z } from "zod";

/**
 * Runners of a project: the computers (compute targets) its agent loops run
 * on. Every runner of a project needs the toolchains of all of its
 * repositories (e.g. .NET, Rust and Node.js for a project with one repository
 * of each), so assign runners that are set up alike. A new loop goes to the
 * least busy one that is online; a loop that continues another (EXECUTE after
 * PLAN) stays on the runner holding its state. A project without runners
 * runs on the computer chosen by the user (or the workflow). Stored as
 * `runnerIds` in the project's `settings`.
 */

export const PROJECT_RUNNERS_MAX = 10;

export type ProjectRunner = {
  id: string;
  machineName: string;
  isOnline: boolean;
  isSharedWithOrg: boolean;
  ownerName: string | null;
  /** Loops it runs at once; null when it did not report it. */
  capacity: number | null;
  /** Loops waiting for it or running on it now. */
  activeLoops: number;
  /**
   * Version of each tool and toolchain it reported, e.g.
   * `{ git: "git version 2.39.5", dotnet: "8.0.404" }`.
   */
  tools: Record<string, string>;
};

export type ProjectRunners = {
  runners: ProjectRunner[];
};

export const updateProjectRunnersInputSchema = z.object({
  runnerIds: z.array(z.uuid()).max(PROJECT_RUNNERS_MAX),
});
export type UpdateProjectRunnersInput = z.infer<
  typeof updateProjectRunnersInputSchema
>;

/** Reads the runner ids from a project's `settings` JSON; [] when unset. */
export function readProjectRunnerIds(settings: unknown): string[] {
  const parsed = z
    .object({ runnerIds: z.array(z.string()) })
    .safeParse(settings);
  return parsed.success ? parsed.data.runnerIds : [];
}
