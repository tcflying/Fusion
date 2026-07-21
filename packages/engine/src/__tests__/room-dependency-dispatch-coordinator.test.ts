import { describe, expect, it } from "vitest";
import {
  RoomCapabilityRegistry,
  hashRoomValue,
  type ClaimReadyRoomTaskDispatchInputV1,
  type ClaimReadyRoomTaskDispatchResultV1,
  type RoomAdaptiveSchedulingWorkItemV1,
  type RoomAggregateV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomRoleAssignmentProjectionV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeProjectionV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  RoomDependencyDispatchCoordinator,
  type RoomTaskDispatchStore,
} from "../room-dependency-dispatch-coordinator.js";
import type {
  RoomCapacityGovernorConnectorStateV1,
  RoomCapacityGovernorInputV1,
  RoomCapacityGovernorQuotaStateV1,
} from "../room-capacity-governor.js";

const PROJECT_ID = "project-dispatch-coordinator";
const ROOM_ID = "room-dispatch-coordinator";
const NOW = "2026-07-19T00:05:00.000Z";

const CAPABILITY_ROUTING_POLICY = {
  freshness: {
    maxSnapshotAgeMs: 60_000,
    maxSignalAgeMs: 60_000,
    maxFutureSkewMs: 5_000,
  },
  requirements: {
    requiredTools: ["workspace_write"],
    minimumAvailableContextTokens: 4_000,
    domain: "code",
    minimumIndependentEvidence: 1,
    minimumCalibrationOutcomeCount: 1,
    minimumQualityScore: 0.5,
  },
  providerLimits: [
    {
      providerId: "codex",
      accountId: "account-codex",
      maxActiveDispatches: 4,
      activeDispatches: 0,
      retryAfterMs: null,
      checkedAt: NOW,
    },
    {
      providerId: "claude",
      accountId: "account-claude",
      maxActiveDispatches: 4,
      activeDispatches: 0,
      retryAfterMs: null,
      checkedAt: NOW,
    },
  ],
} satisfies RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1;

