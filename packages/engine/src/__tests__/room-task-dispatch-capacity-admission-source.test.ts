import {
  RoomCapabilityRegistry,
  type RoomAggregateV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomTaskGraphProjectionV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION,
  createRoomTaskDispatchCapacityAdmissionSource,
  hashRoomTaskDispatchCapacityAdmissionPolicy,
  hashRoomTaskDispatchVerifiedTelemetryObservation,
} from "../room-task-dispatch-capacity-admission-source.js";

/*
 * FNXC:SessionRoomCapacityAdmission 2026-07-19-23:43:
 * Capacity admission may only consume a complete, integrity-bound telemetry
 * observation for the same durable binding selected by the dispatcher. These
 * focused tests keep that boundary in-memory: no database, server, or
 * provider default is allowed to make a missing observation look admissible.
 */

const AS_OF = "2026-07-19T23:40:00.000Z";
const PROJECT_ID = "project-capacity-admission-source";
const ROOM_ID = "room-capacity-admission-source";
const BINDING_ID = "binding-capacity-a";
const PROVIDER_ID = "codex";
const MODEL_ID = "gpt-5";

function room(): RoomAggregateV1 {
  return {
    room: { id: ROOM_ID, projectId: PROJECT_ID },
    bindings: [
      {
        id: BINDING_ID,
        generation: 1,
        providerId: PROVIDER_ID,
        connectorId: "connector-capacity-a",
        nativeSessionId: "native-capacity-a",
        hostId: "host-capacity-a",
      },
    ],
  } as unknown as RoomAggregateV1;
}

function graph(): RoomTaskGraphProjectionV1 {
  return {
    roomId: ROOM_ID,
    readyNodeIds: ["node-capacity-a"],
    nodes: [
      {
        id: "node-capacity-a",
        state: "ready",
        capabilityRequirements: ["workspace_write"],
      },
    ],
  } as unknown as RoomTaskGraphProjectionV1;
}

function policy() {
  const unsigned = {
    contractVersion:
      ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION,
    proof: {
      source: "verified_room_capacity_policy" as const,
      policyId: "room-capacity-policy-r1",
      revision: 1,
      observedAt: "2026-07-19T23:39:00.000Z",
      expiresAt: "2026-07-19T23:45:00.000Z",
    },
    governor: {
      telemetryTtlMs: 60_000,
      maximumFailureRate: 0.5,
      maximumP95LatencyMs: 1_000,
      decreaseStepSlots: 1,
    },
    scheduling: {
      minimumProjectReservations: [],
      minimumRoomReservations: [],
      fairnessAgingQuantumMs: 1_000,
      preemptionEnabled: false,
    },
    capabilityRouting: {
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
          providerId: PROVIDER_ID,
          accountId: "account-capacity-a",
          maxActiveDispatches: 2,
          activeDispatches: 0,
          retryAfterMs: null,
          checkedAt: AS_OF,
        },
      ],
    },
  };
  return {
    ...unsigned,
    proof: {
      ...unsigned.proof,
      integrityHash: hashRoomTaskDispatchCapacityAdmissionPolicy(unsigned),
    },
  };
}

