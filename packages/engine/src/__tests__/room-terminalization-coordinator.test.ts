import { describe, expect, it } from "vitest";
import type {
  EvaluateRoomTerminalizationInputV1,
  RoomTerminalizationOutcomeV1,
} from "@fusion/core";

import {
  RoomTerminalizationCoordinator,
  type RoomTerminalTransitionRequestV1,
  type RoomTerminalizationContractEvidenceV1,
} from "../room-terminalization-coordinator.js";

const PROJECT_ID = "project-terminalization";
const ROOM_ID = "room-terminalization";
const AGGREGATE_VERSION = 7;

const TERMINAL_OUTCOMES: readonly RoomTerminalizationOutcomeV1[] = [
  "completed",
  "completed_with_risks",
  "partial",
  "blocked",
  "cancelled",
  "failed",
];

function terminalizationInput(
  outcome: RoomTerminalizationOutcomeV1,
): EvaluateRoomTerminalizationInputV1 {
  const gateId = "terminal-gate-" + outcome;
  const riskAllowed = outcome === "completed_with_risks";
  return {
    requestedOutcome: outcome,
    protocol: {
      id: "implementation-review",
      version: 1,
      gates: [{ id: gateId }],
      exitConditions: [{
        outcome,
        requiredGateIds: [gateId],
        requireIndependentVerifier: true,
        ...(riskAllowed ? { allowUnresolvedRiskSeverities: ["low"] } : {}),
      }],
    },
    evidence: {
      source: "room_gate_ledger",
      evidenceSetId: "gate-ledger-" + outcome,
      protocolId: "implementation-review",
      protocolVersion: 1,
      producerBindingIds: ["binding-producer"],
      gateResults: [{
        gateId,
        status: "passed",
        evidenceRef: "gate-evidence-" + outcome,
        evaluatorBindingIds: ["binding-independent-verifier"],
      }],
      unresolvedRisks: riskAllowed ? [{
        id: "residual-risk",
        severity: "low",
        evidenceRef: "risk-evidence-residual",
        acceptedByBindingId: "binding-independent-verifier",
        acceptanceEvidenceRef: "risk-acceptance-evidence-residual",
      }] : [],
      unresolvedDissents: riskAllowed ? [] : undefined,
    },
  };
}

function terminalContract(
  outcome: RoomTerminalizationOutcomeV1,
  overrides: Partial<RoomTerminalizationContractEvidenceV1> = {},
): RoomTerminalizationContractEvidenceV1 {
  const terminalization = terminalizationInput(outcome);
  return {
    source: "room_terminal_contract_ledger",
    recordId: "terminal-contract-" + outcome,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion: AGGREGATE_VERSION,
    requestedOutcome: outcome,
    completionContractRef: "completion-contract-" + outcome,
    protocolId: terminalization.protocol.id,
    protocolVersion: terminalization.protocol.version,
    gateEvidenceSetId: terminalization.evidence.evidenceSetId,
    independentVerificationRefs: ["gate-evidence-" + outcome],
    unresolvedRiskEvidence: outcome === "completed_with_risks"
      ? [{ riskId: "residual-risk", evidenceRef: "risk-evidence-residual" }]
      : [],
    cancellationReason: outcome === "cancelled" ? "operator_cancelled" : null,
    terminalization,
    ...overrides,
  };
}

function coordinatorFor(
  contract: RoomTerminalizationContractEvidenceV1 | null,
  requests: RoomTerminalTransitionRequestV1[],
): RoomTerminalizationCoordinator {
  return new RoomTerminalizationCoordinator({
    projectId: PROJECT_ID,
    evidenceReader: {
      readTerminalizationContract: async () => contract,
    },
    transitionRequester: {
      requestTerminalTransition: async (transitionRequest) => {
        requests.push(transitionRequest);
      },
    },
  });
}

function request(
  requestedOutcome: RoomTerminalizationOutcomeV1,
): {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
  readonly idempotencyKey: string;
  readonly correlationId: string;
} {
  return {
    roomId: ROOM_ID,
    expectedAggregateVersion: AGGREGATE_VERSION,
    requestedOutcome,
    idempotencyKey: "terminalize-" + requestedOutcome,
    correlationId: "correlation-" + requestedOutcome,
  };
}

