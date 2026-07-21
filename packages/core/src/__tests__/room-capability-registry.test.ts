import { describe, expect, it } from "vitest";

import type {
  RoomBindingCapabilitySnapshotDraftV1,
  RoomBindingCapabilitySnapshotV1,
  RoomCapabilityFreshnessPolicyV1,
  RoomCapabilityRoutingPolicyV1,
} from "../room-capability-registry.js";
import {
  createRoomBindingCapabilitySnapshot,
  evaluateRoomBindingCapability,
  mergeRoomCapabilityRegistry,
  recommendRoomCapabilityBindings,
} from "../room-capability-registry.js";

const AS_OF = "2026-07-19T00:00:00.000Z";
const FRESHNESS: RoomCapabilityFreshnessPolicyV1 = {
  maxSnapshotAgeMs: 60_000,
  maxSignalAgeMs: 60_000,
  maxFutureSkewMs: 5_000,
};

function snapshotFixture(
  bindingId: string,
  overrides: Partial<RoomBindingCapabilitySnapshotDraftV1> = {},
): RoomBindingCapabilitySnapshotV1 {
  const base: RoomBindingCapabilitySnapshotDraftV1 = {
    contractVersion: 1,
    snapshotId: `${bindingId}-snapshot`,
    revision: 1,
    lineage: {
      bindingId,
      bindingGeneration: 1,
      providerId: "provider-a",
      accountId: "account-a",
      modelId: "model-a",
      connectorId: "connector-a",
      nativeSessionId: `native-${bindingId}`,
      hostId: "host-a",
    },
    freshness: {
      capturedAt: AS_OF,
      expiresAt: "2026-07-19T00:01:00.000Z",
      sourceRevision: "connector-v1",
    },
    tools: [
      { name: "source_read", state: "verified" },
      { name: "workspace_write", state: "verified" },
    ],
    context: {
      contextVersion: "context-v1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: AS_OF,
    },
    health: { connectorState: "healthy", hostState: "healthy", observedAt: AS_OF },
    latency: { p50Ms: 200, p95Ms: 500, sampleCount: 20, observedAt: AS_OF },
    rateLimit: { state: "clear", retryAfterMs: null, observedAt: AS_OF },
    domainQuality: [{
      domain: "code",
      selfReportedScore: 0.99,
      independentEvidence: [{
        sourceId: "deterministic:test-suite",
        kind: "deterministic_gate",
        score: 0.8,
        observedAt: AS_OF,
      }],
    }],
    calibration: [{
      domain: "code",
      outcomeCount: 20,
      meanAbsoluteError: 0.1,
      observedAt: AS_OF,
    }],
  };
  const result = createRoomBindingCapabilitySnapshot({
    ...base,
    ...overrides,
  });
  if (!result.ok) throw new Error(`Invalid snapshot fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function policyFixture(
  overrides: Partial<RoomCapabilityRoutingPolicyV1> = {},
): RoomCapabilityRoutingPolicyV1 {
  return {
    freshness: FRESHNESS,
    requirements: {
      requiredTools: ["source_read"],
      minimumAvailableContextTokens: 4_000,
      domain: "code",
      minimumIndependentEvidence: 1,
      minimumCalibrationOutcomeCount: 10,
      minimumQualityScore: 0.5,
    },
    providerLimits: [{
      providerId: "provider-a",
      accountId: "account-a",
      maxActiveDispatches: 4,
      activeDispatches: 1,
      retryAfterMs: null,
      checkedAt: AS_OF,
    }],
    ...overrides,
  };
}

function registryFixture(...samples: RoomBindingCapabilitySnapshotV1[]) {
  const result = mergeRoomCapabilityRegistry({
    registryId: "room-registry",
    current: null,
    samples,
    asOf: AS_OF,
    freshness: FRESHNESS,
  });
  if (!result.ok) throw new Error(`Invalid registry fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

describe("Room capability/performance registry", () => {
  it("rejects stale samples before they can enter a registry", () => {
    const stale = snapshotFixture("binding-stale", {
      freshness: {
        capturedAt: "2026-07-19T00:00:00.000Z",
        expiresAt: "2026-07-19T00:00:30.000Z",
        sourceRevision: "connector-v1",
      },
    });

    const result = mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: null,
      samples: [stale],
      asOf: "2026-07-19T00:01:01.000Z",
      freshness: FRESHNESS,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "snapshot_expired", bindingId: "binding-stale" }),
        expect.objectContaining({ code: "stale_snapshot", bindingId: "binding-stale" }),
      ]),
    });
  });

  it("removes a binding from new routing when a later health snapshot downgrades it", () => {
    const initial = snapshotFixture("binding-health");
    const registry = registryFixture(initial);
    const downgraded = snapshotFixture("binding-health", {
      revision: 2,
      freshness: { capturedAt: AS_OF, expiresAt: "2026-07-19T00:01:00.000Z", sourceRevision: "connector-v2" },
      health: { connectorState: "degraded", hostState: "healthy", observedAt: AS_OF },
    });

    const merged = mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: registry,
      samples: [downgraded],
      asOf: AS_OF,
      freshness: FRESHNESS,
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("Expected health downgrade merge to succeed");
    const recommendation = recommendRoomCapabilityBindings({
      registry: merged.value,
      asOf: AS_OF,
      policy: policyFixture(),
    });
    expect(recommendation.ok).toBe(true);
    if (!recommendation.ok) throw new Error("Expected recommendation report");
    expect(recommendation.value.recommendations).toEqual([]);
    expect(recommendation.value.rejected).toContainEqual(expect.objectContaining({
      bindingId: "binding-health",
      issues: expect.arrayContaining([expect.objectContaining({ code: "health_not_healthy" })]),
    }));
  });

  it("respects exhausted provider/account capacity even for a high-quality binding", () => {
    const saturated = snapshotFixture("binding-saturated");
    const alternative = snapshotFixture("binding-alternative", {
      lineage: {
        bindingId: "binding-alternative",
        bindingGeneration: 1,
        providerId: "provider-b",
        accountId: "account-b",
        modelId: "model-b",
        connectorId: "connector-b",
        nativeSessionId: "native-binding-alternative",
        hostId: "host-b",
      },
      domainQuality: [{
        domain: "code",
        selfReportedScore: 0.1,
        independentEvidence: [{
          sourceId: "deterministic:test-suite-b",
          kind: "deterministic_gate",
          score: 0.7,
          observedAt: AS_OF,
        }],
      }],
      calibration: [{ domain: "code", outcomeCount: 20, meanAbsoluteError: 0.1, observedAt: AS_OF }],
    });
    const policy = policyFixture({
      providerLimits: [
        {
          providerId: "provider-a",
          accountId: "account-a",
          maxActiveDispatches: 1,
          activeDispatches: 1,
          retryAfterMs: null,
          checkedAt: AS_OF,
        },
        {
          providerId: "provider-b",
          accountId: "account-b",
          maxActiveDispatches: 1,
          activeDispatches: 0,
          retryAfterMs: null,
          checkedAt: AS_OF,
        },
      ],
    });

    const result = recommendRoomCapabilityBindings({
      registry: registryFixture(saturated, alternative),
      asOf: AS_OF,
      policy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected recommendation report");
    expect(result.value.recommendations.map((entry) => entry.bindingId)).toEqual(["binding-alternative"]);
    expect(result.value.rejected).toContainEqual(expect.objectContaining({
      bindingId: "binding-saturated",
      issues: expect.arrayContaining([expect.objectContaining({ code: "provider_capacity_exhausted" })]),
    }));
  });

  it("requires independent evidence and ignores self-reported model quality for routing", () => {
    const selfReportedOnly = snapshotFixture("binding-self-report", {
      domainQuality: [{
        domain: "code",
        selfReportedScore: 1,
        independentEvidence: [],
      }],
      calibration: [{ domain: "code", outcomeCount: 20, meanAbsoluteError: 0, observedAt: AS_OF }],
    });
    const independentlyMeasured = snapshotFixture("binding-independent", {
      domainQuality: [{
        domain: "code",
        selfReportedScore: 0,
        independentEvidence: [{
          sourceId: "reviewer-binding-9",
          kind: "independent_review",
          score: 0.7,
          observedAt: AS_OF,
        }],
      }],
      calibration: [{ domain: "code", outcomeCount: 20, meanAbsoluteError: 0.05, observedAt: AS_OF }],
    });

    const result = recommendRoomCapabilityBindings({
      registry: registryFixture(selfReportedOnly, independentlyMeasured),
      asOf: AS_OF,
      policy: policyFixture(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected recommendation report");
    expect(result.value.recommendations.map((entry) => entry.bindingId)).toEqual(["binding-independent"]);
    expect(result.value.rejected).toContainEqual(expect.objectContaining({
      bindingId: "binding-self-report",
      issues: expect.arrayContaining([expect.objectContaining({ code: "independent_quality_missing" })]),
    }));
  });

  it("ranks equal candidates deterministically regardless of insertion order", () => {
    const bindingA = snapshotFixture("binding-a", {
      latency: { p50Ms: 100, p95Ms: 400, sampleCount: 20, observedAt: AS_OF },
    });
    const bindingB = snapshotFixture("binding-b", {
      latency: { p50Ms: 100, p95Ms: 400, sampleCount: 20, observedAt: AS_OF },
    });
    const first = recommendRoomCapabilityBindings({
      registry: registryFixture(bindingB, bindingA),
      asOf: AS_OF,
      policy: policyFixture(),
    });
    const second = recommendRoomCapabilityBindings({
      registry: registryFixture(bindingA, bindingB),
      asOf: AS_OF,
      policy: policyFixture(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("Expected deterministic recommendation reports");
    expect(first.value.recommendations.map((entry) => entry.bindingId)).toEqual(["binding-a", "binding-b"]);
    expect(second.value).toEqual(first.value);
  });

  it("isolates bindings and preserves native-session lineage across a merge", () => {
    const bindingA = snapshotFixture("binding-a");
    const bindingB = snapshotFixture("binding-b", {
      health: { connectorState: "degraded", hostState: "healthy", observedAt: AS_OF },
    });
    const registry = registryFixture(bindingA, bindingB);
    const refreshedA = snapshotFixture("binding-a", {
      revision: 2,
      freshness: { capturedAt: AS_OF, expiresAt: "2026-07-19T00:01:00.000Z", sourceRevision: "connector-v2" },
      latency: { p50Ms: 50, p95Ms: 100, sampleCount: 30, observedAt: AS_OF },
    });
    const merged = mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: registry,
      samples: [refreshedA],
      asOf: AS_OF,
      freshness: FRESHNESS,
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("Expected isolated binding refresh");
    expect(merged.value.bindings.find((entry) => entry.lineage.bindingId === "binding-a")?.latency.p95Ms).toBe(100);
    expect(merged.value.bindings.find((entry) => entry.lineage.bindingId === "binding-b")).toEqual(bindingB);

    const wrongNativeSession = snapshotFixture("binding-a", {
      revision: 3,
      lineage: {
        ...bindingA.lineage,
        nativeSessionId: "native-replaced-without-lineage",
      },
      freshness: { capturedAt: AS_OF, expiresAt: "2026-07-19T00:01:00.000Z", sourceRevision: "connector-v3" },
    });
    const rejected = mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: merged.value,
      samples: [wrongNativeSession],
      asOf: AS_OF,
      freshness: FRESHNESS,
    });
    expect(rejected).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "binding_lineage_mismatch", bindingId: "binding-a" })],
    });
  });

  it("rejects altered and contradictory same-revision samples", () => {
    const original = snapshotFixture("binding-integrity");
    const registry = registryFixture(original);
    const forged = structuredClone(original) as RoomBindingCapabilitySnapshotV1;
    (forged.lineage as { nativeSessionId: string }).nativeSessionId = "forged-native-session";

    expect(mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: registry,
      samples: [forged],
      asOf: AS_OF,
      freshness: FRESHNESS,
    })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "snapshot_integrity_mismatch", bindingId: "binding-integrity" })],
    });

    const contradictory = snapshotFixture("binding-integrity", {
      latency: { p50Ms: 1, p95Ms: 2, sampleCount: 20, observedAt: AS_OF },
    });
    expect(mergeRoomCapabilityRegistry({
      registryId: "room-registry",
      current: registry,
      samples: [contradictory],
      asOf: AS_OF,
      freshness: FRESHNESS,
    })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "contradictory_revision", bindingId: "binding-integrity" })],
    });
  });

  it("evaluates a single binding without mutable clock or provider access", () => {
    const result = evaluateRoomBindingCapability({
      snapshot: snapshotFixture("binding-pure"),
      asOf: AS_OF,
      policy: policyFixture(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        bindingId: "binding-pure",
        eligible: true,
        qualityScore: 0.72,
      },
    });
  });
});
