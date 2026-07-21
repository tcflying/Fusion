import { describe, expect, it } from "vitest";

import {
  evaluateRoomTerminalization,
  type EvaluateRoomTerminalizationInputV1,
  type RoomTerminalizationOutcomeV1,
} from "../room-terminalization.js";
import { ROOM_PROTOCOL_DEFINITIONS } from "../room-protocol-definitions.js";

const TERMINAL_OUTCOMES: readonly RoomTerminalizationOutcomeV1[] = [
  "completed",
  "completed_with_risks",
  "partial",
  "blocked",
  "cancelled",
  "failed",
];

function validInput(
  requestedOutcome: RoomTerminalizationOutcomeV1,
): EvaluateRoomTerminalizationInputV1 {
  const gateId = `${requestedOutcome}_gate`;
  const requireIndependentVerifier = requestedOutcome === "completed";
  const allowsResidualRisk = requestedOutcome === "completed_with_risks";

  return {
    requestedOutcome,
    protocol: {
      id: "implementation-review",
      version: 1,
      gates: [{ id: gateId, hard: true }],
      exitConditions: [
        {
          outcome: requestedOutcome,
          requiredGateIds: [gateId],
          requireIndependentVerifier,
          ...(allowsResidualRisk ? { allowUnresolvedRiskSeverities: ["low"] } : {}),
        },
      ],
    },
    evidence: {
      source: "room_gate_ledger",
      evidenceSetId: `evidence-${requestedOutcome}`,
      protocolId: "implementation-review",
      protocolVersion: 1,
      producerBindingIds: ["binding-producer"],
      gateResults: [
        {
          gateId,
          status: "passed",
          evidenceRef: `gate-result-${requestedOutcome}`,
          evaluatorBindingIds: requireIndependentVerifier
            ? ["binding-independent-verifier"]
            : ["binding-producer"],
        },
      ],
      artifactEvidence: [],
      deliveryEvidence: [],
      unresolvedRisks: allowsResidualRisk
        ? [
            {
              id: "accepted-low-risk",
              severity: "low",
              evidenceRef: "accepted-low-risk-evidence",
              acceptedByBindingId: "binding-independent-risk-acceptor",
              acceptanceEvidenceRef: "accepted-low-risk-acceptance",
            },
          ]
        : [],
      unresolvedDissents: [],
    },
  };
}

