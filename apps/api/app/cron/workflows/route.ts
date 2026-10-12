import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";
import { runWorkflowTick } from "@/lib/workflows/engine/tick";

/**
 * GET /cron/workflows — one workflow scheduler tick (docs/workflows.md
 * "Scheduler"): poll due connections, advance non-final runs, requeue stale
 * post actions, drain due post actions. Called every WORKFLOW_TICK_SECONDS by
 * the in-process runner (lib/self-hosted-cron.ts) or an external scheduler.
 *
 * Protected by the CRON_SECRET bearer token.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[cron/workflows]");
  if (denied) {
    return denied;
  }

  try {
    const result = await runWorkflowTick();
    // Runs every few seconds: routine ticks stay at debug level.
    if (result.errors.length > 0) {
      log.warn("[cron/workflows] Tick finished with errors", result);
    } else {
      log.debug("[cron/workflows] Tick finished", result);
    }
    scheduleLogFlush();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    log.error("[cron/workflows] Tick failed", { error });
    scheduleLogFlush();
    return Response.json(
      { ok: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
};
