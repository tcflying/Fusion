import { describe, expect, it } from "vitest";

import { createRoomTerminalizationContract } from "../room-terminalization-contract.js";
import { rebuildRoomTerminalizationProjectionFromEvents } from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const PROJECT_ID = "project-terminalization-replay";
const ROOM_ID = "room-terminalization-replay";
const RECORDED_AT = "2026-07-18T12:00:00.000Z";
const TERMINALIZED_AT = "2026-07-18T12:01:00.000Z";

function contract() {
  return createRoomTerminalizationContract({
    id: "contract-terminalization-replay",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion: 1,
    protocolId: "implementation-review",
    protocolVersion: 1,
    completionContractRef: "contract:replay",
    gateEvidenceSetId: "gate-set:replay",
    independentVerificationRefs: ["review:replay-independent"],
    unresolvedRiskEvidence: [],
    cancellationReason: null,
    terminalization: {
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
        evidenceSetId: "gate-set:replay",
        protocolId: "implementation-review",
        protocolVersion: 1,
        producerBindingIds: ["binding-producer"],
        gateResults: [{
          gateId: "final-gate",
          status: "passed",
          evidenceRef: "evidence:replay-final-gate",
          evaluatorBindingIds: ["binding-verifier"],
        }],
        unresolvedRisks: [],
      },
    },
    recordEventId: "event-terminal-contract",
    recordedAt: RECORDED_AT,
  });
}

function event(
  id: string,
  aggregateVersion: number,
  cursor: string,
  eventType: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion,
    cursor,
    eventType,
    actorType: "controller",
    actorId: "worker-terminalization-replay",
    correlationId: "terminalization-replay",
    causationId: null,
    payload,
    occurredAt,
  };
}

describe("Room terminalization event replay", () => {
  it("rebuilds a terminalized projection only from contract-record and terminal events", () => {
    const stored = contract();
    const projection = rebuildRoomTerminalizationProjectionFromEvents([
      event(stored.recordEventId, 1, "1", "room_terminalization_contract_recorded", {
        projectionVersion: 1,
        contract: stored,
        contractHash: stored.contractHash,
        recordedAt: RECORDED_AT,
      }, RECORDED_AT),
      event("event-room-terminalized", 2, "2", "room_terminalized", {
        projectionVersion: 1,
        contract: stored,
        contractId: stored.id,
        contractHash: stored.contractHash,
        recordEventId: stored.recordEventId,
        from: "running",
        to: "completed",
        terminalizedAt: TERMINALIZED_AT,
      }, TERMINALIZED_AT),
    ]);

    expect(projection).toMatchObject({
      state: "terminalized",
      contract: { id: stored.id, contractHash: stored.contractHash },
      terminalization: {
        eventId: "event-room-terminalized",
        aggregateVersion: 2,
        outcome: "completed",
      },
    });
  });

  it("rejects terminal events that skip the immutable contract record", () => {
    const stored = contract();

    expect(() => rebuildRoomTerminalizationProjectionFromEvents([
      event("event-room-terminalized", 2, "1", "room_terminalized", {
        projectionVersion: 1,
        contract: stored,
        contractId: stored.id,
        contractHash: stored.contractHash,
        recordEventId: stored.recordEventId,
        from: "running",
        to: "completed",
        terminalizedAt: TERMINALIZED_AT,
      }, TERMINALIZED_AT),
    ])).toThrow(/no preceding immutable contract-record/i);
  });
});
