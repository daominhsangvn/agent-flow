import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type {
  IntegrationDeliveryMode,
  IntegrationFieldDescriptor,
  IntegrationRepository,
} from "@repo/api/src/types/integration";
import type { ProcessDocumentType } from "@repo/api/src/types/project-process";
import type {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import type { z } from "zod";

/**
 * Server-side contract every integration provider implements.
 *
 * A provider is a plain object (see defineIntegrationProvider) registered in
 * ./registry.ts. The workflow engine only talks to providers through this
 * contract: it never imports a provider module directly, and providers never
 * touch the database. Everything a provider needs (decrypted credentials,
 * HTTP, the run being reported) is passed in.
 *
 * Adding an integration = a folder under ./providers/<key>/ exporting one
 * IntegrationProviderDefinition + one line in ./registry.ts.
 */

/** Identity the connection authenticates as. Used to recognise the "bot". */
export type IntegrationAccount = {
  /** Stable id in the source system (Jira accountId, ADO identity id, ...). */
  externalAccountId: string;
  displayName: string | null;
  /**
   * Other strings the source system uses for the same identity (ADO
   * uniqueName/email, Jira Data Center username, ...). Matched
   * case-insensitively when recognising assignment to the bot.
   */
  aliases: string[];
  /** Provider-specific extras (cloudId, organization name, ...). */
  details: JsonObject;
};

/** Decrypted, validated view of a connection handed to provider code. */
export type ConnectionRuntime<TConfig = JsonObject, TSecrets = JsonObject> = {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  config: TConfig;
  secrets: TSecrets;
  account: IntegrationAccount | null;
};

export const HttpMethod = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export type ProviderHttpRequest = {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON (content-type set automatically); strings as-is. */
  body?: string | JsonValue;
  /** Defaults to 15s. */
  timeoutMs?: number;
  /**
   * Defaults to true. Set false when the URL comes from untrusted input (e.g. a
   * callback URL sent with an inbound webhook) so a redirect cannot steer the
   * request somewhere else; a 3xx then comes back as a non-ok response.
   */
  followRedirects?: boolean;
};

/**
 * Never thrown: transport failures come back as ok=false with status 0.
 * retryable is true for timeouts, network errors, 408, 425, 429 and 5xx.
 */
export type ProviderHttpResponse = {
  ok: boolean;
  status: number;
  headers: Headers;
  text: string;
  /** Parsed body when the response is JSON, otherwise undefined. */
  json: unknown;
  error: string | null;
  retryable: boolean;
};

export type ProviderHttp = {
  request(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
};

export type ProviderLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

export type ProviderContext<TConfig = JsonObject, TSecrets = JsonObject> = {
  connection: ConnectionRuntime<TConfig, TSecrets>;
  http: ProviderHttp;
  log: ProviderLogger;
  now(): Date;
};

export const ValidateConnectionReason = {
  /** Saving the connection: must not have visible side effects. */
  Save: "save",
  /** The admin pressed "Test": may post a test message. */
  Test: "test",
} as const;
export type ValidateConnectionReason =
  (typeof ValidateConnectionReason)[keyof typeof ValidateConnectionReason];

export type ValidateConnectionResult<TConfig = JsonObject> =
  | {
      ok: true;
      account: IntegrationAccount | null;
      /** Normalized config to persist instead of the submitted one (e.g. trimmed site URL). */
      config?: TConfig;
    }
  | { ok: false; error: string };

/** Reference to the item in the source system that a run works on. */
export type SourceItemRef = {
  provider: string;
  /** Immutable id (Jira issue id, ADO work item id, payload id). */
  externalId: string;
  /** Human key shown to users (PROJ-123, #4567). */
  key: string;
  url: string | null;
  title: string | null;
  /** Grouping in the source system (Jira project key, ADO project name). */
  container: string | null;
};

export type SourceItemComment = {
  author: string | null;
  createdAt: string | null;
  bodyMarkdown: string;
};

export type SourceItemAttachment = {
  name: string;
  url: string | null;
  mimeType: string | null;
  size: number | null;
};

/** Full item content, normalized to markdown, that becomes the issue document. */
export type SourceItem = SourceItemRef & {
  title: string;
  bodyMarkdown: string;
  itemType: string | null;
  status: string | null;
  priority: string | null;
  labels: string[];
  reporter: string | null;
  assignee: string | null;
  /** Extra labelled sections, e.g. Acceptance Criteria, Repro Steps. */
  sections: Array<{ title: string; markdown: string }>;
  comments: SourceItemComment[];
  attachments: SourceItemAttachment[];
};

export type InboundEventAttributeValue =
  | string
  | string[]
  | number
  | boolean
  | null;

/**
 * One normalized occurrence from a source system. Produced by webhook
 * parsing, polling and manual runs alike, so the engine treats them the same.
 */
export type InboundEvent = {
  /** Trigger type key this event satisfies, e.g. "jira.issue_assigned". */
  triggerType: string;
  /**
   * Stable id of the logical occurrence, identical whether it arrives by
   * webhook or by polling (e.g. "PROJ-1:assignee:10234" from the changelog id).
   * A workflow starts at most one run per dedupKey.
   */
  dedupKey: string;
  occurredAt: Date;
  /** Who caused the event. Providers drop events caused by the bot itself. */
  actor: { id: string; displayName: string | null } | null;
  item: SourceItemRef;
  /** Values trigger filters match on (projectKey, issueType, labels, areaPath, ...). */
  attributes: Record<string, InboundEventAttributeValue>;
  /**
   * Request data worth handing back to actions (generic webhooks: callbackUrl,
   * metadata). Stored on the run and exposed as WorkflowRunSnapshot.sourceExtras.
   */
  extras?: JsonObject;
  /**
   * Full item content when the event carries it (generic webhooks). When set,
   * the engine uses it instead of calling source.fetchItem.
   */
  inlineItem?: SourceItem;
};

export type InboundRequest = {
  rawBody: string;
  headers: Headers;
  url: URL;
};

export type InboundVerification = { ok: true } | { ok: false; reason: string };

export type InboundParseResult = {
  /** Provider delivery id used for delivery de-duplication (e.g. X-Atlassian-Webhook-Identifier). */
  deliveryId: string;
  eventType: string | null;
  events: InboundEvent[];
  /** Why nothing was produced (unsupported event, caused by the bot, ...). Logged on the delivery. */
  ignoredReason?: string;
};

export type InboundSecretContext<TConfig = JsonObject> = {
  connection: Pick<
    ConnectionRuntime<TConfig>,
    "id" | "provider" | "name" | "config" | "account"
  >;
  inboundSecret: string;
};

export type InboundSetupContext<TConfig = JsonObject> =
  InboundSecretContext<TConfig> & {
    inboundUrl: string;
    deliveryMode: IntegrationDeliveryMode;
  };

export type PollResult = {
  events: InboundEvent[];
  /** Persisted and handed back on the next poll. */
  cursor: JsonValue;
};

export type IntegrationInboundDefinition<TConfig, TSecrets> = {
  /** Supported modes besides "none". */
  deliveryModes: IntegrationDeliveryMode[];
  /** Defaults to 32 random bytes, base64url. */
  generateSecret?: () => string;
  /** Markdown shown to the admin next to the inbound URL and secret. */
  setupInstructions(context: InboundSetupContext<TConfig>): string;
  /** Required for webhook mode. Must be constant-time. */
  verify?(
    request: InboundRequest,
    context: InboundSecretContext<TConfig>
  ): InboundVerification;
  /** Required for webhook mode. Called only after verify succeeded. */
  parse?(
    request: InboundRequest,
    context: ProviderContext<TConfig, TSecrets>
  ): Promise<InboundParseResult>;
  /** Required for poll mode. A null cursor means first poll: return no backlog older than a few minutes. */
  poll?(
    context: ProviderContext<TConfig, TSecrets>,
    cursor: JsonValue | null
  ): Promise<PollResult>;
};

/**
 * Thrown by source.fetchItem (or resolveManual) when the failure is temporary:
 * rate limited, 5xx, timeout, network error. The engine retries the import with
 * backoff instead of failing the run. Any other error fails the run.
 */
export class RetryableSourceError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "RetryableSourceError";
  }
}

