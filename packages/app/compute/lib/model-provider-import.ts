import {
  MODEL_PROVIDER_ENV_KEY_RE,
  MODEL_PROVIDER_MODEL_ENV_KEYS,
} from "@repo/api/src/types/compute-target-model-provider";
import { z } from "zod";

/**
 * Reads a Claude Code `settings.json` (or just its `env` object) pasted into
 * the model provider dialog: the base URL, token and model go to their own
 * fields, model names equal to the model are dropped (the model fills them),
 * the other Claude Code variables become custom variables, and anything else
 * is reported as ignored.
 */

export type ImportedModelProvider = {
  baseUrl: string | null;
  token: string | null;
  model: string | null;
  env: Array<{ key: string; value: string }>;
  ignoredKeys: string[];
};

const envMapSchema = z.record(z.string(), z.unknown());
const settingsSchema = z.looseObject({ env: envMapSchema.optional() });

export function importClaudeSettings(
  text: string
): ImportedModelProvider | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      error: "Paste valid JSON: a settings.json file or its env object.",
    };
  }
  const settings = settingsSchema.safeParse(json);
  const envMap =
    settings.success && settings.data.env
      ? settings.data.env
      : envMapSchema.safeParse(json).data;
  if (!envMap) {
    return { error: "No environment variables found." };
  }
  const values = Object.fromEntries(
    Object.entries(envMap).flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number"
        ? [[key, String(value)]]
        : []
    )
  );
  const model = values.ANTHROPIC_MODEL ?? null;
  const env: ImportedModelProvider["env"] = [];
  const ignoredKeys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (CONSUMED_KEYS.has(key)) {
      continue;
    }
    if (MODEL_PROVIDER_MODEL_ENV_KEYS.includes(key) && value === model) {
      continue;
    }
    if (MODEL_PROVIDER_ENV_KEY_RE.test(key)) {
      env.push({ key, value });
    } else {
      ignoredKeys.push(key);
    }
  }
  return {
    baseUrl: values.ANTHROPIC_BASE_URL ?? null,
    token: values.ANTHROPIC_AUTH_TOKEN ?? values.ANTHROPIC_API_KEY ?? null,
    model,
    env,
    ignoredKeys,
  };
}

const CONSUMED_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
]);
