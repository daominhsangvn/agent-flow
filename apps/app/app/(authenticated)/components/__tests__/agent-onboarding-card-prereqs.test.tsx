// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentOnboardingState,
  AgentRunnerStatus,
} from "@/hooks/queries/use-agent-onboarding";

const mocks = vi.hoisted(() => ({
  onboarding: null as unknown,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: false }),
}));
// The wizard is unfinished, so there is no checklist for the card to stand
// down for (agent-onboarding-card-checklist-standdown.test.tsx covers that).
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({
    data: { wizardCompleted: false, checklistDismissed: false, checklist: [] },
  }),
}));
vi.mock("@/hooks/queries/use-agent-onboarding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/use-agent-onboarding")
  >()),
  useAgentOnboarding: () => mocks.onboarding,
}));
vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AgentOnboardingCard } from "../agent-onboarding-card";

const RUNNERS_SETTINGS_HREF = "/acme/settings?tab=integrations";
const GITHUB_RE = /github/i;
const DESKTOP_RE = /desktop/i;
const GENERATE_AGENTS = "Generate Agents";

describe("AgentOnboardingCard — prerequisites", () => {
  beforeEach(() => {
    setRunner(AgentRunnerStatus.None);
  });

  it("asks for a runner, not for GitHub or the desktop app", () => {
    render(<AgentOnboardingCard />);

    expect(screen.queryByText(GITHUB_RE)).toBeNull();
    expect(screen.queryByText(DESKTOP_RE)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Download and install a runner" })
    ).toHaveAttribute("href", RUNNERS_SETTINGS_HREF);
    expect(
      screen.getByRole("button", { name: GENERATE_AGENTS })
    ).toBeDisabled();
  });

  it("asks to start a runner that is installed but offline", () => {
    setRunner(AgentRunnerStatus.Offline);

    render(<AgentOnboardingCard />);

    expect(
      screen.getByRole("link", { name: "Start your runner" })
    ).toHaveAttribute("href", RUNNERS_SETTINGS_HREF);
    expect(screen.queryByText("Download and install a runner")).toBeNull();
    expect(
      screen.getByRole("button", { name: GENERATE_AGENTS })
    ).toBeDisabled();
  });

  it("ticks the runner row and offers Generate Agents once a runner is online", () => {
    setRunner(AgentRunnerStatus.Online);

    render(<AgentOnboardingCard />);

    expect(screen.getByText("Runner online")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Runner online" })).toBeNull();
    expect(screen.getByRole("link", { name: GENERATE_AGENTS })).toHaveAttribute(
      "href",
      "/acme/agents?from=onboarding"
    );
  });
});

function setRunner(runner: AgentRunnerStatus) {
  const onboarding: Pick<
    AgentOnboardingState,
    "shouldShow" | "runner" | "prereqsMet" | "bootstrapInProgress" | "dismiss"
  > = {
    shouldShow: true,
    runner,
    prereqsMet: runner === AgentRunnerStatus.Online,
    bootstrapInProgress: false,
    dismiss: vi.fn(),
  };
  mocks.onboarding = onboarding;
}
