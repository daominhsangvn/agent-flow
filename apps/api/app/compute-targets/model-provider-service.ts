import {
  ClaudeCodeVersionChannel,
  type ComputeTargetModelProvider,
  claudeCodeVersionSchema,
  MODEL_PROVIDER_MODEL_ENV_KEYS,
  ModelProviderMode,
  type UpdateComputeTargetModelProviderInput,
} from "@repo/api/src/types/compute-target-model-provider";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  SecretPurpose,
} from "@/lib/secret-encryption";

/**
 * Per compute target model provider (Settings → computers → Model provider).
 * The non-secret settings live in `compute_targets.model_provider`, the auth
 * token sealed in `model_provider_token_encrypted`. Only the target's owner
 * reads or changes them; every loop dispatched to the target carries the
 * resulting Claude Code environment and version
 * (`resolveComputeTargetClaudeRuntime`).
 */

const storedSettingsSchema = z.object({
  mode: z.enum(ModelProviderMode),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  // Settings saved before the version existed (or holding one the runner
  // would refuse) run the latest release instead of losing the provider.
  claudeCodeVersion: claudeCodeVersionSchema.catch(
    ClaudeCodeVersionChannel.Latest
  ),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;

const MACHINE_DEFAULT: StoredSettings = {
  mode: ModelProviderMode.Machine,
  baseUrl: null,
  model: null,
  env: {},
  claudeCodeVersion: ClaudeCodeVersionChannel.Latest,
};

/** What every loop dispatched to a compute target carries for Claude Code. */
export type ComputeTargetClaudeRuntime = {
  /** The model provider environment, or null for the computer's own account. */
  claudeEnv: Record<string, string> | null;
  /** `latest` or an exact release, installed by headless runners. */
  claudeCodeVersion: string;
};
const TOKEN_HINT_LENGTH = 4;

export const computeTargetModelProviderService = {
  /** Null when the target does not exist or the caller does not own it. */
  async get(
    organizationId: string,
    userId: string,
    computeTargetId: string
  ): Promise<ComputeTargetModelProvider | null> {
    const target = await findOwnedTarget(
      organizationId,
      userId,
      computeTargetId
    );
    return target
      ? toDto(readSettings(target.modelProvider), target.token)
      : null;
  },

  /** Null when the target does not exist or the caller does not own it. */
  async update(
    organizationId: string,
    userId: string,
    computeTargetId: string,
    input: UpdateComputeTargetModelProviderInput
  ): Promise<ComputeTargetModelProvider | null> {
    const target = await findOwnedTarget(
      organizationId,
      userId,
      computeTargetId
    );
    if (!target) {
      return null;
    }
    const settings: StoredSettings =
      input.mode === ModelProviderMode.Machine
        ? { ...MACHINE_DEFAULT, claudeCodeVersion: input.claudeCodeVersion }
        : {
            mode: ModelProviderMode.Custom,
            baseUrl: input.baseUrl,
            model: input.model || null,
            env: input.env,
            claudeCodeVersion: input.claudeCodeVersion,
          };
    const token = nextToken(input, target.token);
    await withDb((db) =>
      db.computeTarget.updateMany({
        where: { id: computeTargetId, organizationId, userId },
        data: {
          modelProvider: settings,
          modelProviderTokenEncrypted:
            token === null
              ? null
              : encryptSecret(token, SecretPurpose.ComputeTargetModelToken),
        },
      })
    );
    return toDto(settings, token);
  },
};

/**
 * Claude Code settings for loops on the target: the model provider
 * environment (null when it uses the computer's own Claude account) and the
 * Claude Code version. A token that can no longer be decrypted is left out
 * (and logged) rather than failing the loop launch.
 */
export async function resolveComputeTargetClaudeRuntime(
  computeTargetId: string
): Promise<ComputeTargetClaudeRuntime> {
  const target = await withDb((db) =>
    db.computeTarget.findUnique({
      where: { id: computeTargetId },
      select: { modelProvider: true, modelProviderTokenEncrypted: true },
    })
  );
  const settings = readSettings(target?.modelProvider);
  return {
    claudeEnv: buildClaudeEnv(
      computeTargetId,
      settings,
      target?.modelProviderTokenEncrypted ?? null
    ),
    claudeCodeVersion: settings.claudeCodeVersion,
  };
}

async function findOwnedTarget(
  organizationId: string,
  userId: string,
  computeTargetId: string
): Promise<{ modelProvider: Prisma.JsonValue; token: string | null } | null> {
  const target = await withDb((db) =>
    db.computeTarget.findFirst({
      where: { id: computeTargetId, organizationId, userId },
      select: { modelProvider: true, modelProviderTokenEncrypted: true },
    })
  );
  if (!target) {
    return null;
  }
  return {
    modelProvider: target.modelProvider,
    token: openToken(computeTargetId, target.modelProviderTokenEncrypted),
  };
}

function readSettings(value: unknown): StoredSettings {
  const parsed = storedSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : MACHINE_DEFAULT;
}

/** Keep the stored token unless the input sets or clears it; machine mode clears it. */
function nextToken(
  input: UpdateComputeTargetModelProviderInput,
  stored: string | null
): string | null {
  if (input.mode === ModelProviderMode.Machine) {
    return null;
  }
  return input.token === undefined ? stored : input.token;
}

function openToken(
  computeTargetId: string,
  sealed: string | null
): string | null {
  if (!sealed) {
    return null;
  }
  try {
    return decryptSecret(sealed, SecretPurpose.ComputeTargetModelToken);
  } catch (error) {
    log.warn("Could not decrypt a compute target's model provider token", {
      computeTargetId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function toDto(
  settings: StoredSettings,
  token: string | null
): ComputeTargetModelProvider {
  return {
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    model: settings.model,
    env: settings.env,
    token: {
      isSet: token !== null,
      lastFour: token ? token.slice(-TOKEN_HINT_LENGTH) : null,
    },
    claudeCodeVersion: settings.claudeCodeVersion,
  };
}

/** The model provider environment, or null for the computer's own account. */
function buildClaudeEnv(
  computeTargetId: string,
  settings: StoredSettings,
  sealedToken: string | null
): Record<string, string> | null {
  if (settings.mode !== ModelProviderMode.Custom || !settings.baseUrl) {
    return null;
  }
  const env: Record<string, string> = { ...settings.env };
  if (settings.model) {
    for (const key of MODEL_PROVIDER_MODEL_ENV_KEYS) {
      env[key] ??= settings.model;
    }
  }
  env.ANTHROPIC_BASE_URL = settings.baseUrl;
  const token = openToken(computeTargetId, sealedToken);
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  }
  return env;
}
