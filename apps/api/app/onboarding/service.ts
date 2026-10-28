import type { JsonObject } from "@repo/api/src/types/common";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
  type OnboardingState,
  type OnboardingStatus,
} from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import { z } from "zod";

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  wizardCompletedAt: null,
  wizardCompletedBy: null,
  checklistDismissedAt: null,
  createdProjectId: null,
};

const onboardingStateSchema = z.object({
  wizardCompletedAt: z.string().nullable().default(null),
  wizardCompletedBy: z.string().nullable().default(null),
  checklistDismissedAt: z.string().nullable().default(null),
  createdProjectId: z.string().nullable().default(null),
});

/**
 * Safely extract onboarding state from Organization.settings JSON blob.
 */
function getOnboardingState(settings: JsonObject): OnboardingState {
  const result = onboardingStateSchema.safeParse(settings.onboarding);
  if (!result.success) {
    return { ...DEFAULT_ONBOARDING_STATE };
  }
  return result.data;
}

/**
 * Merge onboarding state back into the Organization.settings JSON blob.
 */
function mergeOnboardingState(
  settings: JsonObject,
  state: Partial<OnboardingState>
): JsonObject {
  const current = getOnboardingState(settings);
  return {
    ...settings,
    onboarding: { ...current, ...state },
  };
}

/**
 * Onboarding service — reads/writes onboarding state from Organization.settings,
 * computes checklist completion from actual DB data.
 */
export const onboardingService = {
  async getStatus(organizationId: string): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const state = getOnboardingState(settings);

    // Run checks in parallel for performance
    const [projectCount, runner, googleIntegration, userCount] =
      await Promise.all([
        withDb((db) =>
          db.project.count({
            where: { organizationId },
          })
        ),
        // Any runner of the organization: loops run on the project's runners,
        // else on the organization's, so one is enough for everyone. The
        // synthetic per-org "cloud" target owns cloud-authored agent
        // components and has no device behind it, so it does not count.
        withDb((db) =>
          db.computeTarget.findFirst({
            where: { organizationId, isCloudSentinel: false },
            select: { id: true },
          })
        ),
        withDb((db) =>
          db.googleIntegration.findUnique({
            where: { organizationId },
            select: { id: true },
          })
        ),
        withDb((db) =>
          db.user.count({ where: { organizationId, active: true } })
        ),
      ]);

    // Legacy orgs: if no wizard record but org already has projects, treat as completed
    const wizardCompleted =
      state.wizardCompletedAt !== null || projectCount > 0;

    const checklist: OnboardingChecklistItem[] = [
      // Links to the org-level projects page. (Moot in practice — the
      // checklist only renders once the wizard is complete, which requires a
      // project, so this row is always ticked.)
      {
        id: ChecklistItemId.CreateProject,
        label: "Create a project",
        description: "Start your first project",
        completed: projectCount > 0,
        href: "/projects",
      },
      {
        id: ChecklistItemId.InstallRunner,
        label: "Download and install a runner",
        description:
          "Agent loops run on a runner: a Docker container or a Linux server",
        completed: runner !== null,
        href: INSTALL_RUNNER_HREF,
      },
      {
        id: ChecklistItemId.ConnectGoogle,
        label: "Connect Google Drive",
        description: "Import documents and collaborate on files",
        completed: googleIntegration !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: ChecklistItemId.InviteMembers,
        label: "Invite team members",
        description: "Add colleagues to your organization",
        completed: userCount > 1,
        href: "/settings?tab=organization#/organization-members",
      },
    ];

    return {
      wizardCompleted,
      checklistDismissed: state.checklistDismissedAt !== null,
      checklist,
    };
  },

  async completeWizard(
    organizationId: string,
    userId: string,
    createdProjectId?: string
  ): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const updatedSettings = mergeOnboardingState(settings, {
      wizardCompletedAt: new Date().toISOString(),
      wizardCompletedBy: userId,
      createdProjectId: createdProjectId ?? null,
    });

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: updatedSettings },
      })
    );

    return onboardingService.getStatus(organizationId);
  },

  async dismissChecklist(organizationId: string): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const updatedSettings = mergeOnboardingState(settings, {
      checklistDismissedAt: new Date().toISOString(),
    });

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: updatedSettings },
      })
    );

    return onboardingService.getStatus(organizationId);
  },
};

/**
 * Settings → Integrations, where the organization's runners are listed and the
 * empty list explains how to install one.
 */
export const INSTALL_RUNNER_HREF = "/settings?tab=integrations";
