import type { HarnessType } from "@repo/api/src/types/compute-target";
import {
  computeTargetsService,
  parseSelectedHarness,
} from "@/app/compute-targets/service";
import { computePreferenceService } from "@/app/settings/compute-preference/compute-preference-service";
import {
  type HarnessSelectionIdentity,
  isHarnessSelectionEnabled,
} from "@/lib/loops/harness-selection-feature";

/**
 * Resolves the harness a loop should launch with, enforcing the
 * harness-selection rollback at this consumer boundary. The flag gates only the
 * picker UI, but a persisted harness (a ComputeTarget's `selectedHarness` for
 * Local, or `User.preferredHarness` for Cloud) outlives a flag-off rollback —
 * so when the flag is off for the requesting user, a value saved during a
 * flag-on session is coerced to the default harness (`parseSelectedHarness(null)`)
 * rather than launched.
 *
 * Local: a resolved compute target supplies its per-row `selectedHarness`.
 * Cloud: no compute target resolves (`cloud_resolved`), so the user-scoped
 * `preferredHarness` is read instead. Returns undefined only when a resolved
 * target cannot be found.
 *
 * Shared by POST /documents/{id}/run-loop and the workflow engine launcher.
 */
export async function resolveLaunchHarness(
  resolvedComputeTargetId: string | null | undefined,
  organizationId: string,
  identity: HarnessSelectionIdentity
): Promise<HarnessType | undefined> {
  const harnessSelectionEnabled = await isHarnessSelectionEnabled(identity);

  if (!resolvedComputeTargetId) {
    const preferredHarness = await computePreferenceService.getPreferredHarness(
      identity.userId,
      organizationId
    );
    return parseSelectedHarness(
      harnessSelectionEnabled ? preferredHarness : null
    );
  }

  const resolvedComputeTarget = await computeTargetsService.findById(
    resolvedComputeTargetId
  );
  if (!resolvedComputeTarget) {
    return undefined;
  }
  return parseSelectedHarness(
    harnessSelectionEnabled ? resolvedComputeTarget.selectedHarness : null
  );
}
