/**
 * @file headless-config.ts
 * @description Parses the headless runner configuration from environment
 * variables (see headless-env.ts and docs/runner.md).
 */

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { normalizeAndValidateOrigin } from "../main/settings/origin-policy.js";
import { HeadlessRunnerEnv, resolveRunnerDataDir } from "./headless-env.js";

export const DEFAULT_RUNNER_WORKSPACE = "/workspace";
export const DEFAULT_MAX_CONCURRENT_COMMANDS = 2;
export const DEFAULT_GATEWAY_PORT = 47_821;
/** Ports tried after the configured one is taken (loopback only). */
export const GATEWAY_FALLBACK_PORT_COUNT = 10;

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
  gatewayPort: number;
  rewriteCallbackUrl: boolean;
  reportSessions: boolean;
};

export type HeadlessConfigResult =
  | { ok: true; config: HeadlessRunnerConfig }
  | { ok: false; errors: string[] };

const originSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => HTTP_PROTOCOL_RE.test(new URL(value).protocol), {
    message: "must be an http(s) URL",
  })
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
});

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
      workspaceDir: path.resolve(
        values[HeadlessRunnerEnv.Workspace] ?? DEFAULT_RUNNER_WORKSPACE
      ),
      dataDir: resolveRunnerDataDir(env),
      maxConcurrentCommands:
        values[HeadlessRunnerEnv.MaxConcurrent] ??
        DEFAULT_MAX_CONCURRENT_COMMANDS,
      gatewayPort:
        values[HeadlessRunnerEnv.GatewayPort] ?? DEFAULT_GATEWAY_PORT,
      rewriteCallbackUrl: values[HeadlessRunnerEnv.RewriteCallbackUrl] ?? true,
      reportSessions: values[HeadlessRunnerEnv.ReportSessions] ?? true,
    },
  };
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
