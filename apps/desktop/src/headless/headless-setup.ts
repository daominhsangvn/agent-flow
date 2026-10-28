/**
 * @file headless-setup.ts
 * @description The runner's configuration file and the questions that fill it.
 *
 * `node runner.mjs setup` asks for what the runner needs to connect to
 * AgentFlow (API URL, API key, runner name, workspace) and saves the answers
 * to `<data dir>/runner.env`. It first asks for the mode: `auto` (the
 * default) clones the project repositories into the workspace; `personal`
 * works for one AgentFlow project in a folder of this computer and asks for
 * the project key, that folder, and whether the project's commands can run
 * several loops at once; its answers go to the project's own data directory
 * (`<data dir>/personal/<project key>`), so several personal runners can
 * share one computer. At startup the runner reads that file; a
 * variable set in the environment wins over it. Any other variable written
 * there (CLAUDE_CODE_OAUTH_TOKEN, a connection string for the agents, ...)
 * reaches the loops too. A start with no API URL or key, from a terminal,
 * asks the same questions first. See docs/runner.md.
 */

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  checkApiKeySetting,
  checkApiUrlSetting,
  type SettingCheck,
} from "./headless-config.js";
import {
  HeadlessRunnerEnv,
  normalizeProjectKey,
  RunnerMode,
} from "./headless-env.js";

export const RUNNER_CONFIG_FILE_NAME = "runner.env";
/** Used when the account name has no letter or digit to keep. */
const FALLBACK_RUNNER_NAME = "runner";
const RUNNER_NAME_MAX_LENGTH = 120;
/** `sk_live_` and the last characters of a configured key are shown. */
const API_KEY_VISIBLE_PREFIX = 8;
const API_KEY_VISIBLE_SUFFIX = 4;
const CONFIG_FILE_MODE = 0o600;
const COMBINING_MARKS_RE = /\p{M}+/gu;
const NON_NAME_CHARACTERS_RE = /[^A-Za-z0-9]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;
const LINE_BREAK_RE = /\r?\n/;
const HOME_PREFIX_RE = /^~(?=$|[\\/])/;
/** What Enter keeps for the gateway port when none is set. */
const RANDOM_PORT = "random";
const PORT_RE = /^\d+$/;
const PORT_MIN = 1024;
const PORT_MAX = 65_535;

/** The settings the questions ask for, in the order they are asked. */
export const SETUP_SETTINGS = [
  HeadlessRunnerEnv.Mode,
  HeadlessRunnerEnv.ApiUrl,
  HeadlessRunnerEnv.ApiKey,
  HeadlessRunnerEnv.RunnerName,
  HeadlessRunnerEnv.Workspace,
  HeadlessRunnerEnv.ProjectKey,
  HeadlessRunnerEnv.ProjectDir,
  HeadlessRunnerEnv.Parallel,
  HeadlessRunnerEnv.SkipPermissions,
  HeadlessRunnerEnv.GatewayPort,
] as const;
export type SetupSetting = (typeof SETUP_SETTINGS)[number];
/** Auto mode answers the connection settings and the workspace; personal mode the project instead. */
export type SetupAnswers = Partial<Record<SetupSetting, string>>;

/**
 * Asks one question and resolves to the trimmed answer ("" for Enter).
 * `shownDefault` is what Enter keeps, as displayed to the person.
 */
export type Ask = (question: string, shownDefault?: string) => Promise<string>;

export type SetupContext = {
  ask: Ask;
  /** Prints a line for the person answering. */
  say: (line: string) => void;
  /** Values already configured (file and environment). */
  current: Readonly<Record<string, string | undefined>>;
  username: string;
  homeDir: string;
};

export function runnerConfigFile(dataDir: string): string {
  return path.join(dataDir, RUNNER_CONFIG_FILE_NAME);
}

/** The variables in a runner config file; none when it does not exist. */
export function readRunnerConfigFile(file: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return parseEnv(content) as Record<string, string>;
}

