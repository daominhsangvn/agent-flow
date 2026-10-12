/**
 * Appearance presets for the auth components.
 *
 * The components are built from the design system, so they need no theming;
 * these objects stay as the stable, named props the app passes (and its tests
 * assert on) to choose a presentation.
 */
export type AuthAppearance = Readonly<{ variant: string }>;

export const authPageAppearance: AuthAppearance = { variant: "auth-page" };

export const githubFirstAuthPageAppearance: AuthAppearance = {
  variant: "auth-page",
};

export const embeddedProfileAppearance: AuthAppearance = {
  variant: "embedded-profile",
};

export const embeddedOrganizationProfileAppearance: AuthAppearance = {
  variant: "embedded-organization-profile",
};
