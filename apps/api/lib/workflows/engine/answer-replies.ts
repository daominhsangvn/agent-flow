import {
  IntegrationToolCallStatus,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import {
  WorkflowActionRunStatus,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import { JiraActionType } from "@/lib/integrations/providers/jira/constants";
import type { InboundEvent } from "@/lib/integrations/types";

/**
 * Replies to a run's own comments (docs/workflows.md "Project process"): a
 * comment written in the thread of a comment a run waiting for answers
 * (`needs_input`) posted on its source item, such as its questions, resumes
 * that run, whatever the workflow's triggers are, and never starts one. The
 * comment's run is known from the comment's external ref (the comment tool
 * call or the comment action that posted it), so two runs waiting on the
 * same item each get the replies to their own comments.
 */

export type RepliedRun = { runId: string; workflowId: string };

/** The waiting runs of the event's item that posted the comment it replies to. */
export async function findRepliedRuns(input: {
  connection: LoadedConnection;
  event: InboundEvent;
  projectConnectionId: string;
  sourceKey: string;
}): Promise<RepliedRun[]> {
  const parentId = input.connection.provider.answerReply?.(input.event) ?? null;
  if (!parentId) {
    return [];
  }
  const organizationId = input.connection.record.organizationId;
  const waiting = await withDb((db) =>
    db.workflowRun.findMany({
      where: {
        organizationId,
        projectConnectionId: input.projectConnectionId,
        sourceKey: input.sourceKey,
        status: WorkflowRunStatus.NeedsInput,
      },
      select: { id: true, workflowId: true },
    })
  );
  if (waiting.length === 0) {
    return [];
  }
  const runId = { in: waiting.map((run) => run.id) };
  const [calls, actionRuns] = await Promise.all([
    withDb((db) =>
      db.integrationToolCall.findMany({
        where: {
          organizationId,
          runId,
          tool: IntegrationToolName.SourceItemComment,
          status: IntegrationToolCallStatus.Succeeded,
          externalRef: parentId,
        },
        select: { runId: true },
      })
    ),
    withDb((db) =>
      db.workflowActionRun.findMany({
        where: {
          organizationId,
          runId,
          actionType: JiraActionType.AddComment,
          status: WorkflowActionRunStatus.Succeeded,
          externalRef: parentId,
        },
        select: { runId: true },
      })
    ),
  ]);
  const replied = new Set([...calls, ...actionRuns].map((row) => row.runId));
  return waiting
    .filter((run) => replied.has(run.id))
    .map((run) => ({ runId: run.id, workflowId: run.workflowId }));
}
