import { randomBytes } from "node:crypto";
import {
  type CreateIntegrationConnectionInput,
  type IntegrationConnection,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { type Mock, vi } from "vitest";
import { z } from "zod";
import type { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  defineIntegrationProvider,
  type IntegrationAccount,
  type ProviderContext,
} from "@/lib/integrations/types";
import { resetSecretEncryptionKeyForTests } from "@/lib/secret-encryption";
import { connectionDbFake } from "./connection-db.test-fake";

/**
 * Shared fixtures for the connection-service suites: two fake providers
 * (one with webhook + poll inbound, one outbound-only), the registry lookup
 * the suites mock `@/lib/integrations/registry` with, and helpers that create
 * connections through the real service against the in-memory DB fake.
 */

export const ORG_ID = "org-1";
export const OTHER_ORG_ID = "org-2";
export const USER_ID = "user-1";
export const API_TOKEN = "tok_live_1234567890WXYZ";
export const SECOND_TOKEN = "tok_live_abcdefghij9876";
export const SHORT_TOKEN = "short";
export const PROVIDER_INBOUND_SECRET = "provider-generated-inbound-secret";
export const SITE_URL = "https://example.atlassian.net";
export const MISSING_ID = "0199a5f0-0000-7000-8000-000000000000";
export const PUBLIC_WEBHOOK_BASE = "https://hooks.example.test";

export const BOT_ACCOUNT: IntegrationAccount = {
  externalAccountId: "bot-1",
  displayName: "AgentFlow Bot",
  aliases: ["bot@example.test"],
  details: { cloudId: "cloud-1" },
};

/** The fake provider's validate(); reset to a succeeding implementation per test. */
export const validateMock: Mock = vi.fn();

export const fakeProvider = defineIntegrationProvider({
  key: "fake",
  displayName: "Fake Tracker",
  description: "Test provider with webhook and poll delivery",
  connection: {
    configSchema: z.object({
      siteUrl: z.url(),
      project: z.string().optional(),
    }),
    secretsSchema: z.object({
      apiToken: z.string().min(1),
      extraToken: z.string().optional(),
    }),
    fields: [
      {
        key: "siteUrl",
        label: "Site URL",
        kind: IntegrationFieldKind.Url,
        required: true,
      },
      { key: "project", label: "Project", kind: IntegrationFieldKind.Text },
      {
        key: "apiToken",
        label: "API token",
        kind: IntegrationFieldKind.Secret,
        required: true,
      },
      {
        key: "extraToken",
        label: "Extra token",
        kind: IntegrationFieldKind.Secret,
      },
    ],
    // The stored tokens are only ever sent to this site.
    credentialOriginFields: ["siteUrl"],
    validate: validateMock,
  },
  inbound: {
    deliveryModes: [
      IntegrationDeliveryMode.Webhook,
      IntegrationDeliveryMode.Poll,
    ],
    generateSecret: () => PROVIDER_INBOUND_SECRET,
    setupInstructions: (context) =>
      `Send ${context.deliveryMode} events for ${context.connection.name} to ${context.inboundUrl}`,
    verify: () => ({ ok: true }),
    parse: () =>
      Promise.resolve({
        deliveryId: "delivery-1",
        eventType: null,
        events: [],
      }),
    poll: () => Promise.resolve({ events: [], cursor: null }),
  },
  triggers: [],
  actions: [],
});

export const outboundProvider = defineIntegrationProvider({
  key: "outbound",
  displayName: "Outbound Only",
  description: "Test provider without an inbound side",
  connection: {
    configSchema: z.object({}),
    secretsSchema: z.object({ webhookUrl: z.url() }),
    fields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        kind: IntegrationFieldKind.Secret,
        required: true,
      },
    ],
    validate: () => Promise.resolve({ ok: true, account: null }),
  },
  triggers: [],
  actions: [],
});

/** Providers the mocked registry serves; tests may remove or replace entries. */
export const testProviders = new Map<string, unknown>();

export function getTestProvider(key: string): unknown {
  return testProviders.get(key) ?? null;
}

/** beforeEach: fresh DB fake, providers, env and a succeeding validate(). */
export function resetConnectionServiceFixtures(): void {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("PUBLIC_WEBHOOK_BASE_URL", `${PUBLIC_WEBHOOK_BASE}/`);
  resetSecretEncryptionKeyForTests();
  connectionDbFake.reset();
  testProviders.clear();
  testProviders.set(fakeProvider.key, fakeProvider);
  testProviders.set(outboundProvider.key, outboundProvider);
  validateMock.mockImplementation((context: ProviderContext) =>
    Promise.resolve({
      ok: true,
      account: BOT_ACCOUNT,
      config: { ...context.connection.config, project: "NORMALIZED" },
    })
  );
}

/** afterEach counterpart of resetConnectionServiceFixtures. */
export function restoreConnectionServiceEnv(): void {
  vi.unstubAllEnvs();
  resetSecretEncryptionKeyForTests();
}

export function baseInput(): CreateIntegrationConnectionInput {
  return {
    provider: fakeProvider.key,
    name: "Jira Cloud",
    config: { siteUrl: SITE_URL },
    secrets: { apiToken: API_TOKEN },
    deliveryMode: IntegrationDeliveryMode.Webhook,
    pollIntervalSeconds: 120,
  };
}

/** Creates a fake-provider connection through the real service. */
export async function createTestConnection(
  service: typeof integrationConnectionService,
  overrides: Partial<CreateIntegrationConnectionInput> = {},
  organizationId = ORG_ID
): Promise<IntegrationConnection> {
  const result = await service.create(organizationId, USER_ID, {
    ...baseInput(),
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`create failed: ${result.error.message}`);
  }
  return result.value;
}

/** Creates an outbound-only connection (no inbound side, delivery "none"). */
export async function createOutboundTestConnection(
  service: typeof integrationConnectionService
): Promise<IntegrationConnection> {
  return await createTestConnection(service, {
    provider: outboundProvider.key,
    config: {},
    secrets: { webhookUrl: "https://teams.example.test/hook/abcdef" },
    deliveryMode: IntegrationDeliveryMode.None,
  });
}

export function deliveryRow(
  connectionId: string,
  deliveryId: string,
  receivedAt: string
) {
  return {
    id: `row-${deliveryId}`,
    organizationId: ORG_ID,
    connectionId,
    deliveryId,
    source: IntegrationDeliverySource.Webhook,
    eventType: "jira:issue_updated",
    outcome: IntegrationDeliveryOutcome.Accepted,
    detail: null,
    runCount: 1,
    payload: null,
    receivedAt: new Date(receivedAt),
  };
}

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("base64");
