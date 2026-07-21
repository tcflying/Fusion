import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

const executionStatus = {
  contractVersion: 1,
  projectId: "project-live",
  state: "execution_started",
  reasonCodes: [],
  changedAt: "2026-07-20T02:25:00.000Z",
  readServiceAvailable: true,
  liveEventServiceAvailable: true,
  controllerStarted: true,
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isExecutionStatusRequest(input: RequestInfo | URL): boolean {
  const path = input instanceof URL
    ? input.toString()
    : typeof input === "string"
      ? input
      : input.url;
  return path.startsWith("/api/room-control-plane/status?");
}

function isExistingSessionPreflightRequest(input: RequestInfo | URL): boolean {
  const path = input instanceof URL
    ? input.toString()
    : typeof input === "string"
      ? input
      : input.url;
  return path.startsWith("/api/rooms/session-preflight?");
}

function existingSessionPreflightIdentity(session: {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}, providerId = "happier") {
  return {
    connectorId: session.connectorId,
    providerId,
    nativeSessionId: "019f22f6-6581-7781-bb37-84cf4d63d81d",
    happierSessionId: "cmrlz93zb002jg1888442usqo",
    serverProfileId: "srv_lbLN2rpeYpZBvdYD7njB20g85I8BJsYx",
    machineId: session.requiredMachineId ?? "windows-machine-1",
    hostId: session.requiredHostId,
  };
}

function existingSessionPreflightResult(session: {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}, providerTelemetry?: unknown, providerId = "happier") {
  const identity = existingSessionPreflightIdentity(session, providerId);
  return {
    contractVersion: 1,
    state: "identity_verified" as const,
    request: {
      connectorId: session.connectorId,
      canonicalSessionUri: session.canonicalSessionUri,
      requiredHostId: session.requiredHostId,
      ...(session.requiredMachineId === undefined ? {} : { requiredMachineId: session.requiredMachineId }),
    },
    identity,
    checkedAt: "2026-07-20T07:30:00.000Z",
    providerTurnStarted: false as const,
    capabilities: [
      { name: "ensureExisting", state: "verified" },
      { name: "status", state: "verified" },
      { name: "history", state: "verified" },
      { name: "send", state: "verified" },
    ],
    health: {
      state: "healthy",
      checkedAt: "2026-07-20T07:30:00.000Z",
      authentication: "authenticated",
      rateLimit: "clear",
      reasonCodes: [],
      retryAfterMs: null,
    },
    ...(providerTelemetry === undefined ? {} : { providerTelemetry }),
  };
}

function freshCodexProviderTelemetry(
  identity: ReturnType<typeof existingSessionPreflightIdentity>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    contractVersion: 1,
    state: "reported",
    identity,
    providerId: "codex",
    source: "happier_persisted_in_band_provider_snapshot",
    observedAt: "2026-07-21T02:40:00.000Z",
    expiresAt: "2026-07-21T03:10:00.000Z",
    freshness: "fresh",
    limitations: {
      providerAvailability: "not_inferred",
      capacity: "not_reported",
      onDemandProviderRefresh: "not_attempted",
      accountIdentity: "not_reported",
      rawSnapshot: "not_reported",
    },
    ...overrides,
  };
}

function createCockpitFetcher(roomPayload: unknown = { room: projection }, roomStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL) => (
    isExecutionStatusRequest(input)
      ? jsonResponse({ status: executionStatus })
      : jsonResponse(roomPayload, roomStatus)
  ));
}

/** Room projections and project-scoped lifecycle reads are separate requests. */
function expectProjectionRequestCount(
  fetchProjection: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  expectedCount: number,
): void {
  const projectionCount = fetchProjection.mock.calls.filter(([input]) => (
    typeof input === "string" && input.startsWith("/api/rooms/")
  )).length;
  expect(projectionCount).toBe(expectedCount);
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

  emitRoomEvent(
    payload: unknown,
    cursor = "",
    eventName: "room.event" | "canonical_room_event" = "room.event",
  ): void {
    const event = { data: JSON.stringify(payload), lastEventId: cursor } as MessageEvent;
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }

  emitReplayContinuation(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("room.replay.continue") ?? []) {
      listener(event);
    }
  }

  emitConnection(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("room.connection") ?? []) {
      listener(event);
    }
  }

  emitAlert(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("room.alert") ?? []) {
      listener(event);
    }
  }
}

