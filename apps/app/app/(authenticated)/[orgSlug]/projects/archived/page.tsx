"use client";

import type { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import {
  useDeleteProject,
  useProjectStatusHandler,
  useProjects,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { ProjectsTable } from "../components/projects-table";

const COLUMN_VISIBILITY_KEY = "table:columns:team-projects-archived";

export default function ArchivedProjectsPage() {
  const orgSlug = useOrgSlug();

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => PROJECT_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const {
    data: projects = [],
    isLoading: loading,
    error: projectsError,
  } = useProjects(undefined, {
    status: [ProjectStatus.Archived],
  });

  const error = projectsError?.message || null;

  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updatePriorityMutation = useUpdateProjectPriority();
  const { handleUpdateStatus } = useProjectStatusHandler({
    showUndoOnUnarchive: true,
  });
  const deleteProjectMutation = useDeleteProject();

  const handleUpdateAssignee = (
    projectId: string,
    assigneeId: string | null
  ) => {
    updateAssigneeMutation.mutate({ projectId, assigneeId });
  };

  const handleUpdateTargetDate = (projectId: string, date: Date | null) => {
    updateTargetDateMutation.mutate({ projectId, targetDate: date });
  };

  const handleUpdatePriority = (projectId: string, priority: Priority) => {
    updatePriorityMutation.mutate({ projectId, priority });
  };

  const handleDeleteProject = async (projectId: string) => {
    const result = await deleteProjectMutation.mutateAsync(projectId);
    return result.deleted ?? false;
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Home", href: `/${orgSlug}` },
          { label: "Projects", href: `/${orgSlug}/projects` },
          { label: "Archived Projects" },
        ]}
        suppressPageHeading
      />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Archived Projects</h1>
          <TableViewMenu
            columns={PROJECT_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <ProjectsTable
            emptyStateDescription="Archived projects will appear here."
            emptyStateTitle="No archived projects"
            onDelete={handleDeleteProject}
            onUpdateAssignee={handleUpdateAssignee}
            onUpdatePriority={handleUpdatePriority}
            onUpdateStatus={handleUpdateStatus}
            onUpdateTargetDate={handleUpdateTargetDate}
            projects={projects}
            visibleColumns={visibleColumns}
          />
        </div>
      </div>
    </>
  );
}
