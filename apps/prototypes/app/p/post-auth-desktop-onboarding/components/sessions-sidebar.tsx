"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@repo/design-system/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { cn } from "@repo/design-system/lib/utils";
import {
  BarChart3Icon,
  BotIcon,
  ChevronsUpDownIcon,
  ClipboardListIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  SettingsIcon,
  ShieldIcon,
  StethoscopeIcon,
  UserPlusIcon,
} from "lucide-react";
import { InviteAnnouncementContent } from "./invite-announcement";

// The Sessions-page left sidebar, mirroring the production desktop Sidebar
// (apps/desktop/src/renderer/components/layout/Sidebar.tsx) under FOCUS_MODE:
// the focus pages in the top group, a visible Gateway group, a collapsed Labs
// section, and a footer carrying "Invite your team" above the account menu.
// Nav items are presentational (this prototype is a single Sessions screen);
// "Invite your team" is the live affordance the flow's Card #5 pop-up points at.

const NavItemId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Agents: "agents",
  Approvals: "approvals",
  Requests: "requests",
  Insights: "insights",
  Plans: "plans",
  Packs: "packs",
} as const;
type NavItemId = (typeof NavItemId)[keyof typeof NavItemId];

type NavItem = { id: NavItemId; label: string; icon: LucideIcon };

const MAIN_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Dashboard, label: "Dashboard", icon: LayoutDashboardIcon },
  { id: NavItemId.Sessions, label: "Sessions", icon: HistoryIcon },
  { id: NavItemId.Branches, label: "Branches", icon: GitBranchIcon },
  { id: NavItemId.Agents, label: "Agents", icon: BotIcon },
];

const GATEWAY_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Approvals, label: "Approvals", icon: ShieldIcon },
  { id: NavItemId.Requests, label: "Requests", icon: InboxIcon },
];

const LABS_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Insights, label: "Insights", icon: BarChart3Icon },
  { id: NavItemId.Plans, label: "Plans", icon: ClipboardListIcon },
  { id: NavItemId.Packs, label: "Packs", icon: PackageIcon },
];

const NavMenu = ({ items }: { items: readonly NavItem[] }) => (
  <SidebarMenu className="gap-0">
    {items.map((item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          className="text-sm"
          isActive={item.id === NavItemId.Sessions}
          tooltip={item.label}
        >
          <item.icon />
          <span className="flex-1 truncate">{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ))}
  </SidebarMenu>
);

type SessionsSidebarProps = {
  workspaceName: string;
  // Clicking the footer "Invite your team" item opens the invite dialog.
  onOpenInvite: () => void;
  // Card #5 arrival pop-up, anchored to the invite item so it points at where
  // invite lives. Suppressed in the takeover backdrop (showAnnouncement=false).
  showAnnouncement: boolean;
  announceOpen: boolean;
  onAnnounceOpenChange: (open: boolean) => void;
  onAnnounceInvite: () => void;
};

export const SessionsSidebar = ({
  workspaceName,
  onOpenInvite,
  showAnnouncement,
  announceOpen,
  onAnnounceOpenChange,
  onAnnounceInvite,
}: SessionsSidebarProps) => {
  // On mobile the sidebar is offcanvas, so its "Invite your team" footer item —
  // the desktop pop-up anchor — is off screen. There the topbar owns the pop-up
  // (anchored to the always-visible menu trigger); this component renders the
  // plain item so the anchor only attaches to a visible element on desktop.
  const { isMobile } = useSidebar();
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarContent className="gap-1 pt-2">
        <SidebarGroup className="px-0 py-1">
          <NavMenu items={MAIN_ITEMS} />
        </SidebarGroup>
        <SidebarGroup className="px-0 py-1">
          <SidebarGroupLabel>Gateway</SidebarGroupLabel>
          <NavMenu items={GATEWAY_ITEMS} />
        </SidebarGroup>
        <SidebarCollapsibleSection
          className="px-0 py-1"
          defaultOpen={false}
          title="Labs"
        >
          <NavMenu items={LABS_ITEMS} />
        </SidebarCollapsibleSection>
      </SidebarContent>
      <SidebarFooter className="px-0 pt-1 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            {showAnnouncement && !isMobile ? (
              <Popover onOpenChange={onAnnounceOpenChange} open={announceOpen}>
                <PopoverAnchor asChild>
                  {/* Anchor directly to the ref-forwarding SidebarMenuButton and
                    highlight it while the CTA is open so the pop-up points at
                    where invite lives. Desktop-only: on mobile this item is
                    offcanvas, so the topbar menu trigger carries the pop-up. */}
                  <SidebarMenuButton
                    className={cn(
                      announceOpen && "ring-2 ring-primary/50 ring-offset-1"
                    )}
                    onClick={onOpenInvite}
                    tooltip="Invite your team"
                  >
                    <UserPlusIcon className="size-4" />
                    <span className="truncate">Invite your team</span>
                  </SidebarMenuButton>
                </PopoverAnchor>
                <PopoverContent
                  align="end"
                  className="w-80"
                  side="right"
                  sideOffset={8}
                >
                  <InviteAnnouncementContent
                    onDismiss={() => onAnnounceOpenChange(false)}
                    onInvite={onAnnounceInvite}
                  />
                </PopoverContent>
              </Popover>
            ) : (
              <SidebarMenuButton
                onClick={onOpenInvite}
                tooltip="Invite your team"
              >
                <UserPlusIcon className="size-4" />
                <span className="truncate">Invite your team</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountMenu workspaceName={workspaceName} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

// Footer account trigger, mirroring the production AccountMenu: the AgentFlow
// mark as the avatar, the organization name, and a chevron opening Settings /
// Diagnostics (presentational here).
const AccountMenu = ({ workspaceName }: { workspaceName: string }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SidebarMenuButton
        aria-label="Open account menu"
        size="lg"
        tooltip={workspaceName}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <AgentFlowMark />
        </div>
        <span className="truncate font-medium">{workspaceName}</span>
        <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      className="min-w-56 rounded-md"
      side="top"
    >
      <DropdownMenuItem>
        <SettingsIcon className="size-4" />
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem>
        <StethoscopeIcon className="size-4" />
        Diagnostics
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const AgentFlowMark = () => (
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
