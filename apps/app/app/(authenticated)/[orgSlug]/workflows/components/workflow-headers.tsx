"use client";

import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import {
  useWorkflow,
  useWorkflowRun,
} from "@repo/app/workflows/hooks/use-workflows";
import { Header } from "@/app/(authenticated)/components/header";

/**
 * Breadcrumb + browser-tab title of a workflow detail page. The name only
 * exists after the client read, so this re-reads `useWorkflow` (same query key
 * as the body, served from cache) and falls back to the generic "Workflow".
 */
export function WorkflowDetailHeader({
  orgSlug,
  workflowId,
}: Readonly<{ orgSlug: string; workflowId: string }>) {
  const { data } = useWorkflow(workflowId);
  const label = data?.name ?? WORKFLOW_FALLBACK_LABEL;
  useDocumentTitle(label);

  return (
    <Header
      breadcrumbs={[
        { href: `/${orgSlug}/workflows`, label: WORKFLOWS_LABEL },
        { label },
      ]}
    />
  );
}

/**
 * Breadcrumb + browser-tab title of a run detail page: Workflows > workflow >
 * source item key, all from the run read the body already polls.
 */
export function WorkflowRunHeader({
  orgSlug,
  workflowId,
  runId,
}: Readonly<{ orgSlug: string; workflowId: string; runId: string }>) {
  const { data } = useWorkflowRun(runId);
  const runLabel = data?.source.key ?? RUN_FALLBACK_LABEL;
  useDocumentTitle(runLabel);

  return (
    <Header
      breadcrumbs={[
        { href: `/${orgSlug}/workflows`, label: WORKFLOWS_LABEL },
        {
          href: `/${orgSlug}/workflows/${workflowId}`,
          label: data?.workflowName ?? WORKFLOW_FALLBACK_LABEL,
        },
        { label: runLabel },
      ]}
    />
  );
}

const WORKFLOWS_LABEL = "Workflows";
const WORKFLOW_FALLBACK_LABEL = "Workflow";
const RUN_FALLBACK_LABEL = "Run";
