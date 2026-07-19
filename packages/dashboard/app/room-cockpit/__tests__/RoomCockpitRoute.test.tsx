import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomCockpitNavigationEntry } from "../../App";
import {
  RoomCockpitRoute,
  isRoomCockpitProjection,
  type RoomCockpitProjectionV1,
} from "../RoomCockpitRoute";
import type { RoomCockpitEventSourceV1 } from "../roomCockpitLiveEvents";

const projection = {
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
    telemetry: {
      availability: "available",
      detail: "Persistent runtime telemetry was sampled for this Room.",
      source: "persistent_runtime_telemetry",
      observedAt: "2026-07-19T08:56:00.000Z",
      structuralFields: [
        "theoreticalSlots",
        "configuredSlots",
        "activeSlots",
        "queueDepth",
        "utilizationRatio",
      ],
      observedFields: [
        "reservedVerifierSlots",
        "reservedRecoverySlots",
        "throughputPerMinute",
        "idleReasons",
      ],
    },
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
} satisfies RoomCockpitProjectionV1;

const unavailableTelemetryProjection = {
  ...projection,
  capacity: {
    ...projection.capacity,
    telemetry: {
      availability: "unavailable",
      detail: "No persistent runtime telemetry is available from the canonical Room aggregate.",
      structuralFields: [
        "theoreticalSlots",
        "configuredSlots",
        "activeSlots",
        "queueDepth",
        "utilizationRatio",
      ],
      observedFields: [
        "reservedVerifierSlots",
        "reservedRecoverySlots",
        "throughputPerMinute",
        "idleReasons",
      ],
    },
    reservedVerifierSlots: null,
    reservedRecoverySlots: null,
    throughputPerMinute: null,
    idleReasons: null,
  },
} satisfies RoomCockpitProjectionV1;

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

class ControlledRoomEventSource implements RoomCockpitEventSourceV1 {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn(() => {
    this.closed = true;
  });
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const entries = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  emitRoomEvent(payload: unknown, cursor = ""): void {
    const event = { data: JSON.stringify(payload), lastEventId: cursor } as MessageEvent;
    for (const listener of this.listeners.get("room.event") ?? []) {
      listener(event);
    }
  }
}

function roomEvent(cursor: string, overrides: {
  readonly projectId?: string;
  readonly roomId?: string;
  readonly reconciliationRequired?: boolean;
} = {}) {
  return {
    type: "room_event",
    scope: {
      projectId: overrides.projectId ?? "project-live",
      roomId: overrides.roomId ?? "room-live",
    },
    envelope: { cursor },
    ...(overrides.reconciliationRequired ? {
      connection: { state: "degraded" },
      alerts: [{ code: "canonical_replay_failed" }],
    } : {}),
  };
}

function controlledEventSourceFactory(target: ControlledRoomEventSource[]) {
  return (url: string) => {
    const source = new ControlledRoomEventSource(url);
    target.push(source);
    return source;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomCockpitRoute", () => {
  it("accepts a capacity projection whose unavailable telemetry keeps observations null", () => {
    expect(isRoomCockpitProjection(unavailableTelemetryProjection)).toBe(true);
  });

  it("rejects legacy capacity payloads that omit the telemetry discriminator", () => {
    const { telemetry: _telemetry, ...legacyCapacity } = projection.capacity;

    expect(isRoomCockpitProjection({ ...projection, capacity: legacyCapacity })).toBe(false);
  });

  it("rejects capacity observations that conflict with the telemetry availability", () => {
    expect(isRoomCockpitProjection({
      ...unavailableTelemetryProjection,
      capacity: {
        ...unavailableTelemetryProjection.capacity,
        reservedVerifierSlots: 1,
      },
    })).toBe(false);

    expect(isRoomCockpitProjection({
      ...projection,
      capacity: {
        ...projection.capacity,
        throughputPerMinute: null,
      },
    })).toBe(false);
  });

  it("rejects telemetry metadata that does not match the current capacity contract", () => {
    expect(isRoomCockpitProjection({
      ...projection,
      capacity: {
        ...projection.capacity,
        telemetry: {
          ...projection.capacity.telemetry,
          source: "legacy_telemetry",
        },
      },
    })).toBe(false);

    expect(isRoomCockpitProjection({
      ...unavailableTelemetryProjection,
      capacity: {
        ...unavailableTelemetryProjection.capacity,
        telemetry: {
          ...unavailableTelemetryProjection.capacity.telemetry,
          observedFields: ["reservedVerifierSlots"],
        },
      },
    })).toBe(false);
  });

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

  it("fetches a canonical projection first and uses the scoped Room event stream only to reconcile it", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]?.url).toBe("/api/rooms/room-live/events?projectId=project-live");

    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitRoomEvent(roomEvent("7"), "7");
    });
    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(2));

    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("7"), "7");
      sources[0]?.emitRoomEvent(roomEvent("6"), "6");
    });
    expect(fetchProjection).toHaveBeenCalledTimes(2);
  });

  it("ignores cross-scope live events and tears down an obsolete stream before a project switch", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));
    const { rerender } = render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("8", { projectId: "other-project" }), "8");
      sources[0]?.emitRoomEvent(roomEvent("9", { roomId: "other-room" }), "9");
    });
    expect(fetchProjection).toHaveBeenCalledTimes(1);

    rerender(
      <RoomCockpitRoute
        projectId="project-next"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );
    await waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    expect(sources[1]?.url).toBe("/api/rooms/room-live/events?projectId=project-next");

    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("10"), "10");
    });
    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(2));
  });

  it("closes the live Room stream on pagehide and ignores a late event", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      sources[0]?.emitRoomEvent(roomEvent("12"), "12");
    });

    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    expect(fetchProjection).toHaveBeenCalledTimes(1);
  });

  it("shows explicit unavailable state and reconnects from the last canonical cursor before restoring the cockpit", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("11"), "11");
    });
    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(2));

    vi.useFakeTimers();
    await act(async () => {
      sources[0]?.fail();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/live-event stream is unavailable or reconnecting/i);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toBe("/api/rooms/room-live/events?projectId=project-live&cursor=11");

    vi.useRealTimers();
    await act(async () => {
      sources[1]?.open();
    });
    await waitFor(() => expect(fetchProjection).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
  });

  it("withholds the cockpit when the live EventSource factory itself is unavailable", async () => {
    const user = userEvent.setup();
    const fetchProjection = vi.fn(async () => jsonResponse({ room: projection }));
    const unavailableFactory = vi.fn(() => {
      throw new Error("Room stream unavailable");
    });

    const { unmount } = render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={unavailableFactory}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/last projection is withheld/i);
    expect(unavailableFactory).toHaveBeenCalled();
    const initialFetchCount = fetchProjection.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh Room telemetry" }));
    await waitFor(() => expect(fetchProjection.mock.calls.length).toBeGreaterThan(initialFetchCount));
    expect(screen.getByRole("alert")).toHaveTextContent(/last projection is withheld/i);
    unmount();
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
