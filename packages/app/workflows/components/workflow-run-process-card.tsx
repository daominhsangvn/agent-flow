"use client";

import type { LoopStepCollectedFile } from "@agentflow-ai/loops-api/loop-step";
import {
  PROCESS_ANSWER_MAX,
  type ReviewDecision,
  ReviewDecisionKind,
  ReviewSignalVia,
  RunProcessSource,
  type RunProcessView,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowRunDetail,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
// Cross-slice: the step type labels belong to the project process editor.
import { PROCESS_STEP_TYPE_LABELS } from "@repo/app/projects/lib/process-draft";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  CircleIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  ShieldCheckIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  useAnswerWorkflowRunQuestions,
  useDecideWorkflowRunApproval,
  useDecideWorkflowRunReview,
} from "../hooks/use-workflows";
import {
  approvalFiles,
  RunStepProgress,
  runStepProgress,
} from "../lib/workflow-run-process";

export type WorkflowRunProcessCardProps = {
  run: WorkflowRunDetail;
  /** Admins decide approval steps; any member answers questions. */
  isAdmin: boolean;
};

/**
 * The project process a run follows: its steps and where the run is, the
 * questions a step waits on (answered here or on the source item), the
 * approval a step waits for, and the files the agent steps produced. Nothing
 * for a run on the built-in AgentFlow flow.
 */
export function WorkflowRunProcessCard({
  run,
  isAdmin,
}: Readonly<WorkflowRunProcessCardProps>) {
  const process = run.process;
  if (!process) {
    return null;
  }
  const waiting =
    process.waiting && run.status === WorkflowRunStatus.NeedsInput
      ? process.waiting
      : null;
  const approval =
    process.approval && run.status === WorkflowRunStatus.NeedsApproval
      ? process.approval
      : null;
  const review = process.review;

  return (
    <Card data-testid="workflow-run-process">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Process</CardTitle>
        <span className="text-muted-foreground text-xs">
          {process.source === RunProcessSource.Workflow
            ? "The workflow's own process"
            : `Version ${process.version}`}
          {process.toolkit ? ` · toolkit ${process.toolkit}` : ""}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <RunStepList process={process} status={run.status} />
        {waiting ? (
          <StepQuestions
            answered={waiting.answered}
            questions={waiting.questions}
            runId={run.id}
            stepName={stepName(process, waiting.stepId)}
          />
        ) : null}
        {approval ? (
          <StepApproval
            decided={approval.decided}
            files={approvalFiles(process, approval.show)}
            isAdmin={isAdmin}
            runId={run.id}
            stepName={stepName(process, approval.stepId)}
          />
        ) : null}
        {review ? (
          <StepReview
            isAdmin={isAdmin}
            review={review}
            runId={run.id}
            stepName={stepName(process, review.stepId)}
            waiting={
              review.waiting && run.status === WorkflowRunStatus.NeedsApproval
            }
          />
        ) : null}
        <StepFiles process={process} />
      </CardContent>
    </Card>
  );
}

function RunStepList({
  process,
  status,
}: Readonly<{ process: RunProcessView; status: WorkflowRunDetail["status"] }>) {
  const progress = runStepProgress(process, status);

  return (
    <ol className="space-y-1.5">
      {process.steps.map((step, index) => {
        const state = progress[index] ?? RunStepProgress.Upcoming;
        return (
          <li
            className="flex items-center gap-2 text-sm"
            data-progress={state}
            data-testid="process-run-step"
            key={step.id}
          >
            <StepProgressIcon progress={state} />
            <span
              className={cn(
                state === RunStepProgress.Upcoming && "text-muted-foreground",
                state === RunStepProgress.Current && "font-medium"
              )}
            >
              {step.name}
            </span>
            <Badge variant="muted">{PROCESS_STEP_TYPE_LABELS[step.type]}</Badge>
          </li>
        );
      })}
    </ol>
  );
}