function durableCapabilityRegistryProjection(
  options: {
    readonly bindingId?: "binding-a" | "binding-b";
    readonly connectorState?: "healthy" | "degraded" | "rate_limited";
    readonly rateLimitState?: "clear" | "limited" | "unknown";
    readonly qualityScore?: number;
    readonly observedAt?: string;
    readonly expiresAt?: string;
    readonly nativeSessionId?: string;
    readonly testToolState?:
      | "verified"
      | "degraded"
      | "unavailable"
      | "unverified";
  } = {}
): RoomCapabilityRegistryProjectionV1 {
  const bindingId = options.bindingId ?? "binding-a";
  const observedAt = options.observedAt ?? NOW;
  const binding = aggregate(2).bindings.find(
    (candidate) => candidate.id === bindingId
  );
  if (!binding) throw new Error(`Missing test binding ${bindingId}`);
  const snapshot = RoomCapabilityRegistry.createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: `${binding.id}-runtime-r1`,
    revision: 1,
    lineage: {
      bindingId: binding.id,
      bindingGeneration: binding.generation,
      providerId: binding.providerId,
      accountId:
        binding.providerId === "codex" ? "account-codex" : "account-claude",
      modelId: `${binding.providerId}-model`,
      connectorId: binding.connectorId,
      nativeSessionId: options.nativeSessionId ?? binding.nativeSessionId,
      hostId: binding.hostId,
    },
    freshness: {
      capturedAt: observedAt,
      expiresAt: options.expiresAt ?? "2026-07-19T00:06:00.000Z",
      sourceRevision: "controlled-runtime-r1",
    },
    tools: [
      { name: "source_read", state: "verified" },
      { name: "workspace_write", state: "verified" },
      { name: "test", state: options.testToolState ?? "verified" },
    ],
    context: {
      contextVersion: "context-r1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt,
    },
    health: {
      connectorState:
        options.connectorState ??
        (options.rateLimitState === "limited" ? "rate_limited" : "healthy"),
      hostState: "healthy",
      observedAt,
    },
    latency: { p50Ms: 100, p95Ms: 300, sampleCount: 10, observedAt },
    rateLimit: {
      state: options.rateLimitState ?? "clear",
      retryAfterMs: options.rateLimitState === "limited" ? 1_000 : null,
      observedAt,
    },
    domainQuality: [
      {
        domain: "code",
        selfReportedScore: null,
        independentEvidence: [
          {
            sourceId: "deterministic:dispatch-capability",
            kind: "deterministic_gate",
            score: options.qualityScore ?? 0.72,
            observedAt,
          },
        ],
      },
    ],
    calibration: [
      { domain: "code", outcomeCount: 10, meanAbsoluteError: 0, observedAt },
    ],
  });
  if (!snapshot.ok)
    throw new Error(
      `Invalid durable capability fixture: ${JSON.stringify(snapshot.issues)}`
    );
  const registry = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
    registryId: `room-capability-registry:${PROJECT_ID}:${ROOM_ID}`,
    current: null,
    samples: [snapshot.value],
    asOf: observedAt,
    freshness: CAPABILITY_ROUTING_POLICY.freshness,
  });
  if (!registry.ok)
    throw new Error(
      `Invalid durable registry fixture: ${JSON.stringify(registry.issues)}`
    );
  return {
    id: "room-capability-registry-projection-r1",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    registry: registry.value,
    aggregateVersion: 2,
    sourceEventId: "room-event-capability-r1",
    workerFence: {
      leaseId: WORKER_LEASE.id,
      holderId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      expectedEpoch: WORKER_LEASE.epoch,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function node(
  id: string,
  assignedSeatIds: readonly string[],
  state: RoomTaskNodeProjectionV1["state"] = "ready",
  requirements: Pick<
    RoomTaskNodeProjectionV1,
    "roleRequirements" | "capabilityRequirements"
  > = {
    roleRequirements: ["implementer"],
    capabilityRequirements: ["workspace_write"],
  }
): RoomTaskNodeProjectionV1 {
  return {
    id,
    parentNodeId: null,
    objective: `Complete ${id}`,
    assignedSeatIds,
    inputRefs: [`input:${id}`],
    outputRefs: [`artifact:${id}`],
    roleRequirements: requirements.roleRequirements,
    capabilityRequirements: requirements.capabilityRequirements,
    resourceHints: {
      estimatedDurationMs: 1,
      concurrencyClass: "parallel",
      preferredProviderIds: ["codex"],
    },
    authorityScope: {
      allowedActions: ["workspace:write"],
      readPaths: ["packages"],
      writePaths: ["packages"],
    },
    acceptanceGateIds: ["gate:done"],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "fixed",
      baseDelayMs: 0,
      recoveryActions: ["replan"],
    },
    progressSignature: `progress:${id}`,
    state,
    nodeVersion: 0,
    acceptedAt: null,
    acceptanceEvidenceIds: [],
    invalidatedByEvidenceId: null,
    reopenedByEvidenceId: null,
    origin: { kind: "created" },
    terminalLineage: null,
  };
}

function graph(
  aggregateVersion: number,
  dagVersion: number,
  nodes: readonly RoomTaskNodeProjectionV1[]
): RoomTaskGraphProjectionV1 {
  return {
    roomId: ROOM_ID,
    aggregateVersion,
    dagVersion,
    nodes,
    edges: [],
    readyNodeIds: nodes
      .filter((candidate) => candidate.state === "ready")
      .map((candidate) => candidate.id),
    criticalPathNodeIds: nodes
      .filter((candidate) => candidate.state !== "cancelled")
      .map((candidate) => candidate.id)
      .sort()
      .slice(0, 1),
  };
}

function aggregate(version: number): RoomAggregateV1 {
  return {
    room: {
      contractVersion: 1,
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Dispatch every independent ready branch",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: version,
      createdAt: NOW,
      updatedAt: NOW,
    },
    seats: [
      {
        contractVersion: 1,
        id: "seat-a",
        roomId: ROOM_ID,
        role: "implementer",
        roleVersion: 1,
        roleHistory: [],
        permissionScope: [],
        state: "active",
        activeBindingId: "binding-a",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        contractVersion: 1,
        id: "seat-b",
        roomId: ROOM_ID,
        role: "implementer",
        roleVersion: 1,
        roleHistory: [],
        permissionScope: [],
        state: "active",
        activeBindingId: "binding-b",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    bindings: [
      {
        contractVersion: 1,
        id: "binding-a",
        roomId: ROOM_ID,
        seatId: "seat-a",
        generation: 1,
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: "native-a",
        happierSessionId: "happier-a",
        serverProfileId: "server-a",
        machineId: "machine-a",
        hostId: "host-a",
        state: "attached",
        attachedAt: NOW,
        detachedAt: null,
        replacedByBindingId: null,
      },
      {
        contractVersion: 1,
        id: "binding-b",
        roomId: ROOM_ID,
        seatId: "seat-b",
        generation: 1,
        connectorId: "happier",
        providerId: "claude",
        nativeSessionId: "native-b",
        happierSessionId: "happier-b",
        serverProfileId: "server-b",
        machineId: "machine-b",
        hostId: "host-b",
        state: "attached",
        attachedAt: NOW,
        detachedAt: null,
        replacedByBindingId: null,
      },
    ],
    turns: [],
    activeTurnId: null,
    membershipVersion: 0,
    pendingMembershipChanges: [],
  };
}

function activeImplementerAssignment(): RoomRoleAssignmentProjectionV1 {
  return {
    id: "role-assignment-implementer-r1",
    roomId: ROOM_ID,
    revision: 1,
    state: "active",
    protocolId: "implementation",
    protocolVersion: 1,
    phaseId: "plan",
    capabilitySnapshot: {
      contractVersion: 1,
      snapshotId: "snapshot-implementer-r1",
      revision: 1,
      capturedAt: NOW,
      bindings: [
        {
          bindingId: "binding-a",
          availability: "eligible",
          capabilityRevision: "capability-a-r1",
          capabilities: [
            { name: "source_read", state: "verified" },
            { name: "workspace_write", state: "verified" },
            { name: "test", state: "verified" },
          ],
        },
        {
          bindingId: "binding-b",
          availability: "eligible",
          capabilityRevision: "capability-b-r1",
          capabilities: [
            { name: "source_read", state: "verified" },
            { name: "workspace_write", state: "verified" },
            { name: "test", state: "verified" },
          ],
        },
      ],
    },
    constraints: {
      locks: [{ roleId: "implementer", bindingId: "binding-a" }],
      forbids: [],
    },
    assignment: {
      contractVersion: 1,
      protocolId: "implementation",
      protocolVersion: 1,
      phaseId: "plan",
      capabilitySnapshotId: "snapshot-implementer-r1",
      capabilitySnapshotRevision: 1,
      capabilitySnapshotFingerprint: "sha256:role-assignment-test",
      assignments: [
        {
          roleId: "implementer",
          bindingIds: ["binding-a"],
          requiredCapabilities: ["source_read", "workspace_write"],
        },
        {
          roleId: "implementation_verifier",
          bindingIds: ["binding-b"],
          requiredCapabilities: ["source_read", "test"],
        },
      ],
      producerBindingIds: ["binding-a"],
    },
    authoritativeProducerBindingIds: ["binding-a"],
    aggregateVersion: 2,
    createdAt: NOW,
    supersededAt: null,
  };
}

const WORKER_LEASE: StoredRoomLeaseV1 = {
  contractVersion: 1,
  id: "lease-room-worker",
  roomId: ROOM_ID,
  kind: "room_worker",
  resourceId: ROOM_ID,
  holderId: "controller-1",
  hostId: "host-controller",
  epoch: 1,
  acquiredAt: NOW,
  renewedAt: NOW,
  expiresAt: "2026-07-19T00:06:00.000Z",
  releasedAt: null,
};

interface CapacityAdmissionSourceFixture {
  getCapacityGovernorInput(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly readyNodeIds: readonly string[];
    readonly asOf: string;
    readonly capabilityRegistry?: RoomCapabilityRegistryProjectionV1;
    readonly capabilityRegistryProof?: RoomCapacityGovernorInputV1["capabilityRegistry"];
    readonly capabilityRecommendations?: readonly RoomCapabilityRegistry.RoomCapabilityRecommendationV1[];
    readonly capabilityQualityByReadyNodeId?: Readonly<Record<string, number>>;
    readonly capabilityMinimumP95LatencyMs?: number;
  }): Promise<RoomCapacityGovernorInputV1 | null>;
}

interface CapacityDispatchFixture {
  readonly claims: ClaimReadyRoomTaskDispatchInputV1[];
  readonly coordinator: RoomDependencyDispatchCoordinator;
  readonly room: RoomAggregateV1;
}

function capacityGovernorInput(
  readyNodeIds: readonly string[],
  options: {
    readonly connectorState?: RoomCapacityGovernorConnectorStateV1;
    readonly quotaState?: RoomCapacityGovernorQuotaStateV1;
    readonly capabilityRegistry?: RoomCapacityGovernorInputV1["capabilityRegistry"];
    readonly qualityScores?: ReadonlyMap<string, number>;
    readonly p95LatencyMs?: number;
  } = {}
): RoomCapacityGovernorInputV1 {
  const quotaState = options.quotaState ?? "clear";
  const connectorState = options.connectorState ?? "healthy";
  const queued: RoomAdaptiveSchedulingWorkItemV1[] = readyNodeIds.map(
    (workId, index) => ({
      workId,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      kind: "producer",
      qualityScore: options.qualityScores?.get(workId) ?? 1 - index / 10,
      criticalPathDistance: index,
      projectPriority: 1,
      roomPriority: 1,
      enqueuedAt: NOW,
      requiredSlots: 1,
    })
  );
  return {
    contractVersion: 1,
    asOf: NOW,
    policy: {
      telemetryTtlMs: 60_000,
      maximumFailureRate: 0.5,
      maximumP95LatencyMs: 1_000,
      decreaseStepSlots: 1,
    },
    scheduling: {
      asOf: NOW,
      capacity: {
        totalSlots: 2,
        reservedVerifierSlots: 0,
        reservedRecoverySlots: 0,
      },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 1_000,
        preemptionEnabled: false,
      },
      queued,
      active: [],
    },
    telemetry: {
      sampledAt: NOW,
      queue: {
        source: "controller_observation",
        queuedWorkCount: queued.length,
      },
      running: {
        source: "controller_observation",
        activeWorkCount: 0,
        activeSlots: 0,
      },
      failures: {
        source: "controller_observation",
        attemptCount: 1,
        failureCount: 0,
      },
      latency: {
        source: "controller_observation",
        sampleCount: 1,
        p95Ms: options.p95LatencyMs ?? 1,
      },
      quota: {
        source: "session_connector_observation",
        state: quotaState,
        hardConcurrencyLimit: 2,
        retryAfterMs:
          quotaState === "limited" || quotaState === "exhausted" ? 1_000 : null,
      },
      connector: {
        source: "session_connector_observation",
        state: connectorState,
      },
    },
    capabilityRegistry: options.capabilityRegistry ?? {
      source: "durable_room_ledger",
      registryId: "registry-dispatch-coordinator-r1",
      revision: 1,
      integrityHash: "sha256:registry-dispatch-coordinator-r1",
      observedAt: NOW,
      expiresAt: "2026-07-19T00:06:00.000Z",
    },
  } as RoomCapacityGovernorInputV1;
}

function capacityDispatchFixture(
  capacityAdmissionSource?: CapacityAdmissionSourceFixture,
  options: {
    readonly capabilityRegistry?: RoomCapabilityRegistryProjectionV1;
    readonly nodeRequirements?: Pick<
      RoomTaskNodeProjectionV1,
      "roleRequirements" | "capabilityRequirements"
    >;
  } = {}
): CapacityDispatchFixture {
  const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
  let currentGraph = graph(2, 1, [
    node("node-capacity", ["seat-a"], "ready", options.nodeRequirements),
  ]);
  let currentRoom = aggregate(2);
  const assignment = activeImplementerAssignment();
  const capabilityRegistry =
    options.capabilityRegistry ?? durableCapabilityRegistryProjection();
  const store: RoomTaskDispatchStore = {
    getRoom: async () => currentRoom,
    getTaskGraph: async () => currentGraph,
    getActiveRoomRoleAssignment: async () => assignment,
    getRoomCapabilityRegistry: async () => capabilityRegistry,
    claimReadyTaskDispatch: async (input) => {
      claims.push(input);
      currentGraph = graph(
        currentGraph.aggregateVersion + 1,
        currentGraph.dagVersion + 1,
        currentGraph.nodes.map((candidate) =>
          candidate.id === input.nodeId
            ? {
                ...candidate,
                state: "running",
                nodeVersion: candidate.nodeVersion + 1,
              }
            : candidate
        )
      );
      currentRoom = aggregate(currentGraph.aggregateVersion);
      return {
        nodeId: input.nodeId,
        ownerSeatId: input.owner.seatId,
        ownerBindingId: input.owner.bindingId,
        runningNodeVersion: input.expectedNodeVersion + 1,
        message: {} as ClaimReadyRoomTaskDispatchResultV1["message"],
        target: {} as ClaimReadyRoomTaskDispatchResultV1["target"],
        delivery: {} as ClaimReadyRoomTaskDispatchResultV1["delivery"],
        event: {} as ClaimReadyRoomTaskDispatchResultV1["event"],
        replayed: false,
      };
    },
  };
  const coordinator = new RoomDependencyDispatchCoordinator({
    projectId: PROJECT_ID,
    workerId: WORKER_LEASE.holderId,
    hostId: WORKER_LEASE.hostId,
    store,
    now: () => NOW,
    capabilityRoutingPolicy: CAPABILITY_ROUTING_POLICY,
    ...(capacityAdmissionSource ? { capacityAdmissionSource } : {}),
  });
  return { claims, coordinator, room: currentRoom };
}

describe("RoomDependencyDispatchCoordinator", () => {
  it("uses the durable role assignment instead of stale node seat hints and carries its revision into the claim", async () => {
    const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
    const assignment = activeImplementerAssignment();
    let currentGraph = graph(2, 1, [node("node-role-assigned", ["seat-b"])]);
    let currentRoom = aggregate(2);
    const store: RoomTaskDispatchStore = {
      getRoom: async () => currentRoom,
      getTaskGraph: async () => currentGraph,
      getActiveRoomRoleAssignment: async () => assignment,
      claimReadyTaskDispatch: async (input) => {
        claims.push(input);
        currentGraph = graph(
          3,
          2,
          currentGraph.nodes.map((candidate) =>
            candidate.id === input.nodeId
              ? {
                  ...candidate,
                  state: "running",
                  nodeVersion: candidate.nodeVersion + 1,
                }
              : candidate
          )
        );
        currentRoom = aggregate(3);
        return {
          nodeId: input.nodeId,
          ownerSeatId: input.owner.seatId,
          ownerBindingId: input.owner.bindingId,
          runningNodeVersion: input.expectedNodeVersion + 1,
          message: {} as ClaimReadyRoomTaskDispatchResultV1["message"],
          target: {} as ClaimReadyRoomTaskDispatchResultV1["target"],
          delivery: {} as ClaimReadyRoomTaskDispatchResultV1["delivery"],
          event: {} as ClaimReadyRoomTaskDispatchResultV1["event"],
          replayed: false,
        };
      },
    };
    const coordinator = new RoomDependencyDispatchCoordinator({
      projectId: PROJECT_ID,
      workerId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      store,
      now: () => NOW,
    });

    const result = await coordinator.dispatchReadyTasks({
      room: currentRoom,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(result).toMatchObject({
      claimedNodeIds: ["node-role-assigned"],
      skippedNodeIds: [],
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      owner: { seatId: "seat-a", bindingId: "binding-a" },
      roleAssignment: {
        assignmentId: assignment.id,
        revision: assignment.revision,
        phaseId: assignment.phaseId,
      },
    });
  });

  it("replans after each atomic claim and starts every independent assigned branch", async () => {
    const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
    const renewedLeases: StoredRoomLeaseV1[] = [];
    let currentGraph = graph(2, 1, [
      node("node-a", ["seat-a"]),
      node("node-b", ["seat-b"], "ready", {
        roleRequirements: ["implementation_verifier"],
        capabilityRequirements: ["test"],
      }),
    ]);
    let currentRoom = aggregate(2);
    const assignment = activeImplementerAssignment();
    const store: RoomTaskDispatchStore = {
      getRoom: async () => currentRoom,
      getTaskGraph: async () => currentGraph,
      getActiveRoomRoleAssignment: async () => assignment,
      claimReadyTaskDispatch: async (input) => {
        claims.push(input);
        currentGraph = graph(
          currentGraph.aggregateVersion + 1,
          currentGraph.dagVersion + 1,
          currentGraph.nodes.map((candidate) =>
            candidate.id === input.nodeId
              ? {
                  ...candidate,
                  state: "running",
                  nodeVersion: candidate.nodeVersion + 1,
                }
              : candidate
          )
        );
        currentRoom = aggregate(currentGraph.aggregateVersion);
        return {
          nodeId: input.nodeId,
          ownerSeatId: input.owner.seatId,
          ownerBindingId: input.owner.bindingId,
          runningNodeVersion: input.expectedNodeVersion + 1,
          message: {} as ClaimReadyRoomTaskDispatchResultV1["message"],
          target: {} as ClaimReadyRoomTaskDispatchResultV1["target"],
          delivery: {} as ClaimReadyRoomTaskDispatchResultV1["delivery"],
          event: {} as ClaimReadyRoomTaskDispatchResultV1["event"],
          replayed: false,
        };
      },
    };
    const coordinator = new RoomDependencyDispatchCoordinator({
      projectId: PROJECT_ID,
      workerId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      store,
      now: () => NOW,
    });

    const result = await coordinator.dispatchReadyTasks({
      room: currentRoom,
      lease: WORKER_LEASE,
      renewLease: async (activeLease) => {
        const renewed = {
          ...activeLease,
          renewedAt: `2026-07-19T00:0${renewedLeases.length + 1}:00.000Z`,
          expiresAt: "2026-07-19T00:06:00.000Z",
        };
        renewedLeases.push(renewed);
        return renewed;
      },
    });

    expect(result).toMatchObject({
      room: { room: { aggregateVersion: 4 } },
      claimedNodeIds: ["node-a", "node-b"],
      skippedNodeIds: [],
    });
    expect(claims).toHaveLength(2);
    expect(renewedLeases).toHaveLength(2);
    expect(result.lease).toEqual(renewedLeases[1]);
    expect(
      claims.map((claim) => ({
        nodeId: claim.nodeId,
        expectedAggregateVersion: claim.expectedAggregateVersion,
        expectedDagVersion: claim.expectedDagVersion,
        expectedNodeVersion: claim.expectedNodeVersion,
        owner: claim.owner,
      }))
    ).toEqual([
      {
        nodeId: "node-a",
        expectedAggregateVersion: 2,
        expectedDagVersion: 1,
        expectedNodeVersion: 0,
        owner: {
          seatId: "seat-a",
          bindingId: "binding-a",
          roleAssignment: {
            assignmentId: assignment.id,
            revision: 1,
            phaseId: "plan",
          },
        },
      },
      {
        nodeId: "node-b",
        expectedAggregateVersion: 3,
        expectedDagVersion: 2,
        expectedNodeVersion: 0,
        owner: {
          seatId: "seat-b",
          bindingId: "binding-b",
          roleAssignment: {
            assignmentId: assignment.id,
            revision: 1,
            phaseId: "plan",
          },
        },
      },
    ]);
    for (const claim of claims) {
      expect(claim.authority).toMatchObject({
        actorType: "controller",
        actorId: WORKER_LEASE.holderId,
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        allowedActions: ["room:task:dispatch"],
      });
      expect(hashRoomValue(claim.message.content)).toBe(
        claim.message.contentHash
      );
      expect(claim.message.content).toContain(
        "Authority allowed actions: workspace:write"
      );
      expect(claim.message.content).toContain("Authority read paths: packages");
      expect(claim.message.content).toContain(
        "Authority write paths: packages"
      );
      expect(claim.message.content).toContain(
        `Authority scope hash: ${hashRoomValue({
          allowedActions: ["workspace:write"],
          readPaths: ["packages"],
          writePaths: ["packages"],
        })}`
      );
    }
  });

  it("does not let an ambiguous assignment block an independent exact owner", async () => {
    const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
    const assignment: RoomRoleAssignmentProjectionV1 = {
      ...activeImplementerAssignment(),
      constraints: { locks: [], forbids: [] },
      assignment: {
        ...activeImplementerAssignment().assignment,
        assignments: [
          {
            roleId: "implementer",
            bindingIds: ["binding-a", "binding-b"],
            requiredCapabilities: ["source_read", "workspace_write"],
          },
          {
            roleId: "implementation_verifier",
            bindingIds: ["binding-a"],
            requiredCapabilities: ["source_read", "test"],
          },
        ],
      },
    };
    let currentGraph = graph(2, 1, [
      node("node-ambiguous", ["seat-a", "seat-b"]),
      node("node-independent", ["seat-a"], "ready", {
        roleRequirements: ["implementation_verifier"],
        capabilityRequirements: ["test"],
      }),
    ]);
    let currentRoom = aggregate(2);
    const store: RoomTaskDispatchStore = {
      getRoom: async () => currentRoom,
      getTaskGraph: async () => currentGraph,
      getActiveRoomRoleAssignment: async () => assignment,
      claimReadyTaskDispatch: async (input) => {
        claims.push(input);
        currentGraph = graph(
          currentGraph.aggregateVersion + 1,
          currentGraph.dagVersion + 1,
          currentGraph.nodes.map((candidate) =>
            candidate.id === input.nodeId
              ? {
                  ...candidate,
                  state: "running",
                  nodeVersion: candidate.nodeVersion + 1,
                }
              : candidate
          )
        );
        currentRoom = aggregate(currentGraph.aggregateVersion);
        return {
          nodeId: input.nodeId,
          ownerSeatId: input.owner.seatId,
          ownerBindingId: input.owner.bindingId,
          runningNodeVersion: input.expectedNodeVersion + 1,
          message: {} as ClaimReadyRoomTaskDispatchResultV1["message"],
          target: {} as ClaimReadyRoomTaskDispatchResultV1["target"],
          delivery: {} as ClaimReadyRoomTaskDispatchResultV1["delivery"],
          event: {} as ClaimReadyRoomTaskDispatchResultV1["event"],
          replayed: false,
        };
      },
    };
    const coordinator = new RoomDependencyDispatchCoordinator({
      projectId: PROJECT_ID,
      workerId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      store,
      now: () => NOW,
    });

    const result = await coordinator.dispatchReadyTasks({
      room: currentRoom,
      lease: WORKER_LEASE,
      renewLease: async (activeLease) => activeLease,
    });

    expect(result).toMatchObject({
      room: { room: { aggregateVersion: 3 } },
      claimedNodeIds: ["node-independent"],
      skippedNodeIds: ["node-ambiguous"],
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]!.owner).toMatchObject({
      seatId: "seat-a",
      bindingId: "binding-a",
      roleAssignment: {
        assignmentId: assignment.id,
        revision: 1,
        phaseId: "plan",
      },
    });
  });

  it("claims an independent branch while another node waits for approval", async () => {
    const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
    let currentGraph = graph(2, 1, [
      node("node-waiting", ["seat-a"], "waiting_approval"),
      node("node-independent", ["seat-b"], "ready", {
        roleRequirements: ["implementation_verifier"],
        capabilityRequirements: ["test"],
      }),
    ]);
    let currentRoom = aggregate(2);
    const assignment = activeImplementerAssignment();
    const store: RoomTaskDispatchStore = {
      getRoom: async () => currentRoom,
      getTaskGraph: async () => currentGraph,
      getActiveRoomRoleAssignment: async () => assignment,
      claimReadyTaskDispatch: async (input) => {
        claims.push(input);
        currentGraph = graph(
          currentGraph.aggregateVersion + 1,
          currentGraph.dagVersion + 1,
          currentGraph.nodes.map((candidate) =>
            candidate.id === input.nodeId
              ? {
                  ...candidate,
                  state: "running",
                  nodeVersion: candidate.nodeVersion + 1,
                }
              : candidate
          )
        );
        currentRoom = aggregate(currentGraph.aggregateVersion);
        return {
          nodeId: input.nodeId,
          ownerSeatId: input.owner.seatId,
          ownerBindingId: input.owner.bindingId,
          runningNodeVersion: input.expectedNodeVersion + 1,
          message: {} as ClaimReadyRoomTaskDispatchResultV1["message"],
          target: {} as ClaimReadyRoomTaskDispatchResultV1["target"],
          delivery: {} as ClaimReadyRoomTaskDispatchResultV1["delivery"],
          event: {} as ClaimReadyRoomTaskDispatchResultV1["event"],
          replayed: false,
        };
      },
    };
    const coordinator = new RoomDependencyDispatchCoordinator({
      projectId: PROJECT_ID,
      workerId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      store,
      now: () => NOW,
    });

    const result = await coordinator.dispatchReadyTasks({
      room: currentRoom,
      lease: WORKER_LEASE,
      renewLease: async (activeLease) => activeLease,
    });

    expect(result).toMatchObject({
      room: { room: { aggregateVersion: 3 } },
      claimedNodeIds: ["node-independent"],
      skippedNodeIds: [],
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]!.owner).toMatchObject({
      seatId: "seat-b",
      bindingId: "binding-b",
      roleAssignment: {
        assignmentId: assignment.id,
        revision: 1,
        phaseId: "plan",
      },
    });
  });

  it("fails closed without an active capability-aware role assignment", async () => {
    const claims: ClaimReadyRoomTaskDispatchInputV1[] = [];
    const currentGraph = graph(2, 1, [node("node-unassigned", ["seat-a"])]);
    const currentRoom = aggregate(2);
    const store: RoomTaskDispatchStore = {
      getRoom: async () => currentRoom,
      getTaskGraph: async () => currentGraph,
      getActiveRoomRoleAssignment: async () => null,
      claimReadyTaskDispatch: async (input) => {
        claims.push(input);
        throw new Error(
          "A missing role assignment must not reach the durable claim"
        );
      },
    };
    const coordinator = new RoomDependencyDispatchCoordinator({
      projectId: PROJECT_ID,
      workerId: WORKER_LEASE.holderId,
      hostId: WORKER_LEASE.hostId,
      store,
      now: () => NOW,
    });

    await expect(
      coordinator.dispatchReadyTasks({
        room: currentRoom,
        lease: WORKER_LEASE,
        renewLease: async (lease) => lease,
      })
    ).resolves.toMatchObject({
      claimedNodeIds: [],
      skippedNodeIds: ["node-unassigned"],
    });
    expect(claims).toEqual([]);
  });

  it("claims only ready work admitted by the trusted capacity governor input", async () => {
    const requests: Parameters<
      CapacityAdmissionSourceFixture["getCapacityGovernorInput"]
    >[0][] = [];
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async (input) => {
        requests.push(input);
        return capacityGovernorInput(input.readyNodeIds, {
          capabilityRegistry: input.capabilityRegistryProof,
          qualityScores: new Map(
            Object.entries(input.capabilityQualityByReadyNodeId ?? {})
          ),
          p95LatencyMs: input.capabilityMinimumP95LatencyMs,
        });
      },
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims.map((claim) => claim.nodeId)).toEqual([
      "node-capacity",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      room: { room: { id: ROOM_ID } },
      readyNodeIds: ["node-capacity"],
      asOf: NOW,
    });
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "admitted",
        requestedNodeIds: ["node-capacity"],
        admittedNodeIds: ["node-capacity"],
        reasonCodes: ["capacity_available"],
      }),
    ]);
  });

  it("does not dispatch when the trusted governor reports rate-limited quota", async () => {
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async (input) =>
        capacityGovernorInput(input.readyNodeIds, {
          quotaState: "limited",
          connectorState: "rate_limited",
          capabilityRegistry: input.capabilityRegistryProof,
          qualityScores: new Map(
            Object.entries(input.capabilityQualityByReadyNodeId ?? {})
          ),
          p95LatencyMs: input.capabilityMinimumP95LatencyMs,
        }),
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result).toMatchObject({
      claimedNodeIds: [],
      skippedNodeIds: ["node-capacity"],
    });
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        requestedNodeIds: ["node-capacity"],
        admittedNodeIds: [],
        reasonCodes: ["quota_limited"],
      }),
    ]);
  });

  it("fails closed and exposes a reason when trusted capacity telemetry is unavailable", async () => {
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async () => null,
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result).toMatchObject({
      claimedNodeIds: [],
      skippedNodeIds: ["node-capacity"],
    });
    expect(result.capacityAdmissions).toEqual([
      {
        state: "withheld",
        requestedNodeIds: ["node-capacity"],
        admittedNodeIds: [],
        reasonCodes: ["capacity_telemetry_unavailable"],
        decision: null,
      },
    ]);
  });

  it("refuses an injected healthy default when the durable binding report is rate-limited", async () => {
    const fixture = capacityDispatchFixture(
      {
        getCapacityGovernorInput: async (input) =>
          capacityGovernorInput(input.readyNodeIds),
      },
      {
        capabilityRegistry: durableCapabilityRegistryProjection({
          rateLimitState: "limited",
        }),
      }
    );

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result).toMatchObject({
      claimedNodeIds: [],
      skippedNodeIds: ["node-capacity"],
    });
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        requestedNodeIds: ["node-capacity"],
        admittedNodeIds: [],
        reasonCodes: expect.arrayContaining(["capacity_binding_ineligible"]),
      }),
    ]);
  });

  it("refuses a stale durable binding report before a healthy telemetry default can dispatch", async () => {
    const fixture = capacityDispatchFixture(
      {
        getCapacityGovernorInput: async (input) =>
          capacityGovernorInput(input.readyNodeIds),
      },
      {
        capabilityRegistry: durableCapabilityRegistryProjection({
          observedAt: "2026-07-19T00:03:00.000Z",
          expiresAt: "2026-07-19T00:04:00.000Z",
        }),
      }
    );

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: ["capacity_binding_ineligible"],
      }),
    ]);
  });

  it("refuses a durable report whose concrete native Session identity no longer matches the binding", async () => {
    const fixture = capacityDispatchFixture(
      {
        getCapacityGovernorInput: async (input) =>
          capacityGovernorInput(input.readyNodeIds),
      },
      {
        capabilityRegistry: durableCapabilityRegistryProjection({
          nativeSessionId: "foreign-native-session",
        }),
      }
    );

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: ["capacity_binding_ineligible"],
      }),
    ]);
  });

  it("re-evaluates each node's required tools against the durable report instead of trusting the old role snapshot", async () => {
    const fixture = capacityDispatchFixture(
      {
        getCapacityGovernorInput: async (input) =>
          capacityGovernorInput(input.readyNodeIds, {
            capabilityRegistry: input.capabilityRegistryProof,
            qualityScores: new Map(
              Object.entries(input.capabilityQualityByReadyNodeId ?? {})
            ),
            p95LatencyMs: input.capabilityMinimumP95LatencyMs,
          }),
      },
      {
        capabilityRegistry: durableCapabilityRegistryProjection({
          testToolState: "unavailable",
        }),
        nodeRequirements: {
          roleRequirements: ["implementer"],
          capabilityRequirements: ["test"],
        },
      }
    );

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: ["capacity_binding_ineligible"],
      }),
    ]);
  });

  it("rejects a fake default registry proof before it can claim otherwise admissible work", async () => {
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async (input) =>
        capacityGovernorInput(input.readyNodeIds),
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: ["capacity_capability_registry_mismatch"],
      }),
    ]);
  });

  it("rejects a fake default quality score even when the durable registry proof matches", async () => {
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async (input) =>
        capacityGovernorInput(input.readyNodeIds, {
          capabilityRegistry: input.capabilityRegistryProof,
          p95LatencyMs: input.capabilityMinimumP95LatencyMs,
        }),
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: expect.arrayContaining([
          "capacity_ready_tasks_capability_mismatch",
        ]),
      }),
    ]);
  });

  it("rejects a lower fake p95 latency than the selected durable binding report", async () => {
    const fixture = capacityDispatchFixture({
      getCapacityGovernorInput: async (input) =>
        capacityGovernorInput(input.readyNodeIds, {
          capabilityRegistry: input.capabilityRegistryProof,
          qualityScores: new Map(
            Object.entries(input.capabilityQualityByReadyNodeId ?? {})
          ),
        }),
    });

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result.capacityAdmissions).toEqual([
      expect.objectContaining({
        state: "withheld",
        reasonCodes: expect.arrayContaining([
          "capacity_ready_tasks_latency_mismatch",
        ]),
      }),
    ]);
  });

  it("fails closed with an explicit reason when no capacity governor is configured", async () => {
    const fixture = capacityDispatchFixture();

    const result = await fixture.coordinator.dispatchReadyTasks({
      room: fixture.room,
      lease: WORKER_LEASE,
      renewLease: async (lease) => lease,
    });

    expect(fixture.claims).toEqual([]);
    expect(result).toMatchObject({
      claimedNodeIds: [],
      skippedNodeIds: ["node-capacity"],
    });
    expect(result.capacityAdmissions).toEqual([
      {
        state: "withheld",
        requestedNodeIds: ["node-capacity"],
        admittedNodeIds: [],
        reasonCodes: ["capacity_admission_unconfigured"],
        decision: null,
      },
    ]);
  });
});
