import {
  RoomCapabilityRegistry,
  hashRoomValue,
  type AsyncDataLayer,
  type AsyncRoomStore,
  type RoomAggregateV1,
  type RoomBindingRecordV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  type RoomOutboxRecordV1,
  type RoomTaskGraphProjectionV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import type { RoomHostCompositionContextV1 } from "../room-host-composition.js";
import {
  createRoomProviderBackpressureSendRequestBinding,
  hashRoomProviderBackpressureSendRequestBinding,
  type RoomProviderBackpressureSendGateRequestV1,
} from "../room-provider-backpressure-send-boundary.js";
import {
  WINDOWS_NATIVE_ROOM_HOST_LOCAL_PROVIDER_NODE_ID,
  createWindowsNativeRoomHostCompositionDependencies,
} from "../room-windows-host-composition-runtime.js";

const AS_OF = "2026-07-27T06:40:00.000Z";
const EXPIRES_AT = "2026-07-27T06:50:00.000Z";
const PROJECT_ID = "project-1";
const ROOM_ID = "room-1";
const HOST_ID = "windows-host-1";
const WORKER_ID = "room-worker-1";

const BINDING: RoomBindingRecordV1 = {
  contractVersion: 1,
  id: "binding-1",
  roomId: ROOM_ID,
  seatId: "seat-1",
  generation: 1,
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "native-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: HOST_ID,
  state: "attached",
  attachedAt: AS_OF,
  detachedAt: null,
  replacedByBindingId: null,
};

const ROOM = {
  room: {
    id: ROOM_ID,
    projectId: PROJECT_ID,
    state: "running",
    aggregateVersion: 9,
    updatedAt: AS_OF,
  },
  membershipVersion: 1,
  activeTurnId: null,
  seats: [],
  bindings: [BINDING],
  turns: [],
  pendingMembershipChanges: [],
} as unknown as RoomAggregateV1;

const GRAPH = {
  roomId: ROOM_ID,
  aggregateVersion: 9,
  readyNodeIds: ["ready-node-1"],
  nodes: [
    {
      id: "ready-node-1",
      state: "ready",
      capabilityRequirements: ["workspace_write"],
      resourceHints: { concurrencyClass: "parallel" },
    },
    {
      id: "running-node-1",
      state: "running",
      capabilityRequirements: [],
      resourceHints: { concurrencyClass: "parallel" },
    },
  ],
} as unknown as RoomTaskGraphProjectionV1;

const LEASE: StoredRoomLeaseV1 = {
  contractVersion: 1,
  id: "room-worker-lease-1",
  roomId: ROOM_ID,
  kind: "room_worker",
  resourceId: ROOM_ID,
  holderId: WORKER_ID,
  hostId: HOST_ID,
  epoch: 3,
  acquiredAt: AS_OF,
  heartbeatAt: AS_OF,
  expiresAt: EXPIRES_AT,
  releasedAt: null,
};

function authorityRecord(): RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  return {
    contractVersion: 1,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    bundleId: "windows-room-bundle-1",
    issuer: "fusion-operator",
    policy: {
      connectorIds: ["happier"],
      controllerAdmission: {
        workClass: "normal",
        slots: 4,
      },
      adapterBindings: {
        capabilityObservationAdapterId: "windows-happier-capability-v1",
        providerAdmissionSnapshotAdapterId: "windows-happier-provider-admission-v1",
        capacityTelemetryAdapterId: "windows-happier-capacity-telemetry-v1",
        roomWorkerAuthorityAdapterId: "windows-room-worker-authority-v1",
      },
    },
    policyHash: "policy-hash-1",
    revision: 1,
    issuedAt: "2026-07-27T06:00:00.000Z",
    updatedAt: "2026-07-27T06:00:00.000Z",
    expiresAt: "2026-07-27T07:00:00.000Z",
    revokedAt: null,
    revokedReason: null,
  };
}

