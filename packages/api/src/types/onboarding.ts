/**
 * Canonical status set for the Desktop-first browser-approval device session
 * state machine (`apps/api/app/desktop/device-onboarding/service.ts`). Shared
 * with the web approval UI (`useDesktopDeviceSession`), which gates its
 * approve/deny buttons on the `pending` value — so the contract lives here in
 * `@repo/api/src/types` rather than co-located in `apps/api`.
 */
export const DesktopDeviceSessionStatus = {
  Pending: "pending",
  Approved: "approved",
  Denied: "denied",
  Expired: "expired",
} as const;
export type DesktopDeviceSessionStatus =
  (typeof DesktopDeviceSessionStatus)[keyof typeof DesktopDeviceSessionStatus];

/**
 * Every step the wizard has ever persisted, not the sequence it renders.
 *
 * The rendered sequence is `CREATE_PROJECT` only, but
 * the step is written to `sessionStorage`, so a tab open across the deploy
 * restores one of the others. They stay nameable so `clampStep` can recognise
 * and absorb them instead of leaving the user on a blank card.
 */
export const OnboardingStep = {
  Welcome: "WELCOME",
  CreateTeam: "CREATE_TEAM",
  CreateProject: "CREATE_PROJECT",
  ConnectGitHub: "CONNECT_GITHUB",
  AddAnthropicKey: "ADD_ANTHROPIC_KEY",
  ConnectOptionalIntegrations: "CONNECT_OPTIONAL_INTEGRATIONS",
  DownloadElectronApp: "DOWNLOAD_ELECTRON_APP",
  InviteTeammates: "INVITE_TEAMMATES",
  Complete: "COMPLETE",
} as const;
export type OnboardingStep =
  (typeof OnboardingStep)[keyof typeof OnboardingStep];

export type OnboardingState = {
  wizardCompletedAt: string | null;
  wizardCompletedBy: string | null;
  checklistDismissedAt: string | null;
  createdProjectId: string | null;
};

export type OnboardingStatus = {
  wizardCompleted: boolean;
  checklistDismissed: boolean;
  checklist: OnboardingChecklistItem[];
};

export const ChecklistItemId = {
  CreateProject: "CREATE_PROJECT",
  /**
   * Agent loops run only on runners (headless runners or desktop apps that
   * registered as compute targets), so an organization without one cannot run
   * anything. Complete once the organization has any runner.
   */
  InstallRunner: "INSTALL_RUNNER",
  ConnectGoogle: "CONNECT_GOOGLE",
  InviteMembers: "INVITE_MEMBERS",
} as const;
export type ChecklistItemId =
  (typeof ChecklistItemId)[keyof typeof ChecklistItemId];

export type OnboardingChecklistItem = {
  id: ChecklistItemId;
  label: string;
  description: string;
  completed: boolean;
  /** In-app destination of the row, e.g. `/settings?tab=integrations`. */
  href?: string;
};

/**
 * Clerk organization roles an invitee can be assigned. Mirrors the Clerk
 * `OrganizationMembershipRole` values used by the backend invitation SDK. The
 * "Invite your team" flow (PRD-532 §5.4) mints real Clerk org invitations via
 * `POST /organizations/invitations`; on accept, the Clerk
 * `organizationMembership.created` webhook syncs a durable MEMBER into the
 * existing org (`handleOrganizationMembershipCreated`).
 */
export const OrgInviteRole = {
  Admin: "org:admin",
  Member: "org:member",
} as const;
export type OrgInviteRole = (typeof OrgInviteRole)[keyof typeof OrgInviteRole];

/**
 * Request body for `POST /organizations/invitations`. Shared so the web +
 * desktop invite affordances and the API route validate against one contract.
 */
export type InviteMembersInput = {
  /** Email addresses to invite into the caller's current organization. */
  emailAddresses: string[];
  /** Clerk org role to grant on accept. Defaults to `org:member`. */
  role?: OrgInviteRole;
};

/** Per-email outcome for an invitation batch. */
export type InviteMemberResult = {
  email: string;
  /** Clerk invitation id when minted; omitted when the email was skipped/failed. */
  invitationId?: string;
  status: "invited" | "already_member" | "failed";
  /** Human-readable reason for a non-`invited` status. */
  reason?: string;
};

/** Response for `POST /organizations/invitations`. */
export type InviteMembersResponse = {
  invited: number;
  results: InviteMemberResult[];
};
