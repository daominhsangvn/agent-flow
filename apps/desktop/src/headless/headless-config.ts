/**
 * @file headless-config.ts
 * @description Parses the headless runner configuration from environment
 * variables (see headless-env.ts and docs/runner.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { normalizeAndValidateOrigin } from "../main/settings/origin-policy.js";
import {
  HeadlessRunnerEnv,
  normalizeProjectKey,
  RunnerMode,
  resolveRunnerDataDir,
} from "./headless-env.js";

export const DEFAULT_RUNNER_WORKSPACE = "/workspace";
export const DEFAULT_MAX_CONCURRENT_COMMANDS = 2;

const API_KEY_PREFIX = "sk_live_";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const HTTP_PROTOCOL_RE = /^https?:$/;

export type HeadlessRunnerConfig = {
  apiUrl: string;
  apiKey: string;
  webAppUrl: string;
  runnerName: string;
  workspaceDir: string;
  dataDir: string;
  maxConcurrentCommands: number;
  /** Local gateway port (loopback only); null: any free port. */
  gatewayPort: number | null;
  rewriteCallbackUrl: boolean;
  reportSessions: boolean;
  /** Set in personal mode; the workspace is then the project folder. */
  personal: PersonalRunnerSettings | null;
};

export type PersonalRunnerSettings = {
  projectKey: string;
  projectDir: string;
  /** The project's commands can run several loops in the folder at once. */
  parallel: boolean;
  /** The agent uses any tool without a permission prompt. */
  skipPermissions: boolean;
};

export type HeadlessConfigResult =
  | { ok: true; config: HeadlessRunnerConfig }
  | { ok: false; errors: string[] };

const originSchema = z
  .string()
  .trim()
  .url()
  // Runs after a failed .url() check too: an unparsable value must not throw.
  .refine(
    (value) =>
      URL.canParse(value) && HTTP_PROTOCOL_RE.test(new URL(value).protocol),
    {
      message: "must be an http(s) URL",
    }
  )
  .transform((value) => new URL(value).origin);

const booleanFlagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => TRUE_VALUES.has(value) || FALSE_VALUES.has(value), {
    message: "must be true or false",
  })
  .transform((value) => TRUE_VALUES.has(value));

const envSchema = z.object({
  [HeadlessRunnerEnv.ApiUrl]: originSchema,
  [HeadlessRunnerEnv.ApiKey]: z
    .string()
    .trim()
    .startsWith(API_KEY_PREFIX, {
      message: `must be a AgentFlow API key (${API_KEY_PREFIX}...)`,
    }),
  [HeadlessRunnerEnv.WebAppUrl]: originSchema.optional(),
  [HeadlessRunnerEnv.RunnerName]: z.string().trim().min(1).max(120).optional(),
  [HeadlessRunnerEnv.Workspace]: z.string().trim().min(1).optional(),
  [HeadlessRunnerEnv.DataDir]: z.string().trim().min(1).optional(),
  [HeadlessRunnerEnv.MaxConcurrent]: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .optional(),
  [HeadlessRunnerEnv.GatewayPort]: z.coerce
    .number()
    .int()
    .min(1024)
    .max(65_535)
    .optional(),
  [HeadlessRunnerEnv.RewriteCallbackUrl]: booleanFlagSchema.optional(),
  [HeadlessRunnerEnv.ReportSessions]: booleanFlagSchema.optional(),
  [HeadlessRunnerEnv.Mode]: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(RunnerMode))
    .optional(),
  [HeadlessRunnerEnv.ProjectKey]: z
    .string()
    .transform((value, context) => {
      const key = normalizeProjectKey(value);
      if (!key) {
        context.addIssue({
          code: "custom",
          message: "must be an AgentFlow project key such as PRO-1",
        });
        return z.NEVER;
      }
      return key;
    })
    .optional(),
  [HeadlessRunnerEnv.ProjectDir]: z.string().trim().min(1).optional(),
  [HeadlessRunnerEnv.Parallel]: booleanFlagSchema.optional(),
  [HeadlessRunnerEnv.SkipPermissions]: booleanFlagSchema.optional(),
});

type EnvValues = z.infer<typeof envSchema>;

