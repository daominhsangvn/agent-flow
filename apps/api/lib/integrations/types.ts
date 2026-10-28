import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { SourceOperation } from "@repo/api/src/types/connection-grants";
import {
  type IntegrationDeliveryMode,
  type IntegrationFieldDescriptor,
  IntegrationOperationTarget,
  type IntegrationRepository,
} from "@repo/api/src/types/integration";
import type { ProcessDocumentType } from "@repo/api/src/types/project-process";
import type { Result } from "@repo/api/src/types/result";
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
  /**
   * The project connection's settings when the connection is used through
   * one (an action or agent tool with a project connection key), so an
   * operation can keep to them (Confluence `spaceKeys`); absent otherwise.
   */
  projectSettings?: JsonObject;
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
  /**
   * Objects are sent as JSON (content-type set automatically); strings as-is;
   * FormData as multipart (content-type with its boundary set by fetch).
   */
  body?: string | JsonValue | FormData;
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
  /** The provider's comment id, where the provider gives one. */
  id?: string | null;
  /** The comment this one replies to (a Jira comment thread); null: top level. */
  parentId?: string | null;
  author: string | null;
  createdAt: string | null;
  bodyMarkdown: string;
};

export type SourceItemLink = { url: string; title: string | null };

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
  /**
   * Emails of the reporter and assignee, where the provider shares them
   * (Jira hides them per the user's privacy setting); a workflow's runner
   * rules read them (`source.assignee_email`).
   */
  reporterEmail?: string | null;
  assigneeEmail?: string | null;
  /** Extra labelled sections, e.g. Acceptance Criteria, Repro Steps. */
  sections: Array<{ title: string; markdown: string }>;
  comments: SourceItemComment[];
  attachments: SourceItemAttachment[];
  /**
   * Web links on the item (Jira remote links, Azure DevOps Hyperlink
   * relations), e.g. the page its plan is reviewed on; absent when the
   * provider has none or they could not be read.
   */
  links?: SourceItemLink[];
};

/** What an occurrence on a source item signals to a waiting run. */
export type ReviewSignalFacts = { addedLabels: string[]; mentioned: boolean };

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
  /**
   * The comment or message that caused the event (a mention, a reply, a
   * Teams post), when the provider has it: what the project orchestrator
   * reads as the request (docs/orchestrator.md).
   */
  message?: InboundMessage;
  /**
   * A change of the item itself (its status, its labels): what the
   * orchestrator records as a ticket-change message.
   */
  itemChange?: InboundItemChange;
};

export type InboundMessage = {
  /** The provider's id of the comment or message. */
  id: string | null;
  /** The comment it replies to (a comment thread); null: top level. */
  parentId: string | null;
  /** Its text, as plain text or markdown. */
  text: string;
};

export type InboundItemChange = {
  status?: { from: string | null; to: string | null };
  labels?: { added: string[]; removed: string[] };
};

/** A message the project orchestrator posts on a source item. */
export type ItemReplyInput = {
  item: SourceItemRef;
  /** The comment to answer in the thread of; null: on the item. */
  parentId: string | null;
  /** Markdown. */
  text: string;
  /** What the inbound event left for answers (Teams: service URL, thread). */
  extras: JsonObject | null;
  /**
   * Files already attached to the item (the source's attachFile) that the
   * message shows below its text. Only providers with attachFile get any.
   */
  files?: SourceItemFile[];
};

/** A message of the project orchestrator to replace. */
export type ItemEditInput = {
  item: SourceItemRef;
  /** The provider's id of the message (what replyOnItem returned). */
  externalRef: string;
  /** Markdown. */
  text: string;
  extras: JsonObject | null;
};

export type ItemReplyResult =
  | { ok: true; externalRef: string | null }
  | { ok: false; error: string; retryable: boolean };

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

/**
 * What verify gets besides the inbound secret: HTTP for providers that check
 * a signed token against published keys (Teams: Bot Framework JWTs).
 */
export type InboundVerifyContext<TConfig = JsonObject> =
  InboundSecretContext<TConfig> & {
    http: ProviderHttp;
    now(): Date;
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
  /**
   * Required for webhook mode. Must be constant-time. Asynchronous only when
   * it needs the network (fetching signing keys).
   */
  verify?(
    request: InboundRequest,
    context: InboundVerifyContext<TConfig>
  ): InboundVerification | Promise<InboundVerification>;
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
  /**
   * An item of this connection from what a person or an agent wrote (an
   * issue key, a work item id or link), ready for fetchItem. Agents read
   * other items through it (connection_get_item); an error says what to
   * write instead.
   */
  parseItemReference?(
    config: TConfig,
    input: string
  ): Result<{ externalId: string; key: string }, string>;
  /**
   * Attach a file to the item (an agent's evidence for a comment); the
   * comment action then shows it through ActionContext.attachments. Absent:
   * the provider's comments take no files.
   */
  attachFile?(
    context: ProviderContext<TConfig, TSecrets>,
    ref: SourceItemRef,
    file: SourceItemFileUpload
  ): Promise<Result<SourceItemFile, SourceItemFileError>>;
  /**
   * Read the text of one file attached to the item, by its name (an agent's
   * `source_item_attachment_read`: the computer that runs the agent holds no
   * credentials). Absent: the provider's attachments are only links.
   */
  readAttachment?(
    context: ProviderContext<TConfig, TSecrets>,
    ref: SourceItemRef,
    name: string
  ): Promise<Result<SourceItemFileText, SourceItemFileError>>;
};

