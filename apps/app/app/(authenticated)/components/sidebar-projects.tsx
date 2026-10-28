"use client";

import { useFavoriteProjects } from "@repo/app/projects/hooks/use-projects";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import { ArchiveIcon, FolderIcon, Layers2Icon, PlusIcon } from "lucide-react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { buildCreateProjectHref } from "../[orgSlug]/projects/create-project-param";

export function SidebarProjects() {
  const { data: favorites = [] } = useFavoriteProjects();
  const mounted = useIsMounted();
  const pathname = usePath();
  const orgSlug = useOrgSlug();
  const projectsHref = `/${orgSlug}/projects`;
  const archivedHref = `${projectsHref}/archived`;

  return (
    <SidebarCollapsibleSection
      action={
        mounted ? (
          <Link
            className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
            href={buildCreateProjectHref(projectsHref)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            <span className="sr-only">New project</span>
          </Link>
        ) : (
          <div className="h-5 w-5" />
        )
      }
      title="Projects"
    >
      <SidebarMenu className="gap-0">
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            className="text-sm"
            isActive={pathname === projectsHref}
            tooltip="All projects"
          >
            <Link href={projectsHref}>
              <FolderIcon />
              <span className="truncate">All projects</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            className="text-sm"
            isActive={pathname === archivedHref}
            tooltip="Archived"
          >
            <Link href={archivedHref}>
              <ArchiveIcon />
              <span className="truncate">Archived</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {favorites.length > 0 && (
          <SidebarMenuSub className="mr-0 gap-0 pr-0">
            {favorites.map((project) => {
              const projectHref = `${projectsHref}/${project.id}`;
              return (
                <SidebarMenuSubItem key={project.id}>
                  <SidebarMenuSubButton
                    asChild
                    className="pr-0"
                    isActive={pathname === projectHref}
                  >
                    <Link href={projectHref}>
                      <Layers2Icon />
                      <span>{project.name}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        )}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}
