import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  runProcessSnapshotSchema,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { withDb } from "@repo/database";
import { documentVersionService } from "@/app/documents/document-version-service";
import { truncateText } from "@/lib/integrations/markdown";
import type {
  RunPullRequest,
  RunRepositorySnapshot,
  SourceItemRef,
  WorkflowRunDocumentSnapshot,
  WorkflowRunSnapshot,
  WorkflowRunStepSnapshot,
} from "@/lib/integrations/types";
import type { TemplateVariables } from "../template";
import {
  documentPageUrl,
  implementationPlanUrl,
  issueUrl,
  workflowRunUrl,
} from "./links";
import {
  readAgentConfig,
  readRunError,
  readRunRepositories,
  readRunSource,
  readRunStatus,
} from "./run-data";
import {
  findLatestRunLoop,
  listRunLoops,
  readOpenQuestions,
} from "./run-loops";
import { findRunReplies, type RunReplies } from "./run-process-view";
import { toSourceDocumentType } from "./source-document";
import { listRunDocuments } from "./step-documents";

/**
 * What a pre or post action knows about the run it reports on, built when the
 * action runs (not when the event is enqueued) so it reflects the latest
 * state. Pre actions (run.triggered) run before the agent team: they see no
 * documents and no pull request, even when a resumed run has some from an
 * earlier cycle.
 */

export const PLAN_EXCERPT_MAX_LENGTH = 1200;

/** GitHub ".../pull/42", Azure DevOps ".../pullrequest/42". */
const PR_NUMBER_RE = /\/pull(?:request)?\/(\d+)/;
const EXTRA_BLANK_LINES_RE = /\n{3,}/g;

const SNAPSHOT_RUN_SELECT = {
  id: true,
  organizationId: true,
  workflowId: true,
  status: true,
  sourceKey: true,
  source: true,
  agentConfig: true,
  prUrl: true,
  branchName: true,
  repository: true,
  error: true,
  process: true,
  stepId: true,
  stepState: true,
  createdAt: true,
  completedAt: true,
  workflow: { select: { id: true, name: true } },
  trigger: { select: { id: true, type: true, connectionId: true } },
  organization: { select: { slug: true } },
  featureDocument: {
    select: { id: true, name: true, slug: true, subtype: true },
  },
  planDocument: { select: { id: true, name: true, slug: true } },
} as const;

export type SummaryInput = {
  event: WorkflowRunEvent;
  key: string;
  /** Source item title; null when the source did not send one. */
  title: string | null;
  runUrl: string;
  planUrl: string | null;
  planExcerpt: string | null;
  openQuestions: string[];
  pullRequest: { url: string; branch: string | null } | null;
  /** Every pull request of the run; listed when there are several. */
  pullRequests: RunPullRequest[];
  errorMessage: string | null;
  /** Plan-only workflows succeed with a plan instead of a pull request. */
  planOnly: boolean;
  /** The project process step the run waits on; absent on the built-in flow. */
  step?: WorkflowRunStepSnapshot | null;
};

