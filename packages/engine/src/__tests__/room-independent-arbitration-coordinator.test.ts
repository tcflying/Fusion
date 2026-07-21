import { describe, expect, it } from "vitest";
import type { RoomEvidenceLedgerScope } from "@fusion/core";

import {
  RoomIndependentArbitrationCoordinator,
  type RequestRoomIndependentArbitrationV1,
  type RoomIndependentArbitrationCoordinatorDependenciesV1,
  type RoomIndependentArbitrationDecisionLedgerPortV1,
} from "../room-independent-arbitration-coordinator.js";

const SCOPE = {
  projectId: "project-independent-arbitration",
  roomId: "room-independent-arbitration",
} as RoomEvidenceLedgerScope;
const DECIDED_AT = "2026-07-19T09:30:00.000Z";

function candidate(id: string, producerBindingIds: readonly string[]) {
  return { id, producerBindingIds };
}

function review(
  id: string,
  candidateId: string,
  reviewerBindingId: string,
  verdict: "accept" | "repair_required" | "reject" | "abstain",
  independentFromProducer = true,
) {
  return {
    id,
    candidateId,
    reviewerBindingId,
    independentFromProducer,
    evidenceIds: [`evidence:${id}`],
    verdict,
  };
}

function gate(
  id: string,
  candidateId: string,
  status: "passed" | "failed" | "error" | "not_run" = "passed",
) {
  return {
    id,
    candidateId,
    hard: true as const,
    status,
    evidenceIds: [`evidence:${id}`],
  };
}

function dissent(
  id: string,
  candidateId: string,
  severity: "info" | "minor" | "major" | "critical",
  state: "open" | "investigating" | "resolved" | "accepted_residual",
  ownerId: string,
) {
  return {
    id,
    candidateId,
    severity,
    state,
    ownerId,
    evidenceIds: [`evidence:${id}`],
  };
}

function request(
  overrides: Partial<RequestRoomIndependentArbitrationV1> = {},
): RequestRoomIndependentArbitrationV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    nodeId: "node-independent-arbitration",
    candidates: [
      candidate("candidate-alpha", ["binding-producer-alpha"]),
      candidate("candidate-beta", ["binding-producer-beta"]),
    ],
    reviews: [
      review("review-alpha", "candidate-alpha", "binding-reviewer-alpha", "accept"),
      review("review-beta", "candidate-beta", "binding-reviewer-beta", "reject"),
    ],
    hardGateResults: [
      gate("gate-alpha", "candidate-alpha"),
      gate("gate-beta", "candidate-beta"),
    ],
    dissents: [],
    riskPolicy: {
      minimumIndependentReviewsPerCandidate: 1,
      tieRisk: "medium",
      allowedResidualDissentSeverities: ["info", "minor"],
    },
    arbiter: {
      bindingId: "binding-independent-arbiter",
      selectedCandidateId: null,
      rationale: "Arbitration records only independently evidenced outcomes.",
    },
    command: {
      commandId: "command-independent-arbitration",
      idempotencyKey: "idempotency-independent-arbitration",
      correlationId: "correlation-independent-arbitration",
      causationId: "cause-independent-arbitration",
    },
    decisionId: "decision-independent-arbitration",
    decidedAt: DECIDED_AT,
    ...overrides,
  };
}

function fixture(options: { readonly failAppend?: boolean } = {}) {
  const appended: unknown[] = [];
  const ledger: RoomIndependentArbitrationDecisionLedgerPortV1 = {
    appendDecision: async (input) => {
      appended.push(input);
      if (options.failAppend) throw new Error("durable ledger unavailable");
      return {
        recordId: `record:${input.decision.id}`,
        replayed: false,
      };
    },
  };
  const dependencies: RoomIndependentArbitrationCoordinatorDependenciesV1 = { ledger };
  return {
    appended,
    coordinator: new RoomIndependentArbitrationCoordinator(dependencies),
  };
}