function capabilityProjection(
  overrides: {
    readonly healthObservedAt?: string;
    readonly rateLimitObservedAt?: string;
  } = {},
): RoomCapabilityRegistryProjectionV1 {
  const snapshot = RoomCapabilityRegistry.createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: "binding-snapshot-1",
    revision: 1,
    lineage: {
      bindingId: BINDING.id,
      bindingGeneration: BINDING.generation,
      providerId: BINDING.providerId,
      accountId: "durable-account-1",
      modelId: "gpt-5.6",
      connectorId: BINDING.connectorId,
      nativeSessionId: BINDING.nativeSessionId,
      hostId: BINDING.hostId,
    },
    freshness: {
      capturedAt: AS_OF,
      expiresAt: EXPIRES_AT,
      sourceRevision: "happier-runtime-r1",
    },
    tools: [{ name: "workspace_write", state: "verified" }],
    context: {
      contextVersion: "context-r1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: AS_OF,
    },
    health: {
      connectorState: "healthy",
      hostState: "healthy",
      observedAt: overrides.healthObservedAt ?? AS_OF,
    },
    latency: {
      p50Ms: 50,
      p95Ms: 100,
      sampleCount: 10,
      observedAt: AS_OF,
    },
    rateLimit: {
      state: "clear",
      retryAfterMs: null,
      observedAt: overrides.rateLimitObservedAt ?? AS_OF,
    },
    domainQuality: [{
      domain: "code",
      selfReportedScore: null,
      independentEvidence: [{
        sourceId: "deterministic:windows-host-runtime",
        kind: "deterministic_gate",
        score: 0.9,
        observedAt: AS_OF,
      }],
    }],
    calibration: [{
      domain: "code",
      outcomeCount: 10,
      meanAbsoluteError: 0.1,
      observedAt: AS_OF,
    }],
  });
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issues));
  const registry = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
    registryId: "registry-1",
    current: null,
    samples: [snapshot.value],
    asOf: AS_OF,
    freshness: {
      maxSnapshotAgeMs: Number.MAX_SAFE_INTEGER,
      maxSignalAgeMs: Number.MAX_SAFE_INTEGER,
      maxFutureSkewMs: 5_000,
    },
  });
  if (!registry.ok) throw new Error(JSON.stringify(registry.issues));
  return {
    id: "registry-projection-1",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    registry: registry.value,
    aggregateVersion: 9,
    sourceEventId: "registry-event-1",
    workerFence: {
      leaseId: LEASE.id,
      holderId: LEASE.holderId,
      hostId: LEASE.hostId,
      expectedEpoch: LEASE.epoch,
    },
    createdAt: AS_OF,
    updatedAt: AS_OF,
  };
}

function roomStore(
  projection: RoomCapabilityRegistryProjectionV1 | null = capabilityProjection(),
): AsyncRoomStore {
  return {
    getRoom: vi.fn(async () => ROOM),
    getTaskGraph: vi.fn(async () => GRAPH),
    getRoomCapabilityRegistry: vi.fn(async () => projection),
    assertWorkerAuthority: vi.fn(async () => ({
      lease: LEASE,
      posture: {
        lifecycleState: "running",
        aggregateVersion: ROOM.room.aggregateVersion,
      },
    })),
  } as unknown as AsyncRoomStore;
}

function runtimeFixture(
  projection: RoomCapabilityRegistryProjectionV1 | null = capabilityProjection(),
) {
  const asyncLayer = { projectId: PROJECT_ID } as AsyncDataLayer;
  const store = roomStore(projection);
  const roomContext: RoomHostCompositionContextV1 = {
    projectId: PROJECT_ID,
    taskStore: {} as never,
    asyncLayer,
    roomStore: store,
    connectorRegistry: { ids: () => ["happier"] } as never,
    connectorIds: ["happier"],
    hostId: HOST_ID,
  };
  const getActiveLease = vi.fn(async () => LEASE);
  const assertFence = vi.fn(async () => LEASE);
  const dependencies = createWindowsNativeRoomHostCompositionDependencies({
    authorityRecord: authorityRecord(),
    roomContext,
    createLeaseStore: () => ({ getActiveLease, assertFence }),
  });
  const factoryContext = {
    projectId: PROJECT_ID,
    asyncLayer,
    roomStore: store,
    workerId: WORKER_ID,
    hostId: HOST_ID,
  };
  return {
    dependencies,
    factoryContext,
    getActiveLease,
    assertFence,
    projection,
  };
}

