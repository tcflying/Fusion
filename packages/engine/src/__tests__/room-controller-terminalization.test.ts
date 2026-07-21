import { describe, expect, it, vi } from "vitest";
import {
  createRoomTerminalizationContract,
  createRoomTerminalizationProjection,
  terminalizeRoomTerminalizationProjection,
  type RoomAggregateV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import { RoomController, type RoomWorkerRunInput } from "../room-controller.js";

const PROJECT_ID = "project-controller-terminalization";
const ROOM_ID = "room-controller-terminalization";
const NOW = "2026-07-18T12:30:00.000Z";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function workerLease(): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "lease-controller-terminalization",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: "controller-terminalization",
    hostId: "windows-controller-terminalization",
    epoch: 2,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-18T12:31:00.000Z",
    releasedAt: null,
  };
}

function runnableRoom(): RoomAggregateV1 {
  return {
    room: {
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Terminalization callback must use the controller fence",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: 7,
      createdAt: NOW,
      updatedAt: NOW,
    },
    seats: [],
    bindings: [],
    membershipVersion: 0,
    activeTurnId: null,
  } as RoomAggregateV1;
}

function terminalizationInput() {
  return {
    requestedOutcome: "completed" as const,
    protocol: {
      id: "implementation-review",
      version: 1,
      gates: [{ id: "completed-gate" }],
      exitConditions: [{
        outcome: "completed" as const,
        requiredGateIds: ["completed-gate"],
        requireIndependentVerifier: true,
      }],
    },
    evidence: {
      source: "room_gate_ledger" as const,
      evidenceSetId: "gate-ledger-controller-terminalization",
      protocolId: "implementation-review",
      protocolVersion: 1,
      producerBindingIds: ["binding-producer"],
      gateResults: [{
        gateId: "completed-gate",
        status: "passed" as const,
        evidenceRef: "evidence-independent-completed",
        evaluatorBindingIds: ["binding-independent"],
      }],
      unresolvedRisks: [],
    },
  };
}

describe("RoomController terminalization callback", () => {
  it("captures the live controller fence and does not duplicate Core's terminal lease revocation", async () => {
    const lease = workerLease();
    const completed = deferred();
    const events: unknown[] = [];
    let terminalizationCommitted = false;
    let recordedContract: ReturnType<typeof createRoomTerminalizationContract> | null = null;
    const recordRoomTerminalizationContract = vi.fn(async (input, context) => {
      events.push(context);
      recordedContract = createRoomTerminalizationContract({
        id: "contract-controller-terminalization",
        projectId: PROJECT_ID,
        roomId: input.roomId,
        aggregateVersion: input.expectedAggregateVersion + 1,
        protocolId: input.terminalization.protocol.id,
        protocolVersion: input.terminalization.protocol.version,
        completionContractRef: input.completionContractRef,
        gateEvidenceSetId: input.gateEvidenceSetId,
        independentVerificationRefs: input.independentVerificationRefs,
        unresolvedRiskEvidence: input.unresolvedRiskEvidence,
        cancellationReason: input.cancellationReason,
        terminalization: input.terminalization,
        recordEventId: "event-contract-controller-terminalization",
        recordedAt: input.asOf,
      });
      return {
        projection: createRoomTerminalizationProjection(recordedContract),
        replayed: false,
      };
    });
    const terminalizeRoom = vi.fn(async (input, context) => {
      events.push(context);
      if (!recordedContract) throw new Error("terminalization contract was not recorded");
      const projection = terminalizeRoomTerminalizationProjection(
        createRoomTerminalizationProjection(recordedContract),
        {
          contractId: input.terminalContractId,
          contractHash: input.terminalContractHash,
          outcome: "completed",
          eventId: "event-terminalized-controller",
          aggregateVersion: recordedContract.aggregateVersion + 1,
          terminalizedAt: input.asOf,
        },
      );
      terminalizationCommitted = true;
      return { aggregate: runnableRoom(), projection, replayed: false };
    });
    const releaseLease = vi.fn(async () => undefined);
    const worker = {
      runRoom: vi.fn(async (input: RoomWorkerRunInput) => {
        const terminalize = input.terminalizeRoom;
        expect(terminalize).toBeTypeOf("function");
        const terminalization = terminalizationInput();
        const command = {
          expectedAggregateVersion: 7,
          idempotencyKey: "controller-terminalization-command",
          correlationId: "correlation-controller-terminalization",
          causationId: null,
          completionContractRef: "completion-controller-terminalization",
          gateEvidenceSetId: terminalization.evidence.evidenceSetId,
          independentVerificationRefs: ["evidence-independent-completed"],
          unresolvedRiskEvidence: [],
          cancellationReason: null,
          terminalization,
        };
        const result = await terminalize!(command);
        const replay = await terminalize!(command);
        expect(result.status).toBe("terminalized");
        expect(replay.status).toBe("terminalized");
        completed.resolve();
      }),
    };
    const controller = new RoomController({
      projectId: PROJECT_ID,
      workerId: lease.holderId,
      hostId: lease.hostId,
      roomStore: {
        listRunnableRooms: async () => [runnableRoom()],
        assertWorkerAuthority: async () => ({
          lease,
          posture: {
            lifecycleState: "running",
            aggregateVersion: terminalizationCommitted ? 9 : 7,
            humanPaused: false,
            approvalState: "none" as const,
          },
        }),
        recordRoomTerminalizationContract,
        terminalizeRoom,
      },
      leaseStore: {
        acquireLease: async () => ({ ok: true as const, action: "acquired" as const, lease }),
        renewLease: async () => ({ ok: true as const, lease }),
        releaseLease,
        assertFence: async () => lease,
      },
      worker,
      now: () => NOW,
      pollIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
      recordRunAuditEvent: async (event) => {
        events.push(event);
      },
    });

    await controller.start();
    await completed.promise;
    await controller.stop();

    expect(recordRoomTerminalizationContract).toHaveBeenCalledWith(expect.objectContaining({
      roomWorkerFence: {
        leaseId: lease.id,
        holderId: lease.holderId,
        hostId: lease.hostId,
        expectedEpoch: lease.epoch,
      },
    }), expect.objectContaining({ actorType: "controller", actorId: lease.holderId }));
    expect(terminalizeRoom).toHaveBeenCalledWith(expect.objectContaining({
      expectedAggregateVersion: 8,
      terminalContractId: "contract-controller-terminalization",
    }), expect.objectContaining({ correlationId: "correlation-controller-terminalization" }));
    expect(recordRoomTerminalizationContract).toHaveBeenCalledTimes(2);
    expect(terminalizeRoom).toHaveBeenCalledTimes(2);
    expect(releaseLease).not.toHaveBeenCalled();
  });
});
