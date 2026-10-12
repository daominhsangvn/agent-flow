import { z } from "zod";
import type { JsonObject, JsonValue } from "./common";

/**
 * Generic integration connections (Jira, Azure DevOps, Microsoft Teams,
 * generic HTTPS webhooks, ...) and the provider catalog the web UI renders
 * from.
 *
 * Providers are registered in code (apps/api/lib/integrations/registry.ts).
 * The database only stores provider/trigger/action key strings plus
 * zod-validated config JSON, so adding a provider needs no migration and the
 * UI never hardcodes a provider's fields: it renders the field descriptors
 * served by GET /integrations/providers.
 *
 * Unrelated to the legacy per-provider tables (LinearIntegration,
 * SlackIntegration, GitHubInstallation, ...), which stay as they are.
 */

/**
 * Keys of the built-in providers. Provider keys are open strings on the wire
 * (a provider added later needs no contract change); use these constants
 * instead of literals when code refers to a specific built-in provider.
 */
export const IntegrationProviderKey = {
  Jira: "jira",
  AzureDevOps: "azure_devops",
  MicrosoftTeams: "microsoft_teams",
  Webhook: "webhook",
  GitHub: "github",
  Bitbucket: "bitbucket",
  LocalGit: "local_git",
} as const;
export type IntegrationProviderKey =
  (typeof IntegrationProviderKey)[keyof typeof IntegrationProviderKey];

export const IntegrationConnectionStatus = {
  Active: "active",
  Error: "error",
  Disabled: "disabled",
} as const;
export type IntegrationConnectionStatus =
  (typeof IntegrationConnectionStatus)[keyof typeof IntegrationConnectionStatus];

/**
 * How inbound events reach the platform for a connection.
 * - webhook: the source system POSTs to /webhooks/integrations/{inboundKey}
 * - poll: the in-process scheduler asks the source system for changes
 *   (works without a public URL, e.g. a self-hosted install behind NAT)
 * - none: the connection is only used for post actions
 */
export const IntegrationDeliveryMode = {
  Webhook: "webhook",
  Poll: "poll",
  None: "none",
} as const;
export type IntegrationDeliveryMode =
  (typeof IntegrationDeliveryMode)[keyof typeof IntegrationDeliveryMode];

/**
 * What a provider offers. The UI and the engine pick providers by capability:
 * workflow triggers, workflow actions (pre and post), and repositories that
 * projects can add (clone, push and pull requests through the connection).
 */
export const IntegrationCapability = {
  Triggers: "triggers",
  Actions: "actions",
  Repositories: "repositories",
  /** New repositories can be created through the connection (Local Git). */
  RepositoryCreation: "repository_creation",
} as const;
export type IntegrationCapability =
  (typeof IntegrationCapability)[keyof typeof IntegrationCapability];

/** Where an inbound delivery came from. */
export const IntegrationDeliverySource = {
  Webhook: "webhook",
  Poll: "poll",
  Manual: "manual",
} as const;
export type IntegrationDeliverySource =
  (typeof IntegrationDeliverySource)[keyof typeof IntegrationDeliverySource];

export const IntegrationDeliveryOutcome = {
  /** At least one workflow run was created. */
  Accepted: "accepted",
  /** Verified and parsed, but no enabled trigger matched. */
  Ignored: "ignored",
  /** Same delivery id seen before. */
  Duplicate: "duplicate",
  /** Processing failed after verification. */
  Error: "error",
} as const;
export type IntegrationDeliveryOutcome =
  (typeof IntegrationDeliveryOutcome)[keyof typeof IntegrationDeliveryOutcome];

/** Widget kinds the generic config form knows how to render. */
export const IntegrationFieldKind = {
  Text: "text",
  Textarea: "textarea",
  /** Write-only. Never echoed back; the API returns only isSet + lastFour. */
  Secret: "secret",
  Url: "url",
  Email: "email",
  Number: "number",
  Boolean: "boolean",
  Select: "select",
  MultiSelect: "multiselect",
  /** Free-form list of strings (tags input). */
  StringList: "string_list",
  /** Multi-line text with {{variable}} placeholders, see WORKFLOW_TEMPLATE_VARIABLES. */
  Template: "template",
} as const;
export type IntegrationFieldKind =
  (typeof IntegrationFieldKind)[keyof typeof IntegrationFieldKind];

