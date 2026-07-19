import { describe, expect, it } from "vitest";

import {
  evaluateRoomPhaseTransitionGateEvidence,
  type EvaluateRoomPhaseTransitionGateEvidenceInputV1,
  type RoomPhaseGateEvidenceRecordV1,
} from "../room-phase-gate-evidence.js";

const PROTOCOL_HASH = `sha256:${"a".repeat(64)}`;
const CANDIDATE_HASH = `sha256:${"b".repeat(64)}`;
const EVIDENCE_SOURCE_HASH = `sha256:${"c".repeat(64)}`;
const LINEAGE_SOURCE_HASH = `sha256:${"d".repeat(64)}`;
const AUTHORITY_SOURCE_HASH = `sha256:${"e".repeat(64)}`;

function evidenceFixture(
  overrides: Partial<RoomPhaseGateEvidenceRecordV1> = {},
): RoomPhaseGateEvidenceRecordV1 {
  return {
    contractVersion: 1,
    id: "evidence-candidate-ready",
    protocolId: "implementation-review",
    protocolVersion: 3,
    protocolHash: PROTOCOL_HASH,
    gateId: "candidate_ready",
    phaseId: "produce",
    turnId: "turn-17",
    candidateId: "candidate-7",
    candidateHash: CANDIDATE_HASH,
    source: {
      recordId: "room-event-91",
      sourceHash: EVIDENCE_SOURCE_HASH,
      recordedAt: "2026-07-19T08:04:30.000Z",
    },
    verdict: "passed",
    evaluatorBindingId: "binding-independent-reviewer",
    producerBindingIds: ["binding-producer"],
    operatorApproval: null,
    ...overrides,
  };
}

function validInput(): EvaluateRoomPhaseTransitionGateEvidenceInputV1 {
  return {
    contractVersion: 1,
    protocol: {
      contractVersion: 1,
      id: "implementation-review",
      version: 3,
      definitionHash: PROTOCOL_HASH,
      phases: [
        { id: "produce", entryGateIds: [], exitGateIds: ["candidate_ready", "wrong_gate"] },
        { id: "verify", entryGateIds: ["candidate_ready", "wrong_gate"], exitGateIds: [] },
      ],
      gates: [
        { id: "candidate_ready", kind: "evidence", hard: true },
        { id: "wrong_gate", kind: "deterministic", hard: false },
      ],
      transitions: [
        { fromPhaseId: "produce", toPhaseId: "verify", whenGateId: "candidate_ready" },
      ],
    },
    transition: {
      protocolId: "implementation-review",
      protocolVersion: 3,
      protocolHash: PROTOCOL_HASH,
      fromPhaseId: "produce",
      toPhaseId: "verify",
      turnId: "turn-17",
      candidateId: "candidate-7",
      candidateHash: CANDIDATE_HASH,
      evidenceNotBefore: "2026-07-19T08:04:00.000Z",
      evaluatedAt: "2026-07-19T08:05:00.000Z",
    },
    evidenceLedger: {
      source: "durable_room_phase_gate_ledger",
      records: [evidenceFixture()],
    },
    producerLineage: {
      source: "durable_room_producer_lineage_ledger",
      sourceRecordId: "room-event-90",
      sourceHash: LINEAGE_SOURCE_HASH,
      protocolId: "implementation-review",
      protocolVersion: 3,
      protocolHash: PROTOCOL_HASH,
      turnId: "turn-17",
      candidateId: "candidate-7",
      candidateHash: CANDIDATE_HASH,
      producerBindingIds: ["binding-producer"],
    },
  };
}

