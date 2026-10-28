"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { CreateProjectInput } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectStatus,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Loader2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectsTable } from "./components/projects-table";
import { CreateProjectSearchParam } from "./create-project-param";

const COLUMN_VISIBILITY_KEY = "table:columns:team-projects";

export default function ProjectsPage() {
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const createRequested =
    searchParams.get(CreateProjectSearchParam.Key) ===
    CreateProjectSearchParam.Open;

  // The sidebar "New project" link deep-links here with `?create=1`. Open the
  // modal, then strip the param (replace, so no history entry is added and a
  // reload or back does not reopen it).
  const openRequestedCreate = useEffectEvent(() => {
    setCreateProjectOpen(true);
    navigation.replace(clearCreateParam(searchParams, pathname), {
      scroll: false,
    });
  });
  useEffect(() => {
    if (createRequested) {
      openRequestedCreate();
    }
  }, [createRequested]);

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => PROJECT_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  // Queries
  const {
    data: projects = [],
    isLoading: loading,
    error: projectsError,
  } = useProjects(undefined, {
    excludeStatus: [ProjectStatus.Archived],
  });

  const error = projectsError?.message || null;

  // Mutations
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updatePriorityMutation = useUpdateProjectPriority();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();
  const updateStatusMutation = useUpdateProjectStatus();

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

  const handleCreateProject = async (projectData: CreateProjectInput) => {
    // mutateAsync (not the preferred mutate) is intentional here: the modal
    // awaits this promise to only close + reset on success — a rejection keeps
    // it open with input intact — and we need the resolved project id to
    // navigate. The global QueryClient onError handler still owns the failure
    // toast, so we do not add a local catch.
    const newProject = await createProjectMutation.mutateAsync(projectData);
    navigation.navigate(`/${orgSlug}/projects/${newProject.id}`);
  };

  const handleDeleteProject = async (projectId: string) => {
    const result = await deleteProjectMutation.mutateAsync(projectId);
    return result.deleted ?? false;
  };

  const handleUpdateStatus = (
    projectId: string,
    status: ProjectStatus,
    previousStatus: ProjectStatus
  ) => {
    updateStatusMutation.mutate(
      { projectId, status },
      {
        onSuccess: () => {
          if (status === ProjectStatus.Archived) {
            toast.success("Project archived", {
              action: {
                label: "Undo",
                onClick: () => {
                  updateStatusMutation.mutate({
                    projectId,
                    status: previousStatus,
                  });
                },
              },
            });
            return;
          }
          toast.success("Project unarchived");
        },
      }
    );
  };

  const handleCreateProjectOpenChange = (open: boolean) => {
    setCreateProjectOpen(open);
    if (!open && createRequested) {
      navigation.replace(clearCreateParam(searchParams, pathname), {
        scroll: false,
      });
    }
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
          { label: "Projects" },
        ]}
        suppressPageHeading
      >
        <CreateProjectModal
          onCreateProject={handleCreateProject}
          onOpenChange={handleCreateProjectOpenChange}
          open={createProjectOpen}
        />
      </Header>
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Title bar */}
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Projects</h1>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link href={`/${orgSlug}/projects/archived`}>Archived</Link>
            </Button>
            <TableViewMenu
              columns={PROJECT_DEFAULT_COLUMNS}
              onToggle={toggleColumn}
              visibility={visibility}
            />
          </div>
        </div>
        {/* Table scroll area */}
        <div className="flex-1 overflow-auto">
          <ProjectsTable
            onCreateProject={() => setCreateProjectOpen(true)}
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

function clearCreateParam(
  searchParams: { toString(): string },
  pathname: string
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete(CreateProjectSearchParam.Key);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
