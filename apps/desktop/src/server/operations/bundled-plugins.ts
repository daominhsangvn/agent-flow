import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AgentFlow's Claude Code plugins (code, code-review, judges, platform,
 * self-learning, bootstrap) ship inside this repository under `agent-plugins/`
 * and are loaded per invocation with `claude --plugin-dir <dir>`. Nothing is
 * installed through `/plugin install` or a marketplace, and the user's
 * `~/.claude/plugins` is never touched.
 *
 * Root resolution order:
 *   1. `AGENTFLOW_PLUGINS_DIR` when set — authoritative; a directory without
 *      the plugins disables bundling
 *   2. `<resourcesPath>/agent-plugins` in a packaged build (electron-builder
 *      extraResources)
 *   3. `<repo>/agent-plugins` when running from source
 */

export const PLUGINS_DIR_ENV = "AGENTFLOW_PLUGINS_DIR";

/**
 * Newline-separated plugin directories exported to child processes so shell
 * runners (run-loop.sh) can pass the same `--plugin-dir` flags. Newlines rather
 * than `path.delimiter` because Windows paths contain `:`.
 */
export const PLUGIN_DIRS_ENV = "AGENTFLOW_PLUGIN_DIRS";

const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");
const REQUIRED_ROOT_MARKER = path.join("code", PLUGIN_MANIFEST);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let cachedRoot: string | null | undefined;

export function getBundledPluginsRoot(): string | null {
  if (cachedRoot !== undefined) {
    return cachedRoot;
  }
  // An explicit override is authoritative: pointing it at a directory without
  // the plugins disables bundling instead of silently falling back.
  const override = process.env[PLUGINS_DIR_ENV]?.trim();
  if (override) {
    const resolved = path.resolve(override);
    cachedRoot = isPluginsRoot(resolved) ? resolved : null;
    return cachedRoot;
  }
  cachedRoot = defaultRoots().find(isPluginsRoot) ?? null;
  return cachedRoot;
}

/** Absolute directory of one bundled plugin, or null when not bundled. */
export function getBundledPluginDir(pluginName: string): string | null {
  const root = getBundledPluginsRoot();
  if (!root) {
    return null;
  }
  const dir = path.join(root, pluginName);
  return existsSync(path.join(dir, PLUGIN_MANIFEST)) ? dir : null;
}

/** Every bundled plugin directory, sorted for stable argument order. */
export function getBundledPluginDirs(): string[] {
  const root = getBundledPluginsRoot();
  if (!root) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => existsSync(path.join(dir, PLUGIN_MANIFEST)))
    .sort();
}

/** `--plugin-dir <dir>` pairs for a `claude` invocation. */
export function pluginDirArgs(): string[] {
  return getBundledPluginDirs().flatMap((dir) => ["--plugin-dir", dir]);
}

/** Environment entries that expose the bundled plugin dirs to child scripts. */
export function pluginDirsEnv(): Record<string, string> {
  const dirs = getBundledPluginDirs();
  return dirs.length > 0 ? { [PLUGIN_DIRS_ENV]: dirs.join("\n") } : {};
}

/**
 * Version from a bundled plugin's manifest. Returns null when the plugin is
 * not bundled, and an empty string when the manifest carries no version.
 */
export function getBundledPluginVersion(pluginName: string): string | null {
  const dir = getBundledPluginDir(pluginName);
  if (!dir) {
    return null;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dir, PLUGIN_MANIFEST), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

/** Test-only: forget the resolved root so a test can change the override. */
export function resetBundledPluginsRootForTests(): void {
  cachedRoot = undefined;
}

function defaultRoots(): string[] {
  const candidates: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "agent-plugins"));
  }
  // Source layouts: apps/desktop/out/main (electron-vite build output) and
  // apps/desktop/src/server/operations (tests running from source).
  candidates.push(
    path.resolve(moduleDir, "..", "..", "..", "..", "agent-plugins"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "agent-plugins")
  );
  return candidates;
}

function isPluginsRoot(dir: string): boolean {
  return existsSync(path.join(dir, REQUIRED_ROOT_MARKER));
}
