import { OrchestratorCaseDetailView } from "@repo/app/orchestrator/components/orchestrator-case-detail-view";
import type { Metadata } from "next";
import { resolveWorkflowAdmin } from "@/app/(authenticated)/[orgSlug]/workflows/workflow-admin";
import { OrchestratorCaseHeader } from "./case-header";

export const metadata: Metadata = {
  title: "Orchestrator case",
  description: "Messages, turns, tasks and decisions of an orchestrator case",
};

type OrchestratorCasePageProps = {
  params: Promise<{ orgSlug: string; caseId: string }>;
};

export default async function OrchestratorCasePage({
  params,
}: Readonly<OrchestratorCasePageProps>) {
  const [{ orgSlug, caseId }, isAdmin] = await Promise.all([
    params,
    resolveWorkflowAdmin(),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OrchestratorCaseHeader caseId={caseId} orgSlug={orgSlug} />
      {/* plain div, not main: the shell's SidebarInset owns the single main landmark. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        <OrchestratorCaseDetailView caseId={caseId} isAdmin={isAdmin} />
      </div>
    </div>
  );
}
