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
} from "@agentflow-ai/loops-api/loop-step";
import { z } from "zod";
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
});

const stepDocumentSchema = z.object({
  type: z.enum(ProcessDocumentType),
  /** One of the step's files (from the workspace root); its content is the document. */
  path: relativePathSchema,
  /** Template ({{issue.key}}, {{issue.title}}); empty: the run's Issue title. */
  title: z.string().trim().max(PROCESS_DOCUMENT_TITLE_MAX).default(""),
});
export type ProcessStepDocument = z.infer<typeof stepDocumentSchema>;

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
    const planIndex = process.steps.findIndex(
      (step) => step.type === ProcessStepType.AgentFlowPlan
    );
    process.steps.forEach((step, index) => {
      if (step.type === ProcessStepType.AgentFlowPlan && index !== planIndex) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "type"],
          message: "A process has at most one AgentFlow plan step",
        });
      }
      // EXECUTE continues the PLAN loop's state on the same computer.
      if (
        step.type === ProcessStepType.AgentFlowExecute &&
        (planIndex < 0 || planIndex > index)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "type"],
          message:
            "The AgentFlow implement step needs a AgentFlow plan step before it",
        });
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
  /** Files each agent step collected, from its latest loop. */
  stepFiles: Array<{
    stepId: string;
    loopId: string;
    files: LoopStepCollectedFile[];
  }>;
};
