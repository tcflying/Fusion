import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoomCockpitNavigationEntry } from "../../App";
import {
  RoomCockpitRoute,
  isRoomCockpitProjection,
  type RoomCockpitProjectionV1,
} from "../RoomCockpitRoute";

const projection: RoomCockpitProjectionV1 = {
  roomId: "room-live",
  objective: "Move only verified work through the Room control plane.",
  phase: "evidence review",
  health: { state: "healthy", detail: "All canonical feeds are current." },
  completion: { acceptedNodes: 2, total: 3, blockedNodes: 0 },
  criticalPathNodeIds: ["verify"],
  confidence: {
    band: "high",
    snapshotId: "confidence-live",
    dimensions: [{ name: "evidence", band: "high", rationale: "Independent receipts match." }],
  },
  capacity: {
    theoreticalSlots: 8,
    configuredSlots: 6,
    activeSlots: 4,
    queueDepth: 1,
    reservedVerifierSlots: 1,
    reservedRecoverySlots: 1,
    utilizationRatio: 0.67,
    throughputPerMinute: 2.5,
    idleReasons: [],
  },
  tasks: [{
    id: "verify",
    title: "Verify independent evidence",
    state: "running",
    ownerSeatId: "seat-codex",
    dependencyNodeIds: [],
    critical: true,
    attempt: 1,
    progressSignature: "evidence:2/3",
    inputs: ["candidate packet"],
    outputs: ["verdict"],
    gateIds: ["independent-review"],
    evidenceIds: ["receipt-1"],
    waitReason: null,
    nextRecoveryAction: null,
  }],
  edges: [],
  alerts: [],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function NavigationHarness({ available = true }: { readonly available?: boolean }) {
  const [selected, setSelected] = useState(false);
  return <RoomCockpitNavigationEntry available={available} selected={selected} onSelect={() => setSelected(true)} />;
}

describe("RoomCockpitRoute", () => {
  it("keeps the lazy desktop entry visible, keyboard-selectable, and absent from mobile navigation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NavigationHarness />);

    const entry = screen.getByRole("button", { name: "Room cockpit" });
    expect(entry).toHaveAttribute("aria-pressed", "false");
    entry.focus();
    await user.keyboard("{Enter}");
    expect(entry).toHaveAttribute("aria-pressed", "true");

    rerender(<NavigationHarness available={false} />);
    expect(screen.queryByRole("button", { name: "Room cockpit" })).not.toBeInTheDocument();
  });

  it("renders a deliberate empty boundary before a Room is selected and only displays a validated projection", async () => {
    const user = userEvent.setup();
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));
    const onClose = vi.fn();

    render(<RoomCockpitRoute projectId="project-live" onClose={onClose} fetchProjection={fetchProjection} />);

    expect(screen.getByRole("heading", { name: "No Room projection yet" })).toBeInTheDocument();
    expect(screen.getByText(/No demo telemetry is shown here/i)).toBeInTheDocument();
    expect(fetchProjection).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Room ID" }), "room-live");
    await user.click(screen.getByRole("button", { name: "Load verified Room" }));

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledWith(
      "/api/rooms/room-live?projectId=project-live",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    ));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    expect(screen.getByText(projection.objective)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("withholds malformed or unavailable endpoint data and exposes the retry path", async () => {
    const user = userEvent.setup();
    const fetchProjection = vi.fn(async () => jsonResponse({ error: { code: "ROOM_CONTROL_PLANE_PORT_UNAVAILABLE" } }, 503));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ROOM_CONTROL_PLANE_PORT_UNAVAILABLE");
    expect(isRoomCockpitProjection({ roomId: "room-live" })).toBe(false);

    await user.click(screen.getByRole("button", { name: "Refresh Room telemetry" }));
    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(2));
  });

  it("keeps normal task and chat routing in MainContent instead of creating a synthetic TaskView", () => {
    const appSource = readFileSync(resolve(process.cwd(), "app", "App.tsx"), "utf8");

    expect(appSource).toContain("const _RoomCockpitRoute = lazy");
    expect(appSource).toContain("{roomCockpitOpen ? (");
    expect(appSource).toContain(": <MainContent {...mainContentProps} />}");
    expect(appSource).not.toContain('handleTaskViewChange("room-cockpit")');
    expect(appSource).not.toContain('setTaskView("room-cockpit")');
  });
});
