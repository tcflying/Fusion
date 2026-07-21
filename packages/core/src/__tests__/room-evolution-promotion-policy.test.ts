import { describe, expect, it } from "vitest";

import {
  evaluateRoomEvolutionPromotion,
  type EvaluateRoomEvolutionPromotionInputV1,
} from "../room-evolution-promotion-policy.js";

function validInput(): EvaluateRoomEvolutionPromotionInputV1 {
  return {
    contractVersion: 1,
    proposal: { id: "proposal-1", candidateHash: `sha256:${"a".repeat(64)}`, proposerBindingIds: ["binding-proposer"], requestedAt: "2026-07-19T00:00:00.000Z" },
    requiredHardGateIds: ["gate-security", "gate-quality"],
    hardGateResults: [
      { gateId: "gate-security", status: "passed", evaluatorBindingIds: ["binding-verifier"], evidenceHash: `sha256:${"b".repeat(64)}` },
      { gateId: "gate-quality", status: "passed", evaluatorBindingIds: ["binding-verifier"], evidenceHash: `sha256:${"c".repeat(64)}` },
    ],
    risks: [{ id: "network-risk", surface: "network", severity: "high", mitigated: true }],
    canary: {
      source: "durable_room_evolution_canary_ledger", canaryId: "canary-1", candidateHash: `sha256:${"a".repeat(64)}`, completedAt: "2026-07-19T00:05:00.000Z",
      sampleCount: 100, minimumSampleCount: 80, qualityScore: 0.95, minimumQualityScore: 0.9,
      metrics: [{ id: "quality", baseline: 0.96, canary: 0.95, maxDegradation: 0.02 }, { id: "latency", baseline: 100, canary: 103, maxDegradation: 5 }],
      evaluatorBindingIds: ["binding-verifier"],
    },
    evaluatedAt: "2026-07-19T00:10:00.000Z",
  };
}

describe("Room evolution promotion policy", () => {
  it("only recommends a runtime promotion after hard gates, independent review, mitigated risk, and canary thresholds pass", () => {
    expect(evaluateRoomEvolutionPromotion(validInput())).toEqual({ mayRequestRuntimePromotion: true, requiredRuntimeAction: "promote_candidate", evaluationPath: "eligible", blockers: [] });
  });

  it("runs hard gates first and rejects a failed hard gate without accepting a canary", () => {
    const input = validInput();
    const decision = evaluateRoomEvolutionPromotion({ ...input, hardGateResults: [{ ...input.hardGateResults[0]!, status: "failed" }, input.hardGateResults[1]!] });
    expect(decision).toMatchObject({ mayRequestRuntimePromotion: false, requiredRuntimeAction: "none", evaluationPath: "hard_gate_blocked" });
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "failed_hard_gate" })]));
  });

  it("forbids proposer-only gate and canary acceptance", () => {
    const input = validInput();
    const decision = evaluateRoomEvolutionPromotion({ ...input, hardGateResults: input.hardGateResults.map((gate) => ({ ...gate, evaluatorBindingIds: ["binding-proposer"] })), canary: { ...input.canary!, evaluatorBindingIds: ["binding-proposer"] } });
    expect(decision.mayRequestRuntimePromotion).toBe(false);
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "proposer_only_evaluator_forbidden" })]));
  });

  it.each(["source", "permission", "authentication", "network", "destructive", "evaluator"] as const)("treats unmitigated high %s risk as a hard block", (surface) => {
    const input = validInput();
    const decision = evaluateRoomEvolutionPromotion({ ...input, risks: [{ id: `${surface}-risk`, surface, severity: "high", mitigated: false }] });
    expect(decision).toMatchObject({ mayRequestRuntimePromotion: false, evaluationPath: "hard_gate_blocked" });
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unmitigated_high_risk" })]));
  });

  it("requires a durable candidate-bound canary that clears sample and quality thresholds", () => {
    const input = validInput();
    const decision = evaluateRoomEvolutionPromotion({ ...input, canary: { ...input.canary!, source: "caller_assertion" as never, candidateHash: `sha256:${"d".repeat(64)}`, sampleCount: 4, qualityScore: 0.1 } });
    expect(decision).toMatchObject({ mayRequestRuntimePromotion: false, evaluationPath: "canary_blocked", requiredRuntimeAction: "none" });
    expect(decision.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining(["invalid_authoritative_canary_source", "canary_candidate_mismatch", "canary_sample_below_threshold", "canary_quality_below_threshold"]));
  });

  it("requests runtime rollback when any objective breaches its degradation limit", () => {
    const input = validInput();
    const decision = evaluateRoomEvolutionPromotion({ ...input, canary: { ...input.canary!, metrics: [{ id: "quality", baseline: 0.9, canary: 0.7, maxDegradation: 0.01 }] } });
    expect(decision).toMatchObject({ mayRequestRuntimePromotion: false, evaluationPath: "canary_blocked", requiredRuntimeAction: "rollback_candidate" });
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "multi_objective_degradation" })]));
  });

  it("fails closed on malformed or duplicate evidence and produces deterministic blockers", () => {
    const input = validInput();
    const malformed = { ...input, requiredHardGateIds: ["gate-security", "gate-security"] };
    expect(evaluateRoomEvolutionPromotion(malformed)).toEqual(evaluateRoomEvolutionPromotion(malformed));
    expect(evaluateRoomEvolutionPromotion(malformed).mayRequestRuntimePromotion).toBe(false);
  });
});
