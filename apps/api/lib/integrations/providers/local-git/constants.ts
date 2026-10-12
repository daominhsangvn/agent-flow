/** Action keys of the Local Git provider. */
export const LocalGitActionType = {
  CreatePullRequest: "local_git.create_pull_request",
} as const;
export type LocalGitActionType =
  (typeof LocalGitActionType)[keyof typeof LocalGitActionType];
