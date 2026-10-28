import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { z } from "zod";

/**
 * ISS-5490: the wizard sequence — the one step that genuinely gates entry.
 *
 * A project is the one structural prerequisite: nothing in the product has
 * anywhere to live without it, and the checklist's own completion derivation
 * keys off its existence. Everything the previous nine-step sequence also asked
 * for (desktop download, GitHub, Anthropic key, optional integrations,
 * teammates) is a row in the "Complete Your Setup" checklist on My Tasks,
 * derived from live data, so gating on it up front asked for it twice and
 * blocked the product on the first ask.
 *
 * Typed as `readonly OnboardingStep[]` rather than the literal tuple so
 * `indexOf`/`includes` still accept a step restored from an older build.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  OnboardingStep.CreateProject,
];

const WIZARD_STATE_KEY = "onboarding_wizard_state";

const WIZARD_STATE_SCHEMA = z.object({
  currentStep: z.enum(OnboardingStep),
  createdProjectId: z.string().nullable(),
  createdProjectName: z.string().nullable(),
});

export type WizardState = z.infer<typeof WIZARD_STATE_SCHEMA>;

export function saveWizardState(state: WizardState): void {
  try {
    sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be unavailable (e.g. private browsing quota exceeded)
  }
}

/**
 * Read the persisted wizard state, or `null` when there isn't a usable one.
 *
 * Validated rather than cast: `sessionStorage` is a parse boundary, so the
 * stored blob can be any shape a previous build, a half-finished write, or a
 * user with devtools left behind. A cast would hand the wizard a `WizardState`
 * that is missing fields it renders from.
 */
export function loadWizardState(): WizardState | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = WIZARD_STATE_SCHEMA.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which step a restored state may actually open on.
 *
 * `WizardState` outlives a deploy, so a user mid-wizard when the sequence
 * changed restores a step this sequence no longer contains (`WELCOME`,
 * `CONNECT_GITHUB`, `CREATE_TEAM`, …) and the wizard, which renders per-step,
 * would match no branch. The fallback is the sequence's first step.
 */
export function clampStep(state: WizardState): OnboardingStep {
  return ONBOARDING_STEPS.includes(state.currentStep)
    ? state.currentStep
    : ONBOARDING_STEPS[0];
}

export function clearWizardState(): void {
  try {
    sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch {
    // sessionStorage may be unavailable
  }
}

/** Where the finished wizard hands off. */
export const POST_WIZARD_ROUTE = "/my-tasks?from=onboarding";
