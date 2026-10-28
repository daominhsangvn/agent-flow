import { z } from "zod";

/**
 * Model provider of a compute target (a desktop computer or a headless
 * runner): which endpoint Claude Code talks to when loops run there.
 *
 * - `machine`: the Claude account configured on the computer itself (a
 *   subscription login, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...).
 * - `custom`: an Anthropic-compatible endpoint such as DeepSeek, set per loop
 *   as ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (+ model names and other
 *   Claude Code variables). The token is stored sealed by the API and sent to
 *   the computer with each loop; it is never returned to the browser.
 */

export const ModelProviderMode = {
  Machine: "machine",
  Custom: "custom",
} as const;
export type ModelProviderMode =
  (typeof ModelProviderMode)[keyof typeof ModelProviderMode];

/**
 * Environment variables a provider may set for Claude Code. Anything else
 * (PATH, LD_PRELOAD, NODE_OPTIONS, ...) is refused by the API and again by
 * the computer.
 */
export const MODEL_PROVIDER_ENV_KEY_RE =
  /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|DISABLE_[A-Z0-9_]+|API_TIMEOUT_MS|MAX_THINKING_TOKENS|MAX_MCP_OUTPUT_TOKENS|BASH_DEFAULT_TIMEOUT_MS|BASH_MAX_TIMEOUT_MS)$/;

/** Set through the dedicated fields (base URL, token), never through `env`. */
export const MODEL_PROVIDER_RESERVED_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/** Variables the "Model" field fills, unless `env` sets them explicitly. */
export const MODEL_PROVIDER_MODEL_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

export const MODEL_PROVIDER_ENV_MAX = 30;
const ENV_VALUE_MAX = 4096;

/**
 * Claude Code version a headless runner runs loops with: `latest`, looked up
 * when each loop starts, or an exact release. The runner installs a missing
 * version with Claude Code's native installer; the desktop app keeps its own
 * `claude`.
 */
export const ClaudeCodeVersionChannel = {
  Latest: "latest",
} as const;
export type ClaudeCodeVersionChannel =
  (typeof ClaudeCodeVersionChannel)[keyof typeof ClaudeCodeVersionChannel];

/** An exact Claude Code release such as `2.1.296` (no path separators). */
export const CLAUDE_CODE_RELEASE_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const CLAUDE_CODE_VERSION_MAX = 64;

export const claudeCodeVersionSchema = z
  .string()
  .trim()
  .max(CLAUDE_CODE_VERSION_MAX)
  .refine(
    (value) =>
      value === ClaudeCodeVersionChannel.Latest ||
      CLAUDE_CODE_RELEASE_RE.test(value),
    "Use latest or a version such as 2.1.296"
  );

export type ComputeTargetModelProvider = {
  mode: ModelProviderMode;
  baseUrl: string | null;
  model: string | null;
  /** Additional non-secret Claude Code variables. */
  env: Record<string, string>;
  token: { isSet: boolean; lastFour: string | null };
  /** `latest` or an exact release; applies to headless runners only. */
  claudeCodeVersion: string;
};

/** Environment sent to the computer with a loop (the computer re-checks the keys). */
export const modelProviderEnvSchema = z
  .record(
    z.string().regex(MODEL_PROVIDER_ENV_KEY_RE, "Unsupported variable"),
    z.string().max(ENV_VALUE_MAX)
  )
  .refine(
    (env) => Object.keys(env).length <= MODEL_PROVIDER_ENV_MAX + 8,
    "Too many variables"
  );

export const updateComputeTargetModelProviderInputSchema = z
  .object({
    mode: z.enum(ModelProviderMode),
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .nullable()
      .default(null),
    model: z.string().trim().max(200).nullable().default(null),
    env: z.record(z.string(), z.string().max(ENV_VALUE_MAX)).default({}),
    /** Omitted: keep the stored token. Null: remove it. */
    token: z.string().trim().min(1).max(ENV_VALUE_MAX).nullable().optional(),
    claudeCodeVersion: claudeCodeVersionSchema.default(
      ClaudeCodeVersionChannel.Latest
    ),
  })
  .superRefine((input, ctx) => {
    if (input.mode === ModelProviderMode.Custom && !input.baseUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Enter the base URL of the Anthropic-compatible API",
      });
    }
    const keys = Object.keys(input.env);
    const unsupported = keys.filter(
      (key) => !MODEL_PROVIDER_ENV_KEY_RE.test(key)
    );
    if (unsupported.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["env"],
        message: `Not a Claude Code variable: ${unsupported.join(", ")}. Use ANTHROPIC_*, CLAUDE_CODE_*, DISABLE_* or the other documented Claude Code settings.`,
      });
    }
    if (keys.length > MODEL_PROVIDER_ENV_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["env"],
        message: `At most ${MODEL_PROVIDER_ENV_MAX} variables`,
      });
    }
    const reserved = keys.filter((key) =>
      MODEL_PROVIDER_RESERVED_ENV_KEYS.includes(key)
    );
    if (reserved.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["env"],
        message: `Set ${reserved.join(", ")} with the base URL and token fields`,
      });
    }
  });
export type UpdateComputeTargetModelProviderInput = z.infer<
  typeof updateComputeTargetModelProviderInputSchema
>;