function roomEvent(cursor: string, overrides: {
  readonly projectId?: string;
  readonly roomId?: string;
  readonly reconciliationRequired?: boolean;
} = {}) {
  const projectId = overrides.projectId ?? "project-live";
  const roomId = overrides.roomId ?? "room-live";
  const occurredAt = "2026-07-19T19:30:00.000Z";
  const alerts = overrides.reconciliationRequired ? [{
    code: "canonical_replay_failed",
    severity: "critical",
    scope: { projectId, roomId },
    cursor,
    expectedStreamSequence: null,
    observedStreamSequence: null,
  }] : [];

  return {
    contractVersion: 1,
    type: "canonical_room_event",
    scope: { projectId, roomId },
    provenance: {
      cursor,
      eventId: `event-${cursor}`,
      type: "task_progress_observed",
      occurredAt,
      correlationId: `correlation-${cursor}`,
      causationId: null,
    },
    connection: {
      state: overrides.reconciliationRequired ? "degraded" : "connected",
      reason: null,
      changedAt: occurredAt,
    },
    alerts,
  };
}

function roomConnection(
  state: "connected" | "degraded" | "disconnected" | "unknown",
  overrides: {
    readonly projectId?: string;
    readonly roomId?: string;
    readonly cursor?: string | null;
    readonly reason?: string | null;
    readonly includeReason?: boolean;
    readonly alerts?: readonly unknown[];
  } = {},
) {
  return {
    contractVersion: 1,
    type: "room_connection",
    scope: {
      projectId: overrides.projectId ?? "project-live",
      roomId: overrides.roomId ?? "room-live",
    },
    cursor: overrides.cursor ?? null,
    connection: {
      state,
      ...(overrides.includeReason === false ? {} : { reason: overrides.reason ?? null }),
      changedAt: "2026-07-19T19:30:00.000Z",
    },
    alerts: overrides.alerts ?? [],
  };
}

