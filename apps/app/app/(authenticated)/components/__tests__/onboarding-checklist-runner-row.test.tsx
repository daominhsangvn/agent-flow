// @vitest-environment jsdom

import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
  status: null as unknown,
  statusOptions: undefined as Record<string, unknown> | undefined,
  dismiss: vi.fn(),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => ({ enabled: mocks.enabledFlags.has(key) }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: (options?: Record<string, unknown>) => {
    mocks.statusOptions = options;
    return { data: mocks.status };
  },
  useDismissChecklist: () => ({ mutate: mocks.dismiss }),
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a data-navigation-link="" href={href}>
      {children}
    </a>
  ),
}));

import { OnboardingChecklist } from "../onboarding-checklist";

const RUNNER_LABEL = "Download and install a runner";
/** A stand-in for the href the API sends; `apps/api` pins the real one. */
const FIXTURE_RUNNER_HREF = "/settings?tab=integrations";

function item(
  id: ChecklistItemId,
  overrides: Partial<OnboardingChecklistItem> = {}
): OnboardingChecklistItem {
  return {
    id,
    label: id,
    description: `${id} description`,
    completed: false,
    href: "/settings",
    ...overrides,
  };
}

function setStatus(checklist: OnboardingChecklistItem[]) {
  mocks.status = {
    wizardCompleted: true,
    checklistDismissed: false,
    checklist,
  };
}

/** The full set the service returns, in service order. */
function fullChecklist() {
  return [
    item(ChecklistItemId.CreateProject, { completed: true }),
    item(ChecklistItemId.InstallRunner, {
      label: RUNNER_LABEL,
      href: FIXTURE_RUNNER_HREF,
    }),
    item(ChecklistItemId.ConnectGoogle),
    item(ChecklistItemId.InviteMembers),
  ];
}

describe("OnboardingChecklist — runner row", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    setStatus(fullChecklist());
  });

  it("asks for a runner instead of the desktop app, GitHub or an Anthropic key", () => {
    render(<OnboardingChecklist />);

    expect(screen.getByText(RUNNER_LABEL)).toBeTruthy();
    expect(screen.queryByText("Download the desktop app")).toBeNull();
    expect(screen.queryByText("Connect GitHub")).toBeNull();
    expect(screen.queryByText("Add Anthropic API key")).toBeNull();
    expect(screen.getByText("1 of 3 tasks completed")).toBeTruthy();
  });

  it("links the runner row inside the app", () => {
    render(<OnboardingChecklist />);

    const link = screen.getByText(RUNNER_LABEL).closest("a");
    expect(link?.getAttribute("href")).toBe(FIXTURE_RUNNER_HREF);
    expect(link?.hasAttribute("data-navigation-link")).toBe(true);
    expect(link?.getAttribute("target")).toBeNull();
  });

  it("announces the task count so completing a step is not silent", () => {
    render(<OnboardingChecklist />);

    expect(
      screen.getByText("1 of 3 tasks completed").getAttribute("aria-live")
    ).toBe("polite");
  });

  it("hides the Google row until its own flag is on", () => {
    // The denominator above is 4 rather than 5 because of it.
    render(<OnboardingChecklist />);

    expect(screen.queryByText(ChecklistItemId.ConnectGoogle)).toBeNull();
  });

  it("re-checks the runner row on every return to the tab, not only when stale", () => {
    // The row completes outside the browser (a runner registers itself), so
    // nothing in-tab invalidates the query. `true` would only refetch a STALE
    // query, and this one stays fresh for five minutes.
    render(<OnboardingChecklist />);

    expect(mocks.statusOptions?.refetchOnWindowFocus).toBe("always");
  });

  it("ticks the runner row and stops linking it once a runner registered", () => {
    setStatus(
      fullChecklist().map((entry) =>
        entry.id === ChecklistItemId.InstallRunner
          ? { ...entry, completed: true }
          : entry
      )
    );

    render(<OnboardingChecklist />);

    expect(screen.getByText(RUNNER_LABEL).closest("a")).toBeNull();
    expect(screen.getByText("2 of 3 tasks completed")).toBeTruthy();
  });
});