describe("Room contract-driven terminalization", () => {
  it.each(TERMINAL_OUTCOMES)(
    "accepts %s only when its declared exit condition has authoritative passing evidence",
    (outcome) => {
      expect(evaluateRoomTerminalization(validInput(outcome))).toEqual({
        canTerminalize: true,
        outcome,
        unmetReasons: [],
      });
    },
  );

  it("rejects producer-only evidence when the exit condition requires an independent verifier", () => {
    const input = validInput("completed");
    const gateResult = input.evidence.gateResults[0]!;

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: {
        ...input.evidence,
        gateResults: [{ ...gateResult, evaluatorBindingIds: ["binding-producer"] }],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.outcome).toBeNull();
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "independent_verifier_required" }),
      ]),
    );
  });

  it("fails closed when the requested outcome has no declared protocol exit condition", () => {
    const input = validInput("completed");

    const decision = evaluateRoomTerminalization({
      ...input,
      protocol: { ...input.protocol, exitConditions: [] },
    });

    expect(decision).toEqual({
      canTerminalize: false,
      outcome: null,
      unmetReasons: [
        expect.objectContaining({ code: "missing_declared_exit_condition" }),
      ],
    });
  });

  it("fails closed when a required gate has no authoritative result", () => {
    const input = validInput("completed");

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: { ...input.evidence, gateResults: [] },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_required_gate_evidence" }),
      ]),
    );
  });

  it("does not treat caller assertions as authoritative gate evidence", () => {
    const input = validInput("completed");

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: {
        ...input.evidence,
        source: "caller_assertion" as unknown as "room_gate_ledger",
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_authoritative_gate_evidence_set" }),
      ]),
    );
  });

  it("rejects residual risk severities not explicitly allowed by the exit condition", () => {
    const input = validInput("completed_with_risks");

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: {
        ...input.evidence,
        unresolvedRisks: [
          {
            id: "unaccepted-high-risk",
            severity: "high",
            evidenceRef: "unaccepted-high-risk-evidence",
          },
        ],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unresolved_risk_not_allowed" }),
      ]),
    );
  });

  it("only requires independent verification when the declared exit condition asks for it", () => {
    const input = validInput("partial");

    expect(evaluateRoomTerminalization(input)).toEqual({
      canTerminalize: true,
      outcome: "partial",
      unmetReasons: [],
    });
  });

  it("does not let a passed acceptance gate override a failed hard gate", () => {
    const input = validInput("completed");

    const decision = evaluateRoomTerminalization({
      ...input,
      protocol: {
        ...input.protocol,
        gates: [...input.protocol.gates, { id: "mandatory-test", hard: true }],
      },
      evidence: {
        ...input.evidence,
        gateResults: [
          ...input.evidence.gateResults,
          {
            gateId: "mandatory-test",
            status: "failed",
            evidenceRef: "mandatory-test-failure",
            evaluatorBindingIds: ["binding-independent-verifier"],
          },
        ],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "hard_gate_failed" })]),
    );
  });

  it("does not treat a failed non-selected terminal discriminator as a failed acceptance hard gate", () => {
    const input = validInput("completed");
    const blockedGateId = "implementation-blocked";

    expect(
      evaluateRoomTerminalization({
        ...input,
        protocol: {
          ...input.protocol,
          gates: [...input.protocol.gates, { id: blockedGateId, hard: true }],
          exitConditions: [
            ...input.protocol.exitConditions,
            {
              outcome: "blocked",
              requiredGateIds: [blockedGateId],
              requireIndependentVerifier: false,
            },
          ],
        },
        evidence: {
          ...input.evidence,
          gateResults: [
            ...input.evidence.gateResults,
            {
              gateId: blockedGateId,
              status: "failed",
              evidenceRef: "not-blocked",
              evaluatorBindingIds: ["binding-independent-verifier"],
            },
          ],
        },
      }),
    ).toEqual({
      canTerminalize: true,
      outcome: "completed",
      unmetReasons: [],
    });
  });

  it("requires declared artifact proof and confirmed delivery before terminalization", () => {
    const input = validInput("completed");
    const gateId = input.protocol.gates[0]!.id;

    const decision = evaluateRoomTerminalization({
      ...input,
      protocol: {
        ...input.protocol,
        gates: [
          {
            ...input.protocol.gates[0]!,
            evidenceRequirements: ["artifact:final-result", "delivery:final-result"],
          },
        ],
      },
      evidence: {
        ...input.evidence,
        deliveryEvidence: [
          {
            gateId,
            deliveryId: "final-result",
            status: "delivery_uncertain",
            evidenceRef: "delivery-uncertain",
          },
        ],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_required_artifact_evidence" }),
        expect.objectContaining({ code: "required_delivery_not_confirmed" }),
      ]),
    );
  });

  it("fails closed when the authoritative dissent ledger is absent", () => {
    const input = validInput("completed");
    const { unresolvedDissents: _unresolvedDissents, ...evidenceWithoutDissentLedger } =
      input.evidence;

    const decision = evaluateRoomTerminalization({
      ...input,
      protocol: {
        ...input.protocol,
        gates: [
          {
            ...input.protocol.gates[0]!,
            evidenceRequirements: ["resolved_dissent"],
          },
        ],
      },
      evidence: evidenceWithoutDissentLedger as unknown as typeof input.evidence,
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_authoritative_gate_evidence_set" }),
      ]),
    );
  });

  it("rejects critical unresolved dissent even when residual risk is otherwise authorized", () => {
    const input = validInput("completed_with_risks");

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: {
        ...input.evidence,
        unresolvedDissents: [
          {
            id: "critical-security-objection",
            severity: "critical",
            evidenceRef: "critical-security-objection-evidence",
            acceptedByBindingId: "binding-independent-risk-acceptor",
            acceptanceEvidenceRef: "critical-security-objection-acceptance",
          },
        ],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "critical_dissent_unresolved" }),
      ]),
    );
  });

  it("rejects a producer self-accepting a residual risk", () => {
    const input = validInput("completed_with_risks");
    const risk = input.evidence.unresolvedRisks[0]!;

    const decision = evaluateRoomTerminalization({
      ...input,
      evidence: {
        ...input.evidence,
        unresolvedRisks: [
          {
            ...risk,
            acceptedByBindingId: "binding-producer",
          },
        ],
      },
    });

    expect(decision.canTerminalize).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unresolved_risk_self_accepted" }),
      ]),
    );
  });

  it("declares deterministic gate-backed rules for every built-in terminal outcome", () => {
    for (const definition of ROOM_PROTOCOL_DEFINITIONS) {
      expect(definition.exitConditions.map((exit) => exit.outcome)).toEqual(TERMINAL_OUTCOMES);
      for (const exit of definition.exitConditions) {
        expect(exit.requiredGateIds.length).toBeGreaterThan(0);
        for (const gateId of exit.requiredGateIds) {
          expect(definition.gates.some((gate) => gate.id === gateId)).toBe(true);
          expect(
            definition.phases.some((phase) => phase.exitGateIds.includes(gateId)),
          ).toBe(true);
        }
      }
    }
  });
});
