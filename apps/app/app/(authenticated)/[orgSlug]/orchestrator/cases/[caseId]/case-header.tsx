"use client";

import { useOrchestratorCase } from "@repo/app/orchestrator/hooks/use-orchestrator-cases";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { Header } from "@/app/(authenticated)/components/header";

/**
 * Breadcrumb + browser-tab title of a case page. The workflow and the title
 * only exist after the client read, so this re-reads `useOrchestratorCase`
 * (same query key as the body, served from cache).
 */
export function OrchestratorCaseHeader({
  orgSlug,
  caseId,
}: Readonly<{ orgSlug: string; caseId: string }>) {
  const { data } = useOrchestratorCase(caseId);
  const label = data?.title ?? CASE_FALLBACK_LABEL;
  useDocumentTitle(label);
  const workflow = data?.workflow;

  return (
    <Header
      breadcrumbs={[
        { href: `/${orgSlug}/workflows`, label: WORKFLOWS_LABEL },
        workflow
          ? {
              href: `/${orgSlug}/workflows/${workflow.id}?tab=cases`,
              label: workflow.name,
            }
          : { label: WORKFLOW_FALLBACK_LABEL },
        { label },
      ]}
    />
  );
}

const WORKFLOWS_LABEL = "Workflows";
const WORKFLOW_FALLBACK_LABEL = "Workflow";
const CASE_FALLBACK_LABEL = "Case";
