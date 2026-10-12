import { z } from "zod";
import { type LoopStepConfig, LoopStepConfigSchema } from "./loop-step";

// Context pack attachment (file uploaded to S3 with signed URL)
export type ContextPackAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

export const ContextPackAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  signedUrl: z.string(),
  signedUrlExpiresAt: z.string(),
});

// Context pack artifact entry
export type ContextPackArtifact = {
  id: string;
  type: string;
  title: string;
  content: string;
  raw?: Record<string, unknown>;
};

export const ContextPackArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// Direct referenced artifacts that should be treated as supporting evidence.
// These intentionally duplicate full artifact content that may also exist in
// `artifacts`: ECS and Desktop materializers need an explicit, transport-safe
// list of source-of-truth refs while older consumers keep reading `artifacts`.
export type ContextPackSupportingArtifact = ContextPackArtifact;

export const ContextPackSupportingArtifactSchema = ContextPackArtifactSchema;

export type CodeEvaluationContext = {
  schemaVersion: 1;
  repo?: {
    fullName?: string | null;
    branch?: string | null;
  } | null;
  localRepoPath?: string | null;
  parentBranchName?: string | null;
  parentSessionId?: string | null;
  artifactSlug?: string | null;
  pullRequest?: {
    number?: number | null;
    url?: string | null;
    headBranch?: string | null;
    baseBranch?: string | null;
    headSha?: string | null;
    repositoryFullName?: string | null;
  } | null;
  detected?: {
    branch?: string | null;
    headSha?: string | null;
    gitDetectionError?: string | null;
  } | null;
};

