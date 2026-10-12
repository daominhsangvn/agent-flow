import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeErrorMessage } from "../../main/diagnostics/diagnostics-helpers.js";
import { normalizeAndValidateOrigin } from "../../main/settings/origin-policy.js";
import { assertPathAllowed } from "../security.js";
import { withRepoRefLock } from "./loop-worktree-git.js";
import { addRepo } from "./repos-config-utils.js";
import {
  CLONE_GIT_TIMEOUT,
  expandHome,
  loopError,
  loopLog,
} from "./symphony-utils.js";

/**
 * Local checkouts of project repositories: the repositories a project takes
 * from its integration connections, which a loop clones by `cloneUrl` (never
 * through the `gh` CLI) with the per-loop git credentials of
 * `loop-git-access.ts`. A checkout is reused by later loops and fetched each
 * time, so the agent always starts from the remote's current branches.
 */

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 120_000;
const UNSAFE_DIR_CHARS_RE = /[^A-Za-z0-9._-]+/g;
const LEADING_DOTS_RE = /^\.+/;
const TRAILING_GIT_RE = /\.git$/i;
const TRAILING_SLASHES_RE = /\/+$/;
/** Hook and loop files AgentFlow writes inside a repository's worktree. */
const AGENTFLOW_EXCLUDE = ".agentflow-ai/";

export type ProjectRepoCheckout = {
  fullName: string;
  cloneUrl: string;
};

export type ProjectRepoCheckoutResult =
  | { ok: true; path: string; cloned: boolean }
  | { ok: false; reason: string };

export type ProjectRepoCheckoutOptions = {
  allowedDirs: readonly string[];
  gitBin: string;
  /** Process environment plus the loop's git credentials. */
  env: NodeJS.ProcessEnv;
  loopId: string;
  /** Symphony config directory; the clone is listed in repos.json when set. */
  configDir: string | null;
};

/**
 * Directory name of a project repository's checkout: its full name with each
 * segment made path-safe, e.g. `acme__api` or `contoso__Payments-Team__web`.
 * Distinct per full name, so two repositories named `api` never share one.
 */
export function projectRepoCheckoutDirName(fullName: string): string {
  return fullName
    .split("/")
    .map((segment) =>
      segment
        .trim()
        .replace(UNSAFE_DIR_CHARS_RE, "-")
        .replace(LEADING_DOTS_RE, "")
    )
    .filter(Boolean)
    .join("__");
}

/**
 * Validates a clone URL from the API: https, or http for loopback and the
 * hosts allowed in AGENTFLOW_ALLOW_HTTP_HOSTS, with no password in it.
 */
export function parseProjectRepoCloneUrl(cloneUrl: string): URL {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    throw new Error("cloneUrl is not a valid URL");
  }
  normalizeAndValidateOrigin(url.origin);
  if (url.password) {
    throw new Error("cloneUrl must not contain a password");
  }
  return url;
}

/**
 * Directory of a host's checkouts, e.g. `github.com` or `dev.azure.com`, so
 * repositories with the same full name on two hosts never share one.
 */
export function projectRepoHostDirName(cloneUrl: URL): string {
  return cloneUrl.host
    .toLowerCase()
    .replace(UNSAFE_DIR_CHARS_RE, "-")
    .replace(LEADING_DOTS_RE, "");
}

/**
 * Clones the repository, or fetches the existing checkout of it, at
 * `<allowedDirs[0]>/<host>/<owner>__<repo>`. Loops on different projects that
 * share a repository share its checkout (each works in its own worktree), so
 * the clone or fetch runs under the checkout's ref lock: two loops never fetch
 * into it, or create a worktree from it, at the same time.
 */
