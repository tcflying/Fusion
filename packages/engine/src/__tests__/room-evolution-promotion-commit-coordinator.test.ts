import { describe, expect, it } from "vitest";

import type { EvaluateRoomEvolutionPromotionInputV1 } from "@fusion/core";

import {
  RoomEvolutionPromotionCommitCoordinator,
  type RoomEvolutionPromotionDecisionLedgerPortV1,
} from "../room-evolution-promotion-commit-coordinator.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVALUATED_AT = "2026-07-19T13:40:00.000Z";

function evaluation(
  overrides: Partial<EvaluateRoomEvolutionPromotionInputV1> = {},
): EvaluateRoomEvolutionPromotionInputV1 {
  return {
    contractVersion: 1,
    proposal: {
      id: "proposal-evolution-1",
      candidateHash: HASH,
      proposerBindingIds: ["binding-proposer"],
      requestedAt: "2026-07-19T13:30:00.000Z",
    },
    requiredHardGateIds: ["gate-security"],
    hardGateResults: [{
      gateId: "gate-security",
      status: "passed",
      evaluatorBindingIds: ["binding-independent"],
      evidenceHash: HASH,
    }],
    risks: [{ id: "risk-runtime", surface: "runtime", severity: "low", mitigated: true }],
    canary: {
      source: "durable_room_evolution_canary_ledger",
      canaryId: "canary-evolution-1",
      candidateHash: HASH,
      completedAt: "2026-07-19T13:39:00.000Z",
      sampleCount: 10,
      minimumSampleCount: 10,
      qualityScore: 0.95,
      minimumQualityScore: 0.9,
      metrics: [{ id: "quality", baseline: 0.96, canary: 0.95, maxDegradation: 0.02 }],
      evaluatorBindingIds: ["binding-independent"],
    },
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}

function coordinator(
  appendDecision: RoomEvolutionPromotionDecisionLedgerPortV1["appendDecision"],
): RoomEvolutionPromotionCommitCoordinator {
  return new RoomEvolutionPromotionCommitCoordinator({ ledger: { appendDecision } });
}

describe("RoomEvolutionPromotionCommitCoordinator", () => {
  it("persists an eligible promotion request only after hard gates and independent canary evidence pass", async () => {
    const appended: unknown[] = [];
    const result = await coordinator(async (input) => {
      appended.push(input);
      return { recordId: "ledger-decision-1", decisionId: input.decision.id, replayed: false };
    }).evaluateAndCommit({
      command: { commandId: "command-evolution-1", idempotencyKey: "key-evolution-1", correlationId: "corr-evolution-1", causationId: null },
      decisionId: "decision-evolution-1",
      evaluation: evaluation(),
    });

    expect(result).toMatchObject({
      status: "committed",
      decision: { outcome: "promoted", runtimeAction: "promote_candidate" },
      record: { recordId: "ledger-decision-1", replayed: false },
    });
    expect(appended).toHaveLength(1);
  });

  it("persists a rejected decision when a hard gate fails instead of accepting model or canary claims", async () => {
    const result = await coordinator(async (input) => ({
      recordId: "ledger-decision-hard-gate",
      decisionId: input.decision.id,
      replayed: false,
    })).evaluateAndCommit({
      command: { commandId: "command-evolution-hard-gate", idempotencyKey: "key-evolution-hard-gate", correlationId: "corr-evolution-hard-gate", causationId: null },
      decisionId: "decision-evolution-hard-gate",
      evaluation: evaluation({ hardGateResults: [{
        gateId: "gate-security",
        status: "failed",
        evaluatorBindingIds: ["binding-independent"],
        evidenceHash: HASH,
      }] }),
    });

    expect(result).toMatchObject({
      status: "committed",
      decision: { outcome: "rejected", runtimeAction: "none", evaluationPath: "hard_gate_blocked" },
    });
  });

  it("writes a rollback decision when an otherwise trusted canary breaches an objective", async () => {
    const result = await coordinator(async (input) => ({
      recordId: "ledger-decision-rollback",
      decisionId: input.decision.id,
      replayed: false,
    })).evaluateAndCommit({
      command: { commandId: "command-evolution-rollback", idempotencyKey: "key-evolution-rollback", correlationId: "corr-evolution-rollback", causationId: null },
      decisionId: "decision-evolution-rollback",
      evaluation: evaluation({ canary: {
        ...evaluation().canary!,
        metrics: [{ id: "quality", baseline: 0.96, canary: 0.8, maxDegradation: 0.02 }],
      } }),
    });

    expect(result).toMatchObject({
      status: "committed",
      decision: { outcome: "rolled_back", runtimeAction: "rollback_candidate", evaluationPath: "canary_blocked" },
    });
  });

  it("never reports a durable decision when the immutable ledger append fails", async () => {
    const result = await coordinator(async () => {
      throw new Error("ledger unavailable");
    }).evaluateAndCommit({
      command: { commandId: "command-evolution-fail", idempotencyKey: "key-evolution-fail", correlationId: "corr-evolution-fail", causationId: null },
      decisionId: "decision-evolution-fail",
      evaluation: evaluation(),
    });

    expect(result).toMatchObject({
      status: "append_failed",
      decision: { outcome: "promoted" },
      reason: { code: "ledger_write_failed" },
    });
  });
});