function StepProgressIcon({
  progress,
}: Readonly<{ progress: RunStepProgress }>) {
  switch (progress) {
    case RunStepProgress.Done:
      return (
        <CheckCircle2Icon aria-label="Done" className="size-4 text-success" />
      );
    case RunStepProgress.Current:
      return (
        <CircleDotIcon aria-label="Current" className="size-4 text-primary" />
      );
    case RunStepProgress.Stopped:
      return (
        <XCircleIcon aria-label="Stopped" className="size-4 text-destructive" />
      );
    default:
      return (
        <CircleIcon
          aria-label="Upcoming"
          className="size-4 text-muted-foreground"
        />
      );
  }
}

function StepQuestions({
  runId,
  stepName: name,
  questions,
  answered,
}: Readonly<{
  runId: string;
  stepName: string;
  questions: NonNullable<RunProcessView["waiting"]>["questions"];
  answered: boolean;
}>) {
  const answer = useAnswerWorkflowRunQuestions();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const answers = questions.flatMap((question) => {
    const text = drafts[question.id]?.trim() ?? "";
    return text ? [{ id: question.id, answer: text }] : [];
  });

  if (answered) {
    return (
      <Alert variant="info">
        <MessageCircleQuestionIcon />
        <AlertTitle>{`Answers sent to "${name}"`}</AlertTitle>
        <AlertDescription>
          The step continues its session with them.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="space-y-4 rounded-md border p-4"
      data-testid="run-step-questions"
      onSubmit={async (event) => {
        event.preventDefault();
        await answer.mutateAsync({ runId, input: { answers } });
      }}
    >
      <div className="space-y-1">
        <p className="flex items-center gap-2 font-medium text-sm">
          <MessageCircleQuestionIcon className="size-4" />
          {`"${name}" needs answers`}
        </p>
        <p className="text-muted-foreground text-xs">
          Answer here or on the source item. Questions left empty are decided by
          the agent.
        </p>
      </div>
      {questions.map((question) => (
        <div
          className="space-y-2"
          data-testid="run-step-question"
          key={question.id}
        >
          <Label htmlFor={`answer-${question.id}`}>{question.question}</Label>
          {question.options && question.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => (
                <Button
                  aria-pressed={drafts[question.id] === option}
                  key={option}
                  onClick={() =>
                    setDrafts((current) => ({
                      ...current,
                      [question.id]: option,
                    }))
                  }
                  size="sm"
                  type="button"
                  variant={
                    drafts[question.id] === option ? "default" : "outline"
                  }
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            id={`answer-${question.id}`}
            maxLength={PROCESS_ANSWER_MAX}
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((current) => ({ ...current, [question.id]: value }));
            }}
            rows={2}
            value={drafts[question.id] ?? ""}
          />
        </div>
      ))}
      <Button disabled={answers.length === 0 || answer.isPending} type="submit">
        {answer.isPending ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : null}
        Send answers
      </Button>
    </form>
  );
}

function StepApproval({
  runId,
  stepName: name,
  files,
  isAdmin,
  decided,
}: Readonly<{
  runId: string;
  stepName: string;
  files: Array<{ stepId: string; file: LoopStepCollectedFile }>;
  isAdmin: boolean;
  decided: boolean;
}>) {
  const decide = useDecideWorkflowRunApproval();
  const [comment, setComment] = useState("");
  const submit = async (approved: boolean) => {
    await decide.mutateAsync({ runId, input: { approved, comment } });
  };

  return (
    <div
      className="space-y-4 rounded-md border p-4"
      data-testid="run-step-approval"
    >
      <p className="flex items-center gap-2 font-medium text-sm">
        <ShieldCheckIcon className="size-4" />
        {`"${name}" waits for an approval`}
      </p>
      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map(({ file }) => (
            <StepFile file={file} key={file.path} open />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          The steps produced no file to review.
        </p>
      )}
      <ApprovalControls
        comment={comment}
        decided={decided}
        isAdmin={isAdmin}
        isPending={decide.isPending}
        onComment={setComment}
        onDecide={submit}
      />
    </div>
  );
}

function ApprovalControls({
  isAdmin,
  decided,
  isPending,
  comment,
  onComment,
  onDecide,
}: Readonly<{
  isAdmin: boolean;
  decided: boolean;
  isPending: boolean;
  comment: string;
  onComment: (comment: string) => void;
  onDecide: (approved: boolean) => Promise<void>;
}>): ReactNode {
  if (decided) {
    return (
      <p className="text-muted-foreground text-sm">
        Decided. The run goes on in a moment.
      </p>
    );
  }
  if (!isAdmin) {
    return (
      <p className="text-muted-foreground text-sm">
        An org admin approves or rejects this step.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="approval-comment">Comment</Label>
      <Textarea
        id="approval-comment"
        maxLength={PROCESS_ANSWER_MAX}
        onChange={(event) => onComment(event.target.value)}
        placeholder="Why it is rejected, or a note for the run"
        rows={2}
        value={comment}
      />
      <div className="flex gap-2">
        <Button
          disabled={isPending}
          onClick={() => onDecide(true)}
          type="button"
        >
          <CheckIcon className="size-4" />
          Approve
        </Button>
        <Button
          disabled={isPending}
          onClick={() => onDecide(false)}
          type="button"
          variant="outline"
        >
          <XIcon className="size-4" />
          Reject
        </Button>
      </div>
    </div>
  );
}

function StepFiles({ process }: Readonly<{ process: RunProcessView }>) {
  if (process.stepFiles.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="run-step-files">
      <p className="font-medium text-sm">Step files</p>
      {process.stepFiles.map((group) => (
        <div className="space-y-1.5" key={group.stepId}>
          <p className="text-muted-foreground text-xs">
            {stepName(process, group.stepId)}
          </p>
          {group.files.map((file) => (
            <StepFile file={file} key={file.path} />
          ))}
        </div>
      ))}
    </div>
  );
}

function StepFile({
  file,
  open = false,
}: Readonly<{ file: LoopStepCollectedFile; open?: boolean }>) {
  return (
    <details className="rounded-md border" open={open}>
      <summary className="cursor-pointer px-3 py-2 font-mono text-xs">
        {file.path}
        {file.truncated ? (
          <span className="ml-2 text-muted-foreground">(truncated)</span>
        ) : null}
      </summary>
      <div className="max-h-96 overflow-auto border-t px-3 py-2">
        {MARKDOWN_FILE.test(file.path) ? (
          <MarkdownContent dense skipHtml text={file.content} />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs">
            {file.content}
          </pre>
        )}
      </div>
    </details>
  );
}

function stepName(process: RunProcessView, stepId: string): string {
  return process.steps.find((step) => step.id === stepId)?.name ?? stepId;
}

const MARKDOWN_FILE = /\.(md|markdown)$/i;

type ReviewView = NonNullable<RunProcessView["review"]>;

/**
 * A step under review: how to decide it on the source item, its earlier
 * rounds, and the decisions in AgentFlow.
 */
function StepReview({
  runId,
  stepName: name,
  review,
  waiting,
  isAdmin,
}: Readonly<{
  runId: string;
  stepName: string;
  review: ReviewView;
  waiting: boolean;
  isAdmin: boolean;
}>) {
  const decide = useDecideWorkflowRunReview();
  const [comment, setComment] = useState("");
  const submit = async (decision: ReviewDecisionKind) => {
    await decide.mutateAsync({ runId, input: { decision, comment } });
    setComment("");
  };
  return (
    <div
      className="space-y-4 rounded-md border p-4"
      data-testid="run-step-review"
    >
      <p className="flex items-center gap-2 font-medium text-sm">
        <MessagesSquareIcon className="size-4" />
        {waiting
          ? `"${name}" waits for review (round ${review.round})`
          : `"${name}" is under review (round ${review.round})`}
      </p>
      <ReviewSignals review={review} />
      <ReviewHistory history={review.history} />
      {waiting ? (
        <ReviewControls
          comment={comment}
          isAdmin={isAdmin}
          isPending={decide.isPending}
          onComment={setComment}
          onDecide={submit}
          planStep={review.planStep}
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          The step is working on the latest feedback.
        </p>
      )}
    </div>
  );
}

/** How people decide the review on the source item. */
function ReviewSignals({ review }: Readonly<{ review: ReviewView }>) {
  const hints: string[] = [];
  if (review.goOnLabels.length > 0) {
    hints.push(
      `add ${labelList(review.goOnLabels)} to ${review.planStep ? "approve" : "finish the review"}`
    );
  }
  if (review.feedbackLabels.length > 0) {
    hints.push(`add ${labelList(review.feedbackLabels)} to ask for changes`);
  }
  if (review.mention) {
    hints.push("mention the bot in a comment with the changes you want");
  }
  if (hints.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-sm">
      {`On the ticket: ${hints.join("; ")}.`}
    </p>
  );
}

function ReviewHistory({
  history,
}: Readonly<{ history: readonly ReviewDecision[] }>) {
  if (history.length === 0) {
    return null;
  }
  return (
    <ol className="space-y-2" data-testid="run-step-review-history">
      {history.map((decision) => (
        <li className="text-sm" key={`${decision.at}-${decision.kind}`}>
          <span className="font-medium">{decisionLabel(decision)}</span>
          <span className="text-muted-foreground">
            {` · ${decisionSource(decision)}`}
          </span>
          {decision.text ? (
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
              {decision.text}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ReviewControls({
  planStep,
  isAdmin,
  isPending,
  comment,
  onComment,
  onDecide,
}: Readonly<{
  planStep: boolean;
  isAdmin: boolean;
  isPending: boolean;
  comment: string;
  onComment: (comment: string) => void;
  onDecide: (decision: ReviewDecisionKind) => Promise<void>;
}>): ReactNode {
  return (
    <div className="space-y-2">
      <Label htmlFor="review-comment">Comment</Label>
      <Textarea
        id="review-comment"
        maxLength={PROCESS_ANSWER_MAX}
        onChange={(event) => onComment(event.target.value)}
        placeholder="The changes you want, or a note for the run"
        rows={3}
        value={comment}
      />
      <div className="flex flex-wrap gap-2">
        {isAdmin ? (
          <Button
            disabled={isPending}
            onClick={() => onDecide(ReviewDecisionKind.Approve)}
            type="button"
          >
            <CheckIcon className="size-4" />
            {planStep ? "Approve" : "Done"}
          </Button>
        ) : null}
        <Button
          disabled={isPending}
          onClick={() => onDecide(ReviewDecisionKind.Feedback)}
          type="button"
          variant="secondary"
        >
          <MessagesSquareIcon className="size-4" />
          {planStep ? "Replan" : "Request changes"}
        </Button>
        {isAdmin ? (
          <Button
            disabled={isPending}
            onClick={() => onDecide(ReviewDecisionKind.Reject)}
            type="button"
            variant="outline"
          >
            <XIcon className="size-4" />
            Reject
          </Button>
        ) : null}
      </div>
      {isAdmin ? null : (
        <p className="text-muted-foreground text-xs">
          An org admin approves or rejects; you can ask for changes.
        </p>
      )}
    </div>
  );
}

function labelList(labels: readonly string[]): string {
  return labels.map((label) => `"${label}"`).join(" or ");
}

function decisionLabel(decision: ReviewDecision): string {
  switch (decision.kind) {
    case ReviewDecisionKind.Approve:
      return "Approved";
    case ReviewDecisionKind.Feedback:
      return "Changes asked";
    default:
      return "Rejected";
  }
}

function decisionSource(decision: ReviewDecision): string {
  const who = decision.author ?? "a member";
  switch (decision.via) {
    case ReviewSignalVia.Label:
      return `label "${decision.label ?? ""}" by ${who}`;
    case ReviewSignalVia.Mention:
      return `comment by ${who}`;
    default:
      return "in AgentFlow";
  }
}
