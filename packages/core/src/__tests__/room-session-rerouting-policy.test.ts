import { describe, expect, it } from "vitest";

import type {
  RoomBindingCapabilitySnapshotDraftV1,
  RoomBindingCapabilitySnapshotV1,
  RoomCapabilityRoutingPolicyV1,
} from "../room-capability-registry.js";
import { createRoomBindingCapabilitySnapshot } from "../room-capability-registry.js";
import {
  evaluateRoomSessionReroutingPolicy,
  type EvaluateRoomSessionReroutingPolicyInputV1,
} from "../room-session-rerouting-policy.js";

const AS_OF = "2026-07-19T00:00:00.000Z";
const LATER = "2026-07-19T00:01:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function snapshotFixture(
  bindingId: string,
  overrides: Partial<RoomBindingCapabilitySnapshotDraftV1> = {},
): RoomBindingCapabilitySnapshotV1 {
  const draft: RoomBindingCapabilitySnapshotDraftV1 = {
    contractVersion: 1,
    snapshotId: `${bindingId}-snapshot`,
    revision: 1,
    lineage: {
      bindingId,
      bindingGeneration: 2,
      providerId: "provider-replacement",
      accountId: "account-replacement",
      modelId: "model-replacement",
      connectorId: "connector-replacement",
      nativeSessionId: "native-replacement",
      hostId: "host-replacement",
    },
    freshness: {
      capturedAt: AS_OF,
      expiresAt: LATER,
      sourceRevision: "connector-observation-1",
    },
    tools: [{ name: "source_read", state: "verified" }],
    context: {
      contextVersion: "context-1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: AS_OF,
    },
    health: { connectorState: "healthy", hostState: "healthy", observedAt: AS_OF },
    latency: { p50Ms: 100, p95Ms: 300, sampleCount: 20, observedAt: AS_OF },
    rateLimit: { state: "clear", retryAfterMs: null, observedAt: AS_OF },
    domainQuality: [{
      domain: "code",
      selfReportedScore: 1,
      independentEvidence: [{
        sourceId: "deterministic:gate-1",
        kind: "deterministic_gate",
        score: 0.8,
        observedAt: AS_OF,
      }],
    }],
    calibration: [{ domain: "code", outcomeCount: 12, meanAbsoluteError: 0.1, observedAt: AS_OF }],
    ...overrides,
  };
  const snapshot = createRoomBindingCapabilitySnapshot(draft);
  if (!snapshot.ok) throw new Error(`Invalid snapshot fixture: ${JSON.stringify(snapshot.issues)}`);
  return snapshot.value;
}

function routingPolicyFixture(): RoomCapabilityRoutingPolicyV1 {
  return {
    freshness: { maxSnapshotAgeMs: 60_000, maxSignalAgeMs: 60_000, maxFutureSkewMs: 5_000 },
    requirements: {
      requiredTools: ["source_read"],
      minimumAvailableContextTokens: 4_000,
      domain: "code",
      minimumIndependentEvidence: 1,
      minimumCalibrationOutcomeCount: 10,
      minimumQualityScore: 0.5,
    },
    providerLimits: [{
      providerId: "provider-replacement",
      accountId: "account-replacement",
      maxActiveDispatches: 4,
      activeDispatches: 1,
      retryAfterMs: null,
      checkedAt: AS_OF,
    }],
  };
}

function inputFixture(): EvaluateRoomSessionReroutingPolicyInputV1 {
  return {
    contractVersion: 1,
    asOf: AS_OF,
    request: {
      rerouteId: "reroute-1",
      projectId: "project-1",
      roomId: "room-1",
      seatId: "seat-1",
      requestedAt: AS_OF,
      source: {
        bindingId: "binding-source",
        bindingGeneration: 4,
        providerId: "provider-source",
        accountId: "account-source",
        modelId: "model-source",
        connectorId: "connector-source",
        nativeSessionId: "native-source",
        hostId: "host-source",
      },
      replacement: {
        bindingId: "binding-replacement",
        bindingGeneration: 2,
        providerId: "provider-replacement",
        accountId: "account-replacement",
        modelId: "model-replacement",
        connectorId: "connector-replacement",
        nativeSessionId: "native-replacement",
        hostId: "host-replacement",
      },
      turnBoundary: {
        settledTurnId: "turn-7",
        state: "settled",
        settledAt: AS_OF,
        activeTurnId: null,
      },
      causation: {
        incidentId: "incident-1",
        reason: "connector_degraded",
        evidenceId: "evidence-cause",
        observedAt: AS_OF,
      },
    },
    authorization: {
      authorizationId: "authorization-1",
      projectId: "project-1",
      roomId: "room-1",
      sourceBindingId: "binding-source",
      replacementBindingId: "binding-replacement",
      granted: true,
      authorityKind: "human_operator",
      authorityId: "operator-1",
      issuedAt: AS_OF,
      expiresAt: LATER,
      evidenceHash: HASH_A,
    },
    replacementSnapshot: snapshotFixture("binding-replacement"),
    replacementRoutingPolicy: routingPolicyFixture(),
    evidenceFreshness: { maximumAgeMs: 60_000, maximumFutureSkewMs: 5_000 },
    independentEvidence: [
      {
        evidenceId: "evidence-cause",
        projectId: "project-1",
        roomId: "room-1",
        subjectBindingId: "binding-source",
        kind: "causation",
        sourceKind: "connector_probe",
        sourceId: "probe-source",
        observedAt: AS_OF,
        evidenceHash: HASH_B,
      },
      {
        evidenceId: "evidence-capability",
        projectId: "project-1",
        roomId: "room-1",
        subjectBindingId: "binding-replacement",
        kind: "capability",
        sourceKind: "connector_probe",
        sourceId: "probe-replacement",
        observedAt: AS_OF,
        evidenceHash: HASH_C,
      },
      {
        evidenceId: "evidence-health",
        projectId: "project-1",
        roomId: "room-1",
        subjectBindingId: "binding-replacement",
        kind: "health",
        sourceKind: "connector_probe",
        sourceId: "probe-replacement",
        observedAt: AS_OF,
        evidenceHash: HASH_D,
      },
      {
        evidenceId: "evidence-quality",
        projectId: "project-1",
        roomId: "room-1",
        subjectBindingId: "binding-replacement",
        kind: "quality",
        sourceKind: "independent_evaluator",
        sourceId: "reviewer-2",
        observedAt: AS_OF,
        evidenceHash: HASH_A,
      },
    ],
    reservations: [],
  };
}