export type IntegrationFieldOption = {
  value: string;
  label: string;
};

/**
 * Show the field only when another field of the same form has one of the
 * given values (e.g. the "email" field only for the Jira Cloud auth mode).
 */
export type IntegrationFieldCondition = {
  field: string;
  equals: string | boolean | string[];
};

export type IntegrationFieldDescriptor = {
  /** Property name in the config (or secrets) object. */
  key: string;
  label: string;
  kind: IntegrationFieldKind;
  required?: boolean;
  description?: string;
  placeholder?: string;
  defaultValue?: JsonValue;
  options?: IntegrationFieldOption[];
  showWhen?: IntegrationFieldCondition;
};

export type IntegrationTriggerSummary = {
  /** Globally unique trigger type key, prefixed by the provider key ("jira.issue_assigned"). */
  key: string;
  displayName: string;
  description: string;
  configFields: IntegrationFieldDescriptor[];
  /**
   * Present when a run can be started by hand from an item reference (e.g. a
   * Jira issue key). The UI shows an input with this label and placeholder.
   */
  manualRun: { label: string; placeholder: string } | null;
};

export type IntegrationActionSummary = {
  /** Globally unique action type key ("jira.add_comment"). */
  key: string;
  displayName: string;
  description: string;
  configFields: IntegrationFieldDescriptor[];
  /** Run events preselected when the action is added to a workflow. */
  defaultEvents: string[];
};

export type IntegrationProviderSummary = {
  key: string;
  displayName: string;
  description: string;
  docsUrl: string | null;
  /** Fields of the connection form. Secret fields have kind "secret". */
  connectionFields: IntegrationFieldDescriptor[];
  /**
   * Config fields that decide where the credentials are sent. When one of them
   * changes on edit, the secret fields must be entered again (the API rejects
   * the update otherwise).
   */
  credentialOriginFields: string[];
  /** Empty when the provider has no inbound side (post-action only). */
  deliveryModes: IntegrationDeliveryMode[];
  capabilities: IntegrationCapability[];
  /**
   * Not an integration to connect in Settings: workflows use it as their
   * built-in HTTP trigger and HTTPS call (the generic webhook).
   */
  builtIn: boolean;
  triggers: IntegrationTriggerSummary[];
  actions: IntegrationActionSummary[];
};

export type IntegrationProvidersResponse = {
  providers: IntegrationProviderSummary[];
};

export type IntegrationSecretFieldState = {
  isSet: boolean;
  lastFour: string | null;
};

/** Identity of the account the connection authenticates as (the "bot"). */
export type IntegrationAccountSummary = {
  externalAccountId: string;
  displayName: string | null;
};

export type IntegrationConnection = {
  /**
   * Set for a workflow's built-in HTTP endpoint: managed with that workflow
   * and hidden from Settings.
   */
  managedByWorkflowId: string | null;
  id: string;
  provider: string;
  name: string;
  status: IntegrationConnectionStatus;
  /** Non-secret config. Secret fields are never included. */
  config: JsonObject;
  secretFields: Record<string, IntegrationSecretFieldState>;
  account: IntegrationAccountSummary | null;
  deliveryMode: IntegrationDeliveryMode;
  pollIntervalSeconds: number;
  /** Absolute URL the source system must POST to; null when deliveryMode is not webhook. */
  inboundUrl: string | null;
  lastPolledAt: Date | null;
  lastDeliveryAt: Date | null;
  lastValidatedAt: Date | null;
  lastError: string | null;
  /** Number of workflow triggers and actions that use this connection. */
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type IntegrationConnectionsResponse = {
  connections: IntegrationConnection[];
};

/** Admin-only view of the inbound endpoint, including the shared secret. */
export type IntegrationInboundDetails = {
  inboundUrl: string;
  inboundSecret: string;
  /** Provider-written markdown telling the admin how to configure the source system. */
  setupInstructions: string;
};

export type IntegrationConnectionTestResult = {
  ok: boolean;
  account: IntegrationAccountSummary | null;
  error: string | null;
};

/**
 * A repository a connection can access (GET
 * /integrations/connections/{id}/repositories). `fullName` is the provider's
 * canonical path: `owner/repo` on GitHub, `organization/project/repo` on
 * Azure DevOps.
 */
export type IntegrationRepository = {
  externalId: string;
  fullName: string;
  name: string;
  /** GitHub owner, or Azure DevOps organization/project. */
  namespace: string;
  defaultBranch: string | null;
  webUrl: string;
  isPrivate: boolean;
};

export type IntegrationRepositoriesResponse = {
  repositories: IntegrationRepository[];
};

export const INTEGRATION_REPOSITORY_LIST_MAX = 100;

export const integrationRepositoriesQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INTEGRATION_REPOSITORY_LIST_MAX)
      .optional(),
  })
  .strict();
