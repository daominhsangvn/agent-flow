import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { commitAndPushLoopBranch } from "../src/server/operations/execute-push-finalization.js";
import {
  buildLoopGitEnv,
  grantLoopGitAccess,
  LOOP_GIT_CREDENTIAL_TOKEN_ENV,
  LOOP_GIT_CREDENTIAL_URL_ENV,
  loopGitEnvForPath,
  revokeLoopGitAccess,
} from "../src/server/operations/loop-git-access.js";
import { prepareProjectRepos } from "../src/server/operations/loop-project-repos.js";
import {
  parseProjectRepoCloneUrl,
  projectRepoCheckoutDirName,
  projectRepoHostDirName,
} from "../src/server/operations/loop-repo-checkout.js";

/**
 * Project repositories end to end: a local git server (git http-backend,
 * basic auth) and a fake API that answers the credential helper, so clone,
 * fetch and push really authenticate through `POST /loops/:id/git-credential`.
 */

const LOOP_ID = "loop-project-repos";
const LOOP_TOKEN = "loop-runner-jwt";
const GIT_USER = "x-access-token";
const GIT_PASSWORD = "pat-from-the-connection";
const GIT = "git";

type GitServer = {
  baseUrl: string;
  credentialRequests: string[];
  close: () => Promise<void>;
};

let root: string;
let server: GitServer;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
}

/** Bare repository `owner/name.git` with one commit on main. */
function createRemote(projectRoot: string, name: string): void {
  const bare = path.join(projectRoot, "remotes", "acme", `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "--initial-branch=main");
  git(bare, "config", "http.receivepack", "true");
  const seed = path.join(projectRoot, `seed-${name}`);
  git(projectRoot, "clone", bare, seed);
  writeFileSync(path.join(seed, "README.md"), `# ${name}\n`);
  git(seed, "add", ".");
  git(
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "init"
  );
  git(seed, "push", "origin", "HEAD:main");
}

function startGitServer(projectRoot: string): Promise<GitServer> {
  const credentialRequests: string[] = [];
  const expected = `Basic ${Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString("base64")}`;
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === `/loops/${LOOP_ID}/git-credential`) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        credentialRequests.push(body);
        if (req.headers.authorization !== `Bearer ${LOOP_TOKEN}`) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`username=${GIT_USER}\npassword=${GIT_PASSWORD}\n`);
      });
      return;
    }
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const backend = spawn(GIT, ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: path.join(projectRoot, "remotes"),
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: GIT_USER,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
      },
    });
    req.pipe(backend.stdin);
    let header = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const lines = header.subarray(0, end).toString("utf8").split("\r\n");
      let status = 200;
      for (const line of lines) {
        const [name, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        if (name.toLowerCase() === "status") {
          status = Number.parseInt(value, 10);
        } else {
          res.setHeader(name, value);
        }
      }
      res.writeHead(status);
      headersSent = true;
      res.write(header.subarray(end + 4));
    });
    backend.on("close", () => res.end());
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        credentialRequests,
        close: () =>
          new Promise((done) => {
            httpServer.close(() => done());
          }),
      });
    });
  });
}

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-project-repos-"));
  createRemote(root, "api");
  createRemote(root, "web");
  mkdirSync(path.join(root, "workspace"));
  server = await startGitServer(root);
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("loop git access", () => {
  test("points git at the loop's credential endpoint and clears machine helpers", () => {
    const env = buildLoopGitEnv({
      apiBaseUrl: "https://api.example.com/",
      loopId: LOOP_ID,
      token: LOOP_TOKEN,
    });

    assert.equal(
      env[LOOP_GIT_CREDENTIAL_URL_ENV],
      `https://api.example.com/loops/${LOOP_ID}/git-credential`
    );
    assert.equal(env[LOOP_GIT_CREDENTIAL_TOKEN_ENV], LOOP_TOKEN);
    assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_ALLOW_PROTOCOL, "https:http");
  });

  test("applies a grant to its roots and below, until revoked", () => {
    const repo = path.join(root, "granted");
    grantLoopGitAccess("loop-a", { MARKER: "a" }, [repo]);

    assert.equal(loopGitEnvForPath(repo)?.MARKER, "a");
    assert.equal(loopGitEnvForPath(path.join(repo, "src"))?.MARKER, "a");
    assert.equal(loopGitEnvForPath(`${repo}-other`), undefined);

    revokeLoopGitAccess("loop-a");
    assert.equal(loopGitEnvForPath(repo), undefined);
  });

  test("picks the closest root, then the newest loop, when loops share a checkout", () => {
    const checkout = path.join(root, "shared");
    const nested = path.join(checkout, "nested");
    grantLoopGitAccess("loop-old", { MARKER: "old" }, [checkout]);
    grantLoopGitAccess("loop-nested", { MARKER: "nested" }, [nested]);
    grantLoopGitAccess("loop-new", { MARKER: "new" }, [checkout]);

    assert.equal(loopGitEnvForPath(checkout)?.MARKER, "new");
    assert.equal(loopGitEnvForPath(path.join(nested, "src"))?.MARKER, "nested");

    revokeLoopGitAccess("loop-new");
    assert.equal(loopGitEnvForPath(checkout)?.MARKER, "old");
    revokeLoopGitAccess("loop-old");
    revokeLoopGitAccess("loop-nested");
  });
});

