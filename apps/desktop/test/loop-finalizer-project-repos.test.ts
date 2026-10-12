import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectRepoGitEnv } from "../src/main/loop/loop-finalizer-git.js";
import {
  LOOP_GIT_CREDENTIAL_TOKEN_ENV,
  LOOP_GIT_CREDENTIAL_URL_ENV,
} from "../src/server/operations/loop-git-access.js";

// A replayed EXECUTE finalization (finalizer, boot recovery) of a loop on
// project repositories must push with the loop's git credentials like the
// live exit. Without them it took the gh path, which read the clean worktree
// left by a failed push as "no changes" and dropped the commit.

const API = "http://host.docker.internal:3002/";

describe("projectRepoGitEnv", () => {
  test("gives a loop on project repositories its git credentials", () => {
    const env = projectRepoGitEnv(
      { loopId: "loop-1", pushOnly: true },
      API,
      () => "loop-token"
    );

    assert.equal(
      env?.[LOOP_GIT_CREDENTIAL_URL_ENV],
      "http://host.docker.internal:3002/loops/loop-1/git-credential"
    );
    assert.equal(env?.[LOOP_GIT_CREDENTIAL_TOKEN_ENV], "loop-token");
    assert.equal(env?.GIT_TERMINAL_PROMPT, "0");
  });

  test("leaves other loops on the gh path", () => {
    assert.equal(
      projectRepoGitEnv({ loopId: "loop-1" }, API, () => "loop-token"),
      undefined
    );
    assert.equal(
      projectRepoGitEnv(
        { loopId: "loop-1", pushOnly: false },
        API,
        () => "loop-token"
      ),
      undefined
    );
  });
});
