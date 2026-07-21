import { describe, expect, it, vi } from "vitest";
import {
  allocateRoomEvolutionCanary,
  type RoomEvolutionCanaryAllocationV1,
  type RoomEvolutionEvidenceRefV1,
} from "@fusion/core";
import {
  RoomEvolutionCanaryRollbackCoordinator,
  type RoomEvolutionCanaryRollbackCoordinatorDependenciesV1,
} from "../room-evolution-canary-rollback-coordinator.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function allocation(): RoomEvolutionCanaryAllocationV1 {
  const result = allocateRoomEvolutionCanary({
    contractVersion: 1,
    projectId: "project-evolution",
    requestId: "request-evolution",
    candidate: {
      candidateVersionId: "candidate-v2",
      candidateHash: HASH,
      riskClass: "moderate",
      eligibleRoomIds: ["room-canary"],
    },
    baseline: {
      strategyVersionId: "candidate-v1",
      snapshotId: "baseline-snapshot",
      snapshotHash: HASH,
    },
    authorization: {
      source: "durable_independent_gate_ledger",
      candidateHash: HASH,
      gateResultIds: ["gate-independently-passed"],
      independentEvaluatorBindingIds: ["reviewer-independent"],
      authorizedAt: "2026-07-19T14:40:00.000Z",
      humanApprovalId: null,
    },
    capacity: {
      configuredSlots: 4,
      activeSlots: 1,
      reservedRecoverySlots: 1,
      observedAt: "2026-07-19T14:40:00.000Z",
    },
    policy: {
      minimumRooms: 1,
      maximumRooms: 1,
      maximumEligibleFraction: 1,
      minimumSamplesPerRoom: 2,
      objectives: [{ id: "quality", direction: "higher_is_better", maximumDegradation: 0.1 }],
    },
    allocatedAt: "2026-07-19T14:40:01.000Z",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.reason));
  return result.allocation;
}

function evidence(): readonly RoomEvolutionEvidenceRefV1[] {
  return [{
    id: "evidence-canary-1",
    source: "authorized_observed_outcome",
    sourceRef: "ledger://project-evolution/room-canary/quality",
    evidenceHash: HASH,
    observedAt: "2026-07-19T14:40:02.000Z",
  }];
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1 as const,
    scope: {
      projectId: "project-evolution",
      roomId: null,
      scopeKind: "project" as const,
      scopeKey: "project:project-evolution",
    },
    experimentId: "experiment-v2",
    canaryId: "canary-project-evolution-request-evolution",
    promotionDecisionId: "decision-rollback-v2",
    rollbackId: "rollback-v2",
    candidateProducerActorId: "producer-agent",
    decisionActorId: "independent-controller",
    riskClass: "moderate" as const,
    authorityTier: "independent" as const,
    approvalRequestId: null,
    authorizationEvidence: { source: "durable_independent_gate_ledger", gateResultIds: ["gate-independently-passed"] },
    evidence: evidence(),
    evaluation: {
      contractVersion: 1 as const,
      allocation: allocation(),
      evaluatedAt: "2026-07-19T14:40:03.000Z",
      roomOutcomes: [{
        roomId: "room-canary",
        baselineSnapshotId: "baseline-snapshot",
        samples: 2,
        objectives: [{ id: "quality", baseline: 0.9, candidate: 0.5 }],
      }],
    },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RoomEvolutionCanaryRollbackCoordinatorDependenciesV1> = {},
) {
  const calls: string[] = [];
  const ledger = {
    appendCanaryObservation: vi.fn(async (input: { readonly id: string }) => {
      calls.push("observation");
      return { table: "room_evolution_canary_observations" as const, record: { id: input.id } };
    }),
    appendPromotionDecision: vi.fn(async (input: { readonly id: string }) => {
      calls.push("decision");
      return { table: "room_evolution_promotion_decisions" as const, record: { id: input.id } };
    }),
    appendRollback: vi.fn(async (input: { readonly id: string }) => {
      calls.push("rollback_record");
      return { table: "room_evolution_rollbacks" as const, record: { id: input.id } };
    }),
  };
  const runtime = {
    rollback: vi.fn(async (input: { readonly canaryId: string; readonly targetVersionId: string; readonly roomIds: readonly string[] }) => {
      calls.push("runtime");
      return {
        status: "rolled_back" as const,
        canaryId: input.canaryId,
        targetVersionId: input.targetVersionId,
        roomIds: input.roomIds,
        completedAt: "2026-07-19T14:40:04.000Z",
      };
    }),
  };
  return {
    dependencies: { ledger, runtime, ...overrides } as RoomEvolutionCanaryRollbackCoordinatorDependenciesV1,
    ledger,
    runtime,
    calls,
  };
}

