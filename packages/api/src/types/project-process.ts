import {
  ExecuteReview,
  PlanRecommendations,
} from "@agentflow-ai/loops-api/context-pack";
import { DocumentType } from "@agentflow-ai/loops-api/document";
import {
  LOOP_STEP_QUESTIONS_MAX,
  type LoopStepCollectedFile,
  LoopStepFinish,
  type LoopStepQuestion,
  LoopStepQuestionSchema,
  LoopStepRole,
} from "@agentflow-ai/loops-api/loop-step";
import { z } from "zod";
import { connectionGrantsSchema } from "./connection-grants.ts";
import type { WorkflowAgentConfig } from "./workflow.ts";
import { WorkflowAgentMode } from "./workflow-agent-mode.ts";

/**
 * The process of a project: the steps a workflow run goes through between its
 * pre actions and its post actions. Trigger, pre actions and post actions stay
 * on the workflow; this is the part a project shapes to its toolkit (the
 * built-in AgentFlow agents, Spec Kit, another kit with other commands).
 *
 * Code only provides the step types; the process itself is data, stored as
 * append-only versions per project and snapshotted by each run. A project
 * without a process runs the built-in AgentFlow flow, derived from the
 * workflow's agent config exactly as before (deriveProcessFromAgentConfig).
 */

export const ProcessStepType = {
  /** The AgentFlow planning agents (PLAN loop on the run's plan document). */
  AgentFlowPlan: "agentflow.plan",
  /** The AgentFlow implementation agents (EXECUTE loop; approves the plan, pushes). */
  AgentFlowExecute: "agentflow.execute",
  /** One instruction (e.g. a toolkit command) run by the agent in the workspace. */
  Agent: "agent",
  /** A person approves before the run goes on. */
  Approval: "approval",
} as const;
export type ProcessStepType =
  (typeof ProcessStepType)[keyof typeof ProcessStepType];

/** Whether a step may stop the run to ask the developer. */
export const ProcessQuestionsPolicy = {
  /** Questions stop the run (needs input) when a step follows. */
  Ask: "ask",
  /** Go on without asking. */
  Continue: "continue",
} as const;
export type ProcessQuestionsPolicy =
  (typeof ProcessQuestionsPolicy)[keyof typeof ProcessQuestionsPolicy];

/**
 * What an agent step does with its changes when it ends: nothing, or commit
 * and push every repository with changes (pull requests come from post
 * actions). The values travel to the computer unchanged (LoopStepFinish).
 */
export const ProcessStepFinish = LoopStepFinish;
export type ProcessStepFinish = LoopStepFinish;

/**
 * What an agent step is to AgentFlow (docs/workflows.md "Step roles"): a
 * `plan` step writes the run's implementation plan, an `implement` step works
 * from the approved plan, pushes and writes release notes. AgentFlow adds the
 * role's contract to the agent's instructions, so a toolkit command only has
 * to do the work. The values travel to the computer unchanged (LoopStepRole).
 */
export const ProcessStepRole = LoopStepRole;
export type ProcessStepRole = LoopStepRole;

/**
 * What a plan step does with an open question its agents recommend an answer
 * for: settle it with the recommendation (`accept`), or keep it open for
 * people with the recommendation as a suggestion (`suggest`).
 */
export const ProcessPlanRecommendations = PlanRecommendations;
export type ProcessPlanRecommendations = PlanRecommendations;

/**
 * How an implement step treats the approved plan: review and finalize it
 * before implementing (`full`), or implement it as it is (`fast`).
 */
export const ProcessExecuteReview = ExecuteReview;
export type ProcessExecuteReview = ExecuteReview;

/**
 * Documents an agent step can publish to the project: a PRD for a new
 * feature, an Implementation Plan, or a general document (a bug analysis, a
 * change request impact). The run's Issue already exists, so it is not one.
 */
export const ProcessDocumentType = {
  Prd: DocumentType.Prd,
  ImplementationPlan: DocumentType.ImplementationPlan,
  Doc: DocumentType.Doc,
} as const;
export type ProcessDocumentType =
  (typeof ProcessDocumentType)[keyof typeof ProcessDocumentType];

