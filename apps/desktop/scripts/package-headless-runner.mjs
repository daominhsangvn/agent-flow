#!/usr/bin/env node
/**
 * Packages the headless runner for direct installation on a Linux server
 * (systemd), as an alternative to the Docker image:
 *
 *   dist-headless/agentflow-runner-<version>-linux.tar.gz
 *     agentflow-runner/
 *       runner.mjs, healthcheck.mjs      the bundle (build-headless-runner.mjs)
 *       agent-plugins/                   the vendored Claude Code plugins
 *       entrypoint.sh                    git/gh setup, shared with the image
 *       install.sh                       installer (Ubuntu/Debian)
 *       agentflow-runner.service        systemd unit
 *       runner.env.example               configuration template
 *
 *   pnpm -C apps/desktop package:headless
 *
 * On the server: tar -xzf <file> && sudo bash agentflow-runner/install.sh
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const distDir = path.join(appDir, "dist-headless");
const stageRoot = path.join(distDir, "package");
const stageDir = path.join(stageRoot, "agentflow-runner");
const deployDir = path.join(repoRoot, "deploy/runner");
const EXCLUDED_PLUGIN_DIRS = new Set(["tests", "__pycache__", ".pytest_cache"]);

execFileSync(
  process.execPath,
  [path.join(appDir, "scripts/build-headless-runner.mjs")],
  {
    stdio: "inherit",
  }
);

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const file of [
  "runner.mjs",
  "runner.mjs.map",
  "runner.mjs.LEGAL.txt",
  "healthcheck.mjs",
  "healthcheck.mjs.map",
]) {
  cpSync(path.join(distDir, file), path.join(stageDir, file), { force: true });
}
cpSync(
  path.join(repoRoot, "agent-plugins"),
  path.join(stageDir, "agent-plugins"),
  {
    recursive: true,
    filter: (source) => !EXCLUDED_PLUGIN_DIRS.has(path.basename(source)),
  }
);
cpSync(
  path.join(deployDir, "entrypoint.sh"),
  path.join(stageDir, "entrypoint.sh")
);
for (const file of [
  "install.sh",
  "agentflow-runner.service",
  "runner.env.example",
]) {
  cpSync(path.join(deployDir, "linux", file), path.join(stageDir, file));
}

const { version } = JSON.parse(
  readFileSync(path.join(appDir, "package.json"), "utf8")
);
const archive = path.join(distDir, `agentflow-runner-${version}-linux.tar.gz`);
rmSync(archive, { force: true });
// Relative paths: GNU tar reads "D:\..." on Windows as a remote host.
execFileSync(
  "tar",
  [
    "-czf",
    path.basename(archive),
    "-C",
    path.basename(stageRoot),
    "agentflow-runner",
  ],
  { cwd: distDir, stdio: "inherit" }
);
console.log(`Packaged ${path.relative(appDir, archive)}`);
