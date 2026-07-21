import { describe, expect, it } from "vitest";

import {
  createRoomTerminalizationContract,
  createRoomTerminalizationProjection,
  parseRoomTerminalizationProjection,
  terminalizeRoomTerminalizationProjection,
} from "../room-terminalization-contract.js";
import type { EvaluateRoomTerminalizationInputV1 } from "../room-terminalization.js";

const RECORDED_AT = "2026-07-18T11:30:00.000Z";

function validInput(): EvaluateRoomTerminalizationInputV1 {
  return {
    requestedOutcome: "completed",
    protocol: {
      id: "implementation-review",
      version: 1,
      gates: [{ id: "final-gate" }],
      exitConditions: [{
        outcome: "completed",
        requiredGateIds: ["final-gate"],
        requireIndependentVerifier: true,
      }],
    },
    evidence: {
      source: "room_gate_ledger",
      evidenceSetId: "gate-ledger-final",
      protocolId: "implementation-review",
      protocolVersion: 1,
      producerBindingIds: ["binding-producer"],
      gateResults: [{
        gateId: "final-gate",
        status: "passed",
        evidenceRef: "evidence-final-gate",
        evaluatorBindingIds: ["binding-independent-verifier"],
      }],
      unresolvedRisks: [],
    },
  };
}

function contract() {
  return createRoomTerminalizationContract({
    id: "terminal-contract-1",
    projectId: "project-terminal-contract",
    roomId: "room-terminal-contract",
    aggregateVersion: 4,
    protocolId: "implementation-review",
    protocolVersion: 1,
    completionContractRef: "contract:accepted-brief",
    gateEvidenceSetId: "gate-ledger-final",
    independentVerificationRefs: ["review:independent"],
    unresolvedRiskEvidence: [],
    cancellationReason: null,
    terminalization: validInput(),
    recordEventId: "event-contract-recorded",
    recordedAt: RECORDED_AT,
  });
}

describe("Room terminalization contract", () => {
  it("hash-binds the controller contract and reproduces its policy decision", () => {
    const record = contract();
    const projection = createRoomTerminalizationProjection(record);

    expect(parseRoomTerminalizationProjection(projection)).toEqual(projection);
    expect(record.decision).toEqual({
      canTerminalize: true,
      outcome: "completed",
      unmetReasons: [],
    });
  });

  it("fails closed when a persisted evidence input is modified after recording", () => {
    const record = contract();
    const tampered = {
      ...record,
      terminalization: {
        ...record.terminalization,
        evidence: { ...record.terminalization.evidence, gateResults: [] },
      },
    };

    expect(() => parseRoomTerminalizationProjection({
      contractVersion: 1,
      contract: tampered,
      state: "recorded",
      terminalization: null,
    })).toThrow(/decision does not reproduce|integrity hash/i);
  });

  it("rejects a ledger reference that does not identify the policy-evaluated gate set", () => {
    expect(() => createRoomTerminalizationContract({
      id: "terminal-contract-mismatched-ledger",
      projectId: "project-terminal-contract",
      roomId: "room-terminal-contract",
      aggregateVersion: 4,
      protocolId: "implementation-review",
      protocolVersion: 1,
      completionContractRef: "contract:accepted-brief",
      gateEvidenceSetId: "gate-ledger-other",
      independentVerificationRefs: ["review:independent"],
      unresolvedRiskEvidence: [],
      cancellationReason: null,
      terminalization: validInput(),
      recordEventId: "event-contract-mismatched-ledger",
      recordedAt: RECORDED_AT,
    })).toThrow(/gate evidence/i);
  });

  it("retains a policy-red contract as immutable repair evidence without permitting terminalization", () => {
    const red = validInput();
    const contract = createRoomTerminalizationContract({
      id: "terminal-contract-red",
      projectId: "project-terminal-contract",
      roomId: "room-terminal-contract",
      aggregateVersion: 4,
      protocolId: "implementation-review",
      protocolVersion: 1,
      completionContractRef: "contract:needs-repair",
      gateEvidenceSetId: red.evidence.evidenceSetId,
      independentVerificationRefs: ["review:independent"],
      unresolvedRiskEvidence: [],
      cancellationReason: null,
      terminalization: {
        ...red,
        evidence: {
          ...red.evidence,
          gateResults: [{
            ...red.evidence.gateResults[0]!,
            status: "failed",
          }],
        },
      },
      recordEventId: "event-contract-red",
      recordedAt: RECORDED_AT,
    });

    expect(contract.decision).toMatchObject({ canTerminalize: false, outcome: null });
    expect(parseRoomTerminalizationProjection(createRoomTerminalizationProjection(contract)))
      .toMatchObject({ state: "recorded", terminalization: null });
  });

  it("permits exactly one matching terminal marker immediately after the contract version", () => {
    const record = contract();
    const projection = createRoomTerminalizationProjection(record);
    const terminalized = terminalizeRoomTerminalizationProjection(projection, {
      contractId: record.id,
      contractHash: record.contractHash,
      outcome: "completed",
      eventId: "event-terminalized",
      aggregateVersion: 5,
      terminalizedAt: "2026-07-18T11:31:00.000Z",
    });

    expect(terminalized.state).toBe("terminalized");
    expect(() => terminalizeRoomTerminalizationProjection(projection, {
      contractId: record.id,
      contractHash: record.contractHash,
      outcome: "completed",
      eventId: "event-terminalized-too-late",
      aggregateVersion: 6,
      terminalizedAt: "2026-07-18T11:32:00.000Z",
    })).toThrow(/immediately follow/i);
  });
});
