/** Action keys of the Bitbucket provider. */
export const BitbucketActionType = {
  CreatePullRequest: "bitbucket.create_pull_request",
} as const;
export type BitbucketActionType =
  (typeof BitbucketActionType)[keyof typeof BitbucketActionType];