export type IntegrationSourceDefinition<TConfig, TSecrets> = {
  /** Load the canonical item; webhook payloads are treated as hints only. Throw on failure. */
  fetchItem(
    context: ProviderContext<TConfig, TSecrets>,
    ref: SourceItemRef
  ): Promise<SourceItem>;
  /**
   * Build an event from user input for a manual run (an issue key, a work
   * item id, a JSON payload). The engine makes the dedupKey unique.
   * Throw an Error with a user-facing message when the input is invalid.
   */
  resolveManual?(
    context: ProviderContext<TConfig, TSecrets>,
    input: string,
    triggerType: string
  ): Promise<InboundEvent>;
};

export type IntegrationTriggerDefinition<
  TConfig = unknown,
  TConnectionConfig = JsonObject,
> = {
  key: string;
  displayName: string;
  description: string;
  configSchema: z.ZodType<TConfig>;
  configFields: IntegrationFieldDescriptor[];
  /** Label/placeholder for manual runs; requires source.resolveManual. */
  manualRun?: { label: string; placeholder: string };
  /** Filters an event of this trigger type against the trigger's config. */
  matches(
    event: InboundEvent,
    config: TConfig,
    connection: ConnectionRuntime<TConnectionConfig>
  ): boolean;
};

/** What a post action knows about the run it reports on. */
/** A run's current process step, as actions see it. */
export type WorkflowRunStepSnapshot = {
  id: string;
  name: string;
  /** Questions the step waits on, when it waits for answers. */
  questions: string[];
  /** The step is an approval waiting for a decision. */
  awaitingApproval: boolean;
};

