"use client";

import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { PlusIcon } from "lucide-react";
import { WORKFLOW_SOURCE_SYSTEMS_NOTICE } from "../lib/workflow-labels";
import { OrgWorkflowRunHistory } from "./workflow-runs-table";
import { WorkflowsList } from "./workflows-list";

export const WorkflowsIndexTab = {
  Workflows: "workflows",
  Runs: "runs",
} as const;
export type WorkflowsIndexTab =
  (typeof WorkflowsIndexTab)[keyof typeof WorkflowsIndexTab];

export type WorkflowsIndexViewProps = {
  /** Admins create and change workflows; members see them read-only. */
  isAdmin: boolean;
};

/**
 * The Workflows index: the org's workflows and the org-wide run history, as
 * URL-synced tabs (`?tab=runs`).
 */
export function WorkflowsIndexView({
  isAdmin,
}: Readonly<WorkflowsIndexViewProps>) {
  const buildOrgPath = useOrgPath();
  const { activeTab, setActiveTab } = useTabParam<WorkflowsIndexTab>({
    defaultTab: WorkflowsIndexTab.Workflows,
    validTabs: WORKFLOWS_INDEX_TABS,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl space-y-1 text-muted-foreground text-sm">
          <p>
            Workflows start the agent team when something happens in another
            system, like a Jira issue assigned to the bot account. Pre actions
            run before the agent team (e.g. move the issue to In Progress) and
            post actions report back with comments, messages or callbacks.
          </p>
          <p>{WORKFLOW_SOURCE_SYSTEMS_NOTICE}</p>
        </div>
        {isAdmin ? (
          <Button asChild size="sm">
            <Link href={buildOrgPath("/workflows/new")}>
              <PlusIcon className="size-4" />
              New workflow
            </Link>
          </Button>
        ) : null}
      </div>
      <Tabs onValueChange={setActiveTab} value={activeTab}>
        <TabsList>
          <TabsTrigger
            className="flex-initial px-4"
            value={WorkflowsIndexTab.Workflows}
          >
            Workflows
          </TabsTrigger>
          <TabsTrigger
            className="flex-initial px-4"
            value={WorkflowsIndexTab.Runs}
          >
            Runs
          </TabsTrigger>
        </TabsList>
        <TabsContent className="mt-3" value={WorkflowsIndexTab.Workflows}>
          <WorkflowsList isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent className="mt-3" value={WorkflowsIndexTab.Runs}>
          <OrgWorkflowRunHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const WORKFLOWS_INDEX_TABS: readonly WorkflowsIndexTab[] = [
  WorkflowsIndexTab.Workflows,
  WorkflowsIndexTab.Runs,
];