function operatorApprovalInput(
  grantedByActorId: string,
): EvaluateRoomPhaseTransitionGateEvidenceInputV1 {
  const input = validInput();
  const operatorGateId = "operator_release";
  const operatorEvidence = evidenceFixture({
    id: "evidence-operator-release",
    gateId: operatorGateId,
    evaluatorBindingId: null,
    operatorApproval: {
      operatorId: "operator-1",
      authority: {
        authorityRecordId: "approval-17",
        authoritySourceHash: AUTHORITY_SOURCE_HASH,
        grantedByActorId,
        scope: "approve_phase_gate",
        protocolId: input.protocol.id,
        protocolVersion: input.protocol.version,
        protocolHash: input.protocol.definitionHash,
        gateId: operatorGateId,
        phaseId: "produce",
        turnId: input.transition.turnId,
        candidateId: input.transition.candidateId,
        candidateHash: input.transition.candidateHash,
        grantedAt: "2026-07-19T08:04:10.000Z",
        expiresAt: null,
      },
    },
  });

  return {
    ...input,
    protocol: {
      ...input.protocol,
      phases: [
        { id: "produce", entryGateIds: [], exitGateIds: [operatorGateId] },
        { id: "verify", entryGateIds: [operatorGateId], exitGateIds: [] },
      ],
      gates: [{ id: operatorGateId, kind: "operator_approval", hard: true }],
      transitions: [
        { fromPhaseId: "produce", toPhaseId: "verify", whenGateId: operatorGateId },
      ],
    },
    evidenceLedger: {
      ...input.evidenceLedger,
      records: [operatorEvidence],
    },
  };
}

describe("Room phase-gate evidence policy", () => {
  it("accepts an exact hard transition gate only with an independent evaluator", () => {
    expect(evaluateRoomPhaseTransitionGateEvidence(validInput())).toEqual({
      transitionAllowed: true,
      exactGateId: "candidate_ready",
      acceptedEvidenceId: "evidence-candidate-ready",
      unmetReasons: [],
    });
  });

  it("rejects a producer's fabricated satisfiedGateIds-equivalent claim", () => {
    const input = {
      ...validInput(),
      evidenceLedger: {
        source: "durable_room_phase_gate_ledger" as const,
        records: [],
      },
      satisfiedGateIds: ["candidate_ready"],
    } as unknown as EvaluateRoomPhaseTransitionGateEvidenceInputV1;

    const decision = evaluateRoomPhaseTransitionGateEvidence(input);

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unexpected_input_property" }),
        expect.objectContaining({ code: "missing_exact_gate_evidence" }),
      ]),
    );
  });

  it("rejects evidence that predates the declared transition evidence window", () => {
    const evidence = evidenceFixture();
    const decision = evaluateRoomPhaseTransitionGateEvidence({
      ...validInput(),
      evidenceLedger: {
        source: "durable_room_phase_gate_ledger",
        records: [
          {
            ...evidence,
            source: { ...evidence.source, recordedAt: "2026-07-19T08:03:59.999Z" },
          },
        ],
      },
    });

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale_evidence" })]),
    );
  });

  it("rejects a passed record for a different declared transition gate", () => {
    const decision = evaluateRoomPhaseTransitionGateEvidence({
      ...validInput(),
      evidenceLedger: {
        source: "durable_room_phase_gate_ledger",
        records: [evidenceFixture({ gateId: "wrong_gate" })],
      },
    });

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.exactGateId).toBe("candidate_ready");
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence_gate_mismatch" })]),
    );
  });

  it("rejects duplicate durable evidence records instead of selecting one", () => {
    const duplicate = evidenceFixture({ id: "evidence-candidate-ready-duplicate" });
    const decision = evaluateRoomPhaseTransitionGateEvidence({
      ...validInput(),
      evidenceLedger: {
        source: "durable_room_phase_gate_ledger",
        records: [evidenceFixture(), duplicate],
      },
    });

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_evidence_source_record" })]),
    );
  });

  it("rejects malformed evidence hashes instead of treating the record as authoritative", () => {
    const decision = evaluateRoomPhaseTransitionGateEvidence({
      ...validInput(),
      evidenceLedger: {
        source: "durable_room_phase_gate_ledger",
        records: [evidenceFixture({ candidateHash: "unhashed-candidate" })],
      },
    });

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "malformed_evidence" })]),
    );
  });

  it("rejects self-granted operator approval", () => {
    const decision = evaluateRoomPhaseTransitionGateEvidence(
      operatorApprovalInput("operator-1"),
    );

    expect(decision.transitionAllowed).toBe(false);
    expect(decision.unmetReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "operator_self_authority_forbidden" }),
      ]),
    );
  });

  it("permits operator approval only when its durable authority is explicit and non-self", () => {
    expect(evaluateRoomPhaseTransitionGateEvidence(operatorApprovalInput("owner-1"))).toEqual({
      transitionAllowed: true,
      exactGateId: "operator_release",
      acceptedEvidenceId: "evidence-operator-release",
      unmetReasons: [],
    });
  });
});
