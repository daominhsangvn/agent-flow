import { WorkflowRunDetailView } from "@repo/app/workflows/components/workflow-run-detail-view";
import type { Metadata } from "next";
import { WorkflowRunHeader } from "../../../components/workflow-headers";
import { resolveWorkflowAdmin } from "../../../workflow-admin";

export const metadata: Metadata = {
  title: "Workflow run",
  description:
    "Progress, pre actions, loops, pull request and post actions of a workflow run",
};

type WorkflowRunPageProps = {
  params: Promise<{ orgSlug: string; workflowId: string; runId: string }>;
};

export default async function WorkflowRunPage({
  params,
}: Readonly<WorkflowRunPageProps>) {
  const [{ orgSlug, workflowId, runId }, isAdmin] = await Promise.all([
    params,
    resolveWorkflowAdmin(),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowRunHeader
        orgSlug={orgSlug}
        runId={runId}
        workflowId={workflowId}
      />
      {/* plain div, not main: the shell's SidebarInset owns the single main landmark. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        <WorkflowRunDetailView isAdmin={isAdmin} runId={runId} />
      </div>
    </div>
  );
}
