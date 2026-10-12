import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  getBundledPluginDir,
  getBundledPluginDirs,
  getBundledPluginsRoot,
  getBundledPluginVersion,
  PLUGIN_DIRS_ENV,
  PLUGINS_DIR_ENV,
  pluginDirArgs,
  pluginDirsEnv,
  resetBundledPluginsRootForTests,
} from "../src/server/operations/bundled-plugins.js";

const originalOverride = process.env[PLUGINS_DIR_ENV];
let root = "";

function writePlugin(name: string, manifest: object): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify(manifest)
  );
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "af-plugins-"));
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

test("an override without the code plugin disables bundling", () => {
  writePlugin("judges", { name: "judges" });
  assert.equal(getBundledPluginsRoot(), null);
  assert.deepEqual(pluginDirArgs(), []);

  writePlugin("code", { name: "code" });
  resetBundledPluginsRootForTests();
  assert.equal(getBundledPluginsRoot(), root);
});

test("lists plugin dirs and builds --plugin-dir args in stable order", () => {
  const code = writePlugin("code", { name: "code" });
  const judges = writePlugin("judges", { name: "judges" });
  mkdirSync(path.join(root, "not-a-plugin"));

  assert.deepEqual(getBundledPluginDirs(), [code, judges]);
  assert.deepEqual(pluginDirArgs(), [
    "--plugin-dir",
    code,
    "--plugin-dir",
    judges,
  ]);
  assert.deepEqual(pluginDirsEnv(), {
    [PLUGIN_DIRS_ENV]: `${code}\n${judges}`,
  });
});

test("resolves single plugins and their manifest versions", () => {
  const code = writePlugin("code", { name: "code", version: "1.4.0" });
  writePlugin("platform", { name: "platform" });

  assert.equal(getBundledPluginDir("code"), code);
  assert.equal(getBundledPluginDir("missing"), null);
  assert.equal(getBundledPluginVersion("code"), "1.4.0");
  assert.equal(getBundledPluginVersion("platform"), "");
  assert.equal(getBundledPluginVersion("missing"), null);
});

test("the repository copy resolves when no override is set", () => {
  delete process.env[PLUGINS_DIR_ENV];
  resetBundledPluginsRootForTests();

  const resolved = getBundledPluginsRoot();
  assert.ok(resolved, "expected the repo agent-plugins directory");
  assert.equal(path.basename(resolved), "agent-plugins");
  assert.ok(getBundledPluginDir("code"));
});