function capabilityContext() {
  const snapshot = RoomCapabilityRegistry.createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: "binding-capacity-a-r1",
    revision: 1,
    lineage: {
      bindingId: BINDING_ID,
      bindingGeneration: 1,
      providerId: PROVIDER_ID,
      accountId: "account-capacity-a",
      modelId: MODEL_ID,
      connectorId: "connector-capacity-a",
      nativeSessionId: "native-capacity-a",
      hostId: "host-capacity-a",
    },
    freshness: {
      capturedAt: AS_OF,
      expiresAt: "2026-07-19T23:41:00.000Z",
      sourceRevision: "connector-capacity-r1",
    },
    tools: [{ name: "workspace_write", state: "verified" }],
    context: {
      contextVersion: "context-capacity-r1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: AS_OF,
    },
    health: {
      connectorState: "healthy",
      hostState: "healthy",
      observedAt: AS_OF,
    },
    latency: { p50Ms: 50, p95Ms: 100, sampleCount: 10, observedAt: AS_OF },
    rateLimit: { state: "clear", retryAfterMs: null, observedAt: AS_OF },
    domainQuality: [
      {
        domain: "code",
        selfReportedScore: null,
        independentEvidence: [
          {
            sourceId: "deterministic:capacity-admission-source",
            kind: "deterministic_gate",
            score: 0.9,
            observedAt: AS_OF,
          },
        ],
      },
    ],
    calibration: [
      { domain: "code", outcomeCount: 10, meanAbsoluteError: 0, observedAt: AS_OF },
    ],
  });
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issues));
  const registry = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
    registryId: "room-capacity-registry-r1",
    current: null,
    samples: [snapshot.value],
    asOf: AS_OF,
    freshness: policy().capabilityRouting.freshness,
  });
  if (!registry.ok) throw new Error(JSON.stringify(registry.issues));
  const eligibility = RoomCapabilityRegistry.evaluateRoomBindingCapability({
    snapshot: snapshot.value,
    asOf: AS_OF,
    policy: policy().capabilityRouting,
  });
  if (!eligibility.ok || !eligibility.value.eligible || eligibility.value.qualityScore === null) {
    throw new Error("Expected the capability fixture to be eligible");
  }
  const projection: RoomCapabilityRegistryProjectionV1 = {
    id: "capability-projection-r1",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    registry: registry.value,
    aggregateVersion: 1,
    sourceEventId: "event-capability-r1",
    workerFence: {
      leaseId: "lease-capacity-a",
      holderId: "worker-capacity-a",
      hostId: "host-capacity-a",
      expectedEpoch: 1,
    },
    createdAt: AS_OF,
    updatedAt: AS_OF,
  };
  return {
    projection,
    proof: {
      source: "durable_room_ledger" as const,
      registryId: registry.value.registryId,
      revision: registry.value.revision,
      integrityHash: registry.value.integrityHash,
      observedAt: registry.value.observedAt,
      expiresAt: snapshot.value.freshness.expiresAt,
    },
    recommendation: {
      bindingId: BINDING_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      qualityScore: eligibility.value.qualityScore,
      latencyP95Ms: snapshot.value.latency.p95Ms,
      availableContextTokens: snapshot.value.context.availableTokens,
    },
  };
}

function observation(qualityScore: number, quotaState: "clear" | "unknown" = "clear", sampledAt = AS_OF) {
  const queued = [
    {
      workId: "node-capacity-a",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      kind: "producer" as const,
      qualityScore,
      criticalPathDistance: 0,
      projectPriority: 1,
      roomPriority: 1,
      enqueuedAt: AS_OF,
      requiredSlots: 1,
    },
  ];
  const unsigned = {
    proof: {
      source: "verified_session_connector_capacity_telemetry" as const,
      observationId: "capacity-observation-r1",
      bindingId: BINDING_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      sampledAt,
      expiresAt: "2026-07-19T23:41:00.000Z",
    },
    scheduling: {
      capacity: {
        totalSlots: 2,
        reservedVerifierSlots: 0,
        reservedRecoverySlots: 0,
      },
      queued,
      active: [],
    },
    telemetry: {
      sampledAt,
      queue: { source: "controller_observation" as const, queuedWorkCount: queued.length },
      running: {
        source: "controller_observation" as const,
        activeWorkCount: 0,
        activeSlots: 0,
      },
      failures: { source: "controller_observation" as const, attemptCount: 1, failureCount: 0 },
      latency: { source: "controller_observation" as const, sampleCount: 1, p95Ms: 100 },
      quota: {
        source: "session_connector_observation" as const,
        state: quotaState,
        hardConcurrencyLimit: 2,
        retryAfterMs: null,
      },
      connector: { source: "session_connector_observation" as const, state: "healthy" as const },
    },
  };
  return {
    ...unsigned,
    proof: {
      ...unsigned.proof,
      integrityHash: hashRoomTaskDispatchVerifiedTelemetryObservation(unsigned),
    },
  };
}