function roomAlert(code: string, overrides: {
  readonly projectId?: string;
  readonly roomId?: string;
  readonly alertProjectId?: string;
  readonly alertRoomId?: string;
  readonly cursor?: string | null;
  readonly severity?: "warning" | "critical";
} = {}) {
  const projectId = overrides.projectId ?? "project-live";
  const roomId = overrides.roomId ?? "room-live";
  return {
    contractVersion: 1,
    type: "room_alert",
    scope: { projectId, roomId },
    alerts: [{
      code,
      severity: overrides.severity ?? "critical",
      scope: {
        projectId: overrides.alertProjectId ?? projectId,
        roomId: overrides.alertRoomId ?? roomId,
      },
      cursor: overrides.cursor ?? null,
      expectedStreamSequence: null,
      observedStreamSequence: null,
    }],
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
  cleanup();
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
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();
    const onClose = vi.fn();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={onClose}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

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

  it("preflights multiple existing Sessions through the Cockpit without creating or attaching a Room", async () => {
    const user = userEvent.setup();
    const fetchProjection = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isExistingSessionPreflightRequest(input)) {
        const body = JSON.parse(String(init?.body)) as { readonly sessions: readonly {
          readonly connectorId: string;
          readonly canonicalSessionUri: string;
          readonly requiredHostId: string;
          readonly requiredMachineId?: string;
        }[] };
        return jsonResponse({
          results: body.sessions.map((session, index) => ({
            commandId: `room-existing-session-preflight:test:${index + 1}`,
            result: existingSessionPreflightResult(session),
          })),
        });
      }
      if (isExecutionStatusRequest(input)) return jsonResponse({ status: executionStatus });
      return jsonResponse({ room: projection });
    });

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    expect(screen.getByRole("heading", { name: "Preflight old Sessions" })).toBeInTheDocument();
    expect(screen.getByText(/no attach/i)).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Canonical Session URI 1" }),
      "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
    );
    await user.type(screen.getByRole("textbox", { name: "Required host 1" }), "windows-host-1");
    await user.click(screen.getByRole("button", { name: "Add Session" }));
    await user.type(screen.getByRole("textbox", { name: "Canonical Session URI 2" }), "claude://sessions/claude-session-2");
    await user.type(screen.getByRole("textbox", { name: "Required host 2" }), "windows-host-2");
    await user.type(screen.getByRole("textbox", { name: "Required machine 2" }), "windows-machine-2");
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    await waitFor(() => expect(fetchProjection).toHaveBeenCalledWith(
      "/api/rooms/session-preflight?projectId=project-live",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      }),
    ));
    const preflightCall = fetchProjection.mock.calls.find(([input]) => isExistingSessionPreflightRequest(input as RequestInfo | URL));
    expect(preflightCall?.[1]).toMatchObject({
      body: JSON.stringify({
        sessions: [
          {
            connectorId: "happier-runtime",
            canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
            requiredHostId: "windows-host-1",
          },
          {
            connectorId: "happier-runtime",
            canonicalSessionUri: "claude://sessions/claude-session-2",
            requiredHostId: "windows-host-2",
            requiredMachineId: "windows-machine-2",
          },
        ],
      }),
    });
    expect(await screen.findAllByText("identity verified")).toHaveLength(2);
    expect(screen.getAllByText("No provider turn was started.")).toHaveLength(2);
    expect(screen.getAllByText("019f22f6-6581-7781-bb37-84cf4d63d81d")).toHaveLength(2);
    expect(screen.getAllByText("Provider snapshot withheld")).toHaveLength(2);
    expect(screen.getAllByText("connector_telemetry_unsupported")).toHaveLength(2);
  });

  it("renders a fresh persisted Codex provider snapshot without treating it as provider readiness", async () => {
    const user = userEvent.setup();
    const session = {
      connectorId: "happier-runtime",
      canonicalSessionUri: "codex://threads/provider-telemetry-1",
      requiredHostId: "windows-host-1",
    };
    const identity = existingSessionPreflightIdentity(session, "codex");
    const fetchProjection = vi.fn(async (input: RequestInfo | URL) => (
      isExistingSessionPreflightRequest(input)
        ? jsonResponse({
          results: [{
            commandId: "room-existing-session-preflight:provider-snapshot",
            result: existingSessionPreflightResult(session, freshCodexProviderTelemetry(identity), "codex"),
          }],
        })
        : jsonResponse({ room: projection })
    ));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Canonical Session URI 1" }), session.canonicalSessionUri);
    await user.type(screen.getByRole("textbox", { name: "Required host 1" }), session.requiredHostId);
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    expect(await screen.findByText("Fresh persisted Codex snapshot observed")).toBeInTheDocument();
    expect(screen.getByText("2026-07-21T02:40:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("2026-07-21T03:10:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("Does not represent provider availability, capacity, scheduling admission, or send authorization.")).toBeInTheDocument();
  });

  it("renders a canonical withheld provider snapshot without changing the verified Session result", async () => {
    const user = userEvent.setup();
    const session = {
      connectorId: "happier-runtime",
      canonicalSessionUri: "codex://threads/provider-telemetry-withheld",
      requiredHostId: "windows-host-1",
    };
    const identity = existingSessionPreflightIdentity(session, "codex");
    const fetchProjection = vi.fn(async (input: RequestInfo | URL) => (
      isExistingSessionPreflightRequest(input)
        ? jsonResponse({
          results: [{
            commandId: "room-existing-session-preflight:provider-snapshot-withheld",
            result: existingSessionPreflightResult(session, {
              contractVersion: 1,
              state: "withheld",
              identity,
              reason: "telemetry_stale",
            }, "codex"),
          }],
        })
        : jsonResponse({ room: projection })
    ));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Canonical Session URI 1" }), session.canonicalSessionUri);
    await user.type(screen.getByRole("textbox", { name: "Required host 1" }), session.requiredHostId);
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    expect(await screen.findByText("Provider snapshot withheld")).toBeInTheDocument();
    expect(screen.getByText("telemetry_stale")).toBeInTheDocument();
    expect(screen.getByText("identity verified")).toBeInTheDocument();
  });

  it("withholds a telemetry projection whose canonical identity differs from the verified Session", async () => {
    const user = userEvent.setup();
    const session = {
      connectorId: "happier-runtime",
      canonicalSessionUri: "codex://threads/provider-telemetry-identity-mismatch",
      requiredHostId: "windows-host-1",
    };
    const identity = existingSessionPreflightIdentity(session, "codex");
    const fetchProjection = vi.fn(async (input: RequestInfo | URL) => (
      isExistingSessionPreflightRequest(input)
        ? jsonResponse({
          results: [{
            commandId: "room-existing-session-preflight:provider-snapshot-identity-mismatch",
            result: existingSessionPreflightResult(session, freshCodexProviderTelemetry({
              ...identity,
              nativeSessionId: "different-native-session",
            }), "codex"),
          }],
        })
        : jsonResponse({ room: projection })
    ));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Canonical Session URI 1" }), session.canonicalSessionUri);
    await user.type(screen.getByRole("textbox", { name: "Required host 1" }), session.requiredHostId);
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    expect(await screen.findByText("Provider snapshot withheld")).toBeInTheDocument();
    expect(screen.getByText("telemetry_contract_invalid")).toBeInTheDocument();
    expect(screen.queryByText("Fresh persisted Codex snapshot observed")).not.toBeInTheDocument();
    expect(screen.queryByText("different-native-session")).not.toBeInTheDocument();
    expect(screen.getByText("identity verified")).toBeInTheDocument();
  });

  it("fails malformed, unknown, extra, and sensitive provider telemetry closed without exposing it", async () => {
    const user = userEvent.setup();
    const sessions = [
      {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/provider-telemetry-extra",
        requiredHostId: "windows-host-1",
      },
      {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/provider-telemetry-malformed",
        requiredHostId: "windows-host-2",
      },
      {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/provider-telemetry-unknown",
        requiredHostId: "windows-host-3",
      },
      {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/provider-telemetry-zero-ttl",
        requiredHostId: "windows-host-4",
      },
    ] as const;
    const accountEmail = "provider-account-must-not-render@example.test";
    const rawError = "raw-provider-error-must-not-render";
    const telemetry = [
      freshCodexProviderTelemetry(existingSessionPreflightIdentity(sessions[0], "codex"), {
        accountEmail,
        plan: "provider-plan-must-not-render",
        quotaRemaining: 424242,
      }),
      {
        contractVersion: 1,
        state: "reported",
        identity: existingSessionPreflightIdentity(sessions[1], "codex"),
        providerId: "codex",
        source: "happier_persisted_in_band_provider_snapshot",
        observedAt: "2026-07-21T02:40:00.000Z",
        expiresAt: "2026-07-21T03:10:00.000Z",
        freshness: "fresh",
      },
      {
        contractVersion: 1,
        state: "withheld",
        identity: existingSessionPreflightIdentity(sessions[2], "codex"),
        reason: "unknown-provider-reason",
        rawError,
      },
      freshCodexProviderTelemetry(existingSessionPreflightIdentity(sessions[3], "codex"), {
        observedAt: "2026-07-21T02:40:00.000Z",
        expiresAt: "2026-07-21T02:40:00.000Z",
      }),
    ] as const;
    const fetchProjection = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isExistingSessionPreflightRequest(input)) {
        const body = JSON.parse(String(init?.body)) as { readonly sessions: readonly typeof sessions[number][] };
        return jsonResponse({
          results: body.sessions.map((session, index) => ({
            commandId: `room-existing-session-preflight:provider-snapshot-invalid:${index + 1}`,
            result: existingSessionPreflightResult(session, telemetry[index], "codex"),
          })),
        });
      }
      return jsonResponse({ room: projection });
    });

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    for (const [index, session] of sessions.entries()) {
      if (index > 0) await user.click(screen.getByRole("button", { name: "Add Session" }));
      await user.type(screen.getByRole("textbox", { name: `Canonical Session URI ${index + 1}` }), session.canonicalSessionUri);
      await user.type(screen.getByRole("textbox", { name: `Required host ${index + 1}` }), session.requiredHostId);
    }
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    expect(await screen.findAllByText("Provider snapshot withheld")).toHaveLength(4);
    expect(screen.getAllByText("telemetry_contract_invalid")).toHaveLength(4);
    expect(screen.getAllByText("identity verified")).toHaveLength(4);
    expect(screen.queryByText(accountEmail)).not.toBeInTheDocument();
    expect(screen.queryByText("provider-plan-must-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("424242")).not.toBeInTheDocument();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
  });

  it("withholds malformed existing-Session preflight data before it reaches Cockpit fields", async () => {
    const user = userEvent.setup();
    const fetchProjection = vi.fn(async (input: RequestInfo | URL) => (
      isExistingSessionPreflightRequest(input)
        ? jsonResponse({ results: [{ commandId: "preflight-1", result: { secret: "must-not-reach-browser" } }] })
        : jsonResponse({ room: projection })
    ));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Canonical Session URI 1" }), "codex://threads/room-1");
    await user.type(screen.getByRole("textbox", { name: "Required host 1" }), "windows-host-1");
    await user.click(screen.getByRole("button", { name: "Verify existing Sessions" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("does not satisfy the Cockpit contract");
    expect(screen.queryByText("must-not-reach-browser")).not.toBeInTheDocument();
  });

  it("renders the authorized controller lifecycle separately from provider health", async () => {
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    const panel = await screen.findByRole("status", { name: "Room execution control-plane status" });
    expect(panel).toHaveAttribute("data-execution-state", "execution_started");
    expect(panel).toHaveTextContent("controller started");
    expect(panel).toHaveTextContent("Lifecycle evidence only");
    expect(panel).toHaveTextContent("provider, model, account, quota, and session health are not certified here");
    expect(fetchProjection).toHaveBeenCalledWith(
      "/api/room-control-plane/status?projectId=project-live",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("withholds a malformed lifecycle response without hiding its valid Room projection", async () => {
    const fetchProjection = vi.fn(async (input: RequestInfo | URL) => (
      isExecutionStatusRequest(input)
        ? jsonResponse({ status: { ...executionStatus, reasonCodes: ["unexpected_reason"] } })
        : jsonResponse({ room: projection })
    ));

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    const panel = await screen.findByRole("status", { name: "Room execution control-plane status" });
    expect(panel).toHaveAttribute("data-execution-state", "unavailable");
    expect(panel).toHaveTextContent("does not satisfy the Cockpit contract");
  });

  it("withholds malformed or unavailable endpoint data and exposes the retry path", async () => {
    const user = userEvent.setup();
    const fetchProjection = createCockpitFetcher({ error: { code: "ROOM_CONTROL_PLANE_PORT_UNAVAILABLE" } }, 503);

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Room control-plane projection endpoint is unavailable.");
    expect(alert).not.toHaveTextContent("ROOM_CONTROL_PLANE_PORT_UNAVAILABLE");
    expect(isRoomCockpitProjection({ roomId: "room-live" })).toBe(false);

    await user.click(screen.getByRole("button", { name: "Refresh Room telemetry" }));
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
  });

  it("fetches a canonical projection first and uses the scoped Room event stream only to reconcile it", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]?.url).toBe("/api/rooms/room-live/events?projectId=project-live");

    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitRoomEvent(roomEvent("7"), "7");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));

    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("7"), "7");
      sources[0]?.emitRoomEvent(roomEvent("6"), "6");
    });
    expectProjectionRequestCount(fetchProjection, 2);
  });

  it("accepts both canonical named-event surfaces once and rejects noncanonical test-only payloads", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    const { contractVersion: _contractVersion, ...legacyPayload } = roomEvent("6");
    await act(async () => {
      sources[0]?.emitRoomEvent({ ...legacyPayload, type: "room_event" }, "6");
    });
    expectProjectionRequestCount(fetchProjection, 1);

    const canonical = roomEvent("7");
    await act(async () => {
      sources[0]?.emitRoomEvent(canonical, "7", "canonical_room_event");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));

    await act(async () => {
      sources[0]?.emitRoomEvent(canonical, "7", "room.event");
    });
    expectProjectionRequestCount(fetchProjection, 2);
  });

  it("renders only bounded canonical event provenance and withholds body-bearing frames", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("7"), "7");
    });

    const provenance = await screen.findByRole("status", { name: "Last observed Room event provenance" });
    expect(provenance).toHaveTextContent("event-7");
    expect(provenance).toHaveTextContent("task_progress_observed");
    expect(provenance).toHaveTextContent("correlation-7");
    expect(provenance).toHaveTextContent("No causation recorded");

    const providerBody = "provider-body-must-not-render";
    await act(async () => {
      sources[0]?.emitRoomEvent({
        ...roomEvent("8"),
        providerBody,
        error: providerBody,
      }, "8");
    });

    expect(screen.getByRole("status", { name: "Last observed Room event provenance" })).toHaveTextContent("event-7");
    expect(screen.queryByText(providerBody)).not.toBeInTheDocument();
  });

  it("withholds raw transport error messages from the Cockpit", async () => {
    const rawTransportError = "authorization=do-not-render";
    const fetchProjection = vi.fn(async () => {
      throw new Error(rawTransportError);
    });

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory([])}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to contact the Room control-plane endpoint.");
    expect(alert).not.toHaveTextContent(rawTransportError);
  });

  it("keeps Cockpit degraded for server degraded, disconnected, and alert reports even if the EventSource opens", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitConnection(roomConnection("degraded", { cursor: "7", reason: "canonical_replay_pending" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state degraded/i);

    await act(async () => {
      sources[0]?.open();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state degraded/i);

    await act(async () => {
      sources[0]?.emitConnection(roomConnection("disconnected", { reason: "engine_live_service_stopped" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state disconnected/i);

    await act(async () => {
      sources[0]?.emitAlert(roomAlert("stream_disconnected", { cursor: "7" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/Room live-event alert stream_disconnected/i);
    expectProjectionRequestCount(fetchProjection, 1);
  });

  it("accepts the ordinary server connection frame without a terminal reason", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitConnection(roomConnection("connected", { cursor: "0", includeReason: false }));
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
  });

  it("ignores malformed and cross-scope server live-health frames", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    const invalidTimestampConnection = roomConnection("degraded");
    const invalidSequenceAlert = roomAlert("stream_disconnected");
    await act(async () => {
      sources[0]?.emitConnection(roomConnection("degraded", { projectId: "other-project" }));
      sources[0]?.emitConnection({
        ...roomConnection("degraded"),
        cursor: "01",
      });
      sources[0]?.emitConnection({
        ...invalidTimestampConnection,
        connection: { ...invalidTimestampConnection.connection, changedAt: "not-a-timestamp" },
      });
      sources[0]?.emitAlert(roomAlert("stream_disconnected", { projectId: "other-project" }));
      sources[0]?.emitAlert(roomAlert("stream_disconnected", { alertRoomId: "other-room" }));
      sources[0]?.emitAlert({
        ...roomAlert("stream_disconnected"),
        alerts: [{
          ...roomAlert("stream_disconnected").alerts[0],
          cursor: "invalid-cursor",
        }],
      });
      sources[0]?.emitAlert({
        ...invalidSequenceAlert,
        alerts: [{ ...invalidSequenceAlert.alerts[0], expectedStreamSequence: 0 }],
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    expectProjectionRequestCount(fetchProjection, 1);
  });

  it("treats zero as a canonical live-health cursor instead of accepting stale progress", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitConnection(roomConnection("degraded", { cursor: "0" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state degraded/i);

    await act(async () => {
      sources[0]?.emitAlert(roomAlert("stream_disconnected", { cursor: "0" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/Room live-event alert stream_disconnected/i);
    expectProjectionRequestCount(fetchProjection, 1);
  });

  it("restores Cockpit only after a scoped connected server report and durable projection refresh", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    await act(async () => {
      sources[0]?.emitConnection(roomConnection("degraded", { cursor: "11" }));
      sources[0]?.open();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state degraded/i);
    expectProjectionRequestCount(fetchProjection, 1);

    await act(async () => {
      sources[0]?.emitConnection(roomConnection("connected", { cursor: "11" }));
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("continues a bounded canonical replay without marking the cockpit unavailable and closes the replacement stream on pagehide", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.open();
      sources[0]?.emitRoomEvent(roomEvent("17"), "17");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));

    await act(async () => {
      sources[0]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "other-project", roomId: "room-live" },
        cursor: "17",
      });
      sources[0]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "project-live", roomId: "room-live" },
        cursor: "16",
      });
      sources[0]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "project-live", roomId: "room-live" },
        cursor: "not-a-cursor",
      });
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.close).not.toHaveBeenCalled();

    /*
    FNXC:RoomCockpitReplay 2026-07-19-18:22:
    A bounded canonical replay ends deliberately. Its matching continuation is
    not a transport failure, so the cockpit must immediately resume from the
    consumed cursor without withholding the current canonical projection.
    */
    await act(async () => {
      sources[0]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "project-live", roomId: "room-live" },
        cursor: "17",
      });
    });

    await waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    expect(sources[1]?.url).toBe("/api/rooms/room-live/events?projectId=project-live&cursor=17");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      sources[1]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "project-live", roomId: "room-live" },
        cursor: "17",
      });
    });

    expect(sources[1]?.close).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores late events from a replaced replay source without poisoning the current cursor", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("17"), "17");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
    await act(async () => {
      sources[0]?.emitReplayContinuation({
        contractVersion: 1,
        type: "room_replay_continue",
        scope: { projectId: "project-live", roomId: "room-live" },
        cursor: "17",
      });
    });
    await waitFor(() => expect(sources).toHaveLength(2));

    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("999"), "999");
    });
    expectProjectionRequestCount(fetchProjection, 2);

    await act(async () => {
      sources[1]?.emitRoomEvent(roomEvent("18"), "18", "canonical_room_event");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 3));
  });

  it("ignores cross-scope live events and tears down an obsolete stream before a project switch", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();
    const { rerender } = render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("8", { projectId: "other-project" }), "8");
      sources[0]?.emitRoomEvent(roomEvent("9", { roomId: "other-room" }), "9");
    });
    expectProjectionRequestCount(fetchProjection, 1);

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
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
  });

  it("closes the live Room stream on pagehide and ignores a late event", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      sources[0]?.emitRoomEvent(roomEvent("12"), "12");
    });

    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    expectProjectionRequestCount(fetchProjection, 1);
  });

  it("shows explicit unavailable state and reconnects from the last canonical cursor before restoring the cockpit", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    await waitFor(() => expectProjectionRequestCount(fetchProjection, 1));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emitRoomEvent(roomEvent("11"), "11");
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));

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
      sources[1]?.emitConnection(roomConnection("connected", { cursor: "11" }));
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 3));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
  });

  it("keeps the cockpit unavailable across a closed server stream until the replacement stream reports connected and refreshes", async () => {
    const sources: ControlledRoomEventSource[] = [];
    const fetchProjection = createCockpitFetcher();

    render(
      <RoomCockpitRoute
        projectId="project-live"
        initialRoomId="room-live"
        onClose={vi.fn()}
        fetchProjection={fetchProjection}
        eventSourceFactory={controlledEventSourceFactory(sources)}
      />,
    );

    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
    await waitFor(() => expect(sources).toHaveLength(1));

    vi.useFakeTimers();
    act(() => {
      sources[0]?.open();
      sources[0]?.emitConnection(roomConnection("disconnected", { reason: "engine_live_service_stopped" }));
      sources[0]?.fail();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state disconnected/i);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toBe("/api/rooms/room-live/events?projectId=project-live");

    vi.useRealTimers();
    act(() => {
      sources[1]?.open();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/server reports live-event state disconnected/i);

    act(() => {
      sources[1]?.emitConnection(roomConnection("connected", { cursor: null }));
    });
    await waitFor(() => expectProjectionRequestCount(fetchProjection, 2));
    expect(await screen.findByRole("main", { name: "Room cockpit for room-live" })).toBeInTheDocument();
  });

  it("withholds the cockpit when the live EventSource factory itself is unavailable", async () => {
    const user = userEvent.setup();
    const fetchProjection = createCockpitFetcher();
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
    const appSource = Object.values(import.meta.glob("../../App.tsx", {
      eager: true,
      import: "default",
      query: "?raw",
    }))[0] as string;

    expect(appSource).toContain("const _RoomCockpitRoute = lazy");
    expect(appSource).toContain("{roomCockpitOpen ? (");
    expect(appSource).toContain(": <MainContent {...mainContentProps} />}");
    expect(appSource).not.toContain('handleTaskViewChange("room-cockpit")');
    expect(appSource).not.toContain('setTaskView("room-cockpit")');
  });
});
