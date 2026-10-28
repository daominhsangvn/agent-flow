"use client";

import {
  IntegrationToolCallStatus,
  ToolCallDecision,
  type WorkflowRunToolCall,
} from "@repo/api/src/types/integration-tools";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useDecideWorkflowToolCall } from "../hooks/use-workflows";
import { WORKFLOW_TOOL_CALL_STATUS_LABELS } from "../lib/workflow-labels";

/**
 * The integration tool calls the run's agents made (instructions and process
 * agent steps, docs/workflows.md "Integration tools"): what each asked, on
 * which connection key, and how it went. A write whose grant requires
 * approval waits here for an org admin to approve (carry out) or reject it.
 */
export function WorkflowRunToolCallsCard({
  runId,
  toolCalls,
  isAdmin,
  stepName,
}: Readonly<{
  runId: string;
  toolCalls: readonly WorkflowRunToolCall[];
  isAdmin: boolean;
  /** The process step's name for a step id. */
  stepName: (stepId: string) => string;
}>) {
  if (toolCalls.length === 0) {
    return null;
  }
  const waiting = toolCalls.filter(
    (call) => call.status === IntegrationToolCallStatus.PendingApproval
  ).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Integration tool calls</CardTitle>
        <CardDescription>
          {waiting > 0
            ? `${waiting} ${waiting === 1 ? "write waits" : "writes wait"} for approval.`
            : "What the run's agents read and wrote through their connections."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
                {isAdmin ? (
                  <TableHead>
                    <span className="sr-only">Decision</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {toolCalls.map((call) => (
                <ToolCallRow
                  call={call}
                  isAdmin={isAdmin}
                  key={call.id}
                  runId={runId}
                  stepName={stepName}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ToolCallRow({
  call,
  runId,
  isAdmin,
  stepName,
}: Readonly<{
  call: WorkflowRunToolCall;
  runId: string;
  isAdmin: boolean;
  stepName: (stepId: string) => string;
}>) {
  const decide = useDecideWorkflowToolCall();
  const pending = call.status === IntegrationToolCallStatus.PendingApproval;
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{call.tool}</TableCell>
      <TableCell className="font-mono text-xs">
        {call.connectionKey ?? "—"}
      </TableCell>
      <TableCell className="text-xs">
        {call.stepId ? `Step ${stepName(call.stepId)}` : "Instruction"}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANTS[call.status]}>
          {WORKFLOW_TOOL_CALL_STATUS_LABELS[call.status]}
        </Badge>
      </TableCell>
      <TableCell className="max-w-[24rem] break-words text-xs">
        <ToolCallResult call={call} />
      </TableCell>
      {isAdmin ? (
        <TableCell className="text-right">
          {pending ? (
            <div className="flex justify-end gap-2">
              <Button
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({
                    runId,
                    callId: call.id,
                    decision: ToolCallDecision.Approve,
                  })
                }
                size="sm"
                type="button"
              >
                {decide.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CheckIcon className="size-3.5" />
                )}
                Approve
              </Button>
              <Button
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({
                    runId,
                    callId: call.id,
                    decision: ToolCallDecision.Reject,
                  })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <XIcon className="size-3.5" />
                Reject
              </Button>
            </div>
          ) : null}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function ToolCallResult({ call }: Readonly<{ call: WorkflowRunToolCall }>) {
  const arguments_ = Object.entries(call.input)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join(" · ");
  return (
    <div className="space-y-0.5">
      {arguments_ ? (
        <p className="text-muted-foreground">{arguments_}</p>
      ) : null}
      {call.error ? <p className="text-destructive">{call.error}</p> : null}
      {call.externalRef ? <p>Reference: {call.externalRef}</p> : null}
      {call.decidedBy ? (
        <p className="text-muted-foreground">
          {call.status === IntegrationToolCallStatus.Rejected
            ? "Rejected"
            : "Approved"}{" "}
          by {call.decidedBy}
        </p>
      ) : null}
    </div>
  );
}

const ARGUMENT_TEXT_MAX = 120;

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > ARGUMENT_TEXT_MAX
    ? `${text.slice(0, ARGUMENT_TEXT_MAX)}…`
    : text;
}

const STATUS_VARIANTS: Record<
  IntegrationToolCallStatus,
  "success" | "destructive" | "warning" | "neutral" | "info"
> = {
  [IntegrationToolCallStatus.Running]: "info",
  [IntegrationToolCallStatus.Succeeded]: "success",
  [IntegrationToolCallStatus.Failed]: "destructive",
  [IntegrationToolCallStatus.Refused]: "neutral",
  [IntegrationToolCallStatus.PendingApproval]: "warning",
  [IntegrationToolCallStatus.Rejected]: "neutral",
};