/** Copies config file values into `env` where `env` has none of its own. */
export function applyRunnerConfig(
  env: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>
): void {
  for (const [name, value] of Object.entries(values)) {
    if (!env[name]?.trim()) {
      env[name] = value;
    }
  }
}

/** True when the runner cannot connect: no API URL or no API key. */
export function needsSetup(env: NodeJS.ProcessEnv): boolean {
  return !(
    env[HeadlessRunnerEnv.ApiUrl]?.trim() &&
    env[HeadlessRunnerEnv.ApiKey]?.trim()
  );
}

/**
 * A runner name from an account name: accents dropped (`Nguyễn` → `Nguyen`),
 * every run of other characters, whitespace included, turned into one `-`.
 */
export function defaultRunnerName(username: string): string {
  const name = username
    .normalize("NFD")
    .replace(COMBINING_MARKS_RE, "")
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .replace(NON_NAME_CHARACTERS_RE, "-")
    .replace(EDGE_DASHES_RE, "")
    .slice(0, RUNNER_NAME_MAX_LENGTH)
    .replace(EDGE_DASHES_RE, "");
  return name || FALLBACK_RUNNER_NAME;
}

/** `<home>/.agentflow/_works`: where repositories are cloned by default. */
export function defaultWorkspaceDir(homeDir: string): string {
  return path.join(homeDir, ".agentflow", "_works");
}

/** Asks for the mode: `auto` (Enter, unless personal is configured) or `personal`. */
export async function askRunnerMode(
  context: SetupContext
): Promise<RunnerMode> {
  const configured =
    context.current[HeadlessRunnerEnv.Mode] === RunnerMode.Personal
      ? RunnerMode.Personal
      : RunnerMode.Auto;
  const mode = await askUntilValid(context, {
    question:
      "Runner mode: auto (clones the project repositories) or personal (one project, in a folder of this computer, with its credentials)",
    currentValue: configured,
    check: checkRunnerMode,
  });
  return mode === RunnerMode.Personal ? RunnerMode.Personal : RunnerMode.Auto;
}

/** Asks every setup question of the mode until each answer is valid. */
export async function askRunnerSettings(
  context: SetupContext,
  mode: RunnerMode = RunnerMode.Auto
): Promise<SetupAnswers> {
  if (mode === RunnerMode.Personal) {
    return await askPersonalRunnerSettings(context);
  }
  const { current } = context;
  const connection = await askConnectionSettings(context);
  const runnerName = await askUntilValid(context, {
    question: "Runner name, shown in AgentFlow",
    currentValue:
      current[HeadlessRunnerEnv.RunnerName] ||
      defaultRunnerName(context.username),
    check: checkRunnerName,
  });
  const workspace = await askUntilValid(context, {
    question: "Workspace directory (repositories are cloned here)",
    currentValue:
      current[HeadlessRunnerEnv.Workspace] ||
      defaultWorkspaceDir(context.homeDir),
    check: (value) => ({
      ok: true,
      value: path.resolve(value.replace(HOME_PREFIX_RE, context.homeDir)),
    }),
  });
  const gatewayPort = await askGatewayPort(context);
  return {
    ...connection,
    [HeadlessRunnerEnv.RunnerName]: runnerName,
    [HeadlessRunnerEnv.Workspace]: workspace,
    [HeadlessRunnerEnv.GatewayPort]: gatewayPort,
  };
}

/**
 * Personal mode: the connection, then the project (key, folder, whether its
 * commands run in parallel) and a runner name that names the project.
 */
