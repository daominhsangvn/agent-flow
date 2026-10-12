import { ModelProviderMode } from "@repo/api/src/types/compute-target-model-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeTargetModelProviderService,
  resolveComputeTargetClaudeEnv,
} from "@/app/compute-targets/model-provider-service";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  owner: "0199a5f0-0000-7000-8000-0000000000a1",
  other: "0199a5f0-0000-7000-8000-0000000000a2",
  target: "0199a5f0-0000-7000-8000-0000000000c1",
};

const mocks = vi.hoisted(() => ({
  row: null as {
    organizationId: string;
    userId: string;
    modelProvider: unknown;
    modelProviderTokenEncrypted: string | null;
  } | null,
}));

vi.mock("@/lib/secret-encryption", () => ({
  SecretPurpose: { ComputeTargetModelToken: "compute-target-model-token" },
  encryptSecret: (value: string) => `sealed:${value}`,
  decryptSecret: (value: string) => {
    if (!value.startsWith("sealed:")) {
      throw new Error("bad seal");
    }
    return value.slice("sealed:".length);
  },
}));

vi.mock("@repo/database", () => {
  const matches = (where: { organizationId?: string; userId?: string }) =>
    mocks.row !== null &&
    (where.organizationId === undefined ||
      where.organizationId === mocks.row.organizationId) &&
    (where.userId === undefined || where.userId === mocks.row.userId);
  const db = {
    computeTarget: {
      findFirst: vi.fn(
        (args: { where: { organizationId: string; userId: string } }) =>
          Promise.resolve(matches(args.where) ? mocks.row : null)
      ),
      findUnique: vi.fn(() => Promise.resolve(mocks.row)),
      updateMany: vi.fn(
        (args: {
          where: { organizationId: string; userId: string };
          data: Record<string, unknown>;
        }) => {
          if (mocks.row && matches(args.where)) {
            Object.assign(mocks.row, args.data);
          }
          return Promise.resolve({ count: 1 });
        }
      ),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});

beforeEach(() => {
  mocks.row = {
    organizationId: IDS.org,
    userId: IDS.owner,
    modelProvider: null,
    modelProviderTokenEncrypted: null,
  };
});

const deepseek = {
  mode: ModelProviderMode.Custom,
  baseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-chat",
  env: {
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-lite",
  },
};

describe("computeTargetModelProviderService", () => {
  it("defaults to the computer's own Claude account", async () => {
    await expect(
      computeTargetModelProviderService.get(IDS.org, IDS.owner, IDS.target)
    ).resolves.toEqual({
      mode: ModelProviderMode.Machine,
      baseUrl: null,
      model: null,
      env: {},
      token: { isSet: false, lastFour: null },
    });
    await expect(resolveComputeTargetClaudeEnv(IDS.target)).resolves.toBeNull();
  });

  it("stores the token sealed and returns only its last four characters", async () => {
    const saved = await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      { ...deepseek, token: "sk-deepseek-1234" }
    );

    expect(saved?.token).toEqual({ isSet: true, lastFour: "1234" });
    expect(mocks.row?.modelProviderTokenEncrypted).toBe(
      "sealed:sk-deepseek-1234"
    );
    expect(JSON.stringify(saved)).not.toContain("sk-deepseek");
  });

  it("keeps the stored token when the update omits it and clears it in machine mode", async () => {
    await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      {
        ...deepseek,
        token: "sk-deepseek-1234",
      }
    );
    const kept = await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      deepseek
    );
    const machine = await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      { mode: ModelProviderMode.Machine, baseUrl: null, model: null, env: {} }
    );

    expect(kept?.token.isSet).toBe(true);
    expect(machine?.token.isSet).toBe(false);
    expect(mocks.row?.modelProviderTokenEncrypted).toBeNull();
  });

  it("lets only the owner read or change it", async () => {
    await expect(
      computeTargetModelProviderService.get(IDS.org, IDS.other, IDS.target)
    ).resolves.toBeNull();
    await expect(
      computeTargetModelProviderService.update(
        IDS.org,
        IDS.other,
        IDS.target,
        deepseek
      )
    ).resolves.toBeNull();
  });
});

describe("resolveComputeTargetClaudeEnv", () => {
  it("builds the Claude Code environment with the model filling unset model variables", async () => {
    await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      {
        ...deepseek,
        token: "sk-deepseek-1234",
      }
    );

    await expect(resolveComputeTargetClaudeEnv(IDS.target)).resolves.toEqual({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-deepseek-1234",
      ANTHROPIC_MODEL: "deepseek-chat",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-chat",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-chat",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-lite",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-chat",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    });
  });

  it("leaves out a token that can no longer be decrypted", async () => {
    await computeTargetModelProviderService.update(
      IDS.org,
      IDS.owner,
      IDS.target,
      deepseek
    );
    if (mocks.row) {
      mocks.row.modelProviderTokenEncrypted = "corrupt";
    }

    const env = await resolveComputeTargetClaudeEnv(IDS.target);

    expect(env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});
