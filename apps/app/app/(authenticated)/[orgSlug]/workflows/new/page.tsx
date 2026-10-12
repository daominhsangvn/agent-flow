import type { Metadata } from "next";
import { Header } from "../../../components/header";
import { NewWorkflowView } from "../components/workflow-editor-views";
import { resolveWorkflowAdmin } from "../workflow-admin";

export const metadata: Metadata = {
  title: "New workflow",
  description: "Create an event-driven workflow",
};

type NewWorkflowPageProps = {
  params: Promise<{ orgSlug: string }>;
};

export default async function NewWorkflowPage({
  params,
}: Readonly<NewWorkflowPageProps>) {
  const [{ orgSlug }, isAdmin] = await Promise.all([
    params,
    resolveWorkflowAdmin(),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        breadcrumbs={[
          { href: `/${orgSlug}/workflows`, label: "Workflows" },
          { label: "New workflow" },
        ]}
      />
      {/* plain div, not main: the shell's SidebarInset owns the single main landmark. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        <NewWorkflowView isAdmin={isAdmin} />
      </div>
    </div>
  );
}