async function askPersonalRunnerSettings(
  context: SetupContext
): Promise<SetupAnswers> {
  const connection = await askConnectionSettings(context);
  const { current } = context;
  const projectKey = await askUntilValid(context, {
    question:
      "AgentFlow project key (e.g. PRO-1); this runner runs only that project's loops",
    currentValue: current[HeadlessRunnerEnv.ProjectKey],
    check: checkProjectKey,
  });
  const projectDir = await askUntilValid(context, {
    question: "Project folder (the agent works here, as you do by hand)",
    currentValue: current[HeadlessRunnerEnv.ProjectDir],
    check: (value) => checkProjectDir(value, context.homeDir),
  });
  const parallel = await askUntilValid(context, {
    question:
      "Can the project's commands run several tasks at once in this folder (they make their own worktrees)? yes/no",
    currentValue: current[HeadlessRunnerEnv.Parallel] === "true" ? "yes" : "no",
    check: checkYesNo,
  });
  const skipPermissions = await askUntilValid(context, {
    question:
      "Let the agent use any tool without a permission prompt (nobody is at the terminal to approve one)? yes/no",
    currentValue:
      current[HeadlessRunnerEnv.SkipPermissions] === "true" ? "yes" : "no",
    check: checkYesNo,
  });
  const currentName = current[HeadlessRunnerEnv.RunnerName];
  const runnerName = await askUntilValid(context, {
    question: "Runner name, shown in AgentFlow",
    currentValue:
      currentName && current[HeadlessRunnerEnv.ProjectKey] === projectKey
        ? currentName
        : `${defaultRunnerName(context.username)}-${projectKey}`,
    check: checkRunnerName,
  });
  const gatewayPort = await askGatewayPort(context);
  return {
    [HeadlessRunnerEnv.Mode]: RunnerMode.Personal,
    ...connection,
    [HeadlessRunnerEnv.RunnerName]: runnerName,
    [HeadlessRunnerEnv.ProjectKey]: projectKey,
    [HeadlessRunnerEnv.ProjectDir]: projectDir,
    [HeadlessRunnerEnv.Parallel]: parallel,
    [HeadlessRunnerEnv.SkipPermissions]: skipPermissions,
    [HeadlessRunnerEnv.GatewayPort]: gatewayPort,
  };
}

/**
 * The local gateway port, optional: Enter keeps the configured one, or any
 * free port when none is (saved empty, which counts as unset); `random`
 * clears a configured one. The answer is shown, so the person knows the
 * port the runner is going to take.
 */
async function askGatewayPort(context: SetupContext): Promise<string> {
  const configured = context.current[HeadlessRunnerEnv.GatewayPort] ?? "";
  for (;;) {
    const answer = (
      await context.ask(
        `Local gateway port (loopback only; ${RANDOM_PORT} = any free port)`,
        configured || RANDOM_PORT
      )
    ).toLowerCase();
    const value = answer === "" ? configured : answer;
    if (value === "" || value === RANDOM_PORT) {
      context.say("  Port: any free port, shown when the runner starts.");
      return "";
    }
    const port = Number(value);
    if (PORT_RE.test(value) && port >= PORT_MIN && port <= PORT_MAX) {
      context.say(`  Port: ${port}.`);
      return String(port);
    }
    context.say(
      `  must be a port from ${PORT_MIN} to ${PORT_MAX}, or ${RANDOM_PORT}`
    );
  }
}

/** The API URL and key, asked first in both modes. */
async function askConnectionSettings(
  context: SetupContext
): Promise<SetupAnswers> {
  const { current } = context;
  const apiUrl = await askUntilValid(context, {
    question: "AgentFlow API URL (e.g. https://agentflow.example.com)",
    currentValue: current[HeadlessRunnerEnv.ApiUrl],
    check: checkApiUrlSetting,
  });
  const currentKey = current[HeadlessRunnerEnv.ApiKey];
  const apiKey = await askUntilValid(context, {
    question: "API key (AgentFlow → Settings → API Keys, sk_live_...)",
    currentValue: currentKey,
    shownDefault: currentKey ? maskApiKey(currentKey) : undefined,
    check: checkApiKeySetting,
  });
  return {
    [HeadlessRunnerEnv.ApiUrl]: apiUrl,
    [HeadlessRunnerEnv.ApiKey]: apiKey,
  };
}

