import { INTEGRATION_CONNECTIONS_ANCHOR } from "@repo/app/integrations/lib/integration-anchors";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationConnectionsSection } from "../integration-connections-section";

const { panelMock } = vi.hoisted(() => ({ panelMock: vi.fn() }));

vi.mock(
  "@repo/app/integrations/components/integration-connections-panel",
  () => ({
    IntegrationConnectionsPanel: (props: { id?: string; isAdmin: boolean }) => {
      panelMock(props);
      return <div id={props.id} />;
    },
  })
);

beforeEach(() => {
  panelMock.mockReset();
});

describe("IntegrationConnectionsSection", () => {
  it("owns the deep-link anchor and passes the admin capability", () => {
    render(<IntegrationConnectionsSection isAdmin />);

    expect(INTEGRATION_CONNECTIONS_ANCHOR).toBe("integration-connections");
    expect(panelMock).toHaveBeenCalledWith({
      id: INTEGRATION_CONNECTIONS_ANCHOR,
      isAdmin: true,
    });
    expect(
      document.getElementById(INTEGRATION_CONNECTIONS_ANCHOR)
    ).not.toBeNull();
  });

  it("renders the read-only panel for members", () => {
    render(<IntegrationConnectionsSection isAdmin={false} />);
    expect(panelMock).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: false })
    );
  });
});
