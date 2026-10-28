"use client";

import {
  type OrchestratorCaseConversation,
  type OrchestratorCaseDecision,
  type OrchestratorCaseDetail,
  type OrchestratorCaseMessage,
  OrchestratorCaseStatus,
  type OrchestratorCaseTask,
  type OrchestratorCaseTurn,
  type OrchestratorCaseWait,
  OrchestratorDecisionStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
} from "@repo/api/src/types/orchestrator";
// Cross-slice: retryable error block, API errors and shared dialogs/formatters.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import {
  formatDateTime,
  formatRelativeTime,
} from "@repo/app/shared/lib/date-utils";
import {
  formatCostPrecise,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { InboxIcon } from "lucide-react";
import { useState } from "react";
import {
  useCancelOrchestratorTurn,
  useDecideOrchestratorDecision,
  useOrchestratorCase,
  useSetOrchestratorCaseStatus,
} from "../hooks/use-orchestrator-cases";
import {
  buildConversationTimeline,
  type CaseTimelineEntry,
  CaseTimelineEntryKind,
} from "../lib/case-timeline";

type BadgeVariant = "default" | "secondary" | "success" | "error" | "outline";

const TURN_STATUS_LABELS: Record<OrchestratorTurnStatus, string> = {
  [OrchestratorTurnStatus.Running]: "Running",
  [OrchestratorTurnStatus.Succeeded]: "Succeeded",
  [OrchestratorTurnStatus.Failed]: "Failed",
  [OrchestratorTurnStatus.Superseded]: "Superseded",
};

const TURN_STATUS_VARIANTS: Record<OrchestratorTurnStatus, BadgeVariant> = {
  [OrchestratorTurnStatus.Running]: "default",
  [OrchestratorTurnStatus.Succeeded]: "success",
  [OrchestratorTurnStatus.Failed]: "error",
  [OrchestratorTurnStatus.Superseded]: "outline",
};

const TASK_STATUS_LABELS: Record<OrchestratorTaskStatus, string> = {
  [OrchestratorTaskStatus.Queued]: "Queued",
  [OrchestratorTaskStatus.Running]: "Running",
  [OrchestratorTaskStatus.Succeeded]: "Succeeded",
  [OrchestratorTaskStatus.Failed]: "Failed",
  [OrchestratorTaskStatus.Cancelled]: "Cancelled",
};

const TASK_STATUS_VARIANTS: Record<OrchestratorTaskStatus, BadgeVariant> = {
  [OrchestratorTaskStatus.Queued]: "secondary",
  [OrchestratorTaskStatus.Running]: "default",
  [OrchestratorTaskStatus.Succeeded]: "success",
  [OrchestratorTaskStatus.Failed]: "error",
  [OrchestratorTaskStatus.Cancelled]: "outline",
};

const MESSAGE_KIND_LABELS: Record<OrchestratorMessageKind, string> = {
  [OrchestratorMessageKind.Message]: "Message",
  [OrchestratorMessageKind.TaskResults]: "Task results",
  [OrchestratorMessageKind.Decision]: "Decision",
  [OrchestratorMessageKind.Deadline]: "Deadline",
  [OrchestratorMessageKind.Reply]: "Reply",
  [OrchestratorMessageKind.StatusChanged]: "Status changed",
  [OrchestratorMessageKind.LabelAdded]: "Label added",
  [OrchestratorMessageKind.LabelRemoved]: "Label removed",
};

const DECISION_STATUS_LABELS: Record<OrchestratorDecisionStatus, string> = {
  [OrchestratorDecisionStatus.Pending]: "Pending",
  [OrchestratorDecisionStatus.Approved]: "Approved",
  [OrchestratorDecisionStatus.Rejected]: "Rejected",
};

const CLAMP_CHARS = 600;
const SHORT_ID_CHARS = 8;
const EMPTY_VALUE = "—";

export type OrchestratorCaseDetailViewProps = {
  caseId: string;
  /** Org admins act on the case; members read it (the API enforces it). */
  isAdmin: boolean;
};

/** One orchestrator case: decisions, conversations (messages, turns, tasks) and waits. */
export function OrchestratorCaseDetailView({
  caseId,
  isAdmin,
}: Readonly<OrchestratorCaseDetailViewProps>) {
  const query = useOrchestratorCase(caseId);

  if (query.isLoading) {
    return (
      <div aria-label="Loading case" className="space-y-4" role="status">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (query.error instanceof ApiError && query.error.isNotFound()) {
    return <EmptyState icon={InboxIcon} title="This case does not exist." />;
  }
  if (query.error || !query.data) {
    return (
      <QueryErrorMessage
        error={query.error}
        onRetry={() => {
          query.refetch();
        }}
        title="Couldn't load the case"
      />
    );
  }

  return <CaseContent detail={query.data} isAdmin={isAdmin} />;
}

function CaseContent({
  detail,
  isAdmin,
}: Readonly<{ detail: OrchestratorCaseDetail; isAdmin: boolean }>) {
  return (
    <div className="space-y-6" data-testid="orchestrator-case-detail">
      <CaseHeaderCard detail={detail} isAdmin={isAdmin} />
      <DecisionsCard
        caseId={detail.id}
        decisions={detail.decisions}
        isAdmin={isAdmin}
      />
      {detail.conversations.map((conversation) => (
        <ConversationCard
          caseId={detail.id}
          conversation={conversation}
          isAdmin={isAdmin}
          key={conversation.id}
          tasks={detail.tasks}
        />
      ))}
      <WaitsCard waits={detail.waits} />
    </div>
  );
}

function CaseHeaderCard({
  detail,
  isAdmin,
}: Readonly<{ detail: OrchestratorCaseDetail; isAdmin: boolean }>) {
  const setStatus = useSetOrchestratorCaseStatus(detail.id);
  const [confirmClose, setConfirmClose] = useState(false);
  const isOpen = detail.status === OrchestratorCaseStatus.Open;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle>{detail.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <Badge variant={isOpen ? "default" : "outline"}>
              {isOpen ? "Open" : "Closed"}
            </Badge>
            {detail.sourceKey ? <span>{detail.sourceKey}</span> : null}
            <span>Created {formatDateTime(detail.createdAt)}</span>
            <span>Updated {formatRelativeTime(detail.updatedAt)}</span>
          </div>
        </div>
        {isAdmin ? (
          <Button
            disabled={setStatus.isPending}
            onClick={() => {
              if (isOpen) {
                setConfirmClose(true);
                return;
              }
              setStatus.mutate({ status: OrchestratorCaseStatus.Open });
            }}
            type="button"
            variant="outline"
          >
            {isOpen ? "Close case" : "Reopen case"}
          </Button>
        ) : null}
      </CardHeader>
      {detail.notes ? (
        <CardContent>
          <p className="whitespace-pre-wrap text-sm">{detail.notes}</p>
        </CardContent>
      ) : null}
      <ConfirmationDialog
        confirmLabel="Close case"
        description="Running turns and tasks keep going. A new message in the thread reopens the case."
        isPending={setStatus.isPending}
        onConfirm={async () => {
          await setStatus.mutateAsync({
            status: OrchestratorCaseStatus.Closed,
          });
        }}
        onOpenChange={setConfirmClose}
        open={confirmClose}
        title="Close this case?"
      />
    </Card>
  );
}

function DecisionsCard({
  caseId,
  decisions,
  isAdmin,
}: Readonly<{
  caseId: string;
  decisions: OrchestratorCaseDecision[];
  isAdmin: boolean;
}>) {
  if (decisions.length === 0) {
    return null;
  }
  const pending = decisions.filter(
    (decision) => decision.status === OrchestratorDecisionStatus.Pending
  );
  const decided = decisions.filter(
    (decision) => decision.status !== OrchestratorDecisionStatus.Pending
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {[...pending, ...decided].map((decision) => (
          <DecisionRow
            caseId={caseId}
            decision={decision}
            isAdmin={isAdmin}
            key={decision.id}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function DecisionRow({
  caseId,
  decision,
  isAdmin,
}: Readonly<{
  caseId: string;
  decision: OrchestratorCaseDecision;
  isAdmin: boolean;
}>) {
  const decide = useDecideOrchestratorDecision(caseId);
  const [comment, setComment] = useState("");
  const isPending = decision.status === OrchestratorDecisionStatus.Pending;

  const submit = (approved: boolean) => {
    const trimmed = comment.trim();
    decide.mutate({
      decisionId: decision.id,
      input: trimmed ? { approved, comment: trimmed } : { approved },
    });
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="whitespace-pre-wrap text-sm">{decision.question}</p>
      {isPending ? (
        isAdmin && (
          <div className="space-y-2">
            <Textarea
              aria-label="Comment"
              onChange={(event) => setComment(event.target.value)}
              placeholder="Comment (optional)"
              value={comment}
            />
            <div className="flex gap-2">
              <Button
                disabled={decide.isPending}
                onClick={() => submit(true)}
                size="sm"
                type="button"
              >
                Approve
              </Button>
              <Button
                disabled={decide.isPending}
                onClick={() => submit(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                Reject
              </Button>
            </div>
          </div>
        )
      ) : (
        <DecidedDetails decision={decision} />
      )}
    </div>
  );
}

function DecidedDetails({
  decision,
}: Readonly<{ decision: OrchestratorCaseDecision }>) {
  return (
    <div className="space-y-1 text-muted-foreground text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            decision.status === OrchestratorDecisionStatus.Approved
              ? "success"
              : "error"
          }
        >
          {DECISION_STATUS_LABELS[decision.status]}
        </Badge>
        {decision.decidedBy ? <span>by {decision.decidedBy}</span> : null}
        {decision.via ? <span>via {decision.via}</span> : null}
        {decision.decidedAt ? (
          <span>{formatDateTime(decision.decidedAt)}</span>
        ) : null}
      </div>
      {decision.comment ? (
        <p className="whitespace-pre-wrap">{decision.comment}</p>
      ) : null}
    </div>
  );
}

function ConversationCard({
  caseId,
  conversation,
  tasks,
  isAdmin,
}: Readonly<{
  caseId: string;
  conversation: OrchestratorCaseConversation;
  tasks: OrchestratorCaseTask[];
  isAdmin: boolean;
}>) {
  const timeline = buildConversationTimeline(conversation, tasks);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{conversation.channelKey}</CardTitle>
        <Badge variant="outline">{conversation.status}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {timeline.entries.map((entry) => (
          <TimelineEntry
            caseId={caseId}
            entry={entry}
            isAdmin={isAdmin}
            key={timelineKey(entry)}
          />
        ))}
        {timeline.unassignedTasks.length > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-sm">Other tasks</p>
            {timeline.unassignedTasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TimelineEntry({
  entry,
  caseId,
  isAdmin,
}: Readonly<{ entry: CaseTimelineEntry; caseId: string; isAdmin: boolean }>) {
  if (entry.kind === CaseTimelineEntryKind.Message) {
    return <MessageRow message={entry.message} />;
  }
  return (
    <TurnRow
      caseId={caseId}
      isAdmin={isAdmin}
      tasks={entry.tasks}
      turn={entry.turn}
    />
  );
}

function MessageRow({
  message,
}: Readonly<{ message: OrchestratorCaseMessage }>) {
  const origin =
    message.origin === OrchestratorMessageOrigin.External
      ? "External"
      : "Orchestrator";

  return (
    <div className="space-y-1 rounded-md bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">
          {message.actor ?? origin}
        </span>
        <Badge variant="outline">{MESSAGE_KIND_LABELS[message.kind]}</Badge>
        <span>{origin}</span>
        <span>{formatDateTime(message.createdAt)}</span>
      </div>
      <ClampedText text={message.text} />
    </div>
  );
}

function TurnRow({
  turn,
  tasks,
  caseId,
  isAdmin,
}: Readonly<{
  turn: OrchestratorCaseTurn;
  tasks: OrchestratorCaseTask[];
  caseId: string;
  isAdmin: boolean;
}>) {
  const cancel = useCancelOrchestratorTurn(caseId);
  const [confirmStop, setConfirmStop] = useState(false);
  const isRunning = turn.status === OrchestratorTurnStatus.Running;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={TURN_STATUS_VARIANTS[turn.status]}>
          {TURN_STATUS_LABELS[turn.status]}
        </Badge>
        <span className="font-medium">Turn</span>
        {turn.ended ? (
          <span className="text-muted-foreground">ended: {turn.ended}</span>
        ) : null}
        {turn.runnerName ? (
          <span className="text-muted-foreground">on {turn.runnerName}</span>
        ) : null}
        <span className="text-muted-foreground">{turnDuration(turn)}</span>
        <span className="text-muted-foreground">{usageText(turn)}</span>
        {isRunning && isAdmin ? (
          <Button
            disabled={cancel.isPending}
            onClick={() => setConfirmStop(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Stop turn
          </Button>
        ) : null}
      </div>
      {turn.summary ? (
        <p className="whitespace-pre-wrap text-sm">{turn.summary}</p>
      ) : null}
      {turn.error ? (
        <p className="whitespace-pre-wrap text-destructive text-sm">
          {turn.error}
        </p>
      ) : null}
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
      <ConfirmationDialog
        confirmLabel="Stop turn"
        description="The runner is asked to stop this turn. Its messages are not retried."
        isPending={cancel.isPending}
        onConfirm={async () => {
          await cancel.mutateAsync(turn.id);
        }}
        onOpenChange={setConfirmStop}
        open={confirmStop}
        title="Stop this turn?"
        variant="destructive"
      />
    </div>
  );
}

function TaskRow({ task }: Readonly<{ task: OrchestratorCaseTask }>) {
  const buildOrgPath = useOrgPath();

  return (
    <div className="space-y-1 rounded-md bg-muted/30 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={TASK_STATUS_VARIANTS[task.status]}>
          {TASK_STATUS_LABELS[task.status]}
        </Badge>
        <code className="text-xs">
          {task.command} {task.args}
        </code>
        {task.runnerName ? (
          <span className="text-muted-foreground">on {task.runnerName}</span>
        ) : null}
        <span className="text-muted-foreground">{task.mode}</span>
        <TaskForkNote task={task} />
        {task.waiting ? (
          <span className="text-muted-foreground text-xs">{task.waiting}</span>
        ) : null}
        {task.loopId ? (
          <Link
            className="text-primary hover:underline"
            href={buildOrgPath(`/loops/${task.loopId}`)}
          >
            Open loop
          </Link>
        ) : null}
      </div>
      {task.reply ? <ClampedText text={task.reply} /> : null}
      {task.questions.length > 0 ? (
        <ul className="list-disc pl-5">
          {task.questions.map((question) => (
            <li key={question.id}>{question.question}</li>
          ))}
        </ul>
      ) : null}
      {task.error ? (
        <p className="whitespace-pre-wrap text-destructive">{task.error}</p>
      ) : null}
    </div>
  );
}

function TaskForkNote({ task }: Readonly<{ task: OrchestratorCaseTask }>) {
  if (!task.resumeTaskId) {
    return null;
  }
  return (
    <span className="text-muted-foreground">
      {task.fork ? "forks" : "resumes"} task{" "}
      {task.resumeTaskId.slice(0, SHORT_ID_CHARS)}
    </span>
  );
}

function WaitsCard({ waits }: Readonly<{ waits: OrchestratorCaseWait[] }>) {
  if (waits.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {waits.map((wait) => (
          <div
            className="flex flex-wrap items-center gap-2 text-sm"
            key={wait.id}
          >
            <Badge variant={wait.firedAt ? "outline" : "default"}>
              {wait.firedAt ? "Fired" : "Open"}
            </Badge>
            <span>{wait.kind}</span>
            <span className="text-muted-foreground">
              {wait.taskIds
                .map((id) => id.slice(0, SHORT_ID_CHARS))
                .join(", ") || EMPTY_VALUE}
            </span>
            {wait.deadline ? (
              <span className="text-muted-foreground">
                deadline {formatDateTime(wait.deadline)}
              </span>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ClampedText({ text }: Readonly<{ text: string }>) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > CLAMP_CHARS;
  const shown = isLong && !expanded ? `${text.slice(0, CLAMP_CHARS)}…` : text;

  return (
    <div>
      <p className="whitespace-pre-wrap text-sm">{shown}</p>
      {isLong ? (
        <Button
          onClick={() => setExpanded(!expanded)}
          size="sm"
          type="button"
          variant="link"
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function timelineKey(entry: CaseTimelineEntry): string {
  return entry.kind === CaseTimelineEntryKind.Message
    ? `m-${entry.message.id}`
    : `t-${entry.turn.id}`;
}

function turnDuration(turn: OrchestratorCaseTurn): string {
  if (!turn.finishedAt) {
    return EMPTY_VALUE;
  }
  const ms =
    new Date(turn.finishedAt).getTime() - new Date(turn.startedAt).getTime();
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Unknown usage is shown as a dash, never as zero tokens or $0.00. */
function usageText(turn: OrchestratorCaseTurn): string {
  const usage = turn.usage;
  if (!usage) {
    return EMPTY_VALUE;
  }
  const parts: string[] = [];
  if (usage.inputTokens !== null) {
    parts.push(`${formatTokenCount(usage.inputTokens)} in`);
  }
  if (usage.outputTokens !== null) {
    parts.push(`${formatTokenCount(usage.outputTokens)} out`);
  }
  if (usage.costUsd !== null) {
    parts.push(formatCostPrecise(usage.costUsd));
  }
  return parts.length > 0 ? parts.join(" · ") : EMPTY_VALUE;
}