function sendRequest(): RoomProviderBackpressureSendGateRequestV1 {
  const delivery: RoomOutboxRecordV1 = {
    contractVersion: 1,
    id: "outbox-1",
    roomId: ROOM_ID,
    logicalMessageId: "message-1",
    localMessageId: "local-message-1",
    bindingId: BINDING.id,
    idempotencyKey: "message-1:binding-1",
    payloadHash: hashRoomValue("hello"),
    state: "pending",
    attemptCount: 0,
    connectorAcknowledgementId: null,
    nativeMessageId: null,
    nativeCursor: null,
    reconciliationFromCursor: null,
    reconciliationEvidenceRef: null,
    lastErrorCode: null,
    nextAttemptAt: null,
    updatedAt: AS_OF,
  };
  const base = {
    contractVersion: 1 as const,
    delivery,
    binding: BINDING,
    identity: {
      connectorId: BINDING.connectorId,
      providerId: BINDING.providerId,
      nativeSessionId: BINDING.nativeSessionId,
      happierSessionId: BINDING.happierSessionId,
      serverProfileId: BINDING.serverProfileId,
      machineId: BINDING.machineId,
      hostId: BINDING.hostId,
    },
    attemptId: "attempt-1",
    senderFence: {
      leaseId: "sender-lease-1",
      roomId: ROOM_ID,
      kind: "sender" as const,
      resourceId: BINDING.id,
      holderId: WORKER_ID,
      hostId: HOST_ID,
      expectedEpoch: 1,
    },
    asOf: AS_OF,
    deadline: EXPIRES_AT,
    signal: new AbortController().signal,
  };
  const requestBinding = createRoomProviderBackpressureSendRequestBinding(base);
  return {
    ...base,
    requestBinding,
    requestHash: hashRoomProviderBackpressureSendRequestBinding(requestBinding),
  };
}

