import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ClaudeCodeVersionChannel } from "@repo/api/src/types/compute-target-model-provider";
import {
  type ClaudeCodeVersionsOptions,
  createClaudeCodeVersions,
} from "../src/headless/claude-code-versions.js";

const LATEST = "2.1.296";
const OLDER = "2.1.290";
const FAILING = "9.9.9";
const INSTALL_FAILED_RE =
  /claude install 9\.9\.9 failed \(exit 1\): Could not download 9\.9\.9/;
const OFFLINE_FALLBACK_RE = /offline.*using 2\.1\.100/;

type Sandbox = {
  homeDir: string;
  dataDir: string;
  installerPath: string;
  installLog: string;
  versionsDir: string;
  link: string;
  warnings: string[];
};

describe("createClaudeCodeVersions", () => {
  test("latest installs the newest release and claude runs it", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      const ensured = await versionsFor(sandbox).ensure(
        ClaudeCodeVersionChannel.Latest
      );

      assert.deepEqual(ensured, {
        version: LATEST,
        binaryPath: path.join(sandbox.versionsDir, LATEST),
      });
      assert.equal(claudeOnPath(sandbox), LATEST);
      assert.deepEqual(installs(sandbox), [LATEST]);
    });
  });

  test("switching from latest to a release installs it and claude runs that release", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      const versions = versionsFor(sandbox);
      await versions.ensure(ClaudeCodeVersionChannel.Latest);

      const pinned = await versions.ensure(OLDER);

      assert.equal(pinned?.binaryPath, path.join(sandbox.versionsDir, OLDER));
      assert.equal(reportedVersion(pinned?.binaryPath ?? ""), OLDER);
      assert.equal(claudeOnPath(sandbox), OLDER);
      assert.deepEqual(installs(sandbox), [LATEST, OLDER]);
    });
  });

  test("switching back to an installed release needs no installer and moves claude", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      const versions = versionsFor(sandbox);
      await versions.ensure(ClaudeCodeVersionChannel.Latest);
      await versions.ensure(OLDER);

      const back = await versions.ensure(ClaudeCodeVersionChannel.Latest);

      assert.equal(back?.version, LATEST);
      assert.equal(claudeOnPath(sandbox), LATEST);
      assert.deepEqual(installs(sandbox), [LATEST, OLDER]);
    });
  });

  test("the image's own claude runs when it is the release asked for", async () => {
    await withSandbox(LATEST, async (sandbox) => {
      const ensured = await versionsFor(sandbox).ensure(
        ClaudeCodeVersionChannel.Latest
      );

      assert.equal(ensured?.binaryPath, fs.realpathSync(sandbox.installerPath));
      assert.equal(claudeOnPath(sandbox), LATEST);
      assert.deepEqual(installs(sandbox), []);
    });
  });

  test("a release that cannot be installed fails and leaves claude on the previous one", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      const versions = versionsFor(sandbox);
      await versions.ensure(OLDER);

      await assert.rejects(versions.ensure(FAILING), INSTALL_FAILED_RE);
      assert.equal(claudeOnPath(sandbox), OLDER);
    });
  });

  test("a copy that reports another version is installed again", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      fs.mkdirSync(sandbox.versionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandbox.versionsDir, OLDER),
        '#!/usr/bin/env bash\necho "0.0.1 (Claude Code)"\n',
        { mode: 0o755 }
      );

      const ensured = await versionsFor(sandbox).ensure(OLDER);

      assert.equal(ensured?.version, OLDER);
      assert.equal(claudeOnPath(sandbox), OLDER);
      assert.deepEqual(installs(sandbox), [`${OLDER} --force`]);
    });
  });

  test("latest falls back to the newest release on the runner when it cannot be looked up", async () => {
    await withSandbox("2.1.50", async (sandbox) => {
      const online = versionsFor(sandbox);
      await online.ensure("2.1.100");
      await online.ensure("2.1.99");
      const offline = versionsFor(sandbox, {
        lookupLatest: () => Promise.reject(new Error("offline")),
      });

      const ensured = await offline.ensure(ClaudeCodeVersionChannel.Latest);

      assert.equal(ensured?.version, "2.1.100");
      assert.equal(claudeOnPath(sandbox), "2.1.100");
      assert.match(sandbox.warnings.join("\n"), OFFLINE_FALLBACK_RE);
    });
    await withSandbox("2.1.200", async (sandbox) => {
      await versionsFor(sandbox).ensure("2.1.100");
      const offline = versionsFor(sandbox, {
        lookupLatest: () => Promise.resolve("<html>"),
      });

      const ensured = await offline.ensure(ClaudeCodeVersionChannel.Latest);

      assert.equal(ensured?.binaryPath, fs.realpathSync(sandbox.installerPath));
      assert.equal(claudeOnPath(sandbox), "2.1.200");
    });
    await withSandbox("unknown", async (sandbox) => {
      const offline = versionsFor(sandbox, {
        lookupLatest: () => Promise.reject(new Error("offline")),
      });

      assert.equal(await offline.ensure(ClaudeCodeVersionChannel.Latest), null);
      assert.equal(fs.existsSync(sandbox.link), false);
    });
  });

  test("a failed lookup of latest is retried once", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      let calls = 0;
      const versions = versionsFor(sandbox, {
        lookupLatest: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("connection reset"))
            : Promise.resolve(LATEST);
        },
      });

      const ensured = await versions.ensure(ClaudeCodeVersionChannel.Latest);

      assert.equal(ensured?.version, LATEST);
      assert.equal(calls, 2);
      assert.deepEqual(sandbox.warnings, []);
    });
  });

  test("the last request wins when loops ask at the same time", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      const versions = versionsFor(sandbox);

      const results = await Promise.all([
        versions.ensure(OLDER),
        versions.ensure("2.1.295"),
        versions.ensure(OLDER),
        versions.ensure(ClaudeCodeVersionChannel.Latest),
      ]);

      assert.deepEqual(
        results.map((result) => result?.version),
        [OLDER, "2.1.295", OLDER, LATEST]
      );
      assert.equal(claudeOnPath(sandbox), LATEST);
    });
  });

  test("restore points claude back at the release last set", async () => {
    await withSandbox("2.1.200", async (sandbox) => {
      assert.equal(await versionsFor(sandbox).restore(), null);
      await versionsFor(sandbox).ensure(OLDER);
      // A recreated container loses ~/.local/bin but keeps the versions volume.
      fs.rmSync(sandbox.link);

      const restored = await versionsFor(sandbox).restore();

      assert.deepEqual(restored, {
        version: OLDER,
        binaryPath: path.join(sandbox.versionsDir, OLDER),
      });
      assert.equal(claudeOnPath(sandbox), OLDER);
    });
  });
});

