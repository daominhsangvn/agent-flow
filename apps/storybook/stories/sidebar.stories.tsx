import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarNavLinkItem,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import type { Meta, StoryObj } from "@storybook/react";
import {
  BarChart3,
  BotIcon,
  ChevronsUpDownIcon,
  CopyCheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LaptopIcon,
  Layers2Icon,
  LayoutDashboardIcon,
  type LucideIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SquareCheckIcon,
  UsersIcon,
} from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

// Mirrors the finalized GlobalSidebar nav in apps/app
// (app/(authenticated)/components/sidebar.tsx): top-level items, then the
// Artifacts / Your Teams / Labs collapsible sections, then the compute and
// organization rows in the footer.

// The sr-only text inside SidebarTrigger, which is its accessible name.
const TOGGLE_SIDEBAR_LABEL = "Toggle Sidebar";

type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

const TOP_LEVEL_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon },
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "My Tasks", href: "/my-tasks", icon: CopyCheckIcon },
];

const ARTIFACT_ITEMS: NavItem[] = [
  { title: "Documents", href: "/documents", icon: FileIcon },
  { title: "Issues", href: "/issues", icon: SquareCheckIcon },
  { title: "Sessions", href: "/sessions", icon: HistoryIcon },
  { title: "Branches", href: "/branches", icon: GitBranchIcon },
  { title: "Agents", href: "/agents", icon: BotIcon },
];

const LABS_ITEMS: NavItem[] = [
  { title: "Insights", href: "/insights", icon: BarChart3 },
  { title: "Loops", href: "/loops", icon: RotateCcwIcon },
];

type TeamEntry = {
  name: string;
  href: string;
  projects: { name: string; href: string }[];
};

const TEAMS: TeamEntry[] = [
  { name: "AgentFlow Demo", href: "/teams/agentflow-demo", projects: [] },
  {
    name: "AgentFlow",
    href: "/teams/agentflow",
    projects: [
      { name: "6/8-12", href: "/teams/agentflow/projects/week" },
      { name: "Ideas Triage", href: "/teams/agentflow/projects/ideas" },
      { name: "Design Cleanup", href: "/teams/agentflow/projects/design" },
    ],
  },
  {
    name: "Platform Engineering",
    href: "/teams/platform-engineering",
    projects: [],
  },
];

function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

function NavItemList({
  items,
  activePath,
}: {
  items: NavItem[];
  activePath: string;
}) {
  return (
    <SidebarMenu className="gap-0">
      {items.map((item) => (
        <SidebarNavLinkItem
          className="text-sm"
          href={item.href}
          icon={<item.icon />}
          isActive={isNavItemActive(activePath, item.href)}
          key={item.title}
          title={item.title}
          tooltip={item.title}
          trailing={
            item.title === "Inbox" ? (
              <SidebarCountBadge count={10} />
            ) : undefined
          }
        />
      ))}
    </SidebarMenu>
  );
}

function AgentFlowMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 -87.565 855.92 855.92"
    >
      <path
        d="M307.53 0.94 L302.98 4.72 L300.38 9.72 L203.41 218.72 L82.16 489.72 L7.23 659.72 L0.34 675.72 L-0 678.72 L1.53 680.46 L82.53 680.79 L83.82 679.72 L145.76 548.72 L146.8 544.72 L138.8 499.72 L139.06 496.72 L204.99 354.72 L204.96 352.72 L198.22 344.72 L196.06 340.72 L192.37 328.72 L192.14 318.72 L194.53 309.8 L196.24 305.72 L202.53 296.96 L206.83 292.72 L214.74 287.72 L220.53 285.5 L227.53 284.27 L234.53 284.07 L241.53 285.23 L249.53 288.45 L254.52 291.72 L260.98 297.72 L264.7 302.72 L268.28 310.72 L269.73 316.72 L269.59 330.72 L263.99 344.72 L254.53 354.78 L242.53 361.11 L233.53 362.63 L226.53 362.63 L225.53 363.99 L162.06 499.72 L162.25 506.72 L169.64 544.72 L169.83 550.72 L112.08 671.72 L109.18 679.72 L112.53 680.56 L138.53 680.67 L145.36 679.72 L209.55 544.72 L209.89 521.72 L215.94 507.72 L337.53 250.71 L337.53 249.03 L333.11 243.72 L329.12 236.72 L325.48 224.72 L325.74 212.72 L329.25 201.72 L336.89 190.72 L346.53 183.45 L354.53 179.92 L360.53 178.54 L372.53 178.57 L382.53 181.48 L389.53 185.29 L396.62 191.72 L401.53 197.89 L405.53 207.85 L406.81 213.72 L406.73 224.72 L404.83 232.72 L399.56 242.72 L394.5 248.72 L389.53 252.86 L377.53 258.8 L368.53 260.49 L358.53 260.33 L355.09 265.72 L234.22 521.72 L231.59 528.72 L231.9 550.72 L170.16 679.72 L174.53 680.57 L197.53 680.47 L200.81 679.72 L303.64 463.72 L303.63 461.72 L299.97 456.72 L296.46 448.72 L294.42 440.72 L294.59 432.72 L298.32 419.72 L306.53 408.66 L314.53 403.03 L324.53 399.34 L337.53 399.36 L345.53 401.51 L352.53 405.32 L357.53 409.54 L363.59 417.72 L366.98 425.72 L368.15 432.72 L367.76 441.72 L365.62 449.72 L362.07 456.72 L358.07 461.72 L351.53 467.45 L345.53 470.53 L337.53 473.06 L325.53 473.18 L323.24 474.72 L243.26 641.72 L226.24 679.72 L278.53 680.29 L281.53 679.71 L285.51 676.72 L454.28 287.72 L580 8.72 L581.05 4.72 L580.53 1.7 L576.53 0.01 L320.53 -0 Z M594.53 135.96 L589.06 145.72 L563.19 201.72 L490.34 361.72 L484.2 375.72 L483.27 382.72 L494.4 408.72 L618.23 675.72 L620.53 678.04 L625.53 680.26 L854.53 679.93 L855.85 678.72 L855.92 675.72 L843.28 647.72 L603.7 139.72 L601.85 136.72 L599.53 135.28 L596.53 135.08 Z"
        fill="#01B8FC"
        fillRule="evenodd"
      />
    </svg>
  );
}

