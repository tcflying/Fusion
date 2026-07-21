import { describe, expect, it, vi } from "vitest";
import {
  SESSION_CONNECTOR_CAPABILITIES,
  type RoomAggregateV1,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

const seams = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("../room-capability-registry-updater.js", () => ({
  MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES: 32,
  ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION: 1,
  updateRoomCapabilityRegistry: seams.update,
}));

import {
  RoomController,
  type RoomWorkerRunInput,
} from "../room-controller.js";
import type {
  ControlledRoomConnectorRuntimeObservationPortV1,
  RoomConnectorRuntimeKnownV1,
  RoomConnectorRuntimeObservationV1,
} from "../room-connector-runtime-observation-reporter.js";

const PROJECT_ID = "project-controller-capability";
const ROOM_ID = "room-controller-capability";
const NOW = "2026-07-18T12:52:00.000Z";
const OBSERVED_AT = "2026-07-18T12:51:45.000Z";
const CAPTURED_AT = "2026-07-18T12:51:50.000Z";
const EXPIRES_AT = "2026-07-18T12:53:00.000Z";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function lease(): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "lease-controller-capability",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: "controller-capability",
    hostId: "windows-controller-capability",
    epoch: 3,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-18T12:53:00.000Z",
    releasedAt: null,
  };
}

function room(): RoomAggregateV1 {
  return {
    room: {
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Capability registry update must use the controller fence",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: 7,
      createdAt: NOW,
      updatedAt: NOW,
    },
    seats: [],
    bindings: [],
    membershipVersion: 0,
    activeTurnId: null,
  } as RoomAggregateV1;
}

function identity(bindingId: string): SessionConnectorIdentityV1 {
  return {
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: `codex-thread-${bindingId}`,
    happierSessionId: `happier-session-${bindingId}`,
    serverProfileId: "server-profile-controller-capability",
    machineId: "windows-machine-controller-capability",
    hostId: "windows-controller-capability",
  };
}

function binding(
  bindingId: string,
  state: RoomBindingRecordV1["state"] = "attached",
): RoomBindingRecordV1 {
  const value = identity(bindingId);
  return {
    contractVersion: 1,
    id: bindingId,
    roomId: ROOM_ID,
    seatId: `seat-${bindingId}`,
    generation: 2,
    connectorId: value.connectorId,
    providerId: value.providerId,
    nativeSessionId: value.nativeSessionId,
    happierSessionId: value.happierSessionId,
    serverProfileId: value.serverProfileId,
    machineId: value.machineId,
    hostId: value.hostId,
    state,
    attachedAt: OBSERVED_AT,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function capabilityStates(): SessionConnectorCapabilitiesV1["capabilities"] {
  return Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, {
    state: "verified",
    evidenceRef: `evidence://connector/${name}`,
    reasonCode: null,
    lastVerifiedAt: OBSERVED_AT,
  }])) as SessionConnectorCapabilitiesV1["capabilities"];
}

function healthCapabilities(): Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
  ) as Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>>;
}

function known<T>(value: T): RoomConnectorRuntimeKnownV1<T> {
  return {
    state: "known",
    source: "controlled_connector_runtime_observation_port",
    observedAt: OBSERVED_AT,
    value,
  };
}

function runtimeObservation(
  bindingRecord: RoomBindingRecordV1,
  overrides: Partial<RoomConnectorRuntimeObservationV1> = {},
): RoomConnectorRuntimeObservationV1 {
  const value = identity(bindingRecord.id);
  return {
    contractVersion: 1,
    source: "controlled_connector_runtime_observation_port",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    bindingId: bindingRecord.id,
    identity: value,
    snapshot: known({
      snapshotId: `runtime-capability-snapshot-${bindingRecord.id}`,
      revision: 4,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    }),
    connectorEvidence: known({ availability: "available" }),
    capabilities: known({
      contractVersion: 1,
      connectorId: value.connectorId,
      connectorVersion: "0.2.73",
      sourceRevision: "happier-runtime-revision-controller-capability",
      verifiedAt: OBSERVED_AT,
      capabilities: capabilityStates(),
    } satisfies SessionConnectorCapabilitiesV1),
    health: known({
      connectorId: value.connectorId,
      hostId: value.hostId,
      state: "healthy",
      checkedAt: OBSERVED_AT,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: healthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    } satisfies SessionConnectorHealthV1),
    model: known({
      providerId: value.providerId,
      accountId: `account-${bindingRecord.id}`,
      modelId: "gpt-5.6-codex",
    }),
    tools: known([{ name: "terminal", state: "verified", evidenceRef: "evidence://tool/terminal" }]),
    mcps: known([{ name: "filesystem", state: "verified", evidenceRef: "evidence://mcp/filesystem" }]),
    skills: known([{ name: "typescript", state: "verified", evidenceRef: "evidence://skill/typescript" }]),
    context: known({ contextVersion: "context-v2", maximumTokens: 128_000, availableTokens: 64_000 }),
    workspaceAuthority: known({ workspaceId: "workspace-controller-capability", scopes: ["read", "write"], state: "verified" }),
    latency: known({ p50Ms: 250, p95Ms: 900, sampleCount: 12 }),
    rateLimit: known({ state: "clear", retryAfterMs: null }),
    domainQuality: known([{
      domain: "code",
      independentEvidence: [{
        sourceId: `gate:controller-capability-${bindingRecord.id}`,
        kind: "deterministic_gate",
        score: 0.9,
        observedAt: OBSERVED_AT,
      }],
    }]),
    calibration: known([{ domain: "code", outcomeCount: 20, meanAbsoluteError: 0.1 }]),
    ...overrides,
  };
}