describe("RoomIndependentArbitrationCoordinator", () => {
  it("withholds without a ledger write when a hard gate fails despite an arbiter preference", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      hardGateResults: [
        gate("gate-alpha", "candidate-alpha", "failed"),
        gate("gate-beta", "candidate-beta"),
      ],
      arbiter: {
        bindingId: "binding-independent-arbiter",
        selectedCandidateId: "candidate-alpha",
        rationale: "A vote must not bypass the failed deterministic gate.",
      },
    }));
    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "hard_gate_not_passed" },
      modelOrArbiterMayOverrideHardGates: false,
    });
    expect(appended).toHaveLength(0);
  });

  it("withholds when the arbiter produced any candidate", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      arbiter: {
        bindingId: "binding-producer-alpha",
        selectedCandidateId: null,
        rationale: "A producer cannot arbitrate its own candidate.",
      },
    }));

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "arbiter_is_candidate_producer" },
    });
    expect(appended).toHaveLength(0);
  });

  it("withholds a review that is not independently recorded from the candidate producer", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      reviews: [
        review("review-alpha", "candidate-alpha", "binding-producer-alpha", "accept", false),
        review("review-beta", "candidate-beta", "binding-reviewer-beta", "reject"),
      ],
    }));

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "review_not_independent" },
    });
    expect(appended).toHaveLength(0);
  });

  it("records a promoted decision for an unambiguous independently reviewed winner", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request());

    expect(result).toMatchObject({
      status: "decided",
      record: { recordId: "record:decision-independent-arbitration", replayed: false },
      decision: {
        decision: "promoted",
        selectedCandidateId: "candidate-alpha",
        decisionActorType: "independent_arbiter",
        decisionActorId: "binding-independent-arbiter",
      },
    });
    expect(appended).toHaveLength(1);
  });

  it("records a high-risk tie as escalated with concrete independent-review and operator actions", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      reviews: [
        review("review-alpha", "candidate-alpha", "binding-reviewer-alpha", "accept"),
        review("review-beta", "candidate-beta", "binding-reviewer-beta", "accept"),
      ],
      riskPolicy: {
        minimumIndependentReviewsPerCandidate: 1,
        tieRisk: "high",
        allowedResidualDissentSeverities: ["info", "minor"],
      },
      arbiter: {
        bindingId: "binding-independent-arbiter",
        selectedCandidateId: "candidate-alpha",
        rationale: "A high-risk tie requires more independent evidence.",
      },
    }));

    expect(result).toMatchObject({
      status: "decided",
      decision: {
        decision: "escalated",
        selectedCandidateId: null,
        requiredActions: expect.arrayContaining([
          expect.objectContaining({ kind: "obtain_independent_review" }),
          expect.objectContaining({ kind: "operator_resolve_high_risk_tie" }),
        ]),
      },
    });
    expect(appended).toHaveLength(1);
  });

  it("records an open critical dissent as escalated with its owner and required resolution action", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      dissents: [
        dissent("dissent-critical", "candidate-alpha", "critical", "open", "binding-safety-owner"),
      ],
    }));

    expect(result).toMatchObject({
      status: "decided",
      decision: {
        decision: "escalated",
        selectedCandidateId: null,
        requiredActions: expect.arrayContaining([
          expect.objectContaining({
            kind: "operator_resolve_dissent",
            dissentId: "dissent-critical",
            ownerId: "binding-safety-owner",
          }),
        ]),
      },
    });
    expect(appended).toHaveLength(1);
  });

  it("withholds when the arbiter is the only independent reviewer", async () => {
    const { coordinator, appended } = fixture();
    const result = await coordinator.arbitrate(request({
      reviews: [
        review("review-alpha", "candidate-alpha", "binding-independent-arbiter", "accept"),
        review("review-beta", "candidate-beta", "binding-independent-arbiter", "reject"),
      ],
    }));

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "arbiter_is_only_reviewer" },
    });
    expect(appended).toHaveLength(0);
  });

  it("does not report a successful decision when the typed ledger write fails", async () => {
    const { coordinator, appended } = fixture({ failAppend: true });
    const result = await coordinator.arbitrate(request());

    expect(result).toMatchObject({
      status: "append_failed",
      reason: { code: "ledger_write_failed" },
    });
    expect(appended).toHaveLength(1);
  });
});