export const PROCESS_STEPS_MAX = 20;
export const PROCESS_INSTRUCTION_MAX = 8000;
export const PROCESS_TOOLKIT_INSTRUCTIONS_MAX = 16_000;
export const PROCESS_PATHS_MAX = 20;
export const PROCESS_DOCUMENT_TITLE_MAX = 200;
/** Characters of the YAML a process is edited as (ProjectProcess.source). */
export const PROCESS_SOURCE_MAX = 200_000;
export const PROCESS_SIGNAL_LABELS_MAX = 10;
export const PROCESS_SIGNAL_LABEL_MAX = 255;
export const REVIEW_HISTORY_MAX = 50;
export const PENDING_SIGNALS_MAX = 10;

/** How a feedback round runs the step again. */
export const ReviewSession = {
  /** Continue the step's agent session with the feedback (`--resume`). */
  Resume: "resume",
  /** A new session with the step's instruction and the feedback. */
  Fresh: "fresh",
} as const;
export type ReviewSession = (typeof ReviewSession)[keyof typeof ReviewSession];

/** What people decided on a step under review. */
export const ReviewDecisionKind = {
  /** Go on: the plan is approved, or the review is complete. */
  Approve: "approve",
  /** Run the step again with the feedback. */
  Feedback: "feedback",
  /** Fail the run (AgentFlow only). */
  Reject: "reject",
} as const;
export type ReviewDecisionKind =
  (typeof ReviewDecisionKind)[keyof typeof ReviewDecisionKind];

/** Where a review decision came from. */
export const ReviewSignalVia = {
  App: "app",
  Label: "label",
  Mention: "mention",
} as const;
export type ReviewSignalVia =
  (typeof ReviewSignalVia)[keyof typeof ReviewSignalVia];

/** Ids of the steps of the built-in flow (also used for runs recorded before processes existed). */
export const AgentFlowStepId = {
  Plan: "plan",
  Execute: "execute",
} as const;

const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** A path inside a repository or the workspace: relative, no `..` segment. */
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

const stepIdSchema = z
  .string()
  .trim()
  .regex(
    STEP_ID_RE,
    "Use lowercase letters, digits, - or _ (starting with a letter)"
  );
const stepNameSchema = z.string().trim().min(1, "Enter a name").max(80);
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(RELATIVE_PATH_RE, "Use a relative path without ..");

const agentFlowPlanStepSchema = z.object({
  type: z.literal(ProcessStepType.AgentFlowPlan),
  id: stepIdSchema,
  name: stepNameSchema,
  questions: z.enum(ProcessQuestionsPolicy).default(ProcessQuestionsPolicy.Ask),
  recommendations: z
    .enum(ProcessPlanRecommendations)
    .default(ProcessPlanRecommendations.Accept),
});

const agentFlowExecuteStepSchema = z.object({
  type: z.literal(ProcessStepType.AgentFlowExecute),
  id: stepIdSchema,
  name: stepNameSchema,
  review: z.enum(ProcessExecuteReview).default(ProcessExecuteReview.Full),
  /** The implementation writes release notes; true unless turned off. */
  releaseNotes: z.boolean().optional(),
});

const stepDocumentSchema = z.object({
  type: z.enum(ProcessDocumentType),
  /** One of the step's files (from the workspace root); its content is the document. */
  path: relativePathSchema,
  /** Template ({{issue.key}}, {{issue.title}}); empty: the run's Issue title. */
  title: z.string().trim().max(PROCESS_DOCUMENT_TITLE_MAX).default(""),
});
export type ProcessStepDocument = z.infer<typeof stepDocumentSchema>;

/** Labels (Jira) or tags (Azure DevOps) added on the source item as a signal. */
const signalLabelsSchema = z
  .array(z.string().trim().min(1).max(PROCESS_SIGNAL_LABEL_MAX))
  .max(PROCESS_SIGNAL_LABELS_MAX)
  .default([]);

