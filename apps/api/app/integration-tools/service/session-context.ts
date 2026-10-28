import type { ConnectionGrants } from "@repo/api/src/types/connection-grants";
import {
  type AgentProcessStep,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  PROCESS_STEP_TOOL_WRITES_MAX,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WORKFLOW_INSTRUCTION_OPERATIONS_MAX,
  WorkflowRunEvent,
  workflowInstructionConfigSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import {
  type AgentTool,
  type AgentToolSessionInput,
  buildAgentTools,
} from "@/lib/integrations/agent-tools/catalog";
import { loadAgentToolSession } from "@/lib/integrations/agent-tools/session-input";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import type { WorkflowRunSnapshot } from "@/lib/integrations/types";
import { readRunProcessSnapshot } from "@/lib/workflows/engine/process";
import { buildRunSnapshot } from "@/lib/workflows/engine/snapshot";
import type {
  AuthenticatedToolSession,
  ToolSessionSubject,
} from "../integration-tool-session-service";

/**
 * A session's tools, recomputed on every request so a changed grant or
 * project connection applies at once: from the `connections:` grant of the
 * instruction (its current config) or of the process agent step (the run's
 * process snapshot), and the run as it is now.
 */

export type ToolSessionContext = {
  session: AuthenticatedToolSession;
  snapshot: WorkflowRunSnapshot;
  sourceConnection: LoadedConnection | null;
  input: AgentToolSessionInput;
  tools: AgentTool[];
  /** Writes the session may carry out (pending approvals included). */
  writeBudget: number;
};

export async function loadToolSessionContext(
  session: AuthenticatedToolSession
): Promise<ToolSessionContext | null> {
  const subject = await loadSubjectGrants(session);
  if (!subject) {
    return null;
  }
  const snapshot = await buildRunSnapshot(session.runId, subject.event);
  if (!snapshot) {
    return null;
  }
  const loaded = await loadAgentToolSession({
    agent: subject.agent,
    organizationId: session.organizationId,
    runId: session.runId,
    grants: subject.grants,
    snapshot,
  });
  if (!loaded) {
    return null;
  }
  return {
    session,
    snapshot,
    sourceConnection: loaded.sourceConnection,
    input: loaded.input,
    tools: buildAgentTools(loaded.input),
    writeBudget: subject.writeBudget,
  };
}

type SubjectGrants = {
  agent: string;
  grants: ConnectionGrants | undefined;
  event: WorkflowRunEvent;
  writeBudget: number;
};

function loadSubjectGrants(
  session: AuthenticatedToolSession
): Promise<SubjectGrants | null> {
  return session.subject.kind === "instruction"
    ? loadInstructionGrants(session, session.subject)
    : loadStepGrants(session, session.subject);
}

async function loadInstructionGrants(
  session: AuthenticatedToolSession,
  subject: Extract<ToolSessionSubject, { kind: "instruction" }>
): Promise<SubjectGrants | null> {
  const event = workflowRunEventSchema.safeParse(subject.event);
  const actionId = subject.actionId;
  if (!(event.success && actionId)) {
    return null;
  }
  const action = await withDb((db) =>
    db.workflowAction.findFirst({
      where: {
        id: actionId,
        organizationId: session.organizationId,
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
      },
      select: { config: true },
    })
  );
  const config = workflowInstructionConfigSchema.safeParse(action?.config);
  return config.success
    ? {
        agent: "an instruction",
        grants: config.data.connections,
        event: event.data,
        writeBudget: WORKFLOW_INSTRUCTION_OPERATIONS_MAX,
      }
    : null;
}

/** A step's grant from the process the run follows (its snapshot). */
async function loadStepGrants(
  session: AuthenticatedToolSession,
  subject: Extract<ToolSessionSubject, { kind: "step" }>
): Promise<SubjectGrants | null> {
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: session.runId, organizationId: session.organizationId },
      select: { process: true },
    })
  );
  const step = readRunProcessSnapshot(run?.process)?.definition.steps.find(
    (candidate): candidate is AgentProcessStep =>
      candidate.id === subject.stepId &&
      candidate.type === ProcessStepType.Agent
  );
  return step
    ? {
        agent: `the process step "${step.name}"`,
        grants: step.connections,
        // A step works after the run started: its outputs so far count.
        event: WorkflowRunEvent.ExecuteStarted,
        writeBudget: PROCESS_STEP_TOOL_WRITES_MAX,
      }
    : null;
}
