import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import type { ActionResult } from "@/lib/integrations/types";
import { mergeActionResults } from "@/lib/workflows/engine/action-results";

/**
 * One result for an action that ran on several connections (pull requests in
 * repositories held by different connections).
 */

const OPENED_WEB: ActionResult = {
  status: WorkflowActionRunStatus.Succeeded,
  externalRef: "https://git.test/acme/web/pulls/1",
  detail: "Opened pull request acme/web#1",
  outputs: {
    pullRequests: [
      {
        repositoryId: "web",
        url: "https://git.test/acme/web/pulls/1",
        number: 1,
        branch: "b-web",
      },
    ],
  },
};
const OPENED_API: ActionResult = {
  status: WorkflowActionRunStatus.Succeeded,
  externalRef: "https://git.test/acme/api/pulls/2",
  detail: "Opened pull request acme/api#2",
  outputs: {
    pullRequests: [
      {
        repositoryId: "api",
        url: "https://git.test/acme/api/pulls/2",
        number: 2,
        branch: "b-api",
      },
    ],
  },
};
const NOT_MINE: ActionResult = {
  status: WorkflowActionRunStatus.Skipped,
  reason: "The run's repositories belong to other connections",
};

describe("mergeActionResults", () => {
  it("keeps a single result as it is", () => {
    expect(mergeActionResults([OPENED_WEB])).toBe(OPENED_WEB);
  });

  it("succeeds with every pull request when each connection opened its own", () => {
    expect(mergeActionResults([OPENED_WEB, NOT_MINE, OPENED_API])).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "https://git.test/acme/web/pulls/1",
      detail: "Opened pull request acme/web#1; Opened pull request acme/api#2",
      outputs: {
        pullRequests: [
          ...(OPENED_WEB.status === "succeeded"
            ? (OPENED_WEB.outputs?.pullRequests ?? [])
            : []),
          ...(OPENED_API.status === "succeeded"
            ? (OPENED_API.outputs?.pullRequests ?? [])
            : []),
        ],
      },
    });
  });

  it("fails when one connection failed, still reporting what the others opened", () => {
    const merged = mergeActionResults([
      OPENED_WEB,
      {
        status: WorkflowActionRunStatus.Failed,
        error: "acme/api: HTTP 503",
        retryable: true,
      },
    ]);

    expect(merged).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      error: "acme/api: HTTP 503",
      retryable: true,
      outputs: {
        pullRequests: [expect.objectContaining({ repositoryId: "web" })],
      },
    });
  });

  it("is skipped only when every connection skipped it, with every reason", () => {
    expect(
      mergeActionResults([
        NOT_MINE,
        {
          status: WorkflowActionRunStatus.Skipped,
          reason: "The agent team did not push a branch",
        },
      ])
    ).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason:
        "The run's repositories belong to other connections; The agent team did not push a branch",
    });
  });
});
