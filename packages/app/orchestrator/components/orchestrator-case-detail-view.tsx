"use client";

import {
  type OrchestratorCaseDetail,
  OrchestratorCaseStatus,
} from "@repo/api/src/types/orchestrator";
// Cross-slice: provider logo.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
// Cross-slice: retryable error block, API errors and shared dialogs/formatters.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
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
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { InboxIcon } from "lucide-react";
import { useState } from "react";
import {
  isCaseActive,
  useOrchestratorCase,
  useSetOrchestratorCaseStatus,
} from "../hooks/use-orchestrator-cases";
import { caseSourceProvider } from "../lib/case-source";
import {
  OrchestratorCaseConversationCard,
  OrchestratorCaseWaitsCard,
} from "./orchestrator-case-conversation-card";
import { OrchestratorCaseDecisionsCard } from "./orchestrator-case-decisions-card";
import { OrchestratorCaseWorkCards } from "./orchestrator-case-work-cards";

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
      <CaseHeader detail={detail} isAdmin={isAdmin} />
      {detail.notes ? <CaseNotesCard notes={detail.notes} /> : null}
      <OrchestratorCaseDecisionsCard
        caseId={detail.id}
        decisions={detail.decisions}
        isAdmin={isAdmin}
      />
      <OrchestratorCaseWorkCards detail={detail} />
      {detail.conversations.map((conversation) => (
        <OrchestratorCaseConversationCard
          caseId={detail.id}
          conversation={conversation}
          isAdmin={isAdmin}
          key={conversation.id}
          tasks={detail.tasks}
        />
      ))}
      <OrchestratorCaseWaitsCard waits={detail.waits} />
    </div>
  );
}

function CaseHeader({
  detail,
  isAdmin,
}: Readonly<{ detail: OrchestratorCaseDetail; isAdmin: boolean }>) {
  const buildOrgPath = useOrgPath();
  const setStatus = useSetOrchestratorCaseStatus(detail.id);
  const [confirmClose, setConfirmClose] = useState(false);
  const isOpen = detail.status === OrchestratorCaseStatus.Open;
  const provider = caseSourceProvider(detail.sourceKey);
  const cost =
    detail.costUsd === null
      ? "cost unknown"
      : formatCostPrecise(detail.costUsd);

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {provider ? (
            <ProviderIcon className="size-5" provider={provider} />
          ) : null}
          <h2 className="font-semibold text-xl">{detail.title}</h2>
          <Badge variant={isOpen ? "default" : "outline"}>
            {isOpen ? "Open" : "Closed"}
          </Badge>
          {isCaseActive(detail) ? <Badge variant="info">Running</Badge> : null}
        </div>
        <p className="text-muted-foreground text-sm">
          {"Workflow "}
          <Link
            className="text-foreground hover:underline"
            href={buildOrgPath(`/workflows/${detail.workflow.id}?tab=cases`)}
          >
            {detail.workflow.name}
          </Link>
          {` · opened ${formatRelativeTime(detail.createdAt)}`}
          {` · last activity ${formatRelativeTime(detail.updatedAt)}`}
          {` · ${detail.taskCount} ${detail.taskCount === 1 ? "task" : "tasks"}`}
          {` · ${detail.turnCount} ${detail.turnCount === 1 ? "turn" : "turns"}`}
          {` · ${cost}`}
        </p>
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
    </div>
  );
}

function CaseNotesCard({ notes }: Readonly<{ notes: string }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notes</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm">{notes}</p>
      </CardContent>
    </Card>
  );
}