export type WorkflowRunSnapshot = {
  id: string;
  url: string;
  status: WorkflowRunStatus;
  event: WorkflowRunEvent;
  workflow: { id: string; name: string };
  /** Trigger that started the run; null for runs whose trigger was deleted. */
  trigger: { id: string; type: string; connectionId: string } | null;
  source: SourceItemRef;
  /** InboundEvent.extras of the event that started (or resumed) the run. */
  sourceExtras: JsonObject;
  feature: { id: string; title: string; url: string } | null;
  plan: {
    id: string;
    title: string;
    url: string;
    excerpt: string | null;
    openQuestions: string[];
  } | null;
  /** The run's pull request: the first one opened ({{pr.url}}). */
  pullRequest: {
    url: string;
    number: number | null;
    branch: string | null;
  } | null;
  /** Every pull request opened for the run, one per repository. */
  pullRequests: RunPullRequest[];
  /**
   * The project repositories the agent team works in, recorded when EXECUTE
   * is launched, each with the branch it pushed once EXECUTE has run. Actions
   * that open pull requests or start pipelines act on them through the
   * connection that owns them (`connectionId`).
   */
  repositories: RunRepositorySnapshot[];
  /**
   * The first repository the agent team pushed to (else the first one), for
   * the {{repository.*}} variables.
   */
  repository: RunRepositorySnapshot | null;
  error: { code: string; message: string } | null;
  /**
   * The project process step the run is in; null on the built-in AgentFlow
   * flow and for pre actions.
   */
  step: WorkflowRunStepSnapshot | null;
  /**
   * The reply file of the run's process (AgentProcessStep.reply) from the
   * latest step that wrote one, e.g. an answer to post on the ticket.
   */
  reply: string | null;
  /** Each step's reply by step id, as {{steps.<id>.reply}}. */
  stepReplies: Record<string, string>;
  /**
   * Documents the process steps published (AgentProcessStep.document), as
   * {{steps.<id>.document.url}} and {{steps.<id>.document.title}}.
   */
  documents: WorkflowRunDocumentSnapshot[];
  /** Ready-made markdown describing the event; the default action message. */
  summaryMarkdown: string;
  startedAt: string;
  completedAt: string | null;
};