export type IntegrationRepositoriesQuery = z.infer<
  typeof integrationRepositoriesQuerySchema
>;

export const INTEGRATION_REPOSITORY_NAME_MAX = 100;
export const INTEGRATION_REPOSITORY_DESCRIPTION_MAX = 500;
const REPOSITORY_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * POST /integrations/connections/{id}/repositories: creates a repository
 * through a connection whose provider has the repository_creation capability.
 */
export const createIntegrationRepositoryInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter the repository name")
      .max(INTEGRATION_REPOSITORY_NAME_MAX)
      .regex(
        REPOSITORY_NAME_RE,
        "Use letters, digits, dots, dashes and underscores"
      ),
    description: z
      .string()
      .trim()
      .max(INTEGRATION_REPOSITORY_DESCRIPTION_MAX)
      .default(""),
    private: z.boolean().default(true),
  })
  .strict();
export type CreateIntegrationRepositoryInput = z.input<
  typeof createIntegrationRepositoryInputSchema
>;

export type IntegrationDelivery = {
  id: string;
  deliveryId: string;
  source: IntegrationDeliverySource;
  eventType: string | null;
  outcome: IntegrationDeliveryOutcome;
  detail: string | null;
  runCount: number;
  receivedAt: Date;
};

export type IntegrationDeliveriesResponse = {
  deliveries: IntegrationDelivery[];
};

export const INTEGRATION_NAME_MAX = 120;
export const INTEGRATION_POLL_INTERVAL_MIN_SECONDS = 60;
export const INTEGRATION_POLL_INTERVAL_MAX_SECONDS = 3600;
export const INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS = 120;

export const integrationDeliveryModeSchema = z.enum(IntegrationDeliveryMode);

/**
 * `config` holds non-secret values and `secrets` holds the secret ones, both
 * keyed by field descriptor key and validated by the provider's schemas.
 * On update, a secret omitted (or sent as null) keeps the stored value; an
 * empty string clears it.
 *
 * The field schemas carry no defaults so the update schema can be a plain
 * `.partial()` (zod 4 keeps inner defaults through `.partial()`, which would
 * turn a PATCH of one field into a reset of the others).
 */
const connectionFieldSchemas = {
  name: z.string().trim().min(1).max(INTEGRATION_NAME_MAX),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string().max(8192).nullable()),
  deliveryMode: integrationDeliveryModeSchema,
  pollIntervalSeconds: z
    .number()
    .int()
    .min(INTEGRATION_POLL_INTERVAL_MIN_SECONDS)
    .max(INTEGRATION_POLL_INTERVAL_MAX_SECONDS),
};

export const createIntegrationConnectionInputSchema = z.object({
  provider: z.string().min(1).max(32),
  name: connectionFieldSchemas.name,
  config: connectionFieldSchemas.config.default({}),
  secrets: connectionFieldSchemas.secrets.default({}),
  deliveryMode: connectionFieldSchemas.deliveryMode.default(
    IntegrationDeliveryMode.None
  ),
  pollIntervalSeconds: connectionFieldSchemas.pollIntervalSeconds.default(
    INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS
  ),
});
export type CreateIntegrationConnectionInput = z.infer<
  typeof createIntegrationConnectionInputSchema
>;

export const updateIntegrationConnectionInputSchema = z
  .object(connectionFieldSchemas)
  .partial()
  .extend({
    status: z
      .enum([
        IntegrationConnectionStatus.Active,
        IntegrationConnectionStatus.Disabled,
      ])
      .optional(),
  });
export type UpdateIntegrationConnectionInput = z.infer<
  typeof updateIntegrationConnectionInputSchema
>;