function refreshedRoom(bindings: readonly RoomBindingRecordV1[], aggregateVersion = 7): RoomAggregateV1 {
  const current = room();
  return {
    ...current,
    room: { ...current.room, aggregateVersion },
    bindings,
  } as RoomAggregateV1;
}

function refreshOptions(observationPort: ControlledRoomConnectorRuntimeObservationPortV1) {
  return {
    observationPort,
    reportFreshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    registryFreshness: {
      maxSnapshotAgeMs: 120_000,
      maxSignalAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
  };
}

describe("RoomController capability-registry callback", () => {
  it("binds trusted samples to the live fence and advances controller authority after Core writes", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const done = deferred();
    let registryWritten = false;
    const authorityVersions: number[] = [];
    const recordRoomCapabilityRegistry = vi.fn();
    seams.update.mockImplementation(async (input, writer) => {
      expect(writer.recordRoomCapabilityRegistry).toBe(recordRoomCapabilityRegistry);
      registryWritten = true;
      return {
        ok: true,
        outcome: "written",
        scheduling: "schedulable",
        projectId: input.projectId,
        roomId: input.roomId,
        sampledAt: input.sampledAt,
        samples: [],
        write: {
          projection: {
            id: "registry-controller-capability",
            projectId: input.projectId,
            roomId: input.roomId,
            registry: { revision: 1 },
            aggregateVersion: 8,
            sourceEventId: "event-registry-controller-capability",
            workerFence: input.roomWorkerFence,
            createdAt: input.sampledAt,
            updatedAt: input.sampledAt,
          },
          event: {},
          replayed: false,
        },
      };
    });
    const worker = {
      runRoom: vi.fn(async (input: RoomWorkerRunInput) => {
        const update = input.recordCapabilityRegistry;
        expect(update).toBeTypeOf("function");
        const result = await update!({
          expectedAggregateVersion: 7,
          expectedRegistryRevision: 0,
          idempotencyKey: "capability-controller-command",
          freshness: {
            maxSnapshotAgeMs: 60_000,
            maxSignalAgeMs: 60_000,
            maxFutureSkewMs: 5_000,
          },
          samples: [] as never,
        });
        expect(result).toMatchObject({ ok: true, outcome: "written" });
        await input.assertAuthority();
        done.resolve();
      }),
    };
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [room()],
        assertWorkerAuthority: async (input) => {
          authorityVersions.push(input.expectedAggregateVersion);
          return {
            lease: workerLease,
            posture: {
              lifecycleState: "running" as const,
              aggregateVersion: registryWritten ? 8 : 7,
              humanPaused: false,
              approvalState: "none" as const,
            },
          };
        },
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker,
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await done.promise;
    await controller.stop();

    expect(seams.update).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      expectedAggregateVersion: 7,
      sampledAt: NOW,
      roomWorkerFence: {
        leaseId: workerLease.id,
        holderId: workerLease.holderId,
        hostId: workerLease.hostId,
        expectedEpoch: workerLease.epoch,
      },
    }), expect.objectContaining({ recordRoomCapabilityRegistry }));
    expect(authorityVersions).toContain(8);
  });

  it("refreshes all concrete bindings into one fenced durable write before task dispatch", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const observedAsOf: string[] = [];
    const observe = vi.fn(async (request) => {
      observedAsOf.push(request.asOf);
      return runtimeObservation(request.binding);
    });
    const dispatcher = vi.fn(async (input) => currentRoom);
    let currentRoom = refreshedRoom([binding("binding-a"), binding("binding-b")]);
    let registryWritten = false;
    seams.update.mockImplementation(async (input, writer) => {
      expect(writer.recordRoomCapabilityRegistry).toBe(recordRoomCapabilityRegistry);
      expect(input.samples).toHaveLength(2);
      expect(input.samples.map((sample: { report: { target: { binding: { id: string } } } }) => sample.report.target.binding.id))
        .toEqual(["binding-a", "binding-b"]);
      expect(observedAsOf).toEqual([observedAsOf[0], observedAsOf[0]]);
      expect(input.sampledAt).toBe(observedAsOf[0]);
      registryWritten = true;
      currentRoom = refreshedRoom(currentRoom.bindings, 8);
      return {
        ok: true,
        outcome: "written",
        scheduling: "schedulable",
        projectId: input.projectId,
        roomId: input.roomId,
        sampledAt: input.sampledAt,
        samples: [],
        write: {
          projection: {
            id: "registry-controller-refresh",
            projectId: input.projectId,
            roomId: input.roomId,
            registry: { revision: 1 },
            aggregateVersion: 8,
            sourceEventId: "event-registry-controller-refresh",
            workerFence: input.roomWorkerFence,
            createdAt: input.sampledAt,
            updatedAt: input.sampledAt,
          },
          event: {},
          replayed: false,
        },
      };
    });
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: {
            lifecycleState: "running" as const,
            aggregateVersion: registryWritten ? 8 : 7,
            humanPaused: false,
            approvalState: "none" as const,
          },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse(NOW) + tick++).toISOString();
      })(),
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(dispatcher).toHaveBeenCalledTimes(1));
    await controller.stop();

    expect(seams.update).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.map(([request]) => request.asOf)).toEqual(observedAsOf);
    expect(new Set(observedAsOf).size).toBe(1);
    expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({
      room: expect.objectContaining({ room: expect.objectContaining({ aggregateVersion: 8 }) }),
    }));
  });

  it.each([
    "paused",
    "authentication_blocked",
    "host_unavailable",
    "delivery_uncertain",
  ] as const)("writes trusted %s binding evidence but withholds task dispatch", async (state) => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const dispatcher = vi.fn(async () => refreshedRoom([]));
    let currentRoom = refreshedRoom([binding("binding-a", state)]);
    let registryWritten = false;
    const observe = vi.fn(async (request) => runtimeObservation(request.binding));
    seams.update.mockImplementation(async (input) => {
      registryWritten = true;
      currentRoom = refreshedRoom(currentRoom.bindings, 8);
      return {
        ok: true,
        outcome: "written",
        scheduling: "schedulable",
        projectId: input.projectId,
        roomId: input.roomId,
        sampledAt: input.sampledAt,
        samples: [],
        write: {
          projection: {
            id: `registry-${state}`,
            projectId: input.projectId,
            roomId: input.roomId,
            registry: { revision: 1 },
            aggregateVersion: 8,
            sourceEventId: `event-registry-${state}`,
            workerFence: input.roomWorkerFence,
            createdAt: input.sampledAt,
            updatedAt: input.sampledAt,
          },
          event: {},
          replayed: false,
        },
      };
    });
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: {
            lifecycleState: "running" as const,
            aggregateVersion: registryWritten ? 8 : 7,
            humanPaused: false,
            approvalState: "none" as const,
          },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(seams.update).toHaveBeenCalledTimes(1));
    await controller.stop();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("withholds task dispatch when a concrete binding has no controlled observation", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const audit = vi.fn(async () => undefined);
    const dispatcher = vi.fn(async () => refreshedRoom([]));
    const currentRoom = refreshedRoom([binding("binding-a"), binding("binding-missing")]);
    const observe = vi.fn(async (request) => {
      if (request.binding.id === "binding-missing") throw new Error("connector unavailable");
      return runtimeObservation(request.binding);
    });
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: { lifecycleState: "running" as const, aggregateVersion: 7, humanPaused: false, approvalState: "none" as const },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: audit,
    });

    await controller.start();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    await controller.stop();

    expect(seams.update).not.toHaveBeenCalled();
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
    expect(dispatcher).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "room:capability-registry-withheld",
      metadata: expect.objectContaining({
        reason: "aggregation_withheld",
        aggregateReasonCode: "missing_active_binding",
        collectionFailures: expect.arrayContaining([
          expect.objectContaining({
            bindingId: "binding-missing",
            reasonCode: "observation_port_failed",
          }),
        ]),
      }),
    }));
  });

  it("withholds task dispatch when the fenced registry write is rejected", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const dispatcher = vi.fn(async () => refreshedRoom([]));
    const currentRoom = refreshedRoom([binding("binding-a")]);
    const observe = vi.fn(async (request) => runtimeObservation(request.binding));
    seams.update.mockImplementation(async (input) => ({
      ok: false,
      outcome: "writer_rejected",
      scheduling: "not_schedulable",
      projectId: input.projectId,
      roomId: input.roomId,
      sampledAt: input.sampledAt,
      samples: [],
      reason: { code: "writer_rejected", message: "compare-and-swap rejected" },
    }));
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: { lifecycleState: "running" as const, aggregateVersion: 7, humanPaused: false, approvalState: "none" as const },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(seams.update).toHaveBeenCalledTimes(2));
    await controller.stop();

    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("replays one lost-ack refresh with the same stable operation identity", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const dispatcher = vi.fn(async () => currentRoom);
    let currentRoom = refreshedRoom([binding("binding-a")]);
    let registryWritten = false;
    const observe = vi.fn(async (request) => runtimeObservation(request.binding));
    seams.update
      .mockImplementationOnce(async (input) => ({
        ok: false,
        outcome: "writer_rejected",
        scheduling: "not_schedulable",
        projectId: input.projectId,
        roomId: input.roomId,
        sampledAt: input.sampledAt,
        samples: [],
        reason: { code: "writer_rejected", message: "transport acknowledgment lost" },
      }))
      .mockImplementationOnce(async (input) => {
        registryWritten = true;
        currentRoom = refreshedRoom(currentRoom.bindings, 8);
        return {
          ok: true,
          outcome: "written",
          scheduling: "schedulable",
          projectId: input.projectId,
          roomId: input.roomId,
          sampledAt: input.sampledAt,
          samples: [],
          write: {
            projection: {
              id: "registry-refresh-replay",
              projectId: input.projectId,
              roomId: input.roomId,
              registry: { revision: 1 },
              aggregateVersion: 8,
              sourceEventId: "event-registry-refresh-replay",
              workerFence: input.roomWorkerFence,
              createdAt: input.sampledAt,
              updatedAt: input.sampledAt,
            },
            event: {},
            replayed: true,
          },
        };
      });
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: {
            lifecycleState: "running" as const,
            aggregateVersion: registryWritten ? 8 : 7,
            humanPaused: false,
            approvalState: "none" as const,
          },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(dispatcher).toHaveBeenCalledTimes(1));
    await controller.stop();

    expect(seams.update).toHaveBeenCalledTimes(2);
    const [firstInput] = seams.update.mock.calls[0] as [Record<string, unknown>];
    const [secondInput] = seams.update.mock.calls[1] as [Record<string, unknown>];
    expect(secondInput).toBe(firstInput);
    expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);
    expect(secondInput.sampledAt).toBe(firstInput.sampledAt);
  });

  it("withholds task dispatch when the authoritative binding projection contains pending work", async () => {
    seams.update.mockReset();
    const workerLease = lease();
    const recordRoomCapabilityRegistry = vi.fn();
    const dispatcher = vi.fn(async () => refreshedRoom([]));
    const currentRoom = refreshedRoom([binding("binding-a"), binding("binding-pending", "pending")]);
    const observe = vi.fn(async (request) => runtimeObservation(request.binding));
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: workerLease.holderId,
      hostId: workerLease.hostId,
      roomStore: {
        listRunnableRooms: async () => [currentRoom],
        getRoom: async () => currentRoom,
        getRoomCapabilityRegistry: async () => null,
        assertWorkerAuthority: async () => ({
          lease: workerLease,
          posture: { lifecycleState: "running" as const, aggregateVersion: 7, humanPaused: false, approvalState: "none" as const },
        }),
        recordRoomCapabilityRegistry,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease: workerLease }),
        renewLease: async () => ({ ok: true as const, lease: workerLease }),
        releaseLease: async () => undefined,
        assertFence: async () => workerLease,
      },
      worker: { runRoom: async () => undefined },
      taskDispatcher: { dispatchReadyTasks: dispatcher },
      capabilityRegistryRefresh: refreshOptions({ observe }),
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    await controller.stop();

    expect(seams.update).not.toHaveBeenCalled();
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
    expect(dispatcher).not.toHaveBeenCalled();
  });
});
