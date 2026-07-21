import { describe, expect, it } from "vitest";

import {
  createRoomBindingCapabilitySnapshot,
  mergeRoomCapabilityRegistry,
  type RoomBindingCapabilitySnapshotDraftV1,
  type RoomBindingCapabilitySnapshotV1,
  type RoomCapabilityFreshnessPolicyV1,
} from "../room-capability-registry.js";
import {
  rebuildRoomCapabilityRegistryProjectionFromEvents,
  RoomProjectionReplayError,
  ROOM_CAPABILITY_REGISTRY_MERGED_EVENT_TYPE,
} from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const CREATED_AT = "2026-07-19T10:00:00.000Z";
const OBSERVED_AT = "2026-07-19T10:01:00.000Z";
const FRESHNESS: RoomCapabilityFreshnessPolicyV1 = {
  maxSnapshotAgeMs: 60_000,
  maxSignalAgeMs: 60_000,
  maxFutureSkewMs: 5_000,
};
const REGISTRY_ID = "room-capability-registry/v1:replay-room";

function snapshotFixture(
  overrides: Partial<RoomBindingCapabilitySnapshotDraftV1> = {},
): RoomBindingCapabilitySnapshotV1 {
  const result = createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: "snapshot-replay-binding-1",
    revision: 1,
    lineage: {
      bindingId: "binding-replay-1",
      bindingGeneration: 1,
      providerId: "codex",
      accountId: "account-replay",
      modelId: "gpt-replay",
      connectorId: "happier",
      nativeSessionId: "native-replay-1",
      hostId: "windows-replay-1",
    },
    freshness: {
      capturedAt: OBSERVED_AT,
      expiresAt: "2026-07-19T10:02:00.000Z",
      sourceRevision: "connector-replay-v1",
    },
    tools: [{ name: "source_read", state: "verified" }],
    context: {
      contextVersion: "context-replay-v1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: OBSERVED_AT,
    },
    health: { connectorState: "healthy", hostState: "healthy", observedAt: OBSERVED_AT },
    latency: { p50Ms: 100, p95Ms: 200, sampleCount: 10, observedAt: OBSERVED_AT },
    rateLimit: { state: "clear", retryAfterMs: null, observedAt: OBSERVED_AT },
    domainQuality: [{
      domain: "code",
      selfReportedScore: null,
      independentEvidence: [{
        sourceId: "gate:replay",
        kind: "deterministic_gate",
        score: 0.9,
        observedAt: OBSERVED_AT,
      }],
    }],
    calibration: [{
      domain: "code",
      outcomeCount: 12,
      meanAbsoluteError: 0.1,
      observedAt: OBSERVED_AT,
    }],
    ...overrides,
  });
  if (!result.ok) throw new Error(`Invalid replay snapshot fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function createdEvent(): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-capability-registry-created",
    roomId: "room-capability-registry-replay",
    projectId: "project-capability-registry-replay",
    aggregateVersion: 0,
    eventType: "room_created",
    actorType: "human",
    actorId: "operator-replay",
    correlationId: "correlation-created",
    causationId: null,
    payload: {
      projectionVersion: 1,
      objective: "Replay an immutable capability registry",
      protocolId: "implementation",
      protocolVersion: 1,
      lifecycleState: "draft",
      membershipVersion: 0,
      activeTurnId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    occurredAt: CREATED_AT,
    cursor: "1",
  };
}

function registryEvent(
  sample: RoomBindingCapabilitySnapshotV1,
  registryOverride?: unknown,
): RoomEventRecordV1 {
  const merged = mergeRoomCapabilityRegistry({
    registryId: REGISTRY_ID,
    current: null,
    samples: [sample],
    asOf: OBSERVED_AT,
    freshness: FRESHNESS,
  });
  if (!merged.ok) throw new Error(`Invalid replay registry fixture: ${JSON.stringify(merged.issues)}`);
  return {
    contractVersion: 1,
    id: "event-capability-registry-merged",
    roomId: "room-capability-registry-replay",
    projectId: "project-capability-registry-replay",
    aggregateVersion: 1,
    eventType: ROOM_CAPABILITY_REGISTRY_MERGED_EVENT_TYPE,
    actorType: "controller",
    actorId: "worker-replay",
    correlationId: "record-capability-registry-replay",
    causationId: null,
    payload: {
      projectionVersion: 1,
      registryId: REGISTRY_ID,
      previousRegistryRevision: 0,
      registry: registryOverride ?? merged.value,
      samples: [sample],
      freshness: FRESHNESS,
      createdAt: OBSERVED_AT,
      asOf: OBSERVED_AT,
      workerFence: {
        leaseId: "lease-replay",
        holderId: "worker-replay",
        hostId: "windows-replay-1",
        expectedEpoch: 1,
      },
    },
    occurredAt: OBSERVED_AT,
    cursor: "2",
  };
}

describe("Room capability registry replay", () => {
  it("rebuilds the current registry solely from its canonical Room event", () => {
    const sample = snapshotFixture();
    const replayed = rebuildRoomCapabilityRegistryProjectionFromEvents([
      createdEvent(),
      registryEvent(sample),
    ]);

    expect(replayed).toMatchObject({
      roomId: "room-capability-registry-replay",
      projectId: "project-capability-registry-replay",
      aggregateVersion: 1,
      sourceEventId: "event-capability-registry-merged",
      registry: {
        registryId: REGISTRY_ID,
        revision: 1,
        bindings: [expect.objectContaining({ lineage: expect.objectContaining({ bindingId: "binding-replay-1" }) })],
      },
    });
  });

  it("detects a valid-looking registry that drifts from its immutable input samples", () => {
    const sample = snapshotFixture();
    const alternate = snapshotFixture({
      health: { connectorState: "degraded", hostState: "healthy", observedAt: OBSERVED_AT },
    });
    const forged = mergeRoomCapabilityRegistry({
      registryId: REGISTRY_ID,
      current: null,
      samples: [alternate],
      asOf: OBSERVED_AT,
      freshness: FRESHNESS,
    });
    if (!forged.ok) throw new Error("Forged registry fixture must remain structurally valid");

    try {
      rebuildRoomCapabilityRegistryProjectionFromEvents([
        createdEvent(),
        registryEvent(sample, forged.value),
      ]);
      throw new Error("Expected capability registry drift to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RoomProjectionReplayError);
      expect(error).toMatchObject({ code: "capability_registry_drift" });
    }
  });
});