/** The text of a file attached to a source item. */
export type SourceItemFileText = {
  name: string;
  contentType: string | null;
  size: number | null;
  text: string;
};

/** A file to attach to a source item. */
export type SourceItemFileUpload = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

/** A file attached to a source item. */
export type SourceItemFile = {
  /** The provider's attachment id. */
  id: string;
  name: string;
  contentType: string;
};

export type SourceItemFileError = {
  /** User-facing, never containing credentials. */
  message: string;
  retryable: boolean;
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
  /** Labels (tags) on the source item that approve the waiting approval step. */
  approveLabels?: string[];
  /** The step waits for its review (AgentProcessStep.review); null otherwise. */
  review?: {
    round: number;
    planStep: boolean;
    goOnLabels: string[];
    feedbackLabels: string[];
    mention: boolean;
  } | null;
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
  /**
   * The release notes an implement step wrote (its latest round), as
   * {{releaseNotes}} and {{releaseNotes.url}}; null when none.
   */
  releaseNotes: { text: string; url: string } | null;
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
    /** The title the action gave the pull request (the Sessions page shows it). */
    title?: string;
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
    /**
     * Files already attached to the run's source item that a comment shows
     * (an agent's `source_item_comment` `attachments`); absent for workflow
     * actions.
     */
    attachments?: readonly SourceItemFile[];
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
  /**
   * Acts on the run's repositories through the connection that owns each one
   * (IntegrationActionSummary.repositoryScoped). Default false: the action
   * acts through one connection.
   */
  repositoryScoped?: boolean;
  /**
   * Acts on the run's source item through the run's source connection (a
   * comment, a transition), named by `sourceOperation` in a `source` grant.
   * Absent: external, or repository when repositoryScoped.
   */
  sourceOperation?: SourceOperation;
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
  /**
   * What a project connection of this provider configures (the source
   * containers the project works on). Without it a project connection has no
   * settings and claims no source items (Teams, repository providers).
   */
  // biome-ignore lint/suspicious/noExplicitAny: settings types are heterogeneous; each definition is typed where it is written
  project?: IntegrationProjectDefinition<TConfig, any>;
  inbound?: IntegrationInboundDefinition<TConfig, TSecrets>;
  source?: IntegrationSourceDefinition<TConfig, TSecrets>;
  /**
   * Not offered in Settings → Connections: workflows use it through their
   * built-in HTTP trigger and HTTPS call (one managed connection per workflow).
   */
  builtIn?: boolean;
  /**
   * What an inbound event tells a run waiting on the item for a review or an
   * approval (docs/workflows.md "Review loops"): the labels (tags) it added
   * and whether it mentions the bot. Only one event of an occurrence answers
   * (the "conditions" event), so each occurrence is at most one signal.
   */
  reviewSignal?: (event: InboundEvent) => ReviewSignalFacts | null;
  /**
   * The id of the comment an inbound event's comment replies to (a reply in
   * a comment thread); null when the event is no reply. The run waiting for
   * answers that posted that comment resumes with it, whatever the
   * workflow's triggers are (engine/answer-replies.ts).
   */
  answerReply?: (event: InboundEvent) => string | null;
  /**
   * Posts the project orchestrator's message on a source item
   * (docs/orchestrator.md): in the thread of `parentId` where the provider
   * has threads, else on the item. Must not throw.
   */
  replyOnItem?: (
    ctx: ProviderContext<TConfig, TSecrets>,
    input: ItemReplyInput
  ) => Promise<ItemReplyResult>;
  /**
   * Replaces the text of a message the project orchestrator posted (a newer
   * version of a plan it announced). Must not throw.
   */
  editOnItem?: (
    ctx: ProviderContext<TConfig, TSecrets>,
    input: ItemEditInput
  ) => Promise<ItemReplyResult>;
  /** Repositories projects can add from this connection (clone, push, pull requests). */
  repositories?: IntegrationRepositoriesDefinition<TConfig, TSecrets>;
  // biome-ignore lint/suspicious/noExplicitAny: trigger configs are heterogeneous; each definition is typed where it is written
  triggers: IntegrationTriggerDefinition<any, TConfig>[];
  // biome-ignore lint/suspicious/noExplicitAny: action configs are heterogeneous; each definition is typed where it is written
  actions: IntegrationActionDefinition<any, TConfig, TSecrets>[];
  /**
   * Reads agents may make through a project connection of this provider
   * (Confluence pages and comments), offered as `<provider>_<read>` tools to
   * every key granted `read` or any operation (docs/workflows.md
   * "Integration tools").
   */
  // biome-ignore lint/suspicious/noExplicitAny: read inputs are heterogeneous; each definition is typed where it is written
  reads?: IntegrationReadDefinition<any, TConfig, TSecrets>[];
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

/**
 * Project settings of a provider. A project connection claims the source
 * containers of its settings (Jira project keys, Azure DevOps projects) on
 * its connection's origin (site, organization). A claim belongs to one
 * project; its project connections (one per connection, i.e. per account)
 * may share it.
 */
export type IntegrationProjectDefinition<TConfig, TSettings> = {
  settingsSchema: z.ZodType<TSettings>;
  settingsFields: IntegrationFieldDescriptor[];
  /** The containers the settings claim, normalized like normalizeContainer. */
  containers(settings: TSettings): string[];
  /** A SourceItemRef.container as claims store it (Jira keys upper-case). */
  normalizeContainer(container: string): string;
  /** Where containers live: the same project key on another site is another claim. */
  origin(config: TConfig): string;
  /**
   * The trigger config field that filters by container (Jira `projectKeys`,
   * Azure DevOps `projects`): its values must be containers of the project
   * connection; empty means all of them.
   */
  triggerContainersField: string;
};

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
  /**
   * Review threads of the run's pull requests, for the agents of a process
   * (pull_request_* tools, docs/workflows.md "Pull request review tools").
   * Absent: the provider's pull requests cannot be reviewed by agents yet.
   */
  pullRequests?: IntegrationPullRequestsDefinition<TConfig, TSecrets>;
};

