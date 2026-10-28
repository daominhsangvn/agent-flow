import {
  IntegrationDeliveryMode,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalGitActionType } from "@/lib/integrations/providers/local-git/constants";
import {
  findActionDefinition,
  findTriggerDefinition,
  getIntegrationProvider,
  isRepositoryScopedActionType,
  listIntegrationProviders,
  toProviderSummary,
} from "@/lib/integrations/registry";

/**
 * Structural checks every registered provider must pass. The web UI renders
 * forms from the field descriptors and the API validates with the zod
 * schemas, so the two must agree; trigger/action keys are stored in the
 * database and must stay globally unique and provider-prefixed.
 */

const PROVIDER_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
const RUN_EVENTS = new Set<string>(Object.values(WorkflowRunEvent));
const OPTION_KINDS = new Set<string>([
  IntegrationFieldKind.Select,
  IntegrationFieldKind.MultiSelect,
]);

const providers = listIntegrationProviders();
const providerCases = providers.map(
  (provider) => [provider.key, provider] as const
);

describe("integration provider registry", () => {
  it("registers every built-in provider under its key", () => {
    for (const key of Object.values(IntegrationProviderKey)) {
      expect(getIntegrationProvider(key)?.key).toBe(key);
    }
    expect(getIntegrationProvider("not_a_provider")).toBeNull();
  });

  it("uses well-formed, unique provider keys", () => {
    const keys = providers.map((provider) => provider.key);

    for (const key of keys) {
      expect(key).toMatch(PROVIDER_KEY_RE);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses globally unique trigger and action keys", () => {
    const triggerKeys = providers.flatMap((provider) =>
      provider.triggers.map((trigger) => trigger.key)
    );
    const actionKeys = providers.flatMap((provider) =>
      provider.actions.map((action) => action.key)
    );

    expect(new Set(triggerKeys).size).toBe(triggerKeys.length);
    expect(new Set(actionKeys).size).toBe(actionKeys.length);
  });

  it("tells a repository-scoped action type from any other by the type alone", () => {
    expect(
      isRepositoryScopedActionType(LocalGitActionType.CreatePullRequest)
    ).toBe(true);
    expect(
      isRepositoryScopedActionType("not_a_provider.create_pull_request")
    ).toBe(false);
  });

  describe.each(providerCases)("%s", (_key, provider) => {
    it("prefixes every trigger and action key with the provider key", () => {
      const keys = [
        ...provider.triggers.map((trigger) => trigger.key),
        ...provider.actions.map((action) => action.key),
      ];
      for (const key of keys) {
        expect(key.startsWith(`${provider.key}.`)).toBe(true);
        expect(key.length).toBeLessThanOrEqual(64);
      }
    });

    it("declares secret fields in secretsSchema and the others in configSchema", () => {
      const configKeys = objectShapeKeys(provider.connection.configSchema);
      const secretKeys = objectShapeKeys(provider.connection.secretsSchema);
      expect(configKeys, "configSchema must be a z.object").not.toBeNull();
      expect(secretKeys, "secretsSchema must be a z.object").not.toBeNull();

      for (const field of provider.connection.fields) {
        const schemaKeys =
          field.kind === IntegrationFieldKind.Secret ? secretKeys : configKeys;
        expect(schemaKeys, `connection field "${field.key}"`).toContain(
          field.key
        );
      }
    });

    it("declares trigger and action fields in their config schemas", () => {
      for (const definition of [...provider.triggers, ...provider.actions]) {
        const keys = objectShapeKeys(definition.configSchema);
        expect(
          keys,
          `${definition.key} configSchema must be a z.object`
        ).not.toBeNull();
        for (const field of definition.configFields) {
          expect(keys, `${definition.key} field "${field.key}"`).toContain(
            field.key
          );
        }
      }
    });

    it("uses unique field keys per form and gives choice fields options", () => {
      const forms = [
        provider.connection.fields,
        ...provider.triggers.map((trigger) => trigger.configFields),
        ...provider.actions.map((action) => action.configFields),
      ];
      for (const fields of forms) {
        const keys = fields.map((field) => field.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const field of fields.filter(isChoiceField)) {
          expect(
            field.options?.length,
            `options of "${field.key}"`
          ).toBeGreaterThan(0);
        }
      }
    });

    it("preselects only valid run events", () => {
      for (const action of provider.actions) {
        for (const event of action.defaultEvents) {
          expect(RUN_EVENTS, `${action.key} default event`).toContain(event);
        }
      }
    });

    it("implements the hooks its delivery modes need", () => {
      const inbound = provider.inbound;
      const modes = inbound?.deliveryModes ?? [];

      expect(modes).not.toContain(IntegrationDeliveryMode.None);
      if (modes.includes(IntegrationDeliveryMode.Webhook)) {
        expect(inbound?.verify).toBeTypeOf("function");
        expect(inbound?.parse).toBeTypeOf("function");
      }
      if (modes.includes(IntegrationDeliveryMode.Poll)) {
        expect(inbound?.poll).toBeTypeOf("function");
      }
    });

    it("offers manual runs only with a manual resolver", () => {
      for (const trigger of provider.triggers.filter(
        (item) => item.manualRun
      )) {
        expect(
          provider.source?.resolveManual,
          `${trigger.key} manual run`
        ).toBeTypeOf("function");
      }
    });

    it("is found through the registry lookups and summarized for the catalog", () => {
      for (const trigger of provider.triggers) {
        expect(findTriggerDefinition(provider.key, trigger.key)).toBe(trigger);
        expect(findTriggerDefinition("not_a_provider", trigger.key)).toBeNull();
      }
      for (const action of provider.actions) {
        expect(findActionDefinition(provider.key, action.key)).toBe(action);
        expect(findActionDefinition("not_a_provider", action.key)).toBeNull();
        expect(isRepositoryScopedActionType(action.key)).toBe(
          action.repositoryScoped ?? false
        );
      }

      const summary = toProviderSummary(provider);
      expect(summary.key).toBe(provider.key);
      expect(summary.connectionFields).toEqual(provider.connection.fields);
      expect(summary.deliveryModes).toEqual(
        provider.inbound?.deliveryModes ?? []
      );
      expect(summary.triggers.map((trigger) => trigger.key)).toEqual(
        provider.triggers.map((trigger) => trigger.key)
      );
      expect(summary.actions.map((action) => action.key)).toEqual(
        provider.actions.map((action) => action.key)
      );
      expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    });
  });
});

/**
 * Keys of a z.object schema, also through a `.transform()` pipe (the form
 * still submits the input shape). null for any other schema kind: the UI
 * could not know which fields it accepts.
 */
function objectShapeKeys(schema: z.ZodType): string[] | null {
  const objectSchema = schema instanceof z.ZodPipe ? schema.in : schema;
  return objectSchema instanceof z.ZodObject
    ? Object.keys(objectSchema.shape)
    : null;
}

function isChoiceField(field: IntegrationFieldDescriptor): boolean {
  return OPTION_KINDS.has(field.kind);
}
