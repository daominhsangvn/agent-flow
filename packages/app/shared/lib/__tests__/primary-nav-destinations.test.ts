import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import { CalendarClockIcon, ZapIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  MOBILE_NAV_PHONE_DESTINATION_PATHS,
  PRIMARY_NAV_DESTINATIONS,
  PrimaryNavGroup,
  resolveMobileNavDestinations,
  WORKFLOWS_NAV_PATH,
} from "../primary-nav-destinations";

describe("PRIMARY_NAV_DESTINATIONS — Routines (PRD-566 / FEA-4348)", () => {
  const routines = PRIMARY_NAV_DESTINATIONS.find(
    (destination) => destination.path === "/routines"
  );

  it("registers a Routines destination in the Artifacts group gated by the routines flag", () => {
    expect(routines).toBeDefined();
    expect(routines?.title).toBe("Routines");
    expect(routines?.icon).toBe(CalendarClockIcon);
    expect(routines?.group).toBe(PrimaryNavGroup.Artifact);
    // Gated behind the PostHog `routines` flag (default off) until GA — the
    // route carries the same gate. Belt-and-suspenders with the desktop Labs
    // setting so an unfinished feature never surfaces in prod.
    expect(routines?.featureFlag).toBe(ROUTINES_FEATURE_FLAG_KEY);
  });

  it("orders Routines among the artifact surfaces, not promoted above Sessions/Branches/Agents", () => {
    const artifactDestinations = PRIMARY_NAV_DESTINATIONS.filter(
      (destination) => destination.group === PrimaryNavGroup.Artifact
    );
    expect(
      artifactDestinations.some(
        (destination) => destination.path === "/routines"
      )
    ).toBe(true);
  });
});

describe("PRIMARY_NAV_DESTINATIONS — Workflows (docs/workflows.md)", () => {
  const workflows = PRIMARY_NAV_DESTINATIONS.find(
    (destination) => destination.path === WORKFLOWS_NAV_PATH
  );

  it("registers an always-on Workflows destination in the Artifacts group", () => {
    expect(WORKFLOWS_NAV_PATH).toBe("/workflows");
    expect(workflows).toBeDefined();
    expect(workflows?.title).toBe("Workflows");
    expect(workflows?.icon).toBe(ZapIcon);
    expect(workflows?.group).toBe(PrimaryNavGroup.Artifact);
    // Self-hosted installs have no PostHog: a flag would hide the feature.
    expect(workflows?.featureFlag).toBeUndefined();
  });

  it("sits right after Routines, its scheduled sibling", () => {
    const paths = PRIMARY_NAV_DESTINATIONS.map(
      (destination) => destination.path
    );
    expect(paths.indexOf(WORKFLOWS_NAV_PATH)).toBe(
      paths.indexOf("/routines") + 1
    );
  });

  it("leaves the fixed mobile bottom-nav set unchanged", () => {
    expect(MOBILE_NAV_PHONE_DESTINATION_PATHS).not.toContain(
      WORKFLOWS_NAV_PATH
    );
    expect(
      resolveMobileNavDestinations({}).map((destination) => destination.path)
    ).not.toContain(WORKFLOWS_NAV_PATH);
  });

  it("keeps every destination path unique", () => {
    const paths = PRIMARY_NAV_DESTINATIONS.map(
      (destination) => destination.path
    );
    expect(new Set(paths).size).toBe(paths.length);
  });
});