/**
 * The config file with `answers` set: lines of these settings are replaced,
 * missing ones appended, and every other line (comments, other variables)
 * kept as it was.
 */
export function renderRunnerConfig(
  existing: string,
  answers: SetupAnswers
): string {
  const remaining = new Map<string, string>(
    Object.entries(answers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const lines = existing ? existing.split(LINE_BREAK_RE) : [];
  const updated = lines.map((line) => {
    const name = line.split("=", 1)[0]?.trim() ?? "";
    const value = remaining.get(name);
    if (value === undefined) {
      return line;
    }
    remaining.delete(name);
    return `${name}=${value}`;
  });
  while (updated.length > 0 && updated.at(-1) === "") {
    updated.pop();
  }
  if (updated.length === 0) {
    updated.push(
      "# AgentFlow runner configuration (docs/runner.md). Variables set in the",
      "# environment win over this file. Rewrite it with: node runner.mjs setup"
    );
  }
  for (const [name, value] of remaining) {
    updated.push(`${name}=${value}`);
  }
  return `${updated.join("\n")}\n`;
}

/** Writes the answers to the config file, readable by this account only. */
export function writeRunnerConfigFile(
  file: string,
  answers: SetupAnswers
): void {
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderRunnerConfig(existing, answers), {
    mode: CONFIG_FILE_MODE,
  });
}

type Question = {
  question: string;
  currentValue: string | undefined;
  /** Shown instead of currentValue (a masked key). */
  shownDefault?: string;
  check: (value: string) => SettingCheck;
};

async function askUntilValid(
  context: SetupContext,
  question: Question
): Promise<string> {
  for (;;) {
    const answer = await context.ask(
      question.question,
      question.shownDefault ?? question.currentValue
    );
    const value = answer || question.currentValue || "";
    if (!value) {
      context.say("  A value is required.");
      continue;
    }
    const result = question.check(value);
    if (result.ok) {
      return result.value;
    }
    context.say(`  ${result.error}`);
  }
}

function checkRunnerName(value: string): SettingCheck {
  const trimmed = value.trim();
  return trimmed.length > RUNNER_NAME_MAX_LENGTH
    ? {
        ok: false,
        error: `must be at most ${RUNNER_NAME_MAX_LENGTH} characters`,
      }
    : { ok: true, value: trimmed };
}

function checkRunnerMode(value: string): SettingCheck {
  const answer = value.trim().toLowerCase();
  if (answer === "a" || answer === RunnerMode.Auto) {
    return { ok: true, value: RunnerMode.Auto };
  }
  if (answer === "p" || answer === RunnerMode.Personal) {
    return { ok: true, value: RunnerMode.Personal };
  }
  return { ok: false, error: "answer auto or personal" };
}

function checkProjectKey(value: string): SettingCheck {
  const key = normalizeProjectKey(value);
  return key
    ? { ok: true, value: key }
    : { ok: false, error: "must be an AgentFlow project key such as PRO-1" };
}

function checkProjectDir(value: string, homeDir: string): SettingCheck {
  const dir = path.resolve(value.replace(HOME_PREFIX_RE, homeDir));
  try {
    if (fs.statSync(dir).isDirectory()) {
      return { ok: true, value: dir };
    }
  } catch {
    // Reported below.
  }
  return { ok: false, error: `${dir} is not an existing folder` };
}

function checkYesNo(value: string): SettingCheck {
  const answer = value.trim().toLowerCase();
  if (["y", "yes", "true"].includes(answer)) {
    return { ok: true, value: "true" };
  }
  if (["n", "no", "false"].includes(answer)) {
    return { ok: true, value: "false" };
  }
  return { ok: false, error: "answer yes or no" };
}

function maskApiKey(key: string): string {
  return `${key.slice(0, API_KEY_VISIBLE_PREFIX)}…${key.slice(-API_KEY_VISIBLE_SUFFIX)}`;
}
