import { log } from "@repo/observability/log";
import { computeTargetCapabilitiesRefreshService } from "@/app/compute-targets/capabilities-refresh-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";

export const maxDuration = 300;

/**
 * Daily: asks auto runners whose toolkit AGENTFLOW.md is older than 20 hours
 * to read it again.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[refresh-runner-capabilities]");
  if (denied) {
    return denied;
  }

  try {
    const result = await computeTargetCapabilitiesRefreshService.refreshStale(
      new Date()
    );
    log.info("[refresh-runner-capabilities] refresh completed", result);
    scheduleLogFlush();
    return new Response(
      `OK: dispatched=${result.dispatched} skipped=${result.skipped}`,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[refresh-runner-capabilities] refresh failed", {
      error: message,
    });
    scheduleLogFlush();
    return new Response("refresh-runner-capabilities failed", { status: 500 });
  }
};