describe("Windows native Room host composition runtime", () => {
  it("reads provider lineage from the durable registry and worker authority from the active Core lease", async () => {
    const fixture = runtimeFixture();
    const ports = fixture.dependencies.providerBackpressureVerifiedFactory(
      fixture.factoryContext,
    );
    const request = sendRequest();

    const snapshot = await ports.trustedAdmissionSnapshot.read({
      contractVersion: 1,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      request,
    });
    const authority = await ports.roomWorkerAuthority.resolve({
      contractVersion: 1,
      phase: "admit",
      request,
      asOf: AS_OF,
    });

    expect(snapshot).toMatchObject({
      action: "ready",
      snapshot: {
        scope: {
          providerId: "codex",
          accountId: "durable-account-1",
          modelId: "gpt-5.6",
          connectorId: "happier",
          nodeId: WINDOWS_NATIVE_ROOM_HOST_LOCAL_PROVIDER_NODE_ID,
        },
        telemetry: {
          known: true,
          admissionConfirmed: true,
          activeRequests: 0,
        },
        policy: {
          concurrencyCap: 4,
        },
      },
    });
    expect(authority).toEqual({
      action: "ready",
      authority: {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        lease: LEASE,
        expectedAggregateVersion: 9,
      },
    });
    expect(fixture.getActiveLease).toHaveBeenCalledWith("room_worker", ROOM_ID);
    expect(fixture.assertFence).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: LEASE.id,
      holderId: WORKER_ID,
      hostId: HOST_ID,
      expectedEpoch: LEASE.epoch,
      now: AS_OF,
    }));
  });

  it("transactionally revalidates the durable Room worker fence and aggregate version", async () => {
    const fixture = runtimeFixture();
    const ports = fixture.dependencies.providerBackpressureVerifiedFactory(
      fixture.factoryContext,
    );

    await ports.roomWorkerAuthority.resolve({
      contractVersion: 1,
      phase: "admit",
      request: sendRequest(),
      asOf: AS_OF,
    });

    expect(fixture.factoryContext.roomStore.assertWorkerAuthority)
      .toHaveBeenCalledWith({
        roomId: ROOM_ID,
        lease: LEASE,
        expectedAggregateVersion: ROOM.room.aggregateVersion,
        now: AS_OF,
      });
  });

  it("builds routing and capacity observations from the same durable registry without claiming provider-global quota", async () => {
    const fixture = runtimeFixture();
    const ports = fixture.dependencies
      .taskDispatchCapacityAdmissionVerifiedFactory(fixture.factoryContext);
    if (!ports.capabilityRoutingPolicySource) {
      throw new Error("expected a durable routing policy source");
    }
    const policy = await ports.capabilityRoutingPolicySource
      .getCapabilityRoutingPolicy({
        room: ROOM,
        graph: GRAPH,
        capabilityRegistry: fixture.projection!,
        asOf: AS_OF,
      });
    expect(policy).toMatchObject({
      requirements: { domain: "code" },
      providerLimits: [{
        providerId: "codex",
        accountId: "durable-account-1",
        maxActiveDispatches: 4,
        activeDispatches: 1,
        checkedAt: AS_OF,
      }],
    });

    const registry = fixture.projection!.registry;
    const capability = registry.bindings[0];
    const result = await ports.capacityAdmissionSource.getCapacityGovernorInput({
      room: ROOM,
      graph: GRAPH,
      readyNodeIds: ["ready-node-1"],
      asOf: AS_OF,
      capabilityRegistry: fixture.projection!,
      capabilityRegistryProof: {
        source: "durable_room_ledger",
        registryId: registry.registryId,
        revision: registry.revision,
        integrityHash: registry.integrityHash,
        observedAt: registry.observedAt,
        expiresAt: capability.freshness.expiresAt,
      },
      capabilityRecommendations: [{
        bindingId: BINDING.id,
        providerId: capability.lineage.providerId,
        modelId: capability.lineage.modelId,
        qualityScore: 0.81,
        latencyP95Ms: capability.latency.p95Ms,
        availableContextTokens: capability.context.availableTokens,
      }],
      capabilityQualityByReadyNodeId: { "ready-node-1": 0.81 },
      capabilityMinimumP95LatencyMs: capability.latency.p95Ms,
    });

    expect(result).toMatchObject({
      scheduling: {
        capacity: { totalSlots: 4 },
        active: [{ workId: "running-node-1" }],
      },
      telemetry: {
        quota: {
          source: "host_capacity_policy",
          hardConcurrencyLimit: 4,
        },
        connector: {
          source: "durable_capability_registry",
          state: "healthy",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider_global");
  });

  it("withholds provider admission when the durable capability registry is unavailable", async () => {
    const fixture = runtimeFixture(null);
    const ports = fixture.dependencies.providerBackpressureVerifiedFactory(
      fixture.factoryContext,
    );

    await expect(ports.trustedAdmissionSnapshot.read({
      contractVersion: 1,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      request: sendRequest(),
    })).resolves.toEqual({
      action: "defer",
      reason: "durable_capability_registry_unavailable",
      retryAfterMs: null,
    });
  });

  it("withholds when the durable capability registry was written under a stale Room worker fence", async () => {
    const projection = capabilityProjection();
    const fixture = runtimeFixture({
      ...projection,
      workerFence: {
        ...projection.workerFence,
        leaseId: "stale-room-worker-lease",
      },
    });
    const ports = fixture.dependencies.providerBackpressureVerifiedFactory(
      fixture.factoryContext,
    );

    await expect(ports.trustedAdmissionSnapshot.read({
      contractVersion: 1,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      request: sendRequest(),
    })).resolves.toEqual({
      action: "defer",
      reason: "durable_capability_registry_fence_mismatch",
      retryAfterMs: null,
    });
  });

  it("withholds when any durable provider-admission signal exceeds the host telemetry TTL", async () => {
    const fixture = runtimeFixture(capabilityProjection({
      healthObservedAt: "2026-07-27T06:30:00.000Z",
    }));
    const ports = fixture.dependencies.providerBackpressureVerifiedFactory(
      fixture.factoryContext,
    );

    await expect(ports.trustedAdmissionSnapshot.read({
      contractVersion: 1,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      request: sendRequest(),
    })).resolves.toEqual({
      action: "defer",
      reason: "durable_capability_registry_stale",
      retryAfterMs: null,
    });
  });
});
