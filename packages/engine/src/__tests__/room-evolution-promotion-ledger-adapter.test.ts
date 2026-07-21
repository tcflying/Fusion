import { describe, expect, it } from "vitest";

import {
  evaluateRoomEvolutionPromotion,
  hashRoomValue,
  type AppendRoomEvolutionPromotionDecisionInputV1,
  type EvaluateRoomEvolutionPromotionInputV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionPromotionDecisionRecordV1,
} from "@fusion/core";

import {
  RoomEvolutionPromotionLedgerAdapter,
  type RoomEvolutionPromotionContextSnapshotV1,
} from "../room-evolution-promotion-ledger-adapter.js";

import type { AppendRoomEvolutionPromotionDecisionInputV1 as CommitInput } from "../room-evolution-promotion-commit-coordinator.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVALUATED_AT = "2026-07-19T14:20:00.000Z";

function evaluation(): EvaluateRoomEvolutionPromotionInputV1 {
  return {
    contractVersion: 1,
    proposal: {
      id: "proposal-1",
      candidateHash: HASH,
      proposerBindingIds: ["producer-binding"],
      requestedAt: EVALUATED_AT,
    },
    requiredHardGateIds: ["gate-security"],
    hardGateResults: [{
      gateId: "gate-security",
      status: "passed",
      evaluatorBindingIds: ["independent-binding"],
      evidenceHash: HASH,
    }],
    risks: [],
    canary: {
      source: "durable_room_evolution_canary_ledger",
      canaryId: "canary-1",
      candidateHash: HASH,
      completedAt: EVALUATED_AT,
      sampleCount: 100,
      minimumSampleCount: 10,
      qualityScore: 0.96,
      minimumQualityScore: 0.9,
      metrics: [{ id: "quality", baseline: 0.97, canary: 0.96, maxDegradation: 0.02 }],
      evaluatorBindingIds: ["independent-binding"],
    },
    evaluatedAt: EVALUATED_AT,
  };
}

function snapshot(
  overrides: Partial<RoomEvolutionPromotionContextSnapshotV1> = {},
): RoomEvolutionPromotionContextSnapshotV1 {
  return {
    contractVersion: 1,
    scope: { projectId: "project-1", roomId: "room-1", scopeKind: "room", scopeKey: "room-1" },
    proposalId: "proposal-1",
    candidateHash: HASH,
    experimentId: "experiment-1",
    candidateVersionId: "candidate-version-1",
    canaryId: "canary-1",
    rollbackTargetCandidateVersionId: "candidate-version-baseline",
    riskClass: "moderate",
    changeSurfaces: ["policy"],
    autoPromotionPreAuthorized: false,
    hardGates: [
      { gateClass: "correctness", outcome: "passed", evaluatorActorId: "gate-engine" },
      { gateClass: "security", outcome: "passed", evaluatorActorId: "security-reviewer" },
      { gateClass: "user_constraints", outcome: "passed", evaluatorActorId: "constraint-engine" },
      { gateClass: "evidence_integrity", outcome: "passed", evaluatorActorId: "evidence-reviewer" },
      { gateClass: "regression", outcome: "passed", evaluatorActorId: "test-runner" },
    ],
    authorityTier: "independent",
    candidateProducerActorId: "producer-1",
    decisionActorId: "arbiter-1",
    approvalRequestId: null,
    authorizationEvidence: { authorization: "durable" },
    evidence: [{
      id: "evidence-1",
      source: "durable_room_ledger",
      sourceRef: "evidence-ref-1",
      evidenceHash: HASH,
      observedAt: EVALUATED_AT,
    }],
    ...overrides,
  };
}

function input(
  decision: CommitInput["decision"]["outcome"] = "promoted",
): CommitInput {
  return {
    command: { commandId: "command-1", idempotencyKey: "key-1", correlationId: "corr-1", causationId: null },
    decision: {
      contractVersion: 1,
      id: "decision-1",
      proposalId: "proposal-1",
      candidateHash: HASH,
      outcome: decision,
      runtimeAction: decision === "promoted" ? "promote_candidate" : decision === "rolled_back" ? "rollback_candidate" : "none",
      evaluationPath: decision === "promoted" ? "eligible" : "hard_gate_blocked",
      blockers: [],
      evaluatedAt: EVALUATED_AT,
    },
    evaluation: evaluation(),
  };
}

