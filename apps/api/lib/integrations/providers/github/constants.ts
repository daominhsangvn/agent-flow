/** Action keys of the GitHub provider. */
export const GitHubActionType = {
  CreatePullRequest: "github.create_pull_request",
} as const;
export type GitHubActionType =
  (typeof GitHubActionType)[keyof typeof GitHubActionType];