/** A signal that lets the run go on: an approval, or the end of a review. */
const goOnSignalSchema = z.object({ labels: signalLabelsSchema });

/**
 * A step's review (docs/workflows.md "Review loops"): after the step, the run
 * waits until people let it go on (`approve` on a plan step, `complete` on
 * any other) or send feedback, which runs the step again with it.
 */
const stepReviewSchema = z.object({
  approve: goOnSignalSchema.optional(),
  complete: goOnSignalSchema.optional(),
  feedback: z
    .object({
      labels: signalLabelsSchema,
      /** A comment that mentions the bot; its text is the feedback. */
      mention: z.boolean().default(false),
    })
    .default({ labels: [], mention: false }),
  /** Prompt of a feedback round ({{feedback.text}}, ...); empty: the feedback itself. */
  instruction: z.string().trim().max(PROCESS_INSTRUCTION_MAX).optional(),
  session: z.enum(ReviewSession).default(ReviewSession.Resume),
  /** Remove a feedback label from the source item once it was acted on. */
  consumeLabels: z.boolean().default(true),
});
export type ProcessStepReview = z.infer<typeof stepReviewSchema>;

/** Most automatic retries a step may ask for (AgentProcessStep.retry). */
export const STEP_AUTO_RETRY_ATTEMPTS_MAX = 5;

const agentStepSchema = z.object({
  type: z.literal(ProcessStepType.Agent),
  id: stepIdSchema,
  name: stepNameSchema,
  /** Template ({{issue.title}}, {{issue.body}}, {{issue.file}}, ...); may start with a slash command. */
  instruction: z
    .string()
    .trim()
    .min(1, "Enter the instruction")
    .max(PROCESS_INSTRUCTION_MAX),
  questions: z
    .enum(ProcessQuestionsPolicy)
    .default(ProcessQuestionsPolicy.Continue),
  /** Files (globs from the workspace root) shown on the run once the step ends. */
  artifacts: z.array(relativePathSchema).max(PROCESS_PATHS_MAX).default([]),
  /**
   * A file the step writes for people outside AgentFlow (an answer to post
   * on the ticket, a summary for the team). Post actions get its content as
   * {{reply}}; the latest step that wrote one wins.
   */
  reply: relativePathSchema.nullable().default(null),
  /**
   * Publishes one of the step's files as a document of the workflow's
   * project when the step ends, produced by the run's Issue. Later loops of
   * the step (after answers, a rejection) add versions to that document.
   */
  document: stepDocumentSchema.nullable().default(null),
  finish: z.enum(ProcessStepFinish).default(ProcessStepFinish.None),
  timeoutMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .nullable()
    .default(null),
  /**
   * What the step's agent may read and write through the project's
   * connections (connection-grants.ts). Without it the agent only reads the
   * run's source item.
   */
  connections: connectionGrantsSchema.optional(),
  /** What the step is to AgentFlow; absent: a step without a role. */
  role: z.enum(ProcessStepRole).optional(),
  /** An implement step writes release notes; true unless turned off. */
  releaseNotes: z.boolean().optional(),
  /** People review the step's work before the run goes on. */
  review: stepReviewSchema.optional(),
  /**
   * Automatic retries of the step after its agent failed on the model
   * provider (an expired token, a quota, an overload): after a backoff the
   * failed session goes on in a fork (`--resume --fork-session`). Absent: a
   * failure fails the run (an administrator can still retry it).
   */
  retry: z
    .object({
      attempts: z.number().int().min(1).max(STEP_AUTO_RETRY_ATTEMPTS_MAX),
    })
    .optional(),
});

const approvalStepSchema = z.object({
  type: z.literal(ProcessStepType.Approval),
  id: stepIdSchema,
  name: stepNameSchema,
  /** Step ids or artifact globs shown to the approver. */
  show: z
    .array(z.string().trim().min(1).max(200))
    .max(PROCESS_PATHS_MAX)
    .default([]),
  /** Labels (tags) added on the source item that approve, besides AgentFlow. */
  approve: goOnSignalSchema.optional(),
});

