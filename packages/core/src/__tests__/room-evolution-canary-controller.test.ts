import { describe, expect, it } from "vitest";

import {
  allocateRoomEvolutionCanary,
  evaluateRoomEvolutionCanary,
  type AllocateRoomEvolutionCanaryInputV1,
} from "../room-evolution-canary-controller.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AS_OF = "2026-07-19T14:10:00.000Z";

function input(
  overrides: Partial<AllocateRoomEvolutionCanaryInputV1> = {},
): AllocateRoomEvolutionCanaryInputV1 {
  return {
    contractVersion: 1,
    projectId: "project-canary",
    requestId: "canary-request-1",
    candidate: {
      candidateVersionId: "candidate-v2",
      candidateHash: HASH,
      riskClass: "moderate",
      eligibleRoomIds: ["room-c", "room-a", "room-b", "room-d"],
    },
    baseline: {
      strategyVersionId: "strategy-v1",
      snapshotId: "baseline-snapshot-1",
      snapshotHash: HASH,
    },
    authorization: {
      source: "durable_independent_gate_ledger",
      candidateHash: HASH,
      gateResultIds: ["gate-security", "gate-quality"],
      independentEvaluatorBindingIds: ["reviewer-1"],
      authorizedAt: "2026-07-19T14:09:30.000Z",
      humanApprovalId: null,
    },
    capacity: {
      configuredSlots: 8,
      activeSlots: 3,
      reservedRecoverySlots: 2,
      observedAt: AS_OF,
    },
    policy: {
      minimumRooms: 2,
      maximumRooms: 3,
      maximumEligibleFraction: 0.75,
      minimumSamplesPerRoom: 3,
      objectives: [
        { id: "quality", direction: "higher_is_better", maximumDegradation: 0.05 },
        { id: "latency", direction: "lower_is_better", maximumDegradation: 20 },
      ],
    },
    allocatedAt: AS_OF,
    ...overrides,
  };
}

describe("Room evolution canary controller", () => {
  it("allocates a bounded deterministic subset while preserving recovery capacity and a rollback target", () => {
    const result = allocateRoomEvolutionCanary(input());

    expect(result).toMatchObject({ ok: true, status: "allocated" });
    if (!result.ok) throw new Error("Expected allocation");
    expect(result.allocation).toMatchObject({
      projectId: "project-canary",
      candidateVersionId: "candidate-v2",
      baselineStrategyVersionId: "strategy-v1",
      baselineSnapshotId: "baseline-snapshot-1",
      rollbackTargetVersionId: "strategy-v1",
      roomIds: ["room-a", "room-b"],
      reservedRecoverySlots: 2,
      modelSelfAuthorizationExcluded: true,
    });
    expect(Object.isFrozen(result.allocation)).toBe(true);
  });

  it("fails closed for high-risk candidates without a durable human approval", () => {
    const result = allocateRoomEvolutionCanary(input({
      candidate: {
        candidateVersionId: "candidate-v2",
        candidateHash: HASH,
        riskClass: "high",
        eligibleRoomIds: ["room-a", "room-b"],
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: { code: "human_approval_required" } });
  });

  it("emits rollback commands as soon as one bounded objective degrades beyond the canary policy", () => {
    const allocated = allocateRoomEvolutionCanary(input());
    if (!allocated.ok) throw new Error("Expected allocation");

    const result = evaluateRoomEvolutionCanary({
      contractVersion: 1,
      allocation: allocated.allocation,
      evaluatedAt: "2026-07-19T14:12:00.000Z",
      roomOutcomes: [
        {
          roomId: "room-a",
          baselineSnapshotId: "baseline-snapshot-1",
          samples: 3,
          objectives: [
            { id: "quality", baseline: 0.9, candidate: 0.7 },
            { id: "latency", baseline: 100, candidate: 105 },
          ],
        },
        {
          roomId: "room-b",
          baselineSnapshotId: "baseline-snapshot-1",
          samples: 3,
          objectives: [
            { id: "quality", baseline: 0.9, candidate: 0.9 },
            { id: "latency", baseline: 100, candidate: 105 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      status: "rollback_required",
      rollback: {
        targetVersionId: "strategy-v1",
        roomIds: ["room-a", "room-b"],
      },
    });
  });

  it("withholds an outcome when any room compares against a different immutable baseline snapshot", () => {
    const allocated = allocateRoomEvolutionCanary(input());
    if (!allocated.ok) throw new Error("Expected allocation");

    const result = evaluateRoomEvolutionCanary({
      contractVersion: 1,
      allocation: allocated.allocation,
      evaluatedAt: "2026-07-19T14:12:00.000Z",
      roomOutcomes: [
        {
          roomId: "room-a",
          baselineSnapshotId: "different-snapshot",
          samples: 3,
          objectives: [
            { id: "quality", baseline: 0.9, candidate: 0.9 },
            { id: "latency", baseline: 100, candidate: 105 },
          ],
        },
        {
          roomId: "room-b",
          baselineSnapshotId: "baseline-snapshot-1",
          samples: 3,
          objectives: [
            { id: "quality", baseline: 0.9, candidate: 0.9 },
            { id: "latency", baseline: 100, candidate: 105 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, reason: { code: "baseline_snapshot_mismatch" } });
  });
});
