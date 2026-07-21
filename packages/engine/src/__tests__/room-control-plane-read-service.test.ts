import type {
  AsyncRoomStore,
  ListRoomSummariesResultV1,
  RoomAggregateV1,
  RoomSummaryV1,
  RoomTaskGraphProjectionV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_COCKPIT_DEEP_LINK_LOOKUP_TIMEOUT_MS,
  RoomControlPlaneReadService,
  RoomControlPlaneReadServiceError,
} from "../room-control-plane-read-service.js";

const PROJECT_ID = "project-room-read";
const OTHER_PROJECT_ID = "project-other";
const ROOM_ID = "room-read-1";
const UPDATED_AT = "2026-07-19T08:00:00.000Z";

function roomSummary(overrides: Partial<RoomSummaryV1> = {}): RoomSummaryV1 {
  return {
    contractVersion: 1,
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Produce a verified control-plane projection",
    protocolId: "deliberation",
    protocolVersion: 1,
    lifecycleState: "running",
    aggregateVersion: 7,
    membershipVersion: 2,
    activeTurnId: "turn-1",
    seatCount: 1,
    createdAt: "2026-07-19T07:00:00.000Z",
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function aggregate(overrides: Partial<RoomAggregateV1> = {}): RoomAggregateV1 {
  return {
    room: {
      contractVersion: 1,
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Produce a verified control-plane projection",
      protocolId: "deliberation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: 7,
      createdAt: "2026-07-19T07:00:00.000Z",
      updatedAt: UPDATED_AT,
    },
    membershipVersion: 2,
    activeTurnId: "turn-1",
    seats: [{
      contractVersion: 1,
      id: "seat-1",
      roomId: ROOM_ID,
      role: "implementer",
      state: "active",
      permissionScope: ["read", "write"],
      activeBindingId: "binding-1",
      roleVersion: 1,
      createdAt: "2026-07-19T07:00:00.000Z",
      updatedAt: UPDATED_AT,
    }],
    bindings: [{
      contractVersion: 1,
      id: "binding-1",
      roomId: ROOM_ID,
      seatId: "seat-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex://threads/example",
      happierSessionId: "happier-1",
      serverProfileId: "server-1",
      machineId: "machine-1",
      hostId: "host-1",
      state: "attached",
      attachedAt: "2026-07-19T07:00:00.000Z",
      detachedAt: null,
      replacedByBindingId: null,
    }],
    turns: [{
      contractVersion: 1,
      id: "turn-1",
      roomId: ROOM_ID,
      sequence: 1,
      protocolPhaseId: "implementation",
      membershipVersion: 2,
      state: "running",
      startedAt: "2026-07-19T07:30:00.000Z",
      endedAt: null,
    }],
    pendingMembershipChanges: [],
    ...overrides,
  } as RoomAggregateV1;
}

function taskGraph(overrides: Partial<RoomTaskGraphProjectionV1> = {}): RoomTaskGraphProjectionV1 {
  return {
    roomId: ROOM_ID,
    aggregateVersion: 7,
    dagVersion: 3,
    nodes: [
      {
        id: "task-accepted",
        parentNodeId: null,
        objective: "Verify the read boundary",
        assignedSeatIds: ["seat-1"],
        inputRefs: ["brief-1"],
        outputRefs: ["projection-1"],
        roleRequirements: ["implementer"],
        capabilityRequirements: ["read"],
        resourceHints: {
          estimatedDurationMs: 1_000,
          concurrencyClass: "parallel",
          preferredProviderIds: ["codex"],
        },
        authorityScope: {
          allowedActions: ["read"],
          readPaths: ["/workspace"],
          writePaths: [],
        },
        acceptanceGateIds: ["gate-1"],
        retryPolicy: {
          maxAttempts: 2,
          backoff: "fixed",
          baseDelayMs: 0,
          recoveryActions: [],
        },
        progressSignature: "sha256:progress-accepted",
        state: "accepted",
        nodeVersion: 4,
        acceptedAt: UPDATED_AT,
        acceptanceEvidenceIds: ["evidence-1"],
        invalidatedByEvidenceId: null,
        reopenedByEvidenceId: null,
        origin: { kind: "created" },
        terminalLineage: null,
      },
      {
        id: "task-ready",
        parentNodeId: null,
        objective: "Render canonical state",
        assignedSeatIds: [],
        inputRefs: ["projection-1"],
        outputRefs: [],
        roleRequirements: [],
        capabilityRequirements: [],
        resourceHints: {
          estimatedDurationMs: 1_000,
          concurrencyClass: "parallel",
          preferredProviderIds: [],
        },
        authorityScope: {
          allowedActions: ["read"],
          readPaths: ["/workspace"],
          writePaths: [],
        },
        acceptanceGateIds: [],
        retryPolicy: {
          maxAttempts: 1,
          backoff: "fixed",
          baseDelayMs: 0,
          recoveryActions: [],
        },
        progressSignature: "sha256:progress-ready",
        state: "ready",
        nodeVersion: 1,
        acceptedAt: null,
        acceptanceEvidenceIds: [],
        invalidatedByEvidenceId: null,
        reopenedByEvidenceId: null,
        origin: { kind: "created" },
        terminalLineage: null,
      },
    ],
    edges: [{
      id: "edge-1",
      fromNodeId: "task-accepted",
      toNodeId: "task-ready",
      kind: "requires",
      createdByOperationId: null,
      derivedFromEdgeIds: [],
    }],
    readyNodeIds: ["task-ready"],
    criticalPathNodeIds: ["task-accepted", "task-ready"],
    ...overrides,
  } as RoomTaskGraphProjectionV1;
}

function createStore(input: {
  readonly list?: ListRoomSummariesResultV1;
  readonly room?: RoomAggregateV1 | undefined;
  readonly graph?: RoomTaskGraphProjectionV1 | null;
} = {}) {
  const listRoomSummaries = vi.fn(async () => input.list ?? {
    rooms: [roomSummary()],
    nextCursor: null,
  });
  const getRoom = vi.fn(async () => ("room" in input ? input.room : aggregate()));
  const getTaskGraph = vi.fn(async () => ("graph" in input ? input.graph ?? null : taskGraph()));

  return {
    store: {
      listRoomSummaries,
      getRoom,
      getTaskGraph,
    } as unknown as AsyncRoomStore,
    calls: { listRoomSummaries, getRoom, getTaskGraph },
  };
}

describe("RoomControlPlaneReadService", () => {
  it("forwards the opaque cursor and bounded limit to the project-bound canonical summary store", async () => {
    const { store, calls } = createStore({
      list: { rooms: [roomSummary()], nextCursor: "next-opaque-cursor" },
    });
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    const page = await service.listRooms({
      projectId: PROJECT_ID,
      cursor: "prior-opaque-cursor",
      limit: 12,
    });

    expect(calls.listRoomSummaries).toHaveBeenCalledWith({
      cursor: "prior-opaque-cursor",
      limit: 12,
    });
    expect(page).toEqual({ items: [roomSummary()], nextCursor: "next-opaque-cursor" });
  });

  it("denies a caller that tries to read a different project before touching the store", async () => {
    const { store, calls } = createStore();
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    await expect(service.listRooms({ projectId: OTHER_PROJECT_ID, cursor: null, limit: null }))
      .rejects.toMatchObject<Partial<RoomControlPlaneReadServiceError>>({
        code: "room_control_plane_project_scope_mismatch",
      });

    expect(calls.listRoomSummaries).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid cursor", { projectId: PROJECT_ID, cursor: " ", limit: null }, "room_control_plane_invalid_cursor"],
    ["invalid limit", { projectId: PROJECT_ID, cursor: null, limit: 0 }, "room_control_plane_invalid_limit"],
  ] as const)("rejects %s without forwarding it to the durable store", async (_label, input, code) => {
    const { store, calls } = createStore();
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    await expect(service.listRooms(input)).rejects.toMatchObject<Partial<RoomControlPlaneReadServiceError>>({ code });

    expect(calls.listRoomSummaries).not.toHaveBeenCalled();
  });

  it("returns null for an unknown Room without synthesizing a cockpit projection", async () => {
    const { store, calls } = createStore({ room: undefined });
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    await expect(service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID })).resolves.toBeNull();

    expect(calls.getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(calls.getTaskGraph).not.toHaveBeenCalled();
  });

  it("returns a frozen cockpit-compatible projection with unavailable runtime telemetry kept distinct from structural derivations", async () => {
    const sourceAggregate = aggregate();
    const { store, calls } = createStore({ room: sourceAggregate, graph: taskGraph() });
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    const projection = await service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });

    expect(calls.getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(calls.getTaskGraph).toHaveBeenCalledWith(ROOM_ID);
    expect(projection).toMatchObject({
      roomId: ROOM_ID,
      objective: "Produce a verified control-plane projection",
      phase: "implementation",
      health: { state: "unknown" },
      completion: { acceptedNodes: 1, total: 2, blockedNodes: 0 },
      criticalPathNodeIds: ["task-accepted", "task-ready"],
      confidence: { band: "unknown", snapshotId: "unavailable", dimensions: [] },
      capacity: {
        theoreticalSlots: 1,
        configuredSlots: 1,
        activeSlots: 0,
        queueDepth: 1,
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
        utilizationRatio: 0,
        throughputPerMinute: null,
        idleReasons: null,
      },
      tasks: [
        expect.objectContaining({
          id: "task-accepted",
          title: "Verify the read boundary",
          state: "accepted",
          ownerSeatId: "seat-1",
          inputs: ["brief-1"],
          outputs: ["projection-1"],
          gateIds: ["gate-1"],
          evidenceIds: ["evidence-1"],
        }),
        expect.objectContaining({
          id: "task-ready",
          state: "ready",
          ownerSeatId: null,
        }),
      ],
      edges: [{
        id: "edge-1",
        fromNodeId: "task-accepted",
        toNodeId: "task-ready",
        kind: "depends_on",
      }],
      alerts: [],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.capacity)).toBe(true);
    expect(Object.isFrozen(projection?.capacity.telemetry)).toBe(true);
    expect(Object.isFrozen(projection?.capacity.telemetry.structuralFields)).toBe(true);
    expect(Object.isFrozen(projection?.capacity.telemetry.observedFields)).toBe(true);
    expect(Object.isFrozen(projection?.tasks)).toBe(true);
    expect(Object.isFrozen(projection?.tasks[0])).toBe(true);

    (sourceAggregate.room as { objective: string }).objective = "mutated source";
    expect(projection?.objective).toBe("Produce a verified control-plane projection");
  });

  it("projects session links only when the connector certifies the exact active binding identity", async () => {
    const getDeepLinks = vi.fn(async () => ({
      ok: true as const,
      value: {
        contractVersion: 1 as const,
        bindingId: "binding-1",
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: "codex://threads/example",
        happierSessionId: "happier-1",
        serverProfileId: "server-1",
        machineId: "machine-1",
        hostId: "host-1",
        happierUrl: "http://127.0.0.1:18287/session/happier-1?serverId=server-1",
        nativeSessionUrl: "codex://threads/example",
      },
    }));
    const connectorRegistry = {
      tryGet: vi.fn(() => ({ getDeepLinks })),
    };
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: connectorRegistry as never,
    });

    const projection = await service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });

    expect(connectorRegistry.tryGet).toHaveBeenCalledWith("happier");
    expect(getDeepLinks).toHaveBeenCalledWith({
      contractVersion: 1,
      bindingId: "binding-1",
      identity: {
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: "codex://threads/example",
        happierSessionId: "happier-1",
        serverProfileId: "server-1",
        machineId: "machine-1",
        hostId: "host-1",
      },
    });
    expect(projection?.participants).toEqual([expect.objectContaining({
      seatId: "seat-1",
      bindingId: "binding-1",
      happierUrl: "http://127.0.0.1:18287/session/happier-1?serverId=server-1",
      nativeSessionUrl: "codex://threads/example",
    })]);
    expect(Object.isFrozen(projection?.participants)).toBe(true);
    expect(Object.isFrozen(projection?.participants[0])).toBe(true);
  });

  it("projects only identity-bound connector health and keeps it distinct from unreported provider telemetry", async () => {
    const getDeepLinks = vi.fn(async () => ({ ok: false as const, error: { code: "unavailable" } }));
    const getHealth = vi.fn(async () => ({
      connectorId: "happier",
      hostId: "host-1",
      state: "authentication_required" as const,
      checkedAt: UPDATED_AT,
      authentication: "required" as const,
      daemon: "running" as const,
      server: "reachable" as const,
      backend: "ready" as const,
      rateLimit: "unknown" as const,
      host: "reachable" as const,
      capabilities: {},
      reasonCodes: ["authentication_required" as const],
      retryAfterMs: null,
    }));
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: { tryGet: vi.fn(() => ({ getDeepLinks, getHealth })) } as never,
    });

    const projection = await service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });

    expect(getHealth).toHaveBeenCalledWith("host-1");
    expect(projection?.participants).toEqual([expect.objectContaining({
      model: null,
      connectorHealth: {
        state: "authentication_required",
        checkedAt: UPDATED_AT,
        authentication: "required",
        rateLimit: "unknown",
        reasonCodes: ["authentication_required"],
        retryAfterMs: null,
      },
    })]);
  });

  it("withholds malformed or mismatched connector health without blocking the canonical Room projection", async () => {
    const getDeepLinks = vi.fn(async () => ({ ok: false as const, error: { code: "unavailable" } }));
    const getHealth = vi.fn(async () => ({
      connectorId: "other-connector",
      hostId: "host-1",
      state: "healthy",
      checkedAt: UPDATED_AT,
      authentication: "authenticated",
      rateLimit: "clear",
      reasonCodes: ["not-a-contract-code"],
      retryAfterMs: null,
    }));
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: { tryGet: vi.fn(() => ({ getDeepLinks, getHealth })) } as never,
    });

    await expect(service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID })).resolves.toMatchObject({
      roomId: ROOM_ID,
      participants: [expect.objectContaining({
        connectorHealth: {
          state: "unknown",
          checkedAt: null,
          authentication: "unknown",
          rateLimit: "unknown",
          reasonCodes: [],
          retryAfterMs: null,
        },
      })],
    });
  });

  it("withholds connector links when the returned immutable identity does not match the Room binding", async () => {
    const getDeepLinks = vi.fn(async () => ({
      ok: true as const,
      value: {
        contractVersion: 1 as const,
        bindingId: "different-binding",
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: "codex://threads/example",
        happierSessionId: "happier-1",
        serverProfileId: "server-1",
        machineId: "machine-1",
        hostId: "host-1",
        happierUrl: "http://127.0.0.1:18287/session/happier-1?serverId=server-1",
        nativeSessionUrl: "codex://threads/example",
      },
    }));
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: { tryGet: vi.fn(() => ({ getDeepLinks })) } as never,
    });

    const projection = await service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });

    expect(projection?.participants).toEqual([expect.objectContaining({
      happierUrl: null,
      nativeSessionUrl: null,
    })]);
  });

  it("withholds a connector web link that does not target the exact Happier session and server profile", async () => {
    const getDeepLinks = vi.fn(async () => ({
      ok: true as const,
      value: {
        contractVersion: 1 as const,
        bindingId: "binding-1",
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: "codex://threads/example",
        happierSessionId: "happier-1",
        serverProfileId: "server-1",
        machineId: "machine-1",
        hostId: "host-1",
        happierUrl: "https://untrusted.example/session/different-session?serverId=server-1",
        nativeSessionUrl: null,
      },
    }));
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: { tryGet: vi.fn(() => ({ getDeepLinks })) } as never,
    });

    const projection = await service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });

    expect(projection?.participants).toEqual([expect.objectContaining({
      happierUrl: null,
      nativeSessionUrl: null,
    })]);
  });

  it("does not let a stalled connector deep-link lookup block the canonical Room projection", async () => {
    vi.useFakeTimers();
    const getDeepLinks = vi.fn(() => new Promise<never>(() => undefined));
    const { store } = createStore();
    const service = new RoomControlPlaneReadService({
      projectId: PROJECT_ID,
      roomStore: store,
      connectorRegistry: { tryGet: vi.fn(() => ({ getDeepLinks })) } as never,
    });

    try {
      const projectionPromise = service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(ROOM_COCKPIT_DEEP_LINK_LOOKUP_TIMEOUT_MS);

      await expect(projectionPromise).resolves.toMatchObject({
        roomId: ROOM_ID,
        participants: [expect.objectContaining({ happierUrl: null, nativeSessionUrl: null })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a project-bound store returns a foreign Room projection", async () => {
    const foreign = aggregate();
    (foreign.room as { projectId: string }).projectId = OTHER_PROJECT_ID;
    const { store, calls } = createStore({ room: foreign });
    const service = new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore: store });

    await expect(service.getRoomProjection({ projectId: PROJECT_ID, roomId: ROOM_ID }))
      .rejects.toMatchObject<Partial<RoomControlPlaneReadServiceError>>({
        code: "room_control_plane_projection_scope_violation",
      });

    expect(calls.getTaskGraph).not.toHaveBeenCalled();
  });
});