export async function buildRunSnapshot(
  runId: string,
  event: WorkflowRunEvent
): Promise<WorkflowRunSnapshot | null> {
  const run = await loadSnapshotRun(runId);
  if (!run) {
    return null;
  }

  const orgSlug = run.organization.slug;
  const runUrl = workflowRunUrl(orgSlug, run.workflowId, run.id);
  const stored = readRunSource(run.source);
  const source = stored?.item ?? fallbackSourceRef(run.sourceKey);
  const error = readRunError(run.error);
  const outputs =
    event === WorkflowRunEvent.Triggered
      ? NO_RUN_OUTPUTS
      : await buildRunOutputs(run, orgSlug, runUrl);
  const { feature, plan, pullRequest } = outputs;
  const mode = readAgentConfig(run.agentConfig)?.mode;
  const repositories = runRepositories(run.repository, run.branchName);
  const pullRequests =
    event === WorkflowRunEvent.Triggered
      ? []
      : runPullRequests(repositories, pullRequest);
  const step =
    event === WorkflowRunEvent.Triggered ? null : runStepSnapshot(run);
  const replies =
    event === WorkflowRunEvent.Triggered || !run.process
      ? NO_REPLIES
      : findRunReplies(run.process, await listRunLoops(run.id));
  const documents =
    event === WorkflowRunEvent.Triggered || !run.process
      ? []
      : await buildDocumentSnapshots(run, orgSlug, runUrl);

  return {
    id: run.id,
    url: runUrl,
    status: readRunStatus(run.status),
    event,
    workflow: { id: run.workflow.id, name: run.workflow.name },
    trigger: run.trigger
      ? {
          id: run.trigger.id,
          type: run.trigger.type,
          connectionId: run.trigger.connectionId,
        }
      : null,
    source,
    sourceExtras: stored?.extras ?? {},
    feature,
    plan,
    pullRequest,
    pullRequests,
    repositories,
    repository:
      repositories.find((repository) => repository.branch) ??
      repositories[0] ??
      null,
    error,
    step,
    reply: replies.reply,
    stepReplies: replies.byStep,
    documents,
    summaryMarkdown: buildSummaryMarkdown({
      event,
      key: source.key,
      title: source.title,
      runUrl,
      planUrl: plan?.url ?? null,
      planExcerpt: plan?.excerpt ?? null,
      openQuestions: plan?.openQuestions ?? [],
      pullRequest,
      pullRequests,
      errorMessage: error?.message ?? null,
      planOnly: mode === WorkflowAgentMode.Plan,
      step,
    }),
    startedAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** Ready-made markdown per event (docs/workflows.md "Actions"). */
export function buildSummaryMarkdown(input: SummaryInput): string {
  const key = `**${input.key}**`;
  switch (input.event) {
    case WorkflowRunEvent.Triggered:
      return triggeredSummary(key, input);
    case WorkflowRunEvent.Started:
      return `🤖 AgentFlow picked up ${key} and started planning. Follow the run: ${input.runUrl}`;
    case WorkflowRunEvent.PlanReady:
      return planReadySummary(key, input);
    case WorkflowRunEvent.NeedsInput:
      return needsInputSummary(key, input);
    case WorkflowRunEvent.Succeeded:
      return succeededSummary(key, input);
    default:
      return `⚠️ AgentFlow could not complete ${key}: ${input.errorMessage ?? "the run failed"}. Details: ${input.runUrl}`;
  }
}

/** Flat `{{variable}}` values for ctx.render (WORKFLOW_TEMPLATE_VARIABLES). */
export function snapshotTemplateVariables(
  snapshot: WorkflowRunSnapshot
): TemplateVariables {
  return {
    summary: snapshot.summaryMarkdown,
    event: snapshot.event,
    "run.status": snapshot.status,
    "run.url": snapshot.url,
    "workflow.name": snapshot.workflow.name,
    "source.provider": snapshot.source.provider,
    "source.key": snapshot.source.key,
    "source.title": snapshot.source.title ?? "",
    "source.url": snapshot.source.url ?? "",
    "feature.url": snapshot.feature?.url ?? "",
    "plan.url": snapshot.plan?.url ?? "",
    "plan.excerpt": snapshot.plan?.excerpt ?? "",
    "plan.openQuestions": snapshot.plan?.openQuestions.join("\n") ?? "",
    "pr.url": snapshot.pullRequest?.url ?? "",
    "pr.number":
      snapshot.pullRequest?.number === null ||
      snapshot.pullRequest?.number === undefined
        ? ""
        : String(snapshot.pullRequest.number),
    "pr.branch": snapshot.pullRequest?.branch ?? "",
    "pr.urls": snapshot.pullRequests.map((pr) => pr.url).join("\n"),
    "repository.name": snapshot.repository?.fullName ?? "",
    "repository.url": snapshot.repository?.webUrl ?? "",
    "repository.branch": snapshot.repository?.branch ?? "",
    "repository.baseBranch": snapshot.repository?.baseBranch ?? "",
    "error.message": snapshot.error?.message ?? "",
    "step.name": snapshot.step?.name ?? "",
    "step.questions": snapshot.step?.questions.join("\n") ?? "",
    reply: snapshot.reply ?? "",
    ...Object.fromEntries(
      Object.entries(snapshot.stepReplies).map(([stepId, reply]) => [
        `steps.${stepId}.reply`,
        reply,
      ])
    ),
    ...Object.fromEntries(
      snapshot.documents.flatMap((document) => [
        [`steps.${document.stepId}.document.url`, document.url],
        [`steps.${document.stepId}.document.title`, document.title],
      ])
    ),
  };
}

function triggeredSummary(key: string, input: SummaryInput): string {
  const title = input.title ? ` (${input.title})` : "";
  return `🤖 AgentFlow received ${key}${title} and is about to start working on it. Follow the run: ${input.runUrl}`;
}

function planReadySummary(key: string, input: SummaryInput): string {
  const head = `📝 The implementation plan for ${key} is ready: ${input.planUrl ?? input.runUrl}`;
  return input.planExcerpt ? `${head}\n\n${input.planExcerpt}` : head;
}

function needsInputSummary(key: string, input: SummaryInput): string {
  if (input.step?.awaitingApproval) {
    return `🛂 The "${input.step.name}" step for ${key} waits for an approval in AgentFlow: ${input.runUrl}`;
  }
  if (input.step && input.step.questions.length > 0) {
    return [
      `❓ The "${input.step.name}" step for ${key} has questions that need an answer:`,
      input.step.questions.map((question) => `- ${question}`).join("\n"),
      `Answer them on the ticket and assign it to the bot again, or answer in AgentFlow: ${input.runUrl}`,
    ].join("\n\n");
  }
  const questions = input.openQuestions.map((question) => `- ${question}`);
  return [
    `❓ The plan for ${key} has open questions that need an answer before implementation:`,
    questions.join("\n"),
    `Plan: ${input.planUrl ?? input.runUrl}`,
    "Answer them on the ticket and assign it to the bot again, or approve the plan in AgentFlow.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

function succeededSummary(key: string, input: SummaryInput): string {
  if (input.pullRequests.length > 1) {
    const lines = input.pullRequests.map(
      (pr) => `- ${pr.repository}: ${pr.url}`
    );
    return [`✅ ${key} is done. Pull requests:`, ...lines].join("\n");
  }
  if (input.pullRequest) {
    const branch = input.pullRequest.branch
      ? ` (branch ${input.pullRequest.branch})`
      : "";
    return `✅ ${key} is done. Pull request: ${input.pullRequest.url}${branch}.`;
  }
  if (input.planOnly && input.planUrl) {
    return `✅ ${key} is done. Implementation plan: ${input.planUrl}`;
  }
  return `✅ ${key} is done. Details: ${input.runUrl}`;
}

type SnapshotRunRow = NonNullable<Awaited<ReturnType<typeof loadSnapshotRun>>>;

/** The process step the run is in; null on the built-in AgentFlow flow. */
function runStepSnapshot(run: SnapshotRunRow): WorkflowRunStepSnapshot | null {
  const process = runProcessSnapshotSchema.safeParse(run.process);
  const step = process.success
    ? process.data.definition.steps.find((entry) => entry.id === run.stepId)
    : undefined;
  if (!step) {
    return null;
  }
  const parsedState = runStepStateSchema.safeParse(run.stepState);
  const state = parsedState.success ? parsedState.data : null;
  const waiting = state?.waiting?.stepId === step.id ? state.waiting : null;
  const approval = state?.approval?.stepId === step.id ? state.approval : null;
  return {
    id: step.id,
    name: step.name,
    questions: waiting?.questions.map((question) => question.question) ?? [],
    awaitingApproval: approval !== null && approval.decision === null,
  };
}

type RunOutputs = Pick<WorkflowRunSnapshot, "feature" | "plan" | "pullRequest">;

const NO_REPLIES: RunReplies = { reply: null, byStep: {} };

const NO_RUN_OUTPUTS: RunOutputs = {
  feature: null,
  plan: null,
  pullRequest: null,
};

function loadSnapshotRun(runId: string) {
  return withDb((db) =>
    db.workflowRun.findUnique({
      where: { id: runId },
      select: SNAPSHOT_RUN_SELECT,
    })
  );
}

/** Issue document, plan and pull request the agent team produced so far. */
async function buildRunOutputs(
  run: SnapshotRunRow,
  orgSlug: string,
  runUrl: string
): Promise<RunOutputs> {
  const feature = run.featureDocument
    ? {
        id: run.featureDocument.id,
        title: run.featureDocument.name,
        url: sourceDocumentUrl(orgSlug, run.featureDocument, runUrl),
      }
    : null;
  const plan = run.planDocument
    ? await buildPlanSnapshot(run.id, orgSlug, run.planDocument, runUrl)
    : null;
  const pullRequest = run.prUrl
    ? {
        url: run.prUrl,
        number: await resolvePullRequestNumber(run.id, run.prUrl),
        branch: run.branchName,
      }
    : null;
  return { feature, plan, pullRequest };
}

async function buildPlanSnapshot(
  runId: string,
  orgSlug: string,
  planDocument: { id: string; name: string; slug: string | null },
  runUrl: string
): Promise<NonNullable<WorkflowRunSnapshot["plan"]>> {
  const [latestVersion, planLoop] = await Promise.all([
    documentVersionService.getLatest(planDocument.id),
    findLatestRunLoop(runId, LoopCommand.Plan),
  ]);
  return {
    id: planDocument.id,
    title: planDocument.name,
    url: documentUrl(orgSlug, planDocument, implementationPlanUrl, runUrl),
    excerpt: buildPlanExcerpt(latestVersion?.content ?? null),
    openQuestions: planLoop
      ? readOpenQuestions(planLoop.uploadedArtifacts)
      : [],
  };
}

/** The documents the process steps published, with their absolute links. */
async function buildDocumentSnapshots(
  run: SnapshotRunRow,
  orgSlug: string,
  runUrl: string
): Promise<WorkflowRunDocumentSnapshot[]> {
  const documents = await listRunDocuments({
    id: run.id,
    organizationId: run.organizationId,
    featureDocumentId: run.featureDocument?.id ?? null,
  });
  return documents.map((document) => ({
    stepId: document.stepId,
    type: document.type,
    title: document.title,
    url:
      (document.slug
        ? documentPageUrl(orgSlug, document.type, document.slug)
        : null) ?? runUrl,
  }));
}

function buildPlanExcerpt(content: string | null): string | null {
  const normalized = content?.replaceAll(EXTRA_BLANK_LINES_RE, "\n\n").trim();
  if (!normalized) {
    return null;
  }
  return truncateText(normalized, PLAN_EXCERPT_MAX_LENGTH);
}

/** The EXECUTE loop's PR number, else the number parsed from the PR URL. */
async function resolvePullRequestNumber(
  runId: string,
  prUrl: string
): Promise<number | null> {
  const executeLoop = await findLatestRunLoop(runId, LoopCommand.Execute);
  if (executeLoop?.prNumber) {
    return executeLoop.prNumber;
  }
  const match = PR_NUMBER_RE.exec(prUrl);
  return match ? Number.parseInt(match[1], 10) : null;
}

function documentUrl(
  orgSlug: string,
  document: { slug: string | null },
  build: (orgSlug: string, slug: string) => string,
  fallback: string
): string {
  return document.slug ? build(orgSlug, document.slug) : fallback;
}

/** Page of the run's source document: its PRD, or its Issue. */
function sourceDocumentUrl(
  orgSlug: string,
  document: { slug: string | null; subtype: string | null },
  fallback: string
): string {
  if (!document.slug) {
    return fallback;
  }
  return toSourceDocumentType(document.subtype) === DocumentType.Prd
    ? (documentPageUrl(orgSlug, DocumentType.Prd, document.slug) ?? fallback)
    : issueUrl(orgSlug, document.slug);
}

/** Source of a run whose stored JSON no longer parses: "<provider>:<key>". */
function fallbackSourceRef(sourceKey: string): SourceItemRef {
  const separator = sourceKey.indexOf(":");
  const provider = separator > 0 ? sourceKey.slice(0, separator) : "";
  const key = separator > 0 ? sourceKey.slice(separator + 1) : sourceKey;
  return {
    provider,
    externalId: key,
    key,
    url: null,
    title: null,
    container: null,
  };
}

/**
 * The run's repositories. EXECUTE records each one's pushed branch; on a run
 * recorded before that (one repository), the branch is the run's branchName.
 */
function runRepositories(
  stored: unknown,
  branchName: string | null
): RunRepositorySnapshot[] {
  const { repositories, legacy } = readRunRepositories(stored);
  return legacy
    ? repositories.map((repository) => ({
        ...repository,
        branch: branchName ?? repository.branch,
      }))
    : repositories;
}

/** Pull requests recorded on the repositories, else the run's own one. */
function runPullRequests(
  repositories: RunRepositorySnapshot[],
  pullRequest: WorkflowRunSnapshot["pullRequest"]
): RunPullRequest[] {
  const recorded = repositories.flatMap((repository) =>
    repository.pullRequest
      ? [
          {
            url: repository.pullRequest.url,
            number: repository.pullRequest.number,
            branch: repository.branch,
            repository: repository.fullName,
          },
        ]
      : []
  );
  if (recorded.length > 0 || !pullRequest) {
    return recorded;
  }
  return [
    {
      url: pullRequest.url,
      number: pullRequest.number,
      branch: pullRequest.branch,
      repository: repositories[0]?.fullName ?? "",
    },
  ];
}