/**
 * A HOME, a data directory and a fake `claude`: `--version` reports the
 * image's own release, and `install <v>` writes a binary that reports <v>
 * (failing for 9.9.9) like the native installer, but never moves
 * ~/.local/bin/claude.
 */
async function withSandbox(
  bundledVersion: string,
  body: (sandbox: Sandbox) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-versions-"));
  const homeDir = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const installerPath = path.join(root, "bin", "claude");
  const installLog = path.join(root, "install.log");
  for (const dir of [homeDir, dataDir, path.dirname(installerPath)]) {
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(installerPath, fakeClaude(bundledVersion, installLog), {
    mode: 0o755,
  });
  try {
    await body({
      homeDir,
      dataDir,
      installerPath,
      installLog,
      versionsDir: path.join(homeDir, ".local", "share", "claude", "versions"),
      link: path.join(homeDir, ".local", "bin", "claude"),
      warnings: [],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeClaude(bundledVersion: string, installLog: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `case "\${1:-}" in`,
    `  --version) echo "${bundledVersion} (Claude Code)" ;;`,
    "  install)",
    `    echo "\${*:2}" >> "${installLog}"`,
    `    if [ "$2" = "${FAILING}" ]; then echo "Could not download ${FAILING}" >&2; exit 1; fi`,
    '    dir="$HOME/.local/share/claude/versions"',
    '    mkdir -p "$dir"',
    String.raw`    printf '#!/usr/bin/env bash\necho "%s (Claude Code)"\n' "$2" > "$dir/$2"`,
    '    chmod +x "$dir/$2"',
    "    ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
}

function versionsFor(
  sandbox: Sandbox,
  overrides: Partial<ClaudeCodeVersionsOptions> = {}
) {
  return createClaudeCodeVersions({
    homeDir: sandbox.homeDir,
    dataDir: sandbox.dataDir,
    installerPath: sandbox.installerPath,
    log: {
      info: () => undefined,
      warn: (message) => sandbox.warnings.push(message),
    },
    lookupLatest: () => Promise.resolve(LATEST),
    ...overrides,
  });
}

/** The version a plain `claude` (~/.local/bin/claude) runs. */
function claudeOnPath(sandbox: Sandbox): string {
  return reportedVersion(sandbox.link);
}

function reportedVersion(binary: string): string {
  return execFileSync(binary, ["--version"], { encoding: "utf8" }).split(
    " "
  )[0];
}

function installs(sandbox: Sandbox): string[] {
  if (!fs.existsSync(sandbox.installLog)) {
    return [];
  }
  return fs.readFileSync(sandbox.installLog, "utf8").trim().split("\n");
}