export async function ensureProjectRepoCheckout(
  repo: ProjectRepoCheckout,
  options: ProjectRepoCheckoutOptions
): Promise<ProjectRepoCheckoutResult> {
  let cloneUrl: URL;
  try {
    cloneUrl = parseProjectRepoCloneUrl(repo.cloneUrl);
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
  const parent = options.allowedDirs[0];
  const dirName = projectRepoCheckoutDirName(repo.fullName);
  const hostDirName = projectRepoHostDirName(cloneUrl);
  if (!(parent && dirName && hostDirName)) {
    return {
      ok: false,
      reason: parent
        ? `invalid repository name: ${repo.fullName}`
        : "no allowed directories configured",
    };
  }
  const destPath = path.join(expandHome(parent), hostDirName, dirName);
  try {
    assertPathAllowed(destPath, [...options.allowedDirs]);
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }

  return await withRepoRefLock(destPath, async () =>
    existsSync(destPath)
      ? await fetchExistingCheckout(repo, cloneUrl, destPath, options)
      : await cloneCheckout(repo, cloneUrl, destPath, options)
  );
}

async function fetchExistingCheckout(
  repo: ProjectRepoCheckout,
  cloneUrl: URL,
  destPath: string,
  options: ProjectRepoCheckoutOptions
): Promise<ProjectRepoCheckoutResult> {
  const origin = await runGit(
    options,
    ["remote", "get-url", "origin"],
    destPath,
    10_000
  );
  if (!origin.ok) {
    return {
      ok: false,
      reason: `${destPath} exists but is not a checkout of ${repo.fullName}`,
    };
  }
  if (sameRemote(origin.stdout.trim(), cloneUrl)) {
    const fetched = await runGit(
      options,
      ["fetch", "--prune", "origin"],
      destPath,
      FETCH_TIMEOUT_MS
    );
    if (!fetched.ok) {
      return {
        ok: false,
        reason: `could not fetch ${repo.fullName}: ${fetched.error}`,
      };
    }
    loopLog(options.loopId, `Fetched project repository ${repo.fullName}`);
    await excludeAgentFlowFiles(destPath);
    return { ok: true, path: destPath, cloned: false };
  }
  return {
    ok: false,
    reason: `${destPath} is a checkout of another remote, not ${repo.fullName}`,
  };
}

async function cloneCheckout(
  repo: ProjectRepoCheckout,
  cloneUrl: URL,
  destPath: string,
  options: ProjectRepoCheckoutOptions
): Promise<ProjectRepoCheckoutResult> {
  loopLog(
    options.loopId,
    `Cloning project repository ${repo.fullName} into ${destPath}`
  );
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const cloned = await runGit(
    options,
    ["clone", "--origin", "origin", "--", cloneUrl.href, destPath],
    path.dirname(destPath),
    CLONE_GIT_TIMEOUT
  );
  if (!cloned.ok) {
    await fs.rm(destPath, { recursive: true, force: true }).catch(() => {});
    loopError(
      options.loopId,
      `clone of ${repo.fullName} failed: ${cloned.error}`
    );
    return {
      ok: false,
      reason: `could not clone ${repo.fullName}: ${cloned.error}`,
    };
  }
  if (options.configDir) {
    const added = await addRepo(destPath, undefined, options.configDir);
    if (!added.success && added.error !== "Repository already configured") {
      loopError(
        options.loopId,
        `listing ${destPath} in repos.json failed (non-fatal): ${added.error ?? "unknown error"}`
      );
    }
  }
  await excludeAgentFlowFiles(destPath);
  return { ok: true, path: destPath, cloned: true };
}

type GitRunResult = { ok: true; stdout: string } | { ok: false; error: string };

async function runGit(
  options: ProjectRepoCheckoutOptions,
  args: string[],
  cwd: string,
  timeout: number
): Promise<GitRunResult> {
  try {
    const { stdout } = await execFileAsync(options.gitBin, args, {
      cwd,
      env: options.env,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text =
      typeof stderr === "string" && stderr.trim() ? stderr : errorText(error);
    return {
      ok: false,
      error: sanitizeErrorMessage(text.trim()).slice(0, 500),
    };
  }
}

/** Same repository: scheme, host and path match, ignoring a user name and `.git`. */
function sameRemote(remote: string, cloneUrl: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return false;
  }
  return (
    parsed.protocol === cloneUrl.protocol &&
    parsed.host.toLowerCase() === cloneUrl.host.toLowerCase() &&
    normalizePath(parsed.pathname) === normalizePath(cloneUrl.pathname)
  );
}

function normalizePath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path; it then only matches an identical one.
  }
  return decoded
    .replace(TRAILING_SLASHES_RE, "")
    .replace(TRAILING_GIT_RE, "")
    .toLowerCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps AgentFlow's own files (plugin hook logs, critic gates) out of the
 * agent's `git status`: the checkout's `.git/info/exclude` applies to all of
 * its worktrees and is never committed. Best effort.
 */
async function excludeAgentFlowFiles(checkoutPath: string): Promise<void> {
  const excludeFile = path.join(checkoutPath, ".git", "info", "exclude");
  try {
    const current = existsSync(excludeFile)
      ? await fs.readFile(excludeFile, "utf8")
      : "";
    const lines = current.split("\n").map((line) => line.trim());
    if (lines.includes(AGENTFLOW_EXCLUDE)) {
      return;
    }
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await fs.appendFile(excludeFile, `${separator}${AGENTFLOW_EXCLUDE}\n`);
  } catch {
    // Untracked files then show in git status; the commit step skips them.
  }
}