export type AgentProcessStep = z.infer<typeof agentStepSchema>;

export const processStepSchema = z.discriminatedUnion("type", [
  agentFlowPlanStepSchema,
  agentFlowExecuteStepSchema,
  agentStepSchema,
  approvalStepSchema,
]);
export type ProcessStep = z.infer<typeof processStepSchema>;

export const processToolkitSchema = z.object({
  /** Full name of one of the project's repositories. */
  repository: z
    .string()
    .trim()
    .min(3, "Choose the toolkit repository")
    .max(256),
  /** Directories of that repository the agent loads, e.g. .claude/skills. */
  mounts: z.array(relativePathSchema).min(1).max(PROCESS_PATHS_MAX),
  /** Added to the workspace CLAUDE.md, e.g. where the kit's scripts run from. */
  instructions: z.string().max(PROCESS_TOOLKIT_INSTRUCTIONS_MAX).default(""),
});
export type ProcessToolkit = z.infer<typeof processToolkitSchema>;

export const projectProcessSchema = z
  .object({
    toolkit: processToolkitSchema.nullable().default(null),
    steps: z
      .array(processStepSchema)
      .min(1, "Add a step")
      .max(PROCESS_STEPS_MAX),
    /**
     * The YAML the process was written in, comments and layout kept, when it
     * was edited as YAML. `toolkit` and `steps` are what runs; the editor
     * shows this text again while it still describes them.
     */
    source: z.string().max(PROCESS_SOURCE_MAX).optional(),
  })
  .superRefine((process, ctx) => {
    const seen = new Set<string>();
    process.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Step id ${step.id} is used twice`,
        });
      }
      seen.add(step.id);
    });
    const planIndex = process.steps.findIndex(isPlanStep);
    const agentFlowPlanIndex = process.steps.findIndex(
      (step) => step.type === ProcessStepType.AgentFlowPlan
    );
    process.steps.forEach((step, index) => {
      if (isPlanStep(step) && index !== planIndex) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, ...planStepIssuePath(step)],
          message:
            "A process has at most one plan step (an AgentFlow plan step or a step with role: plan)",
        });
      }
      // EXECUTE continues the PLAN loop's state on the same computer.
      if (
        step.type === ProcessStepType.AgentFlowExecute &&
        (agentFlowPlanIndex < 0 || agentFlowPlanIndex > index)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "type"],
          message:
            "The AgentFlow implement step needs a AgentFlow plan step before it",
        });
      }
      if (step.type === ProcessStepType.Agent) {
        checkAgentStepRole(step, index, planIndex, ctx);
      }
    });
  });
export type ProjectProcess = z.infer<typeof projectProcessSchema>;
export type ProjectProcessInput = z.input<typeof projectProcessSchema>;

/**
 * Variables of an agent step's instruction ({{issue.title}}, ...). Unknown
 * names render as an empty string.
 */
export const PROCESS_INSTRUCTION_VARIABLES = [
  { name: "issue.key", description: "Key of the source item, e.g. PROJ-123" },
  { name: "issue.title", description: "Title of the source item" },
  { name: "issue.url", description: "Link to the source item" },
  {
    name: "issue.body",
    description: "The run's Issue document (description, sections, comments)",
  },
  {
    name: "issue.file",
    description:
      "Path of the Issue as markdown in the loop workspace, for long issues",
  },
] as const;

export const PROCESS_ANSWER_MAX = 4000;

/** The answer to one question of an agent step. */
export const processAnswerSchema = z.object({
  id: z.string().trim().min(1).max(64),
  answer: z.string().trim().min(1, "Enter an answer").max(PROCESS_ANSWER_MAX),
});
export type ProcessAnswer = z.infer<typeof processAnswerSchema>;

/**
 * Progress of the run's current process step (WorkflowRun.stepState): the
 * questions an agent step stopped with (and their answers until the step
 * resumes), or the approval a step waits for (and the decision until the run
 * moves on).
 */
/** One decision on a step under review (RunStepState.review). */
export const reviewDecisionSchema = z.object({
  kind: z.enum(ReviewDecisionKind),
  via: z.enum(ReviewSignalVia),
  /** The feedback, or the comment of an approval or rejection. */
  text: z.string().max(PROCESS_ANSWER_MAX),
  /** User id of who decided in AgentFlow. */
  by: z.string().nullable(),
  /** Who signalled on the source item (its display name). */
  author: z.string().nullable(),
  /** The label (tag) that signalled. */
  label: z.string().nullable(),
  /** ISO time of the decision. */
  at: z.string(),
});
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const runStepStateSchema = z.object({
  waiting: z
    .object({
      stepId: z.string(),
      /** The STEP loop that asked; its agent session is resumed with the answers. */
      loopId: z.string(),
      questions: z.array(LoopStepQuestionSchema),
      /** ISO time the run started waiting. */
      askedAt: z.string(),
      /** Answers given in AgentFlow, until the step resumes with them. */
      answers: z.array(processAnswerSchema).nullable().default(null),
      /** User id of who answered. */
      answeredBy: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  approval: z
    .object({
      stepId: z.string(),
      /** ISO time the run started waiting for the approval. */
      requestedAt: z.string(),
      decision: z
        .object({
          approved: z.boolean(),
          comment: z.string(),
          /** User id of who decided. */
          decidedBy: z.string().nullable(),
          decidedAt: z.string(),
        })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  /**
   * An asking step wrote questions that could not be read; its session was
   * resumed to rewrite them (`attempts` times so far) while the run stays
   * running.
   */
  questionsRepair: z
    .object({
      stepId: z.string(),
      /** The loop whose questions could not be read. */
      loopId: z.string(),
      attempts: z.number().int().min(1),
    })
    .nullable()
    .optional(),
  /**
   * The step under review (AgentProcessStep.review): the run waits for a
   * decision while `decision` is null; earlier rounds are in `history`.
   * While a feedback round runs, it stays with `decision` cleared.
   */
  review: z
    .object({
      stepId: z.string(),
      /** The step's latest loop; a feedback round resumes its session. */
      loopId: z.string(),
      /** 1 for the first review of the step, +1 per feedback round. */
      round: z.number().int().min(1),
      /** ISO time the run started waiting (empty while a round runs). */
      requestedAt: z.string(),
      decision: reviewDecisionSchema.nullable().default(null),
      history: z
        .array(reviewDecisionSchema)
        .max(REVIEW_HISTORY_MAX)
        .default([]),
    })
    .nullable()
    .optional(),
  /**
   * Signals from the source item that arrived while the step still worked;
   * applied once it waits for its review or approval.
   */
  pendingSignals: z
    .array(reviewDecisionSchema)
    .max(PENDING_SIGNALS_MAX)
    .optional(),
  /**
   * The step's agent failed on the model provider; its session was resumed
   * in a fork (`attempts` automatic retries so far, AgentProcessStep.retry)
   * while the run stays running.
   */
  autoRetry: z
    .object({
      stepId: z.string(),
      /** The failed loop whose session the retry forked. */
      loopId: z.string(),
      attempts: z.number().int().min(1),
    })
    .nullable()
    .optional(),
  /**
   * A plan step ended without writing the plan; its session was resumed to
   * write it (`attempts` times so far) while the run stays running.
   */
  outputRepair: z
    .object({
      stepId: z.string(),
      /** The loop that did not write the plan. */
      loopId: z.string(),
      attempts: z.number().int().min(1),
    })
    .nullable()
    .optional(),
});
export type RunStepState = z.infer<typeof runStepStateSchema>;

/** A run's snapshot of the process it follows (WorkflowRun.process). */
/** Where a run's process came from. */
export const RunProcessSource = {
  /** A version of the project's process. */
  Project: "project",
  /** The workflow's own process (WorkflowAgentConfig.process). */
  Workflow: "workflow",
} as const;
export type RunProcessSource =
  (typeof RunProcessSource)[keyof typeof RunProcessSource];

export const runProcessSnapshotSchema = z.object({
  /** The project process version; 1 for a workflow's own process. */
  version: z.number().int().positive(),
  source: z.enum(RunProcessSource).default(RunProcessSource.Project),
  definition: projectProcessSchema,
});
export type RunProcessSnapshot = z.infer<typeof runProcessSnapshotSchema>;

/**
 * The built-in AgentFlow flow a workflow ran before processes existed: PLAN,
 * then EXECUTE in plan_and_execute mode. stopOnOpenQuestions is the plan
 * step's questions policy; recommendations are accepted and the plan is
 * reviewed in full. A project without a process runs exactly this.
 */
export function deriveProcessFromAgentConfig(
  agent: Pick<WorkflowAgentConfig, "mode" | "stopOnOpenQuestions">
): ProjectProcess {
  const plan: ProcessStep = {
    type: ProcessStepType.AgentFlowPlan,
    id: AgentFlowStepId.Plan,
    name: "Plan",
    questions: agent.stopOnOpenQuestions
      ? ProcessQuestionsPolicy.Ask
      : ProcessQuestionsPolicy.Continue,
    recommendations: ProcessPlanRecommendations.Accept,
  };
  if (agent.mode === WorkflowAgentMode.Plan) {
    return { toolkit: null, steps: [plan] };
  }
  return {
    toolkit: null,
    steps: [
      plan,
      {
        type: ProcessStepType.AgentFlowExecute,
        id: AgentFlowStepId.Execute,
        name: "Implement",
        review: ProcessExecuteReview.Full,
      },
    ],
  };
}

/** The step after `stepId`, or null when it is the last one (or unknown). */
export function nextProcessStep(
  process: ProjectProcess,
  stepId: string
): ProcessStep | null {
  const index = process.steps.findIndex((step) => step.id === stepId);
  return index >= 0 ? (process.steps[index + 1] ?? null) : null;
}

/** Starting points of the process editor (data, edited before saving). */
export const PROCESS_PRESETS: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  process: ProjectProcessInput;
}> = [
  {
    key: "agentflow",
    name: "AgentFlow (default)",
    description:
      "The built-in AgentFlow planning and implementation agents: plan, stop for open questions, then implement and push.",
    process: deriveProcessFromAgentConfig({
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
    }),
  },
  {
    key: "spec-kit",
    name: "Spec Kit",
    description:
      "GitHub Spec Kit commands from a toolkit repository: specify, clarify, plan, tasks, analyze, approval, implement.",
    process: {
      toolkit: {
        repository: "",
        mounts: [".claude/skills", ".claude/commands", ".specify"],
        instructions:
          "Spec Kit lives in the toolkit repository. Run its commands from the workspace root; its scripts are under .specify/scripts.",
      },
      steps: [
        {
          type: ProcessStepType.Agent,
          id: "specify",
          name: "Specify",
          instruction: "/speckit-specify {{issue.title}}\n\n{{issue.body}}",
        },
        {
          type: ProcessStepType.Agent,
          id: "clarify",
          name: "Clarify",
          instruction: "/speckit-clarify",
          questions: ProcessQuestionsPolicy.Ask,
        },
        {
          type: ProcessStepType.Agent,
          id: "plan",
          name: "Plan",
          instruction: "/speckit-plan",
        },
        {
          type: ProcessStepType.Agent,
          id: "tasks",
          name: "Tasks",
          instruction: "/speckit-tasks",
        },
        {
          type: ProcessStepType.Agent,
          id: "analyze",
          name: "Analyze",
          instruction: "/speckit-analyze",
          questions: ProcessQuestionsPolicy.Ask,
          artifacts: ["specs/*/spec.md", "specs/*/plan.md", "specs/*/tasks.md"],
        },
        {
          type: ProcessStepType.Approval,
          id: "approve",
          name: "Approve the plan",
          show: ["analyze"],
        },
        {
          type: ProcessStepType.Agent,
          id: "implement",
          name: "Implement",
          instruction: "/speckit-implement",
          finish: ProcessStepFinish.Push,
        },
      ],
    },
  },
];

/** POST /workflow-runs/{id}/answers: answers to the questions of the waiting step. */
export const answerStepQuestionsInputSchema = z.object({
  answers: z.array(processAnswerSchema).min(1).max(LOOP_STEP_QUESTIONS_MAX),
});
export type AnswerStepQuestionsInput = z.infer<
  typeof answerStepQuestionsInputSchema
>;

/** POST /workflow-runs/{id}/approval: the decision on the waiting approval step. */
export const decideStepApprovalInputSchema = z.object({
  approved: z.boolean(),
  comment: z.string().trim().max(PROCESS_ANSWER_MAX).default(""),
});
export type DecideStepApprovalInput = z.input<
  typeof decideStepApprovalInputSchema
>;
/** The decision as the server reads it (comment trimmed, "" when none). */
export type DecidedStepApproval = z.output<
  typeof decideStepApprovalInputSchema
>;

/** POST /workflow-runs/{id}/review: the decision on the step under review. */
export const decideStepReviewInputSchema = z.object({
  decision: z.enum(ReviewDecisionKind),
  comment: z.string().trim().max(PROCESS_ANSWER_MAX).default(""),
});
export type DecideStepReviewInput = z.input<typeof decideStepReviewInputSchema>;
export type DecidedStepReview = z.output<typeof decideStepReviewInputSchema>;

/** Who saved a process version. */
export type ProjectProcessAuthor = { id: string; name: string | null } | null;

/** A saved process version; `definition` null: back to the built-in flow. */
export type ProjectProcessVersion = {
  version: number;
  definition: ProjectProcess | null;
  createdAt: string;
  createdBy: ProjectProcessAuthor;
};

/** GET /projects/{id}/process. */
export type ProjectProcessState = {
  /**
   * The current custom process; null when the project runs the built-in
   * AgentFlow flow (each workflow's agent settings).
   */
  current: ProjectProcessVersion | null;
  /** Set when the latest version no longer parses (saved by a newer build). */
  invalidVersion: number | null;
};

/** GET /projects/{id}/process/versions: newest first. */
export type ProjectProcessVersions = { versions: ProjectProcessVersion[] };

export const PROCESS_VERSIONS_LIST_MAX = 50;

/** PUT /projects/{id}/process: a new version; `process: null` resets to the built-in flow. */
export const updateProjectProcessInputSchema = z.object({
  process: projectProcessSchema.nullable(),
});
export type UpdateProjectProcessInput = z.input<
  typeof updateProjectProcessInputSchema
>;

/** A run's process as its detail page shows it (WorkflowRunDetail.process). */
export type RunProcessView = {
  version: number;
  source: RunProcessSource;
  /** Full name of the toolkit repository, if any. */
  toolkit: string | null;
  steps: Array<{ id: string; name: string; type: ProcessStep["type"] }>;
  /** The step the run is in. */
  stepId: string | null;
  /** Questions of the step waiting for answers. */
  waiting: {
    stepId: string;
    questions: LoopStepQuestion[];
    askedAt: string;
    /** Answers were given and the step is about to go on. */
    answered: boolean;
  } | null;
  /** The approval step waiting for a decision. */
  approval: {
    stepId: string;
    requestedAt: string;
    /** Step ids or file globs the approver should look at. */
    show: string[];
    decided: boolean;
  } | null;
  /**
   * The step under review (AgentProcessStep.review): its round, the signals
   * people can give on the source item and what was decided in earlier
   * rounds. `waiting` while it waits for a decision.
   */
  review: {
    stepId: string;
    round: number;
    /** The step is a plan step: Approve / Replan, else Done / Request changes. */
    planStep: boolean;
    waiting: boolean;
    requestedAt: string;
    /** Labels (tags) on the source item that approve or complete it. */
    goOnLabels: string[];
    feedbackLabels: string[];
    /** A comment that mentions the bot sends feedback. */
    mention: boolean;
    history: ReviewDecision[];
  } | null;
  /** Files each agent step collected, from its latest loop. */
  stepFiles: Array<{
    stepId: string;
    loopId: string;
    files: LoopStepCollectedFile[];
  }>;
};

/** A step that writes the run's implementation plan: AgentFlow's plan step, or an agent step with role plan. */
export function isPlanStep(step: ProcessStep): boolean {
  return (
    step.type === ProcessStepType.AgentFlowPlan ||
    (step.type === ProcessStepType.Agent && step.role === ProcessStepRole.Plan)
  );
}

/** True when the process has a plan step, so its runs get a plan document. */
export function processHasPlanStep(process: ProjectProcess): boolean {
  return process.steps.some(isPlanStep);
}

/** What an agent step does with its changes: an implement step always pushes. */
export function agentStepFinish(step: AgentProcessStep): ProcessStepFinish {
  return step.role === ProcessStepRole.Implement
    ? ProcessStepFinish.Push
    : step.finish;
}

/**
 * An implement step (role implement, or AgentFlow's implement step) writes
 * release notes unless `releaseNotes: false`.
 */
export function writesReleaseNotes(step: ProcessStep): boolean {
  const isImplementStep =
    step.type === ProcessStepType.AgentFlowExecute ||
    (step.type === ProcessStepType.Agent &&
      step.role === ProcessStepRole.Implement);
  return isImplementStep && step.releaseNotes !== false;
}

/** Where a second plan step is reported: its role, or its type. */
function planStepIssuePath(step: ProcessStep): string[] {
  return step.type === ProcessStepType.Agent ? ["role"] : ["type"];
}

/** The rules of an agent step's role (docs/workflows.md "Step roles"). */
function checkAgentStepRole(
  step: AgentProcessStep,
  index: number,
  planIndex: number,
  ctx: z.RefinementCtx
): void {
  if (
    step.role === ProcessStepRole.Implement &&
    (planIndex < 0 || planIndex > index)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "role"],
      message:
        "A step with role: implement needs a plan step before it (an AgentFlow plan step or a step with role: plan)",
    });
  }
  if (
    step.role === ProcessStepRole.Plan &&
    step.document?.type === ProcessDocumentType.ImplementationPlan
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "document", "type"],
      message:
        "A step with role: plan already writes the run's implementation plan; remove its IMPLEMENTATION_PLAN document",
    });
  }
  checkStepReview(step, index, ctx);
  if (
    step.releaseNotes !== undefined &&
    step.role !== ProcessStepRole.Implement
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "releaseNotes"],
      message: "releaseNotes applies to steps with role: implement",
    });
  }
}

/** A review's signals: `approve` on a plan step, `complete` elsewhere, each label once. */
function checkStepReview(
  step: AgentProcessStep,
  index: number,
  ctx: z.RefinementCtx
): void {
  const review = step.review;
  if (!review) {
    return;
  }
  const planStep = step.role === ProcessStepRole.Plan;
  if (review.approve && !planStep) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "review", "approve"],
      message:
        "review.approve is for a step with role: plan; use review.complete to end the review of another step",
    });
  }
  if (review.complete && planStep) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "review", "complete"],
      message: "A plan step is approved: use review.approve",
    });
  }
  const labels = [
    ...(review.approve?.labels ?? []),
    ...(review.complete?.labels ?? []),
    ...review.feedback.labels,
  ].map((label) => label.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    ctx.addIssue({
      code: "custom",
      path: ["steps", index, "review"],
      message:
        "A label can signal one thing only (approve, complete or feedback)",
    });
  }
}

/** Labels that let a step under review go on (approve or complete). */
export function reviewGoOnLabels(review: ProcessStepReview): string[] {
  return [
    ...(review.approve?.labels ?? []),
    ...(review.complete?.labels ?? []),
  ];
}

/** An approval step's decision from an approve signal of the source item. */
export function approvalFromSignal(
  signal: ReviewDecision
): NonNullable<NonNullable<RunStepState["approval"]>["decision"]> {
  return {
    approved: true,
    comment: signal.label
      ? `Approved with the label "${signal.label}"${signal.author ? ` by ${signal.author}` : ""}.`
      : signal.text,
    decidedBy: signal.by,
    decidedAt: signal.at,
  };
}
