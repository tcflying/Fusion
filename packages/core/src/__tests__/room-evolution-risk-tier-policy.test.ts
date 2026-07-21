import { describe, expect, it } from "vitest";

import {
  evaluateRoomEvolutionRiskTier,
  type EvaluateRoomEvolutionRiskTierInputV1,
} from "../room-evolution-risk-tier-policy.js";

const AT = "2026-07-19T15:00:00.000Z";

function input(
  overrides: Partial<EvaluateRoomEvolutionRiskTierInputV1> = {},
): EvaluateRoomEvolutionRiskTierInputV1 {
  return {
    contractVersion: 1,
    candidate: {
      id: "candidate-1",
      producerActorId: "producer-1",
      riskClass: "low",
      changeSurfaces: ["policy"],
      autoPromotionPreAuthorized: true,
    },
    hardGates: [
      { gateClass: "correctness", outcome: "passed", evaluatorActorId: "gate-engine" },
      { gateClass: "security", outcome: "passed", evaluatorActorId: "security-reviewer" },
      { gateClass: "user_constraints", outcome: "passed", evaluatorActorId: "constraint-engine" },
      { gateClass: "evidence_integrity", outcome: "passed", evaluatorActorId: "evidence-reviewer" },
      { gateClass: "regression", outcome: "passed", evaluatorActorId: "test-runner" },
    ],
    requestedAuthority: {
      tier: "automatic_pre_authorized",
      actorId: "controller-1",
      approvalRequestId: null,
      evaluatedAt: AT,
    },
    ...overrides,
  };
}

describe("evaluateRoomEvolutionRiskTier", () => {
  it("permits a pre-authorized low-risk policy candidate only after every baseline hard gate passes independently", () => {
    const result = evaluateRoomEvolutionRiskTier(input());

    expect(result).toMatchObject({
      allowed: true,
      action: "auto_promote",
      requiredAuthorityTier: "automatic_pre_authorized",
      requiresHumanApproval: false,
      blockers: [],
    });
  });

  it("requires configured human approval and stronger independent gates for a source candidate", () => {
    const result = evaluateRoomEvolutionRiskTier(input({
      candidate: {
        ...input().candidate,
        changeSurfaces: ["source"],
      },
    }));

    expect(result).toMatchObject({
      allowed: false,
      action: "human_approval_required",
      requiredAuthorityTier: "human",
      requiresHumanApproval: true,
    });
    expect(result.requiredGateClasses).toEqual(expect.arrayContaining([
      "independent_security_review",
      "independent_runtime_validation",
      "rollback_lineage",
    ]));
    expect(result.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "human_authority_required",
      "approval_request_required",
      "required_gate_missing",
    ]));
  });

  it("permits a high-impact candidate only after human approval and every strengthened gate passes independently", () => {
    const result = evaluateRoomEvolutionRiskTier(input({
      candidate: {
        ...input().candidate,
        riskClass: "high",
        changeSurfaces: ["authentication", "network"],
      },
      hardGates: [
        ...input().hardGates,
        { gateClass: "independent_security_review", outcome: "passed", evaluatorActorId: "security-reviewer-2" },
        { gateClass: "independent_runtime_validation", outcome: "passed", evaluatorActorId: "runtime-reviewer" },
        { gateClass: "rollback_lineage", outcome: "passed", evaluatorActorId: "release-reviewer" },
      ],
      requestedAuthority: {
        tier: "human",
        actorId: "owner-1",
        approvalRequestId: "approval-1",
        evaluatedAt: AT,
      },
    }));

    expect(result).toMatchObject({
      allowed: true,
      action: "human_promote",
      requiredAuthorityTier: "human",
      requiresHumanApproval: true,
      blockers: [],
    });
  });

  it("blocks a producer-only gate set before it can reach any automatic or human promotion path", () => {
    const result = evaluateRoomEvolutionRiskTier(input({
      hardGates: input().hardGates.map((gate) => ({ ...gate, evaluatorActorId: "producer-1" })),
    }));

    expect(result).toMatchObject({ allowed: false, action: "withhold" });
    expect(result.blockers.map((entry) => entry.code)).toContain("producer_only_evaluator_forbidden");
  });

  it("blocks failed and malformed risk declarations instead of treating them as low risk", () => {
    const failed = evaluateRoomEvolutionRiskTier(input({
      hardGates: [{ ...input().hardGates[0], outcome: "failed" }],
    }));
    const malformed = evaluateRoomEvolutionRiskTier({
      ...input(),
      candidate: { ...input().candidate, changeSurfaces: ["unrecognized_surface" as never] },
    });

    expect(failed).toMatchObject({ allowed: false, action: "withhold" });
    expect(failed.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining(["required_gate_missing", "hard_gate_failed"]));
    expect(malformed).toMatchObject({ allowed: false, action: "withhold" });
    expect(malformed.blockers.map((entry) => entry.code)).toContain("invalid_input");
  });
});