describe("project repository checkouts", () => {
  test("names checkouts after the full name, one directory per repository", () => {
    assert.equal(projectRepoCheckoutDirName("acme/api"), "acme__api");
    assert.equal(
      projectRepoCheckoutDirName("contoso/Payments Team/web app"),
      "contoso__Payments-Team__web-app"
    );
    assert.equal(projectRepoCheckoutDirName("../../etc"), "etc");
    assert.equal(
      projectRepoHostDirName(new URL("https://GitHub.com/acme/api.git")),
      "github.com"
    );
    assert.equal(
      projectRepoHostDirName(new URL("http://127.0.0.1:4011/acme/api.git")),
      "127.0.0.1-4011"
    );
  });

  test("two loops preparing the same repository at once share one checkout", async () => {
    const workspace = path.join(root, "workspace-concurrent");
    const request = () =>
      prepareProjectRepos({
        body: {
          loopId: LOOP_ID,
          agentFlowAuthToken: LOOP_TOKEN,
          repo: {
            fullName: "acme/api",
            branch: "main",
            cloneUrl: `${server.baseUrl}/acme/api.git`,
          },
        },
        apiBaseUrl: server.baseUrl,
        allowedDirs: [workspace],
        gitBin: GIT,
      });

    const results = await Promise.all([request(), request(), request()]);

    for (const result of results) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.ok);
      assert.equal(result.primaryPath, checkoutPath(workspace, "acme__api"));
    }
    assert.equal(
      git(
        checkoutPath(workspace, "acme__api"),
        "rev-parse",
        "--abbrev-ref",
        "HEAD"
      ),
      "main"
    );
    revokeLoopGitAccess(LOOP_ID);
  });

  test("accepts https, and http only for loopback or allowed hosts", () => {
    assert.equal(
      parseProjectRepoCloneUrl("https://github.com/acme/api.git").host,
      "github.com"
    );
    assert.equal(
      parseProjectRepoCloneUrl("http://127.0.0.1:9/acme/api.git").hostname,
      "127.0.0.1"
    );
    for (const url of [
      "http://git.example.com/acme/api.git",
      "ext::sh -c touch% /tmp/pwned",
      "file:///tmp/repo",
      "https://user:secret@github.com/acme/api.git",
    ]) {
      assert.throws(() => parseProjectRepoCloneUrl(url), url);
    }
  });

  test("clones the primary and additional repositories with per-loop credentials, then fetches", async () => {
    const workspace = path.join(root, "workspace");
    const body = {
      loopId: LOOP_ID,
      agentFlowAuthToken: LOOP_TOKEN,
      repo: {
        fullName: "acme/api",
        branch: "main",
        cloneUrl: `${server.baseUrl}/acme/api.git`,
      },
      additionalRepos: [
        {
          fullName: "acme/web",
          branch: "main",
          cloneUrl: `${server.baseUrl}/acme/web.git`,
        } as {
          fullName: string;
          branch: string;
          cloneUrl: string;
          localRepoPath?: string;
        },
      ],
    };

    const first = await prepareProjectRepos({
      body,
      apiBaseUrl: server.baseUrl,
      allowedDirs: [workspace],
      gitBin: GIT,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.ok);
    assert.equal(first.primaryPath, checkoutPath(workspace, "acme__api"));
    assert.equal(
      body.additionalRepos[0].localRepoPath,
      checkoutPath(workspace, "acme__web")
    );
    assert.equal(
      readFileSync(
        checkoutPath(workspace, "acme__web", "README.md"),
        "utf8"
      ).trim(),
      "# web"
    );
    assert.ok(
      server.credentialRequests.some((request) =>
        request.includes("path=acme/api.git")
      ),
      "git sends the repository path to the credential endpoint"
    );
    // The token never lands in the checkout's git config.
    const config = readFileSync(
      checkoutPath(workspace, "acme__api", ".git", "config"),
      "utf8"
    );
    assert.equal(config.includes(GIT_PASSWORD), false);
    assert.equal(config.includes(LOOP_TOKEN), false);

    const again = await prepareProjectRepos({
      body,
      apiBaseUrl: server.baseUrl,
      allowedDirs: [workspace],
      gitBin: GIT,
    });
    assert.equal(again.ok, true, "an existing checkout is fetched");
    // AgentFlow's files stay out of git status, excluded exactly once.
    const exclude = readFileSync(
      checkoutPath(workspace, "acme__api", ".git", "info", "exclude"),
      "utf8"
    );
    assert.equal(
      exclude.split("\n").filter((line) => line.trim() === ".agentflow-ai/")
        .length,
      1
    );
    revokeLoopGitAccess(LOOP_ID);
  });

  test("fails with a clear reason when the API refuses the credential", async () => {
    const result = await prepareProjectRepos({
      body: {
        loopId: LOOP_ID,
        agentFlowAuthToken: "wrong-token",
        repo: {
          fullName: "acme/other",
          branch: "main",
          cloneUrl: `${server.baseUrl}/acme/api.git`,
        },
      },
      apiBaseUrl: server.baseUrl,
      allowedDirs: [path.join(root, "workspace")],
      gitBin: GIT,
    });

    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.message.includes("could not clone acme/other")
    );
  });
});

