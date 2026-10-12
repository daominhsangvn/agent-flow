import type { Metadata } from "next";
import { WorkflowDetailPageView } from "../components/workflow-editor-views";
import { WorkflowDetailHeader } from "../components/workflow-headers";
import { resolveWorkflowAdmin } from "../workflow-admin";

export const metadata: Metadata = {
  title: "Workflow",
  description: "Workflow configuration and run history",
};

type WorkflowDetailPageProps = {
  params: Promise<{ orgSlug: string; workflowId: string }>;
};

export default async function WorkflowDetailPage({
  params,
}: Readonly<WorkflowDetailPageProps>) {
  const [{ orgSlug, workflowId }, isAdmin] = await Promise.all([
    params,
    resolveWorkflowAdmin(),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowDetailHeader orgSlug={orgSlug} workflowId={workflowId} />
      {/* plain div, not main: the shell's SidebarInset owns the single main landmark. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        <WorkflowDetailPageView isAdmin={isAdmin} workflowId={workflowId} />
      </div>
    </div>
  );
}