/** Results an action reports back to the run, e.g. the pull requests it opened. */
export type ActionOutputs = {
  pullRequests?: Array<{
    /** RunRepositorySnapshot.id of the repository the pull request is in. */
    repositoryId: string;
    url: string;
    number: number;
    branch: string;
  }>;
};

export type ActionResult =
  | {
      status: "succeeded";
      externalRef?: string;
      detail?: string;
      outputs?: ActionOutputs;
    }
  | { status: "skipped"; reason: string }
  | {
      status: "failed";
      error: string;
      retryable: boolean;
      /** What the action did before it failed, e.g. pull requests it opened. */
      outputs?: ActionOutputs;
    };

export type ActionContext<TConfig, TConnectionConfig, TSecrets> =
  ProviderContext<TConnectionConfig, TSecrets> & {
    config: TConfig;
    run: WorkflowRunSnapshot;
    /** Stable across retries of this action run (use it as an idempotency key). */
    actionRunId: string;
    /** 1 on the first attempt. */
    attempt: number;
    /** Renders {{variables}} (see WORKFLOW_TEMPLATE_VARIABLES) against the run. */
    render(template: string): string;
  };

export type IntegrationActionDefinition<
  TConfig = unknown,
  TConnectionConfig = JsonObject,
  TSecrets = JsonObject,
> = {
  key: string;
  displayName: string;
  description: string;
  configSchema: z.ZodType<TConfig>;
  configFields: IntegrationFieldDescriptor[];
  defaultEvents: WorkflowRunEvent[];
  /** Must not throw; map every failure to an ActionResult. */
  execute(
    context: ActionContext<TConfig, TConnectionConfig, TSecrets>
  ): Promise<ActionResult>;
};

export type IntegrationProviderDefinition<
  TConfig = JsonObject,
  TSecrets = JsonObject,
> = {
  /** Lowercase, matches /^[a-z][a-z0-9_]{1,31}$/. Prefix of every trigger/action key. */
  key: string;
  displayName: string;
  description: string;
  docsUrl?: string;
  connection: {
    configSchema: z.ZodType<TConfig>;
    secretsSchema: z.ZodType<TSecrets>;
    /** Config and secret fields in display order; secret fields use kind "secret". */
    fields: IntegrationFieldDescriptor[];
    /**
     * Config fields that decide WHERE the stored credentials are sent (e.g. the
     * Jira site URL). Changing one requires the secret fields to be submitted
     * again in the same request, so stored credentials are never sent to a new
     * host the admin did not authenticate against.
     */
    credentialOriginFields?: string[];
    /**
     * Check credentials against the source system and identify the account.
     * reason "test" may have visible side effects (Teams posts a test card);
     * "save" must not.
     */
    validate(
      context: ProviderContext<TConfig, TSecrets>,
      reason: ValidateConnectionReason
    ): Promise<ValidateConnectionResult<TConfig>>;
  };
  inbound?: IntegrationInboundDefinition<TConfig, TSecrets>;
  source?: IntegrationSourceDefinition<TConfig, TSecrets>;
  /**
   * Not offered in Settings → Connections: workflows use it through their
   * built-in HTTP trigger and HTTPS call (one managed connection per workflow).
   */
  builtIn?: boolean;
  /** Repositories projects can add from this connection (clone, push, pull requests). */
  repositories?: IntegrationRepositoriesDefinition<TConfig, TSecrets>;
  // biome-ignore lint/suspicious/noExplicitAny: trigger configs are heterogeneous; each definition is typed where it is written
  triggers: IntegrationTriggerDefinition<any, TConfig>[];
  // biome-ignore lint/suspicious/noExplicitAny: action configs are heterogeneous; each definition is typed where it is written
  actions: IntegrationActionDefinition<any, TConfig, TSecrets>[];
};

