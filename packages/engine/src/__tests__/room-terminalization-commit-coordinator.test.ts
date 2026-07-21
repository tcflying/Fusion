import { describe, expect, it, vi } from "vitest";
import {
  createRoomTerminalizationContract,
  createRoomTerminalizationProjection,
  terminalizeRoomTerminalizationProjection,
  type EvaluateRoomTerminalizationInputV1,
  type RecordRoomTerminalizationContractInputV1,
} from "@fusion/core";

import {
  RoomTerminalizationCommitCoordinator,
  RoomTerminalizationCommitCoordinatorError,
  type CommitRoomTerminalizationInputV1,
  type RoomTerminalizationCommitStore,
} from "../room-terminalization-commit-coordinator.js";

const PROJECT_ID = "project-terminal-commit";
const ROOM_ID = "room-terminal-commit";
const OCCURRED_AT = "2026-07-18T12:10:00.000Z";

function terminalization(
  outcome: "completed" | "failed" = "completed",
): EvaluateRoomTerminalizationInputV1 {
  const gateId = `gate-${outcome}`;
  return {
    requestedOutcome: outcome,
    protocol: {
      id: "implementation-review",
      version: 1,
      gates: [{ id: gateId }],
      exitConditions: [{ outcome, requiredGateIds: [gateId], requireIndependentVerifier: true }],
    },
    evidence: {
      source: "room_gate_ledger",
      evidenceSetId: `gate-ledger-${outcome}`,
      protocolId: "implementation-review",
      protocolVersion: 1,
      producerBindingIds: ["binding-producer"],
      gateResults: [{
        gateId,
        status: outcome === "completed" ? "passed" : "failed",
        evidenceRef: `evidence-${outcome}`,
        evaluatorBindingIds: ["binding-independent"],
      }],
      unresolvedRisks: [],
    },
  };
}

function input(
  override: Partial<CommitRoomTerminalizationInputV1> = {},
): CommitRoomTerminalizationInputV1 {
  const value = terminalization();
  return {
    roomId: ROOM_ID,
    expectedAggregateVersion: 7,
    roomWorkerFence: {
      leaseId: "lease-terminal-commit",
      holderId: "controller-terminal-commit",
      hostId: "windows-terminal-commit",
      expectedEpoch: 4,
    },
    idempotencyKey: "terminal-commit-1",
    correlationId: "correlation-terminal-commit",
    causationId: null,
    completionContractRef: "completion-contract-1",
    gateEvidenceSetId: value.evidence.evidenceSetId,
    independentVerificationRefs: ["evidence-completed"],
    unresolvedRiskEvidence: [],
    cancellationReason: null,
    terminalization: value,
    occurredAt: OCCURRED_AT,
    ...override,
  };
}

function storeFor(recordedInput: CommitRoomTerminalizationInputV1): {
  readonly store: RoomTerminalizationCommitStore;
  readonly record: ReturnType<typeof vi.fn>;
  readonly terminalize: ReturnType<typeof vi.fn>;
} {
  const record = vi.fn(async (raw: RecordRoomTerminalizationContractInputV1) => {
    const contract = createRoomTerminalizationContract({
      id: "contract-terminal-commit",
      projectId: PROJECT_ID,
      roomId: raw.roomId,
      aggregateVersion: raw.expectedAggregateVersion + 1,
      protocolId: raw.terminalization.protocol.id,
      protocolVersion: raw.terminalization.protocol.version,
      completionContractRef: raw.completionContractRef,
      gateEvidenceSetId: raw.gateEvidenceSetId,
      independentVerificationRefs: raw.independentVerificationRefs,
      unresolvedRiskEvidence: raw.unresolvedRiskEvidence,
      cancellationReason: raw.cancellationReason,
      terminalization: raw.terminalization,
      recordEventId: "event-contract-terminal-commit",
      recordedAt: raw.asOf,
    });
    return { projection: createRoomTerminalizationProjection(contract), replayed: false };
  });
  const terminalize = vi.fn(async (raw: { readonly terminalContractId: string; readonly terminalContractHash: string; readonly asOf: string }) => {
    const contract = createRoomTerminalizationContract({
      id: raw.terminalContractId,
      projectId: PROJECT_ID,
      roomId: recordedInput.roomId,
      aggregateVersion: recordedInput.expectedAggregateVersion + 1,
      protocolId: recordedInput.terminalization.protocol.id,
      protocolVersion: recordedInput.terminalization.protocol.version,
      completionContractRef: recordedInput.completionContractRef,
      gateEvidenceSetId: recordedInput.gateEvidenceSetId,
      independentVerificationRefs: recordedInput.independentVerificationRefs,
      unresolvedRiskEvidence: recordedInput.unresolvedRiskEvidence,
      cancellationReason: recordedInput.cancellationReason,
      terminalization: recordedInput.terminalization,
      recordEventId: "event-contract-terminal-commit",
      recordedAt: recordedInput.occurredAt,
    });
    const projection = terminalizeRoomTerminalizationProjection(
      createRoomTerminalizationProjection(contract),
      {
        contractId: contract.id,
        contractHash: raw.terminalContractHash,
        outcome: contract.requestedOutcome,
        eventId: "event-terminalized-commit",
        aggregateVersion: contract.aggregateVersion + 1,
        terminalizedAt: raw.asOf,
      },
    );
    return { aggregate: {} as never, projection, replayed: false };
  });
  return { store: { recordRoomTerminalizationContract: record, terminalizeRoom: terminalize }, record, terminalize };
}

function coordinator(store: RoomTerminalizationCommitStore): RoomTerminalizationCommitCoordinator {
  return new RoomTerminalizationCommitCoordinator({
    projectId: PROJECT_ID,
    controllerId: "controller-terminal-commit",
    store,
  });
}

describe("RoomTerminalizationCommitCoordinator", () => {
  it("records the immutable contract then terminalizes only by its persisted hash", async () => {
    const request = input();
    const fixture = storeFor(request);

    const result = await coordinator(fixture.store).commit(request);

    expect(result.status).toBe("terminalized");
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "terminal-commit-1:contract",
      expectedAggregateVersion: 7,
      gateEvidenceSetId: "gate-ledger-completed",
    }), expect.objectContaining({ actorType: "controller", actorId: "controller-terminal-commit" }));
    expect(fixture.terminalize).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "terminal-commit-1:terminalize",
      expectedAggregateVersion: 8,
      terminalContractId: "contract-terminal-commit",
    }), expect.objectContaining({ correlationId: "correlation-terminal-commit" }));
  });

  it("persists a valid red contract but withholds its lifecycle transition", async () => {
    const redTerminalization = terminalization("failed");
    const request = input({
      terminalization: redTerminalization,
      gateEvidenceSetId: redTerminalization.evidence.evidenceSetId,
      independentVerificationRefs: ["evidence-failed"],
    });
    const fixture = storeFor(request);

    const result = await coordinator(fixture.store).commit(request);

    expect(result.status).toBe("withheld");
    expect(fixture.record).toHaveBeenCalledTimes(1);
    expect(fixture.terminalize).not.toHaveBeenCalled();
  });

  it("rejects a mismatched caller ledger reference before a durable write", async () => {
    const request = input({ gateEvidenceSetId: "unrelated-ledger" });
    const fixture = storeFor(request);

    await expect(coordinator(fixture.store).commit(request)).rejects.toMatchObject<Partial<RoomTerminalizationCommitCoordinatorError>>({
      code: "invalid_terminalization_commit",
    });
    expect(fixture.record).not.toHaveBeenCalled();
    expect(fixture.terminalize).not.toHaveBeenCalled();
  });
});