describe("RoomTerminalizationCoordinator", () => {
  it.each(TERMINAL_OUTCOMES)(
    "requests the distinct %s controller command only after independent contract evidence",
    async (outcome) => {
      const requests: RoomTerminalTransitionRequestV1[] = [];
      const coordinator = coordinatorFor(terminalContract(outcome), requests);

      const result = await coordinator.requestTerminalization(request(outcome));

      expect(result).toMatchObject({
        status: "transition_requested",
        requestedOutcome: outcome,
        terminalizationDecision: { canTerminalize: true, outcome },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        expectedAggregateVersion: AGGREGATE_VERSION,
        terminalContractRef: "completion-contract-" + outcome,
      });
      if (outcome === "cancelled") {
        expect(requests[0]?.command).toEqual({
          type: "cancel_room",
          outcome: "cancelled",
          reason: "operator_cancelled",
        });
      } else {
        expect(requests[0]?.command).toMatchObject({
          type: "complete_room",
          outcome,
          independentVerificationRefs: ["gate-evidence-" + outcome],
          unresolvedRiskRefs: outcome === "completed_with_risks"
            ? ["risk-evidence-residual"]
            : [],
        });
      }
    },
  );

  it("withholds when no authoritative terminal contract record exists", async () => {
    const requests: RoomTerminalTransitionRequestV1[] = [];
    const result = await coordinatorFor(null, requests).requestTerminalization(request("completed"));

    expect(result).toMatchObject({
      status: "withheld",
      blockers: [expect.objectContaining({ code: "terminal_contract_evidence_unavailable" })],
    });
    expect(requests).toEqual([]);
  });

  it("withholds producer-only gate evidence even when the contract has a reference", async () => {
    const requests: RoomTerminalTransitionRequestV1[] = [];
    const contract = terminalContract("completed");
    const gateResult = contract.terminalization.evidence.gateResults[0]!;
    const producerOnly: RoomTerminalizationContractEvidenceV1 = {
      ...contract,
      terminalization: {
        ...contract.terminalization,
        evidence: {
          ...contract.terminalization.evidence,
          gateResults: [{ ...gateResult, evaluatorBindingIds: ["binding-producer"] }],
        },
      },
    };

    const result = await coordinatorFor(producerOnly, requests).requestTerminalization(request("completed"));

    expect(result).toMatchObject({
      status: "withheld",
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "independent_verification_required" }),
        expect.objectContaining({ code: "core_terminalization_rejected" }),
      ]),
    });
    expect(requests).toEqual([]);
  });

  it("does not accept an unproven independent-verification reference", async () => {
    const requests: RoomTerminalTransitionRequestV1[] = [];
    const contract = terminalContract("partial", {
      independentVerificationRefs: ["fabricated-independent-reference"],
    });

    const result = await coordinatorFor(contract, requests).requestTerminalization(request("partial"));

    expect(result).toMatchObject({
      status: "withheld",
      terminalizationDecision: { canTerminalize: true, outcome: "partial" },
      blockers: [expect.objectContaining({ code: "independent_verification_ref_unproven" })],
    });
    expect(requests).toEqual([]);
  });

  it("requires exact risk evidence and a cancellation reason before those terminal requests", async () => {
    const riskRequests: RoomTerminalTransitionRequestV1[] = [];
    const riskResult = await coordinatorFor(
      terminalContract("completed_with_risks", { unresolvedRiskEvidence: [] }),
      riskRequests,
    ).requestTerminalization(request("completed_with_risks"));

    expect(riskResult).toMatchObject({
      status: "withheld",
      blockers: [expect.objectContaining({ code: "terminal_contract_unresolved_risk_mismatch" })],
    });
    expect(riskRequests).toEqual([]);

    const cancelledRequests: RoomTerminalTransitionRequestV1[] = [];
    const cancelledResult = await coordinatorFor(
      terminalContract("cancelled", { cancellationReason: null }),
      cancelledRequests,
    ).requestTerminalization(request("cancelled"));

    expect(cancelledResult).toMatchObject({
      status: "withheld",
      blockers: [expect.objectContaining({ code: "cancelled_terminal_contract_reason_missing" })],
    });
    expect(cancelledRequests).toEqual([]);
  });

  it("withholds when the evidence record no longer matches the Room aggregate version", async () => {
    const requests: RoomTerminalTransitionRequestV1[] = [];
    const result = await coordinatorFor(
      terminalContract("failed", { aggregateVersion: AGGREGATE_VERSION + 1 }),
      requests,
    ).requestTerminalization(request("failed"));

    expect(result).toMatchObject({
      status: "withheld",
      blockers: [expect.objectContaining({ code: "terminal_contract_aggregate_version_mismatch" })],
    });
    expect(requests).toEqual([]);
  });
});