/** Reads the runner configuration; empty variables count as unset. */
export function loadHeadlessConfig(
  env: NodeJS.ProcessEnv = process.env
): HeadlessConfigResult {
  const parsed = envSchema.safeParse(withoutEmptyValues(env));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`
      ),
    };
  }
  const values = parsed.data;
  const personal = readPersonalSettings(values);
  if (!personal.ok) {
    return { ok: false, errors: personal.errors };
  }
  const apiUrl = values[HeadlessRunnerEnv.ApiUrl];
  // The API key travels over this connection: same origin policy as the desktop.
  const originError = validateTransportOrigin(apiUrl);
  if (originError) {
    return {
      ok: false,
      errors: [`${HeadlessRunnerEnv.ApiUrl}: ${originError}`],
    };
  }
  return {
    ok: true,
    config: {
      apiUrl,
      apiKey: values[HeadlessRunnerEnv.ApiKey],
      webAppUrl: values[HeadlessRunnerEnv.WebAppUrl] ?? apiUrl,
      runnerName: values[HeadlessRunnerEnv.RunnerName] ?? os.hostname(),
      // A personal runner works in the project folder only.
      workspaceDir:
        personal.value?.projectDir ??
        path.resolve(
          values[HeadlessRunnerEnv.Workspace] ?? DEFAULT_RUNNER_WORKSPACE
        ),
      dataDir: resolveRunnerDataDir(env),
      maxConcurrentCommands:
        values[HeadlessRunnerEnv.MaxConcurrent] ??
        DEFAULT_MAX_CONCURRENT_COMMANDS,
      gatewayPort: values[HeadlessRunnerEnv.GatewayPort] ?? null,
      rewriteCallbackUrl: values[HeadlessRunnerEnv.RewriteCallbackUrl] ?? true,
      reportSessions: values[HeadlessRunnerEnv.ReportSessions] ?? true,
      personal: personal.value,
    },
  };
}

export type SettingCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Validates an API URL the way the runner will: an http(s) origin it may use. */
export function checkApiUrlSetting(value: string): SettingCheck {
  const parsed = originSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: "must be an http(s) URL" };
  }
  const originError = validateTransportOrigin(parsed.data);
  return originError
    ? { ok: false, error: originError }
    : { ok: true, value: parsed.data };
}

/** Validates a AgentFlow API key (`sk_live_...`). */
export function checkApiKeySetting(value: string): SettingCheck {
  const trimmed = value.trim();
  return trimmed.startsWith(API_KEY_PREFIX)
    ? { ok: true, value: trimmed }
    : {
        ok: false,
        error: `must be a AgentFlow API key (${API_KEY_PREFIX}...)`,
      };
}

/** Personal mode needs a project key and an existing project folder. */
function readPersonalSettings(
  values: EnvValues
):
  | { ok: true; value: PersonalRunnerSettings | null }
  | { ok: false; errors: string[] } {
  if (values[HeadlessRunnerEnv.Mode] !== RunnerMode.Personal) {
    return { ok: true, value: null };
  }
  const projectKey = values[HeadlessRunnerEnv.ProjectKey];
  const projectDir = values[HeadlessRunnerEnv.ProjectDir];
  const errors: string[] = [];
  if (!projectKey) {
    errors.push(`${HeadlessRunnerEnv.ProjectKey}: required in personal mode`);
  }
  if (!projectDir) {
    errors.push(`${HeadlessRunnerEnv.ProjectDir}: required in personal mode`);
  } else if (!isDirectory(projectDir)) {
    errors.push(
      `${HeadlessRunnerEnv.ProjectDir}: ${projectDir} is not a directory`
    );
  }
  if (!(projectKey && projectDir) || errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      projectKey,
      projectDir: path.resolve(projectDir),
      parallel: values[HeadlessRunnerEnv.Parallel] ?? false,
      skipPermissions: values[HeadlessRunnerEnv.SkipPermissions] ?? false,
    },
  };
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.values(HeadlessRunnerEnv)) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      result[name] = value;
    }
  }
  return result;
}

function validateTransportOrigin(origin: string): string | null {
  try {
    normalizeAndValidateOrigin(origin);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
