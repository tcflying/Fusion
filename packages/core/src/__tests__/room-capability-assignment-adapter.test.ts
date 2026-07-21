import { describe, expect, it } from "vitest";

import type { IsoTimestamp } from "../room-contracts/ids.js";
import type {
  RoomBindingCapabilitySnapshotDraftV1,
  RoomBindingCapabilitySnapshotV1,
  RoomCapabilityFreshnessPolicyV1,
  RoomCapabilityRegistryV1,
} from "../room-capability-registry.js";
import {
  createRoomBindingCapabilitySnapshot,
  mergeRoomCapabilityRegistry,
} from "../room-capability-registry.js";
import { adaptRoomCapabilityRegistryToAssignmentSnapshot } from "../room-capability-assignment-adapter.js";

const AS_OF = "2026-07-19T00:00:00.000Z" as IsoTimestamp;
const FRESHNESS: RoomCapabilityFreshnessPolicyV1 = {
  maxSnapshotAgeMs: 60_000,
  maxSignalAgeMs: 60_000,
  maxFutureSkewMs: 5_000,
};

function bindingSnapshotFixture(
  bindingId: string,
  overrides: Partial<RoomBindingCapabilitySnapshotDraftV1> = {},
): RoomBindingCapabilitySnapshotV1 {
  const result = createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: `${bindingId}-snapshot`,
    revision: 1,
    lineage: {
      bindingId,
      bindingGeneration: 1,
      providerId: `provider-${bindingId}`,
      accountId: `account-${bindingId}`,
      modelId: `model-${bindingId}`,
      connectorId: `connector-${bindingId}`,
      nativeSessionId: `native-${bindingId}`,
      hostId: `host-${bindingId}`,
    },
    freshness: {
      capturedAt: AS_OF,
      expiresAt: "2026-07-19T00:01:00.000Z",
      sourceRevision: `${bindingId}-source-v1`,
    },
    tools: [
      { name: "workspace_write", state: "verified" },
      { name: "source_read", state: "verified" },
    ],
    context: {
      contextVersion: "context-v1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: AS_OF,
    },
    health: {
      connectorState: "healthy",
      hostState: "healthy",
      observedAt: AS_OF,
    },
    latency: {
      p50Ms: 100,
      p95Ms: 300,
      sampleCount: 20,
      observedAt: AS_OF,
    },
    rateLimit: {
      state: "clear",
      retryAfterMs: null,
      observedAt: AS_OF,
    },
    domainQuality: [],
    calibration: [],
    ...overrides,
  });
  if (!result.ok) throw new Error(`Invalid binding fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function registryFixture(
  samples: readonly RoomBindingCapabilitySnapshotV1[],
  current: RoomCapabilityRegistryV1 | null = null,
  asOf: IsoTimestamp = AS_OF,
): RoomCapabilityRegistryV1 {
  const result = mergeRoomCapabilityRegistry({
    registryId: "room-registry",
    current,
    samples,
    asOf,
    freshness: FRESHNESS,
  });
  if (!result.ok) throw new Error(`Invalid registry fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function adapt(registry: RoomCapabilityRegistryV1, asOf: IsoTimestamp = AS_OF) {
  return adaptRoomCapabilityRegistryToAssignmentSnapshot({
    registry,
    asOf,
    freshness: FRESHNESS,
  });
}

describe("room capability assignment adapter", () => {
  it("orders bindings deterministically and preserves exact lineage outside the legacy snapshot", () => {
    const bindingB = bindingSnapshotFixture("binding-b");
    const bindingA = bindingSnapshotFixture("binding-a");
    const registry = registryFixture([bindingB, bindingA]);
    const callerOrdered = {
      ...registry,
      bindings: [...registry.bindings].reverse(),
    };

    const result = adapt(callerOrdered);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a converted assignment snapshot");
    expect(result.value.capabilitySnapshot).toMatchObject({
      contractVersion: 1,
      snapshotId: "room-registry",
      revision: 1,
      capturedAt: AS_OF,
    });
    expect(result.value.capabilitySnapshot.bindings.map((binding) => binding.bindingId)).toEqual([
      "binding-a",
      "binding-b",
    ]);
    expect(result.value.bindingLineages.map((lineage) => lineage.bindingId)).toEqual([
      "binding-a",
      "binding-b",
    ]);
    expect(result.value.bindingLineages[0]).toEqual(bindingA.lineage);
    expect(result.value.bindingLineages[1]).toEqual(bindingB.lineage);
    expect(result.value.capabilitySnapshot.bindings[0]).toEqual({
      bindingId: "binding-a",
      availability: "eligible",
      capabilityRevision: "binding-a-source-v1",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "workspace_write", state: "verified" },
      ],
    });
    expect(result.value.capabilitySnapshot.bindings[0]).not.toHaveProperty("providerId");
    expect(result.value.capabilitySnapshot.bindings[0]).not.toHaveProperty("modelId");
  });

  it("rejects incomplete and registry-integrity-altered input", () => {
    const registry = registryFixture([bindingSnapshotFixture("binding-a")]);
    const incomplete = structuredClone(registry) as unknown as {
      bindings: Array<{ lineage: Record<string, unknown> }>;
    };
    delete incomplete.bindings[0]?.lineage.accountId;

    const incompleteResult = adapt(incomplete as unknown as RoomCapabilityRegistryV1);

    expect(incompleteResult.ok).toBe(false);
    if (incompleteResult.ok) throw new Error("Expected incomplete lineage rejection");
    expect(incompleteResult.issues).toContainEqual(expect.objectContaining({ code: "invalid_snapshot" }));

    const integrityAltered = structuredClone(registry) as unknown as { registryId: string } & RoomCapabilityRegistryV1;
    integrityAltered.registryId = "another-registry";
    const integrityResult = adapt(integrityAltered);

    expect(integrityResult.ok).toBe(false);
    if (integrityResult.ok) throw new Error("Expected registry-integrity rejection");
    expect(integrityResult.issues).toContainEqual(expect.objectContaining({ code: "registry_integrity_mismatch" }));
  });

  it("rejects a stale registry and stale capability signals", () => {
    const registry = registryFixture([bindingSnapshotFixture("binding-a")]);

    const result = adapt(registry, "2026-07-19T00:01:01.000Z" as IsoTimestamp);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale registry rejection");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_registry" }),
      expect.objectContaining({ code: "stale_snapshot", bindingId: "binding-a" }),
      expect.objectContaining({ code: "snapshot_expired", bindingId: "binding-a" }),
      expect.objectContaining({ code: "stale_signal", bindingId: "binding-a" }),
    ]));
  });

  it("rejects unsafe binding health instead of treating a degraded connector as assignable", () => {
    const registry = registryFixture([
      bindingSnapshotFixture("binding-a", {
        health: {
          connectorState: "degraded",
          hostState: "healthy",
          observedAt: AS_OF,
        },
      }),
    ]);

    const result = adapt(registry);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unsafe health rejection");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "unsafe_binding_health",
      bindingId: "binding-a",
    }));
  });

  it("carries a later loss of a capability into the next frozen assignment snapshot", () => {
    const initialBinding = bindingSnapshotFixture("binding-a");
    const initialRegistry = registryFixture([initialBinding]);
    const refreshedBinding = bindingSnapshotFixture("binding-a", {
      revision: 2,
      freshness: {
        capturedAt: AS_OF,
        expiresAt: "2026-07-19T00:01:00.000Z",
        sourceRevision: "binding-a-source-v2",
      },
      tools: [
        { name: "workspace_write", state: "unavailable" },
        { name: "source_read", state: "verified" },
      ],
    });
    const refreshedRegistry = registryFixture([refreshedBinding], initialRegistry);

    const before = adapt(initialRegistry);
    const after = adapt(refreshedRegistry);

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("Expected refreshed capability snapshots");
    expect(before.value.capabilitySnapshot.bindings[0]?.capabilities).toContainEqual({
      name: "workspace_write",
      state: "verified",
    });
    expect(after.value.capabilitySnapshot).toMatchObject({ revision: 2 });
    expect(after.value.capabilitySnapshot.bindings[0]).toMatchObject({
      bindingId: "binding-a",
      availability: "eligible",
      capabilityRevision: "binding-a-source-v2",
    });
    expect(after.value.capabilitySnapshot.bindings[0]?.capabilities).toContainEqual({
      name: "workspace_write",
      state: "unavailable",
    });
  });

  it("returns a deeply frozen detached result", () => {
    const registry = registryFixture([bindingSnapshotFixture("binding-a")]);
    const callerOwned = structuredClone(registry) as unknown as {
      bindings: Array<{
        lineage: { providerId: string };
        tools: Array<{ name: string }>;
      }>;
    };

    const result = adapt(callerOwned as unknown as RoomCapabilityRegistryV1);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a detached assignment snapshot");
    callerOwned.bindings[0]!.lineage.providerId = "mutated-provider";
    callerOwned.bindings[0]!.tools[0]!.name = "mutated-capability";

    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.capabilitySnapshot)).toBe(true);
    expect(Object.isFrozen(result.value.capabilitySnapshot.bindings)).toBe(true);
    expect(Object.isFrozen(result.value.capabilitySnapshot.bindings[0]?.capabilities)).toBe(true);
    expect(Object.isFrozen(result.value.bindingLineages)).toBe(true);
    expect(Object.isFrozen(result.value.bindingLineages[0])).toBe(true);
    expect(result.value.bindingLineages[0]?.providerId).toBe("provider-binding-a");
    expect(result.value.capabilitySnapshot.bindings[0]?.capabilities).toContainEqual({
      name: "workspace_write",
      state: "verified",
    });
    expect(() => {
      (result.value.bindingLineages as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });
});
