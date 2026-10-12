#!/usr/bin/env node
/**
 * Builds the headless runner (src/headless/) into two self-contained ESM
 * files that run on plain Node.js, without Electron or node_modules:
 *
 *   dist-headless/runner.mjs       the runner (src/headless/headless-main.ts)
 *   dist-headless/healthcheck.mjs  the container healthcheck
 *
 * The runner reuses the desktop gateway and loop code unchanged. The three
 * Electron packages that code imports are replaced by Node shims from
 * src/headless/shims/, and the build fails if anything else still pulls in
 * Electron. Workspace packages are bundled from source so a clean checkout
 * builds without building them first.
 *
 *   pnpm -C apps/desktop build:headless
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const outDir = path.join(appDir, "dist-headless");
const shimDir = path.join(appDir, "src/headless/shims");

const ELECTRON_SHIMS = {
  electron: path.join(shimDir, "electron.ts"),
  "electron-store": path.join(shimDir, "electron-store.ts"),
  "electron-log/main.js": path.join(shimDir, "electron-log.ts"),
};
const ELECTRON_PACKAGE_RE =
  /^(electron|electron-store|electron-log|electron-updater)(\/|$)/;
const LOOPS_API_RE = /^@agentflow-ai\/loops-api\/(.+)$/;
const ELECTRON_IMPORT_RE = /^electron/;
const NODE_MODULES_SEGMENT_RE = /node_modules[\\/]/;
const PNPM_STORE_PREFIX_RE = /^\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/]/;

ensureBuildInfo();

const result = await build({
  entryPoints: {
    runner: path.join(appDir, "src/headless/headless-main.ts"),
    healthcheck: path.join(appDir, "src/headless/headless-healthcheck.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "linked",
  metafile: true,
  logLevel: "warning",
  // CommonJS dependencies (socket.io, ws, ...) call require() at run time.
  banner: {
    js: "import { createRequire as __headlessCreateRequire } from 'node:module'; const require = __headlessCreateRequire(import.meta.url);",
  },
  plugins: [headlessResolvePlugin()],
});

assertNoElectron(result.metafile);
const runnerBytes =
  result.metafile.outputs[
    path
      .relative(process.cwd(), path.join(outDir, "runner.mjs"))
      .replaceAll("\\", "/")
  ]?.bytes;
console.log(
  `Built ${path.relative(appDir, outDir)}/runner.mjs${runnerBytes ? ` (${Math.round(runnerBytes / 1024)} KiB)` : ""} and healthcheck.mjs`
);

function headlessResolvePlugin() {
  return {
    name: "headless-resolve",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: ELECTRON_IMPORT_RE }, (args) => {
        const shim = ELECTRON_SHIMS[args.path];
        if (shim) {
          return { path: shim };
        }
        return {
          errors: [
            {
              text: `No headless shim for "${args.path}" (imported by ${path.relative(repoRoot, args.importer)}). Add one in src/headless/shims/ or keep the importer out of the runner graph.`,
            },
          ],
        };
      });
      // loops-api exports resolve to dist/, which a clean checkout lacks.
      pluginBuild.onResolve({ filter: LOOPS_API_RE }, (args) => {
        const subpath = LOOPS_API_RE.exec(args.path)?.[1];
        return {
          path: path.join(repoRoot, "packages/loops-api/src", `${subpath}.ts`),
        };
      });
    },
  };
}

function assertNoElectron(metafile) {
  const offenders = Object.keys(metafile.inputs).filter((input) =>
    input
      .split(NODE_MODULES_SEGMENT_RE)
      .slice(1)
      .some((segment) =>
        ELECTRON_PACKAGE_RE.test(segment.replace(PNPM_STORE_PREFIX_RE, ""))
      )
  );
  if (offenders.length > 0) {
    throw new Error(
      `Electron code reached the headless bundle:\n${offenders.join("\n")}`
    );
  }
}

/**
 * src/shared/build-info.ts is generated (and gitignored) by the desktop
 * prebuild, which needs git. Docker build contexts have no .git, so fall back
 * to BUILD_COMMIT_HASH (or "unknown") and the package.json version.
 */
function ensureBuildInfo() {
  const buildInfoPath = path.join(appDir, "src/shared/build-info.ts");
  try {
    execFileSync(
      process.execPath,
      [path.join(appDir, "scripts/write-build-info.mjs")],
      {
        cwd: appDir,
        stdio: "ignore",
      }
    );
    return;
  } catch {
    if (existsSync(buildInfoPath)) {
      return;
    }
  }
  const { version } = JSON.parse(
    readFileSync(path.join(appDir, "package.json"), "utf8")
  );
  const commit = process.env.BUILD_COMMIT_HASH ?? "unknown";
  writeFileSync(
    buildInfoPath,
    `// AUTO-GENERATED — do not edit\nexport const BUILD_COMMIT_HASH = ${JSON.stringify(commit)};\nexport const BUILD_APP_VERSION = ${JSON.stringify(version)};\n`
  );
}
