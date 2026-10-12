import { WorkflowsIndexView } from "@repo/app/workflows/components/workflows-index-view";
import type { Metadata } from "next";
import { Header } from "../../components/header";
import { resolveWorkflowAdmin } from "./workflow-admin";

const WORKFLOWS_BREADCRUMBS = [{ label: "Workflows" }];

export const metadata: Metadata = {
  title: "Workflows",
  description:
    "Event-driven agent runs started from Jira, Azure DevOps and HTTPS webhooks",
};

/**
 * Workflows index (docs/workflows.md): the org's workflows and the org-wide
 * run history. Always-on: the self-hosted edition has no PostHog, so the route
 * carries no feature-flag gate. Admin capability comes from the session role;
 * members get a read-only view.
 */
export default async function WorkflowsPage() {
  const isAdmin = await resolveWorkflowAdmin();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={WORKFLOWS_BREADCRUMBS} />
      {/* plain div, not main: the shell's SidebarInset owns the single main landmark. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <WorkflowsIndexView isAdmin={isAdmin} />
      </div>
    </div>
  );
}
