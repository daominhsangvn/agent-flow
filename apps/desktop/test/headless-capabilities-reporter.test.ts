import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunnerCapabilitiesSource } from "@repo/api/src/types/runner-capabilities";
import {
  collectCapabilityWarnings,
  startHeadlessCapabilitiesReporter,
} from "../src/headless/headless-capabilities-reporter.js";
import { collectCapabilityWarningsIn } from "../src/server/operations/capability-warnings.js";

const TARGET = "01a12707-7360-710b-b9f0-a498a6560081";
const MISSING_COMMAND_RE = /^\/missing is not in/;
const MISSING_SKILL_RE = /^skill absent is not in/;
const NO_FRONT_MATTER_RE = /no front matter/;

const FILE = `---
commands:
  - { name: /plan-ticket, mode: write }
  - { name: /qa:lookup, mode: read }
  - { name: /missing, mode: read }
skills: [tdd, absent]
---
# Dev runner
`;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, relative: string, content = "x"): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

type Call = { url: string; init: RequestInit };

function recordingFetch(status = 200): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}", { status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("collectCapabilityWarnings names declared commands and skills the folders do not have", () => {
  const project = tempDir("caps-project-");
  const home = tempDir("caps-home-");
  writeFile(project, ".claude/commands/plan-ticket.md");
  writeFile(home, ".claude/commands/qa/lookup.md");
  writeFile(project, ".claude/skills/tdd/SKILL.md");

  const warnings = collectCapabilityWarnings(FILE, [project, home]);

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", MISSING_COMMAND_RE);
  assert.match(warnings[1] ?? "", MISSING_SKILL_RE);
});

test("collectCapabilityWarnings reports a front matter that does not parse", () => {
  const warnings = collectCapabilityWarnings("# no front matter", []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", NO_FRONT_MATTER_RE);
});

test("report uploads the file for the project with the runner's warnings", async () => {
  const project = tempDir("caps-project-");
  fs.writeFileSync(path.join(project, "AGENTFLOW.md"), FILE);
  const { calls, fetchImpl } = recordingFetch();
  const reporter = startHeadlessCapabilitiesReporter({
    apiUrl: "http://api.test/",
    apiKey: "sk_live_test",
    projectKey: "PRO-1",
    projectDir: project,
    homeDir: tempDir("caps-home-"),
    getComputeTargetId: () => TARGET,
    fetchImpl,
    watch: () => ({ close: () => undefined }),
  });

  await reporter.report({ force: true });
  reporter.stop();

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(
    call?.url,
    `http://api.test/compute-targets/${TARGET}/capabilities`
  );
  assert.equal(call?.init.method, "PUT");
  assert.deepEqual(
    (call?.init.headers as Record<string, string>).Authorization,
    "Bearer sk_live_test"
  );
  const body = JSON.parse(String(call?.init.body));
  assert.equal(body.project, "PRO-1");
  assert.equal(body.source, RunnerCapabilitiesSource.Personal);
  assert.equal(body.content, FILE);
  assert.equal(body.warnings.length, 5);
});

test("report skips an unchanged file unless forced, and skips before the runner is registered", async () => {
  const project = tempDir("caps-project-");
  fs.writeFileSync(path.join(project, "AGENTFLOW.md"), FILE);
  const { calls, fetchImpl } = recordingFetch();
  let targetId: string | null = null;
  const reporter = startHeadlessCapabilitiesReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    projectKey: "PRO-1",
    projectDir: project,
    getComputeTargetId: () => targetId,
    fetchImpl,
    watch: () => ({ close: () => undefined }),
  });

  await reporter.report();
  assert.equal(calls.length, 0);

  targetId = TARGET;
  await reporter.report();
  await reporter.report();
  assert.equal(calls.length, 1);

  await reporter.report({ force: true });
  assert.equal(calls.length, 2);

  fs.writeFileSync(path.join(project, "AGENTFLOW.md"), `${FILE}\nMore.\n`);
  await reporter.report();
  assert.equal(calls.length, 3);
  reporter.stop();
});

test("a failed upload is tried again on the next report", async () => {
  const project = tempDir("caps-project-");
  fs.writeFileSync(path.join(project, "AGENTFLOW.md"), FILE);
  const { calls, fetchImpl } = recordingFetch(500);
  const reporter = startHeadlessCapabilitiesReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    projectKey: "PRO-1",
    projectDir: project,
    getComputeTargetId: () => TARGET,
    fetchImpl,
    watch: () => ({ close: () => undefined }),
  });

  await reporter.report();
  await reporter.report();
  reporter.stop();
  assert.equal(calls.length, 2);
});

test("a change to AGENTFLOW.md uploads it once it settles; other files are ignored", async () => {
  const project = tempDir("caps-project-");
  fs.writeFileSync(path.join(project, "AGENTFLOW.md"), FILE);
  const { calls, fetchImpl } = recordingFetch();
  let onChange: ((fileName: string | null) => void) | null = null;
  let uploaded: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    uploaded = resolve;
  });
  const reporter = startHeadlessCapabilitiesReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    projectKey: "PRO-1",
    projectDir: project,
    getComputeTargetId: () => TARGET,
    fetchImpl: ((url: string, init: RequestInit) => {
      const response = fetchImpl(url, init);
      uploaded();
      return response;
    }) as unknown as typeof fetch,
    debounceMs: 5,
    watch: (_dir, callback) => {
      onChange = callback;
      return { close: () => undefined };
    },
  });

  assert.ok(onChange);
  (onChange as (fileName: string | null) => void)("README.md");
  (onChange as (fileName: string | null) => void)("AGENTFLOW.md");
  (onChange as (fileName: string | null) => void)("AGENTFLOW.md");
  await settled;
  reporter.stop();
  assert.equal(calls.length, 1);
});

test("no file: nothing is uploaded", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const reporter = startHeadlessCapabilitiesReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    projectKey: "PRO-1",
    projectDir: tempDir("caps-project-"),
    getComputeTargetId: () => TARGET,
    fetchImpl,
    watch: () => ({ close: () => undefined }),
  });
  await reporter.report({ force: true });
  reporter.stop();
  assert.equal(calls.length, 0);
});

test("collectCapabilityWarningsIn checks declared names against a file set", () => {
  const files = new Set([
    ".claude/commands/qa/lookup.md",
    ".claude/skills/tdd/SKILL.md",
  ]);
  const warnings = collectCapabilityWarningsIn(
    FILE,
    (rel) => files.has(rel),
    "the toolkit repository"
  );
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.startsWith("/plan-ticket is not in")));
  assert.ok(warnings.some((w) => w.startsWith("/missing is not in")));
  assert.ok(warnings.every((w) => !w.startsWith("/qa:lookup")));
  assert.ok(warnings.some((w) => w.includes("of the toolkit repository")));
  assert.ok(warnings.some((w) => w.startsWith("skill absent is not in")));
});