function appended(
  appendInput: AppendRoomEvolutionPromotionDecisionInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1> {
  return {
    table: "room_evolution_promotion_decisions",
    record: {
      contractVersion: 1,
      id: appendInput.id,
      projectId: appendInput.scope.projectId,
      roomId: appendInput.scope.roomId,
      scopeKind: appendInput.scope.scopeKind,
      scopeKey: appendInput.scope.scopeKey,
      experimentId: appendInput.experimentId,
      candidateVersionId: appendInput.candidateVersionId,
      canaryId: appendInput.canaryId,
      decision: appendInput.decision,
      riskClass: appendInput.riskClass,
      authorityTier: appendInput.authorityTier,
      candidateProducerActorId: appendInput.candidateProducerActorId,
      decisionActorId: appendInput.decisionActorId,
      approvalRequestId: appendInput.approvalRequestId,
      authorizationEvidence: appendInput.authorizationEvidence,
      evidence: appendInput.evidence,
      evidenceHash: appendInput.evidenceHash,
      rollbackTargetCandidateVersionId: appendInput.rollbackTargetCandidateVersionId,
      decidedAt: appendInput.decidedAt,
    },
  };
}

describe("RoomEvolutionPromotionLedgerAdapter", () => {
  it("binds a promotion decision to one durable context and appends the exact immutable record", async () => {
    const seen: AppendRoomEvolutionPromotionDecisionInputV1[] = [];
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot() },
      ledger: {
        appendPromotionDecision: async (appendInput) => {
          seen.push(appendInput);
          return appended(appendInput);
        },
      },
    });

    const result = await adapter.appendDecision(input());

    expect(result).toEqual({ recordId: "decision-1", decisionId: "decision-1", replayed: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: "decision-1",
      experimentId: "experiment-1",
      candidateVersionId: "candidate-version-1",
      canaryId: "canary-1",
      decision: "promoted",
      decisionActorId: "arbiter-1",
      rollbackTargetCandidateVersionId: "candidate-version-baseline",
    });
    expect(seen[0]?.evidenceHash).toBe(hashRoomValue({
      id: "decision-1",
      scope: snapshot().scope,
      evidence: snapshot().evidence,
    }));
  });

  it("maps a canary rollback decision to Core's immutable rollback-required outcome", async () => {
    const seen: AppendRoomEvolutionPromotionDecisionInputV1[] = [];
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot() },
      ledger: {
        appendPromotionDecision: async (appendInput) => {
          seen.push(appendInput);
          return appended(appendInput);
        },
      },
    });

    const baseline = input();
    const rollbackEvaluation = {
      ...baseline.evaluation,
      canary: {
        ...baseline.evaluation.canary!,
        metrics: [{ id: "quality", baseline: 0.97, canary: 0.8, maxDegradation: 0.02 }],
      },
    };
    const evaluated = evaluateRoomEvolutionPromotion(rollbackEvaluation);
    await adapter.appendDecision({
      ...baseline,
      decision: {
        ...baseline.decision,
        outcome: "rolled_back",
        runtimeAction: evaluated.requiredRuntimeAction,
        evaluationPath: evaluated.evaluationPath,
        blockers: evaluated.blockers,
      },
      evaluation: rollbackEvaluation,
    });

    expect(seen[0]).toMatchObject({ decision: "rollback_required", canaryId: "canary-1" });
  });

  it("refuses a context that does not bind the exact proposal and candidate hash", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot({ candidateHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) },
      ledger: { appendPromotionDecision: async (appendInput) => {
        writes += 1;
        return appended(appendInput);
      } },
    });

    await expect(adapter.appendDecision(input())).rejects.toMatchObject({ code: "context_snapshot_invalid" });
    expect(writes).toBe(0);
  });

  it("refuses a context whose durable canary is not the one evaluated", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot({ canaryId: "canary-other" }) },
      ledger: { appendPromotionDecision: async (appendInput) => {
        writes += 1;
        return appended(appendInput);
      } },
    });

    await expect(adapter.appendDecision(input())).rejects.toMatchObject({ code: "context_snapshot_invalid" });
    expect(writes).toBe(0);
  });

  it("refuses candidate self-acceptance before it can reach the immutable ledger", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot({ decisionActorId: "producer-1" }) },
      ledger: { appendPromotionDecision: async (appendInput) => {
        writes += 1;
        return appended(appendInput);
      } },
    });

    await expect(adapter.appendDecision(input())).rejects.toMatchObject({ code: "self_acceptance_forbidden" });
    expect(writes).toBe(0);
  });

  it("withholds a source change until the risk-tier human authority and strengthened gates are present", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot({ changeSurfaces: ["source"] }) },
      ledger: { appendPromotionDecision: async (appendInput) => {
        writes += 1;
        return appended(appendInput);
      } },
    });

    await expect(adapter.appendDecision(input())).rejects.toMatchObject({ code: "risk_policy_withheld" });
    expect(writes).toBe(0);
  });

  it("refuses a forged promotion outcome when the deterministic evaluation has a hard-gate failure", async () => {
    let reads = 0;
    let writes = 0;
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => {
        reads += 1;
        return snapshot();
      } },
      ledger: { appendPromotionDecision: async (appendInput) => {
        writes += 1;
        return appended(appendInput);
      } },
    });
    const forged = input();
    const failedEvaluation = {
      ...forged.evaluation,
      hardGateResults: [{
        ...forged.evaluation.hardGateResults[0],
        status: "failed" as const,
      }],
    };

    await expect(adapter.appendDecision({ ...forged, evaluation: failedEvaluation })).rejects.toMatchObject({ code: "invalid_input" });
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it("never confirms a decision when the ledger acknowledges another immutable record", async () => {
    const adapter = new RoomEvolutionPromotionLedgerAdapter({
      contextReader: { readPromotionContext: async () => snapshot() },
      ledger: { appendPromotionDecision: async (appendInput) => ({
        ...appended(appendInput),
        record: { ...appended(appendInput).record, id: "decision-other" },
      }) },
    });

    await expect(adapter.appendDecision(input())).rejects.toMatchObject({ code: "ledger_response_invalid" });
  });
});
