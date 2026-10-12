import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  PLUGINS_DIR_ENV,
  resetBundledPluginsRootForTests,
} from "../src/server/operations/bundled-plugins.js";
import { needsPluginVersionCheck } from "../src/server/operations/health-check-plugin-inventory.js";
import type { GatewayCheckResult } from "../src/server/operations/health-check-types.js";
import { pluginCheckId } from "../src/server/operations/health-check-types.js";

const originalOverride = process.env[PLUGINS_DIR_ENV];
let root = "";

function pluginCheck(folder: string, passed: boolean): GatewayCheckResult {
  return { id: pluginCheckId(folder), label: folder, required: true, passed };
}

const GIT_CHECK: GatewayCheckResult = {
  id: "git",
  label: "Git",
  required: true,
  passed: false,
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "af-plugins-gate-"));
  process.env[PLUGINS_DIR_ENV] = root;
  resetBundledPluginsRootForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalOverride === undefined) {
    delete process.env[PLUGINS_DIR_ENV];
  } else {
    process.env[PLUGINS_DIR_ENV] = originalOverride;
  }
  resetBundledPluginsRootForTests();
});

test("user-scoped plugins are version-checked once every plugin check passed", () => {
  assert.equal(
    needsPluginVersionCheck([pluginCheck("code", true), GIT_CHECK]),
    true
  );
  assert.equal(
    needsPluginVersionCheck([
      pluginCheck("code", true),
      pluginCheck("judges", false),
    ]),
    false
  );
});

test("bundled plugins are never compared with the marketplace", () => {
  const codeDir = path.join(root, "code", ".claude-plugin");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(
    path.join(codeDir, "plugin.json"),
    JSON.stringify({ name: "code", version: "1.0.0" })
  );
  resetBundledPluginsRootForTests();

  assert.equal(needsPluginVersionCheck([pluginCheck("code", true)]), false);
});