describe("EXECUTE push-only finalization", () => {
  test("commits the agent's changes, skips AgentFlow files and pushes the branch", async () => {
    const workspace = path.join(root, "workspace");
    const checkout = checkoutPath(workspace, "acme__api");
    const worktree = checkoutPath(workspace, "acme__api-loop-ISS-1");
    const env = {
      ...process.env,
      ...buildLoopGitEnv({
        apiBaseUrl: server.baseUrl,
        loopId: LOOP_ID,
        token: LOOP_TOKEN,
      }),
    };
    execFileSync(
      GIT,
      ["worktree", "add", "-b", "symphony/ISS-1", worktree, "origin/main"],
      { cwd: checkout, env }
    );
    const workDir = path.join(worktree, ".agentflow-ai", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, "plan.md"), "# Export orders as CSV\n");
    mkdirSync(path.join(worktree, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(worktree, ".claude", "agents", "a.md"), "agent\n");
    writeFileSync(path.join(worktree, "export.ts"), "export {};\n");

    const outcome = await commitAndPushLoopBranch({
      worktreeDir: worktree,
      claudeWorkDir: workDir,
      baseBranch: "main",
      loopId: LOOP_ID,
      artifactSlug: "ISS-1",
      committer: { name: "Agent", email: "agent@example.com" },
      gitBin: GIT,
      env,
    });

    assert.equal(outcome.kind, "pushed", JSON.stringify(outcome));
    const remote = path.join(root, "remotes", "acme", "api.git");
    assert.equal(
      git(remote, "log", "-1", "--format=%s", "symphony/ISS-1"),
      "ISS-1: Export orders as CSV"
    );
    const files = git(remote, "ls-tree", "-r", "--name-only", "symphony/ISS-1");
    assert.deepEqual(files.split("\n").sort(), ["README.md", "export.ts"]);

    const second = await commitAndPushLoopBranch({
      worktreeDir: worktree,
      claudeWorkDir: workDir,
      baseBranch: "main",
      loopId: LOOP_ID,
      committer: undefined,
      gitBin: GIT,
      env,
    });
    assert.equal(
      second.kind,
      "pushed",
      "the pushed branch still differs from main"
    );
  });

  test("reports no changes when nothing differs from the base branch", async () => {
    const workspace = path.join(root, "workspace");
    const checkout = checkoutPath(workspace, "acme__web");
    const worktree = checkoutPath(workspace, "acme__web-loop-ISS-2");
    const env = {
      ...process.env,
      ...buildLoopGitEnv({
        apiBaseUrl: server.baseUrl,
        loopId: LOOP_ID,
        token: LOOP_TOKEN,
      }),
    };
    execFileSync(
      GIT,
      ["worktree", "add", "-b", "symphony/ISS-2", worktree, "origin/main"],
      { cwd: checkout, env }
    );

    const outcome = await commitAndPushLoopBranch({
      worktreeDir: worktree,
      claudeWorkDir: path.join(worktree, ".agentflow-ai", "work"),
      baseBranch: "main",
      loopId: LOOP_ID,
      committer: undefined,
      gitBin: GIT,
      env,
    });

    assert.equal(outcome.kind, "no-changes");
  });
});

/** `name` (`owner__repo`) under the test server host directory, plus `rest`. */
function checkoutPath(
  workspace: string,
  name: string,
  ...rest: string[]
): string {
  return path.join(
    workspace,
    projectRepoHostDirName(new URL(server.baseUrl)),
    name,
    ...rest
  );
}
