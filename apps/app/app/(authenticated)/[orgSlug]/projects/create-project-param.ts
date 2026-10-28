/**
 * Search param that opens the create-project modal on the projects list page.
 * The sidebar "New project" link deep-links here with `?create=1`.
 */
export const CreateProjectSearchParam = {
  Key: "create",
  Open: "1",
} as const;
export type CreateProjectSearchParam =
  (typeof CreateProjectSearchParam)[keyof typeof CreateProjectSearchParam];

export function buildCreateProjectHref(projectsHref: string): string {
  return `${projectsHref}?${CreateProjectSearchParam.Key}=${CreateProjectSearchParam.Open}`;
}