/** Where a pull request stands. */
export const PullRequestState = {
  Open: "open",
  Merged: "merged",
  /** Declined, abandoned or superseded. */
  Declined: "declined",
} as const;
export type PullRequestState =
  (typeof PullRequestState)[keyof typeof PullRequestState];

/** Whether a review thread still waits for an answer. */
export const PullRequestThreadStatus = {
  Open: "open",
  Resolved: "resolved",
} as const;
export type PullRequestThreadStatus =
  (typeof PullRequestThreadStatus)[keyof typeof PullRequestThreadStatus];

export type PullRequestComment = {
  id: string;
  /** The author's account id at the provider; null when unknown. */
  authorId: string | null;
  author: string | null;
  createdAt: string | null;
  bodyMarkdown: string;
};

/**
 * A review thread: a general comment or one on a line of a file, with its
 * replies. Bitbucket's thread is a root comment and the replies below it
 * (its id is the root's); Azure DevOps has threads of its own.
 */
export type PullRequestThread = {
  id: string;
  status: PullRequestThreadStatus;
  /** The file (and line) the thread is on; null for a general comment. */
  file: { path: string; line: number | null } | null;
  /** The root first, then the replies in order. */
  comments: PullRequestComment[];
};

export type IntegrationPullRequestsDefinition<TConfig, TSecrets> = {
  get(
    context: ProviderContext<TConfig, TSecrets>,
    repository: RepositoryInfo,
    number: number
  ): Promise<
    RepositoryOperationResult<{
      state: PullRequestState;
      title: string | null;
      url: string;
    }>
  >;
  listThreads(
    context: ProviderContext<TConfig, TSecrets>,
    repository: RepositoryInfo,
    number: number
  ): Promise<RepositoryOperationResult<PullRequestThread[]>>;
  /** Replies at the end of the thread; the new comment's id. */
  reply(
    context: ProviderContext<TConfig, TSecrets>,
    repository: RepositoryInfo,
    number: number,
    threadId: string,
    markdown: string
  ): Promise<RepositoryOperationResult<{ commentId: string }>>;
  /** Marks the thread resolved; resolving a resolved thread is no error. */
  resolve(
    context: ProviderContext<TConfig, TSecrets>,
    repository: RepositoryInfo,
    number: number,
    threadId: string
  ): Promise<RepositoryOperationResult<null>>;
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

/** What an action works on (IntegrationOperationTarget), from its definition. */
export function actionTarget(action: {
  repositoryScoped?: boolean;
  sourceOperation?: SourceOperation;
}): IntegrationOperationTarget {
  if (action.sourceOperation) {
    return IntegrationOperationTarget.SourceItem;
  }
  return action.repositoryScoped
    ? IntegrationOperationTarget.Repository
    : IntegrationOperationTarget.External;
}

/** What a read returns: JSON for the agent, or why it failed. */
export type ReadResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: string; retryable: boolean };

/**
 * A read an agent makes through a project connection: its input is built
 * from `inputFields` like an action's arguments and parsed by `inputSchema`.
 */
export type IntegrationReadDefinition<
  TInput = unknown,
  TConnectionConfig = JsonObject,
  TSecrets = JsonObject,
> = {
  /** Prefixed by the provider key ("confluence.get_page"). */
  key: string;
  displayName: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  inputFields: IntegrationFieldDescriptor[];
  /** Must not throw; map every failure to a ReadResult. */
  execute(
    ctx: ProviderContext<TConnectionConfig, TSecrets>,
    input: TInput
  ): Promise<ReadResult>;
};