describe("Room evolution canary rollback coordinator", () => {
  it("records degradation, writes a rollback-required decision, rolls back at the runtime boundary, and appends immutable rollback history", async () => {
    const harness = dependencies();
    const coordinator = new RoomEvolutionCanaryRollbackCoordinator(harness.dependencies);

    const result = await coordinator.evaluateAndRollback(request());

    expect(result).toMatchObject({
      status: "rolled_back",
      rollback: { targetVersionId: "candidate-v1", roomIds: ["room-canary"] },
    });
    expect(harness.calls).toEqual(["observation", "decision", "runtime", "rollback_record"]);
    expect(harness.ledger.appendCanaryObservation).toHaveBeenCalledWith(expect.objectContaining({
      canaryId: "canary-project-evolution-request-evolution",
      metricName: "canary_degradation",
      breached: true,
    }));
    expect(harness.ledger.appendPromotionDecision).toHaveBeenCalledWith(expect.objectContaining({
      id: "decision-rollback-v2",
      decision: "rollback_required",
      rollbackTargetCandidateVersionId: "candidate-v1",
    }));
    expect(harness.runtime.rollback).toHaveBeenCalledWith(expect.objectContaining({
      turnBoundaryOnly: true,
      expectedCandidateVersionId: "candidate-v2",
      targetVersionId: "candidate-v1",
    }));
    expect(harness.ledger.appendRollback).toHaveBeenCalledWith(expect.objectContaining({
      id: "rollback-v2",
      triggerKind: "automatic",
      fromCandidateVersionId: "candidate-v2",
      toCandidateVersionId: "candidate-v1",
    }));
  });

  it("does not call the runtime or durable ledger when the candidate remains eligible for independent promotion", async () => {
    const harness = dependencies();
    const coordinator = new RoomEvolutionCanaryRollbackCoordinator(harness.dependencies);
    const input = request({
      evaluation: {
        contractVersion: 1 as const,
        allocation: allocation(),
        evaluatedAt: "2026-07-19T14:40:03.000Z",
        roomOutcomes: [{
          roomId: "room-canary",
          baselineSnapshotId: "baseline-snapshot",
          samples: 2,
          objectives: [{ id: "quality", baseline: 0.9, candidate: 0.85 }],
        }],
      },
    });

    const result = await coordinator.evaluateAndRollback(input);

    expect(result).toMatchObject({ status: "promotion_eligible" });
    expect(harness.calls).toEqual([]);
  });

  it("does not record a completed rollback when the runtime cannot prove the exact target restoration", async () => {
    const harness = dependencies({
      runtime: {
        rollback: vi.fn(async () => {
          throw new Error("native session turn boundary unavailable");
        }),
      },
    });
    const coordinator = new RoomEvolutionCanaryRollbackCoordinator(harness.dependencies);

    const result = await coordinator.evaluateAndRollback(request());

    expect(result).toMatchObject({ status: "rollback_execution_failed" });
    expect(harness.ledger.appendRollback).not.toHaveBeenCalled();
    expect(harness.ledger.appendPromotionDecision).toHaveBeenCalledTimes(1);
  });
});