describe("Room session rerouting policy", () => {
  it("permits only an explicitly authorized independently certified replacement at a settled boundary", () => {
    const result = evaluateRoomSessionReroutingPolicy(inputFixture());

    expect(result).toMatchObject({
      ok: true,
      value: {
        replacement: expect.objectContaining({ bindingId: "binding-replacement", nativeSessionId: "native-replacement" }),
        lineage: expect.objectContaining({
          sourceBindingId: "binding-source",
          replacementBindingId: "binding-replacement",
          rollbackTarget: expect.objectContaining({ bindingId: "binding-source", nativeSessionId: "native-source" }),
          activation: expect.objectContaining({ kind: "after_settled_turn", settledTurnId: "turn-7" }),
        }),
      },
    });
    if (!result.ok) throw new Error("Expected a permitted reroute");
    expect(result.value.lineage.evidenceIds).toEqual([
      "evidence-capability",
      "evidence-cause",
      "evidence-health",
      "evidence-quality",
    ]);
    expect(result.value.lineage.lineageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.lineage)).toBe(true);
  });

  it("fails closed for provider/model self-report, cross-scope evidence, and missing independent certification", () => {
    const selfReportBase = inputFixture();
    const selfReport = {
      ...selfReportBase,
      independentEvidence: selfReportBase.independentEvidence.map((entry) => entry.evidenceId === "evidence-quality"
        ? { ...entry, sourceKind: "provider_model_self_report" as unknown as typeof entry.sourceKind }
        : entry),
    };
    expect(evaluateRoomSessionReroutingPolicy(selfReport)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "untrusted_evidence_source" })]),
    });

    const crossRoomBase = inputFixture();
    const crossRoom = {
      ...crossRoomBase,
      independentEvidence: crossRoomBase.independentEvidence.map((entry) => entry.evidenceId === "evidence-capability"
        ? { ...entry, roomId: "room-other" }
        : entry),
    };
    expect(evaluateRoomSessionReroutingPolicy(crossRoom)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "scope_mismatch" })]),
    });

    const missingQualityBase = inputFixture();
    const missingQuality = {
      ...missingQualityBase,
      independentEvidence: missingQualityBase.independentEvidence.filter((entry) => entry.kind !== "quality"),
    };
    expect(evaluateRoomSessionReroutingPolicy(missingQuality)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "missing_independent_evidence" })]),
    });
  });

  it("never aliases a host-bound native Session, skips active turns, or races the same replacement", () => {
    const sameNativeSessionBase = inputFixture();
    const sameNativeSession = {
      ...sameNativeSessionBase,
      request: {
        ...sameNativeSessionBase.request,
        replacement: { ...sameNativeSessionBase.request.replacement, nativeSessionId: "native-source" },
      },
    };
    expect(evaluateRoomSessionReroutingPolicy(sameNativeSession)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "native_session_identity_immutable" })]),
    });

    const activeTurnBase = inputFixture();
    const activeTurn = {
      ...activeTurnBase,
      request: {
        ...activeTurnBase.request,
        turnBoundary: { ...activeTurnBase.request.turnBoundary, activeTurnId: "turn-8" as unknown as null },
      },
    };
    expect(evaluateRoomSessionReroutingPolicy(activeTurn)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({
        code: "turn_boundary_required",
        path: "$.request.turnBoundary.activeTurnId",
      })]),
    });

    const reservedBase = inputFixture();
    const reserved = {
      ...reservedBase,
      reservations: [{
        reservationId: "reservation-1",
        projectId: "project-1",
        roomId: "room-1",
        replacementBindingId: "binding-replacement",
        providerId: "provider-replacement",
        nativeSessionId: "native-replacement",
        state: "pending" as const,
      }],
    };
    expect(evaluateRoomSessionReroutingPolicy(reserved)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "replacement_concurrent" })]),
    });
  });
});