function GlobalNavDemo() {
  const pathname = usePath();
  // The preview's memory adapter starts at "/"; show Sessions as the active
  // view until an item is clicked so the default canvas matches the app.
  const activePath = pathname === "/" ? "/sessions" : pathname;

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <form className="flex items-center px-2 pt-2.5">
          <div className="relative w-full">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <Input
              className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-3 pl-8 text-xs shadow-none focus-visible:bg-background"
              name="q"
              placeholder="Search"
              type="text"
            />
          </div>
        </form>
        <SidebarContent className="gap-1 pt-2">
          <SidebarGroup className="p-1">
            <NavItemList activePath={activePath} items={TOP_LEVEL_ITEMS} />
          </SidebarGroup>

          <SidebarCollapsibleSection title="Artifacts">
            <NavItemList activePath={activePath} items={ARTIFACT_ITEMS} />
          </SidebarCollapsibleSection>

          <SidebarCollapsibleSection
            action={
              <button
                className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
                type="button"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Add Team</span>
              </button>
            }
            title="Your Teams"
          >
            <SidebarMenu className="gap-0">
              {TEAMS.map((team) => (
                <SidebarMenuItem key={team.name}>
                  <SidebarMenuButton
                    asChild
                    className="text-sm"
                    isActive={isNavItemActive(activePath, team.href)}
                    tooltip={team.name}
                  >
                    <Link href={team.href}>
                      <UsersIcon />
                      <span className="truncate">{team.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  {team.projects.length > 0 && (
                    <SidebarMenuSub className="mr-0 gap-0 pr-0">
                      {team.projects.map((project) => (
                        <SidebarMenuSubItem key={project.name}>
                          <SidebarMenuSubButton
                            asChild
                            className="pr-0"
                            isActive={activePath === project.href}
                          >
                            <Link href={project.href}>
                              <Layers2Icon />
                              <span>{project.name}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarCollapsibleSection>

          <SidebarCollapsibleSection title="Labs">
            <NavItemList activePath={activePath} items={LABS_ITEMS} />
          </SidebarCollapsibleSection>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Compute target">
                <LaptopIcon />
                <span className="truncate">
                  Compute: parkerbyrd-MacBook-Pro
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Organization">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                  <AgentFlowMark />
                </div>
                <span className="truncate font-medium">AgentFlow</span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <span className="text-muted-foreground text-sm">Sessions</span>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">
          <div className="grid auto-rows-min gap-4 md:grid-cols-3">
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
          </div>
          <div className="min-h-0 flex-1 rounded-xl bg-muted/50" />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const meta: Meta<typeof Sidebar> = {
  title: "Design System/Navigation & Shell/Sidebar",
  component: Sidebar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj<typeof Sidebar>;

export const GlobalNav: Story = {
  render: () => <GlobalNavDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Collapse and expand through the real control rather than the provider,
    // so the trigger's own wiring is what is under test.
    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "collapsed"
    );

    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Nav items are real links, so they are keyboard-reachable by construction
    // rather than by an onClick on a div — tabbing out of the search field
    // lands on the first one.
    //
    // Deliberately never clicked: the preview mounts ONE module-level memory
    // navigation adapter shared by every story in the sweep, so navigating
    // here would change the path the other stories render against.
    const dashboard = canvas.getByRole("link", { name: "Dashboard" });
    await expect(dashboard).toHaveAttribute("href", "/dashboard");

    canvas.getByPlaceholderText("Search").focus();
    await userEvent.tab();
    await expect(dashboard).toHaveFocus();
  },
};

// The Sidebar root is the element carrying collapse state; it has no role or
// accessible name, so `data-slot` is the only handle for it.
function sidebarRoot(canvasElement: HTMLElement): Element {
  const root = canvasElement.querySelector('[data-slot="sidebar"]');
  if (root === null) {
    throw new Error("sidebar root did not render");
  }
  return root;
}
