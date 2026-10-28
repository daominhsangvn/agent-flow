import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CreateProjectSearchParam } from "../../[orgSlug]/projects/create-project-param";
import { SidebarProjects } from "../sidebar-projects";

const mockUseFavoriteProjects = vi.fn();
const mockUseIsMounted = vi.fn();
const mockUsePathname = vi.fn();

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useFavoriteProjects: () => mockUseFavoriteProjects(),
}));

vi.mock("@repo/app/shared/hooks/use-is-mounted", () => ({
  useIsMounted: () => mockUseIsMounted(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
}));

vi.mock("lucide-react", () => ({
  ArchiveIcon: () => <svg data-testid="archive-icon" />,
  ChevronDownIcon: () => <svg data-testid="chevron-down-icon" />,
  FolderIcon: () => <svg data-testid="folder-icon" />,
  Layers2Icon: () => <svg data-testid="layers2-icon" />,
  PlusIcon: () => <svg data-testid="plus-icon" />,
}));

vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuSubButton: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("SidebarProjects", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFavoriteProjects.mockReturnValue({
      data: [{ id: "proj-1", name: "Web App" }],
    });
    mockUseIsMounted.mockReturnValue(true);
    mockUsePathname.mockReturnValue("/test-org");
  });

  test("links to the org-level project pages", () => {
    render(<SidebarProjects />);
    expect(
      screen.getByText("All projects").closest("a")?.getAttribute("href")
    ).toBe("/test-org/projects");
    expect(
      screen.getByText("Archived").closest("a")?.getAttribute("href")
    ).toBe("/test-org/projects/archived");
    expect(screen.getByText("Web App").closest("a")?.getAttribute("href")).toBe(
      "/test-org/projects/proj-1"
    );
  });

  test("the New project link deep-links to the create modal", () => {
    render(<SidebarProjects />);
    expect(
      screen.getByText("New project").closest("a")?.getAttribute("href")
    ).toBe(
      `/test-org/projects?${CreateProjectSearchParam.Key}=${CreateProjectSearchParam.Open}`
    );
  });

  test("does not render team wording", () => {
    render(<SidebarProjects />);
    expect(screen.queryByText("Your Teams")).toBeNull();
  });
});
