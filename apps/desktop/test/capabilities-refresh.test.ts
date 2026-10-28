import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RunnerCapabilitiesSource,
  runnerCapabilitiesGitCredentialPath,
} from "@repo/api/src/types/runner-capabilities";
import {
  type CapabilitiesRefreshDeps,
  runCapabilitiesRefresh,
  toolkitRepositoryWarnings,
} from "../src/server/operations/capabilities-refresh.js";

const TARGET = "01a12707-7360-710b-b9f0-a498a6560081";
const REFRESH = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const REPOSITORY = "workshop/toolkit";
const REQUEST = {
  refreshId: REFRESH,
  projectId: PROJECT,
  repository: REPOSITORY,
  cloneUrl: "https://example.com/workshop/toolkit.git",
  defaultBranch: "main",
};
const MISSING_FILE_RE = /has no AGENTFLOW\.md at the root of main/;
const NOT_CONNECTED_RE = /not connected to AgentFlow/;
const UPLOAD_403_RE = /answered 403/;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caps-refresh-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(dir, ".keep"), "");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

const FILE = `---
commands:
  - { name: /plan-ticket, mode: write }
  - { name: /missing, mode: read }
---
# Toolkit
`;

type Call = { url: string; init: RequestInit };

function setup(
  repoDir: string,
  status = 200
): { deps: CapabilitiesRefreshDeps; calls: Call[]; envs: NodeJS.ProcessEnv[] } {
  const calls: Call[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const deps: CapabilitiesRefreshDeps = {
    getAllowedDirectories: () => [os.tmpdir()],
    getApiOrigin: () => "https://api.example.com/",
    getApiKey: () => "sk_test",
    getComputeTargetId: () => TARGET,
    resolveGitBin: () => Promise.resolve("git"),
    ensureCheckout: (_repo, options) => {
      envs.push(options.env);
      return Promise.resolve({ ok: true, path: repoDir, cloned: false });
    },
    fetchImpl: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("denied", { status }));
    }) as unknown as typeof fetch,
  };
  return { deps, calls, envs };
}

test("uploads the file read from the remote branch with warnings", async () => {
  const repo = makeRepo({
    "AGENTFLOW.md": FILE,
    ".claude/commands/plan-ticket.md": "x",
  });
  const { deps, calls, envs } = setup(repo);
  const result = await runCapabilitiesRefresh(REQUEST, deps);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    `https://api.example.com/compute-targets/${TARGET}/capabilities`
  );
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.source, RunnerCapabilitiesSource.Toolkit);
  assert.equal(body.project, PROJECT);
  assert.equal(body.content, FILE);
  assert.ok(
    body.warnings.some((w: string) => w.startsWith("/missing is not in"))
  );
  assert.ok(body.warnings.some((w: string) => w.includes("names no toolkit")));
  assert.ok(!body.warnings.some((w: string) => w.includes("/plan-ticket")));
  assert.equal(
    envs[0]?.AGENTFLOW_LOOP_GIT_CREDENTIAL_URL ??
      Object.values(envs[0] ?? {}).find((v) => v?.endsWith("/git-credential")),
    `https://api.example.com${runnerCapabilitiesGitCredentialPath(TARGET, REFRESH)}`
  );
});

test("a missing AGENTFLOW.md fails with a message naming the repository", async () => {
  const repo = makeRepo({ "README.md": "x" });
  const { deps, calls } = setup(repo);
  const result = await runCapabilitiesRefresh(REQUEST, deps);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, MISSING_FILE_RE);
  assert.equal(calls.length, 0);
});

test("a refused upload fails", async () => {
  const repo = makeRepo({ "AGENTFLOW.md": FILE });
  const { deps } = setup(repo, 403);
  const result = await runCapabilitiesRefresh(REQUEST, deps);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, UPLOAD_403_RE);
});

test("fails when this computer is not connected", async () => {
  const repo = makeRepo({ "AGENTFLOW.md": FILE });
  const { deps } = setup(repo);
  const result = await runCapabilitiesRefresh(REQUEST, {
    ...deps,
    getApiKey: () => null,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, NOT_CONNECTED_RE);
});

test("warns when the front matter names another toolkit repository", () => {
  const content = `---
toolkit:
  repository: other/repo
  mounts: [.claude/skills]
---
`;
  const warnings = toolkitRepositoryWarnings(content, REPOSITORY);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("other/repo"));
  assert.deepEqual(toolkitRepositoryWarnings(content, "OTHER/Repo"), []);
});