export const CodeEvaluationContextSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z
    .object({
      fullName: z.string().nullable().optional(),
      branch: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  localRepoPath: z.string().nullable().optional(),
  parentBranchName: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  artifactSlug: z.string().nullable().optional(),
  pullRequest: z
    .object({
      number: z.number().nullable().optional(),
      url: z.string().nullable().optional(),
      headBranch: z.string().nullable().optional(),
      baseBranch: z.string().nullable().optional(),
      headSha: z.string().nullable().optional(),
      repositoryFullName: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  detected: z
    .object({
      branch: z.string().nullable().optional(),
      headSha: z.string().nullable().optional(),
      gitDetectionError: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

// Additional repository reference for multi-repo loop execution
export type AdditionalRepoRef = {
  fullName: string;
  branch: string;
};

/**
 * Repository full name: `owner/repo` (GitHub) or `organization/project/repo`
 * (Azure DevOps, whose project and repository names may contain spaces).
 */
export const REPOSITORY_FULL_NAME_REGEX =
  /^[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*(?:\/[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*){1,2}$/;
export const REPOSITORY_FULL_NAME_ERROR =
  "Must be in 'owner/repo' or 'organization/project/repo' format";

// Format constraints mirror the write-path `repoSchema` in
// apps/api/app/loops/validators.ts so data round-tripped through the DB is
// held to the same shape it was validated with on write.
export const AdditionalRepoRefSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .max(256)
    .regex(REPOSITORY_FULL_NAME_REGEX, REPOSITORY_FULL_NAME_ERROR),
  branch: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._/-]+$/, "Branch name contains invalid characters"),
});

// Additional repository reference with optional GitHub token. `cloneUrl` is
// set for a project repository the computer clones with per-loop credentials.
export type AdditionalRepoRefWithToken = AdditionalRepoRef & {
  githubToken?: string;
  cloneUrl?: string;
};

export const AdditionalRepoRefWithTokenSchema = AdditionalRepoRefSchema.extend({
  githubToken: z.string().optional(),
  cloneUrl: z.string().optional(),
});

export type ContextPackAgent = {
  slug: string;
  name: string;
  prompt: string;
};

export const ContextPackAgentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  prompt: z.string(),
});

export type ContextPackRepoConfig = {
  repoFullName: string;
  criticGates: Record<string, unknown>;
};

export const ContextPackRepoConfigSchema = z.object({
  repoFullName: z.string(),
  criticGates: z.record(z.string(), z.unknown()),
});

/**
 * Context pack — the input payload assembled by the backend and consumed
 * by the ECS runner harness (via S3) or desktop gateway (via relay).
 *
 * Canonical source: apps/api/lib/loops/loop-state.ts
 */
export type ContextPack = {
  command: string;
  prompt?: string;
  artifacts: ContextPackArtifact[];
  supportingArtifacts?: ContextPackSupportingArtifact[];
  codeEvaluationContext?: CodeEvaluationContext;
  repoInfo?: { fullName: string; branch: string; cloneUrl?: string };
  priorLoopSummaries?: Array<{
    loopId: string;
    command: string;
    summary: string;
  }>;
  committer?: { name: string; email: string };
  secrets?: { anthropicApiKey?: string; githubToken?: string };
  userContext?: string;
  /** Agent instructions of the project (loop on project repositories). */
  projectInstructions?: string;
  /** The process step of a STEP loop. */
  step?: LoopStepConfig;
  /**
   * A PLAN loop that re-plans a workflow run after its open questions were
   * answered: the computer hands it the previous plan to revise with the
   * answers (now in the source document) instead of planning from scratch.
   */
  replan?: boolean;
  /**
   * What the agents of a workflow process step decide on their own, when
   * the step changes the default (agentflow.plan `recommendations`,
   * agentflow.execute `review`). Absent: the built-in behaviour.
   */
  agentPolicy?: LoopAgentPolicy;
  attachments?: ContextPackAttachment[];
  additionalRepos?: AdditionalRepoRefWithToken[];
  agents?: ContextPackAgent[];
  repoConfigs?: ContextPackRepoConfig[];
};

export const ContextPackSchema = z.object({
  command: z.string(),
  prompt: z.string().optional(),
  artifacts: z.array(ContextPackArtifactSchema),
  supportingArtifacts: z.array(ContextPackSupportingArtifactSchema).optional(),
  codeEvaluationContext: CodeEvaluationContextSchema.optional(),
  repoInfo: z
    .object({
      fullName: z.string(),
      branch: z.string(),
      cloneUrl: z.string().optional(),
    })
    .optional(),
  priorLoopSummaries: z
    .array(
      z.object({
        loopId: z.string(),
        command: z.string(),
        summary: z.string(),
      })
    )
    .optional(),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
  secrets: z
    .object({
      anthropicApiKey: z.string().optional(),
      githubToken: z.string().optional(),
    })
    .optional(),
  userContext: z.string().optional(),
  projectInstructions: z.string().optional(),
  step: LoopStepConfigSchema.optional(),
  attachments: z.array(ContextPackAttachmentSchema).optional(),
  additionalRepos: z.array(AdditionalRepoRefWithTokenSchema).optional(),
  agents: z.array(ContextPackAgentSchema).optional(),
  repoConfigs: z.array(ContextPackRepoConfigSchema).optional(),
});

/**
 * Open questions of a plan the planning agents recommend an answer for
 * (agentflow.plan `recommendations`).
 */
export const PlanRecommendations = {
  /** The recommended answer settles the question. */
  Accept: "accept",
  /** The recommendation is a suggestion: the question stays open for people. */
  Suggest: "suggest",
} as const;
export type PlanRecommendations =
  (typeof PlanRecommendations)[keyof typeof PlanRecommendations];

/**
 * How the implementation agents treat the approved plan (agentflow.execute
 * `review`).
 */
export const ExecuteReview = {
  /**
   * Evaluate the plan, check other repositories, run the critics and
   * finalize it before implementing, then check the result against the
   * plan's decision table.
   */
  Full: "full",
  /** Implement the approved plan as it is; tests and build checks still run. */
  Fast: "fast",
} as const;
export type ExecuteReview = (typeof ExecuteReview)[keyof typeof ExecuteReview];

/** See {@link ContextPack.agentPolicy}. */
export const LoopAgentPolicySchema = z.object({
  recommendations: z.enum(PlanRecommendations).optional(),
  review: z.enum(ExecuteReview).optional(),
});
export type LoopAgentPolicy = z.infer<typeof LoopAgentPolicySchema>;