/** Identity helpers that keep the generic parameters inferred at the definition site. */
export function defineIntegrationProvider<TConfig, TSecrets>(
  definition: IntegrationProviderDefinition<TConfig, TSecrets>
): IntegrationProviderDefinition<TConfig, TSecrets> {
  return definition;
}

export function defineTrigger<TConfig, TConnectionConfig = JsonObject>(
  definition: IntegrationTriggerDefinition<TConfig, TConnectionConfig>
): IntegrationTriggerDefinition<TConfig, TConnectionConfig> {
  return definition;
}

export function defineAction<
  TConfig,
  TConnectionConfig = JsonObject,
  TSecrets = JsonObject,
>(
  definition: IntegrationActionDefinition<TConfig, TConnectionConfig, TSecrets>
): IntegrationActionDefinition<TConfig, TConnectionConfig, TSecrets> {
  return definition;
}

/** A repository as its provider describes it, including how to clone it over HTTPS. */
export type RepositoryInfo = IntegrationRepository & { cloneUrl: string };

/** Git-over-HTTPS credential for one repository, issued for one loop. */
export type GitCredential = {
  username: string;
  password: string;
  /** Null when the credential lives as long as the connection's token. */
  expiresAt: Date | null;
};

export type PullRequestRequest = {
  repository: RepositoryInfo;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft: boolean;
};

export type CreateRepositoryRequest = {
  name: string;
  description: string;
  isPrivate: boolean;
};

export type CreatedPullRequest = {
  url: string;
  number: number;
  externalId: string;
  /** True when a pull request for the branch already existed and was reused. */
  existing: boolean;
};

export type RepositoryOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable: boolean };

export type IntegrationRepositoriesDefinition<TConfig, TSecrets> = {
  /**
   * Repositories the connection can access, matching `query` (name filter)
   * when given. Throw an Error with a user-facing message on failure.
   */
  list(
    context: ProviderContext<TConfig, TSecrets>,
    options: { query: string | null; limit: number }
  ): Promise<RepositoryInfo[]>;
  /** One repository by its provider id, or null when it is gone or inaccessible. */
  get(
    context: ProviderContext<TConfig, TSecrets>,
    externalId: string
  ): Promise<RepositoryInfo | null>;
  /** Credential for cloning and pushing the repository over HTTPS. */
  gitCredential(
    context: ProviderContext<TConfig, TSecrets>,
    repository: RepositoryInfo
  ): Promise<GitCredential>;
  /** Opens a pull request, or returns the open one for the same source branch. */
  createPullRequest(
    context: ProviderContext<TConfig, TSecrets>,
    request: PullRequestRequest
  ): Promise<RepositoryOperationResult<CreatedPullRequest>>;
  /**
   * Creates a repository, with a first commit on its default branch, where
   * the connection keeps new repositories. Only providers that host the
   * repositories themselves offer it (Local Git).
   */
  create?(
    context: ProviderContext<TConfig, TSecrets>,
    request: CreateRepositoryRequest
  ): Promise<RepositoryOperationResult<RepositoryInfo>>;
};

/** A repository of the run as actions see it (WorkflowRunSnapshot.repositories). */
export type RunRepositorySnapshot = {
  /** ProjectRepository id. */
  id: string;
  connectionId: string;
  provider: string;
  externalId: string;
  fullName: string;
  webUrl: string;
  cloneUrl: string;
  defaultBranch: string | null;
  /** Branch the agent team pushed; null until EXECUTE completed. */
  branch: string | null;
  /** Branch the work is based on (pull request target). */
  baseBranch: string;
  /** Pull request an action opened from `branch`; null until then. */
  pullRequest: { url: string; number: number } | null;
};

/** A pull request opened for the run (WorkflowRunSnapshot.pullRequests). */
export type RunPullRequest = {
  url: string;
  number: number | null;
  branch: string | null;
  /** Full name of the repository it is in. */
  repository: string;
};

/** A document a process step published, with its absolute link. */
export type WorkflowRunDocumentSnapshot = {
  stepId: string;
  type: ProcessDocumentType;
  title: string;
  url: string;
};