describe("RoomTaskDispatchCapacityAdmissionSource", () => {
  it("builds a governor input from one current verified binding observation", async () => {
    const activePolicy = policy();
    const capability = capabilityContext();
    const telemetry = observation(capability.recommendation.qualityScore);
    const source = createRoomTaskDispatchCapacityAdmissionSource({
      policy: activePolicy,
      telemetryObservation: {
        observeVerifiedCapacityTelemetry: async () => telemetry,
      },
    });

    const result = await source.getCapacityGovernorInput({
      room: room(),
      graph: graph(),
      readyNodeIds: ["node-capacity-a"],
      asOf: AS_OF,
      capabilityRegistry: capability.projection,
      capabilityRegistryProof: capability.proof,
      capabilityRecommendations: [capability.recommendation],
      capabilityQualityByReadyNodeId: {
        "node-capacity-a": capability.recommendation.qualityScore,
      },
      capabilityMinimumP95LatencyMs: capability.recommendation.latencyP95Ms,
    });

    expect(result).toMatchObject({
      asOf: AS_OF,
      policy: activePolicy.governor,
      capabilityRegistry: capability.proof,
      scheduling: {
        asOf: AS_OF,
        queued: [
          {
            workId: "node-capacity-a",
            qualityScore: capability.recommendation.qualityScore,
          },
        ],
      },
      telemetry: {
        sampledAt: AS_OF,
        quota: { state: "clear", hardConcurrencyLimit: 2 },
      },
    });
  });

  it("fails closed when the verified observation reports unknown quota", async () => {
    const activePolicy = policy();
    const capability = capabilityContext();
    const source = createRoomTaskDispatchCapacityAdmissionSource({
      policy: activePolicy,
      telemetryObservation: {
        observeVerifiedCapacityTelemetry: async () =>
          observation(capability.recommendation.qualityScore, "unknown"),
      },
    });

    await expect(source.getCapacityGovernorInput({
      room: room(),
      graph: graph(),
      readyNodeIds: ["node-capacity-a"],
      asOf: AS_OF,
      capabilityRegistry: capability.projection,
      capabilityRegistryProof: capability.proof,
      capabilityRecommendations: [capability.recommendation],
      capabilityQualityByReadyNodeId: {
        "node-capacity-a": capability.recommendation.qualityScore,
      },
      capabilityMinimumP95LatencyMs: capability.recommendation.latencyP95Ms,
    })).resolves.toBeNull();
  });

  it("fails closed when the signed telemetry sample is older than the verified TTL", async () => {
    const activePolicy = policy();
    const capability = capabilityContext();
    const source = createRoomTaskDispatchCapacityAdmissionSource({
      policy: activePolicy,
      telemetryObservation: {
        observeVerifiedCapacityTelemetry: async () =>
          observation(
            capability.recommendation.qualityScore,
            "clear",
            "2026-07-19T23:38:00.000Z"
          ),
      },
    });

    await expect(source.getCapacityGovernorInput({
      room: room(),
      graph: graph(),
      readyNodeIds: ["node-capacity-a"],
      asOf: AS_OF,
      capabilityRegistry: capability.projection,
      capabilityRegistryProof: capability.proof,
      capabilityRecommendations: [capability.recommendation],
      capabilityQualityByReadyNodeId: {
        "node-capacity-a": capability.recommendation.qualityScore,
      },
      capabilityMinimumP95LatencyMs: capability.recommendation.latencyP95Ms,
    })).resolves.toBeNull();
  });

  it("fails closed for a mixed binding/provider recommendation group", async () => {
    const activePolicy = policy();
    const capability = capabilityContext();
    const source = createRoomTaskDispatchCapacityAdmissionSource({
      policy: activePolicy,
      telemetryObservation: {
        observeVerifiedCapacityTelemetry: async () =>
          observation(capability.recommendation.qualityScore),
      },
    });

    await expect(source.getCapacityGovernorInput({
      room: room(),
      graph: graph(),
      readyNodeIds: ["node-capacity-a"],
      asOf: AS_OF,
      capabilityRegistry: capability.projection,
      capabilityRegistryProof: capability.proof,
      capabilityRecommendations: [
        capability.recommendation,
        {
          ...capability.recommendation,
          bindingId: "binding-capacity-b",
          providerId: "claude",
          modelId: "claude-sonnet",
        },
      ],
      capabilityQualityByReadyNodeId: {
        "node-capacity-a": capability.recommendation.qualityScore,
      },
      capabilityMinimumP95LatencyMs: capability.recommendation.latencyP95Ms,
    })).resolves.toBeNull();
  });

  it("fails closed when the dispatcher proof does not match the durable registry", async () => {
    const activePolicy = policy();
    const capability = capabilityContext();
    const source = createRoomTaskDispatchCapacityAdmissionSource({
      policy: activePolicy,
      telemetryObservation: {
        observeVerifiedCapacityTelemetry: async () =>
          observation(capability.recommendation.qualityScore),
      },
    });

    await expect(source.getCapacityGovernorInput({
      room: room(),
      graph: graph(),
      readyNodeIds: ["node-capacity-a"],
      asOf: AS_OF,
      capabilityRegistry: capability.projection,
      capabilityRegistryProof: {
        ...capability.proof,
        integrityHash: "sha256:tampered-capability-registry",
      },
      capabilityRecommendations: [capability.recommendation],
      capabilityQualityByReadyNodeId: {
        "node-capacity-a": capability.recommendation.qualityScore,
      },
      capabilityMinimumP95LatencyMs: capability.recommendation.latencyP95Ms,
    })).resolves.toBeNull();
  });
});
