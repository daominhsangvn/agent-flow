"use client";

import {
  type OrchestratorCaseDecision,
  OrchestratorDecisionStatus,
} from "@repo/api/src/types/orchestrator";
import { formatDateTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useState } from "react";
import { useDecideOrchestratorDecision } from "../hooks/use-orchestrator-cases";

const DECISION_STATUS_LABELS: Record<OrchestratorDecisionStatus, string> = {
  [OrchestratorDecisionStatus.Pending]: "Pending",
  [OrchestratorDecisionStatus.Approved]: "Approved",
  [OrchestratorDecisionStatus.Rejected]: "Rejected",
};

export function OrchestratorCaseDecisionsCard({
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
