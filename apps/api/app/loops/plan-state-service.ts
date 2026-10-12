import { LoopCommand } from "@repo/api/src/types/loop";
import {
  generateDownloadUrl,
  generateUploadUrl,
  getPlanStateKeys,
  loopStateObjectExists,
} from "@/lib/loops/loop-state";
import { loopsService } from "./service";

/** The loops that work on a plan and save its state. */
const PLAN_STATE_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
]);

/**
 * A plan's saved state: what its last loop left in the work directory, which
 * the runner bundles at the end of each PLAN / EXECUTE / REQUEST_CHANGES loop
 * and restores at the start of the next, on whatever computer that one runs.
 * The bundle lives in the loop-state bucket under the plan (the loop's
 * document); nothing about it is stored in the database.
 */
export const planStateService = {
  /**
   * A presigned GET for the latest saved state of the loop's plan, or null
   * when the loop has no plan or the plan has no saved state yet.
   */
  async latestDownloadUrl(
    loopId: string,
    organizationId: string
  ): Promise<string | null> {
    const loop = await loopsService.findById(loopId, organizationId);
    if (!loop?.documentId) {
      return null;
    }
    const { latest } = getPlanStateKeys(
      organizationId,
      loop.documentId,
      loopId
    );
    if (!(await loopStateObjectExists(latest))) {
      return null;
    }
    return await generateDownloadUrl(latest);
  },

  /**
   * Presigned PUTs for the loop's copy of the plan state and, with `latest`,
   * for the plan's latest state; null when the loop does not work on a plan.
   */
  async uploadUrls(
    loopId: string,
    organizationId: string,
    latest: boolean
  ): Promise<string[] | null> {
    const loop = await loopsService.findById(loopId, organizationId);
    if (!(loop?.documentId && PLAN_STATE_COMMANDS.has(loop.command))) {
      return null;
    }
    const keys = getPlanStateKeys(organizationId, loop.documentId, loopId);
    return await Promise.all(
      [keys.loop, ...(latest ? [keys.latest] : [])].map((key) =>
        generateUploadUrl(key)
      )
    );
  },
};
