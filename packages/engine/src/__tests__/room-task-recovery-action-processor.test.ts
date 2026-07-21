import { describe, expect, it, vi } from "vitest";
import {
  ROOM_PROTOCOL_DEFINITIONS,
  getRoomProtocolNoProgressRecoveryPolicy,
  hashRoomValue,
  type ClaimRoomTaskRecoveryActionInputV1,
  type CompleteRoomTaskRecoveryActionInputV1,
  type RoomTaskRecoveryActionResultV1,
  type RoomTaskRecoveryActionV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  RoomTaskRecoveryActionProcessor,
  type RoomTaskRecoveryActionStore,
} from "../room-task-recovery-action-processor.js";

const ROOM_ID = "room-task-recovery";
const WORKER_ID = "room-worker-1";
const HOST_ID = "host-controller";
const NOW = "2026-07-19T02:00:00.000Z";
const RETRY_AT = "2026-07-19T02:00:05.000Z";

function workerLease(overrides: Partial<StoredRoomLeaseV1> = {}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-worker-lease-1",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 7,
    acquiredAt: NOW,
    renewedAt: NOW,
    expiresAt: "2026-07-19T02:01:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function claimedAction(id: string): RoomTaskRecoveryActionV1 {
  const protocol = ROOM_PROTOCOL_DEFINITIONS[0];
  if (!protocol) throw new Error("Expected at least one built-in Room protocol");
  const policy = getRoomProtocolNoProgressRecoveryPolicy(protocol.id, protocol.version);
  const policyAction = policy?.actions[0];
  const recoveryAction = protocol.recoveryActions.find(
    (candidate) => candidate.id === policyAction?.recoveryActionId,
  );
  if (!policy || !policyAction || !recoveryAction) {
    throw new Error("Expected a declared no-progress recovery action");
  }

  return {
    id,
    roomId: ROOM_ID,
    nodeId: `node-${id}`,
    nodeVersion: 1,
    observationId: `observation-${id}`,
    actionId: recoveryAction.id,
    actionSnapshot: {
      contractVersion: "room-task-no-progress-recovery-action/v1",
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      turnId: "turn-1",
      phaseId: recoveryAction.phaseIds[0] ?? protocol.phases[0]?.id ?? "phase-1",
      nodeId: `node-${id}`,
      nodeVersion: 1,
      observationId: `observation-${id}`,
      recoveryAction,
      recoveryActionHash: hashRoomValue(recoveryAction),
      ladderOrder: policyAction.ladderOrder,
      minimumConsecutiveUnchangedRounds: policyAction.minimumConsecutiveUnchangedRounds,
      executionMode: "controller_plan",
    },
    policySnapshot: policy,
    state: "claimed",
    attemptCount: 1,
    claimToken: `claim-token-${id}`,
    claimExpiresAt: "2026-07-19T02:05:00.000Z",
    claimedByWorkerId: WORKER_ID,
    claimedAt: NOW,
    nextEligibleAt: NOW,
    resultPayload: null,
    lastErrorCode: null,
    operatorApprovalId: null,
    createdAt: NOW,
    updatedAt: NOW,
    processedAt: null,
  };
}

function resultReceipt(
  kind: RoomTaskRecoveryActionResultV1["kind"] = "controller_plan_submitted",
): RoomTaskRecoveryActionResultV1 {
  const receiptRef = `receipt:${kind}`;
  return {
    contractVersion: "room-task-recovery-action-result/v1",
    kind,
    receiptRef,
    resultHash: hashRoomValue({
      contractVersion: "room-task-recovery-action-result/v1",
      kind,
      receiptRef,
    }),
  };
}

function createStore(actions: readonly RoomTaskRecoveryActionV1[]): {
  readonly store: RoomTaskRecoveryActionStore;
  readonly claims: ClaimRoomTaskRecoveryActionInputV1[];
  readonly completions: CompleteRoomTaskRecoveryActionInputV1[];
} {
  const pending = [...actions];
  const claims: ClaimRoomTaskRecoveryActionInputV1[] = [];
  const completions: CompleteRoomTaskRecoveryActionInputV1[] = [];
  return {
    store: {
      claimNextRoomTaskRecoveryAction: async (input) => {
        claims.push(input);
        return pending.shift() ?? null;
      },
      completeRoomTaskRecoveryAction: async (input) => {
        completions.push(input);
        const action = actions.find((candidate) => candidate.id === input.actionId);
        if (!action) throw new Error(`Unknown action ${input.actionId}`);
        return {
          ...action,
          state: input.outcome === "processed" ? "processed" : "pending",
          claimToken: null,
          claimExpiresAt: null,
          claimedByWorkerId: null,
          claimedAt: null,
          resultPayload: input.resultPayload,
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
          processedAt: input.outcome === "processed" ? input.now : null,
        };
      },
    },
    claims,
    completions,
  };
}

describe("RoomTaskRecoveryActionProcessor", () => {
  it("fails closed without a consumer and releases only the claimed action for retry", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-unconfigured"),
      claimedAction("action-unrelated"),
    ]);
    const processor = new RoomTaskRecoveryActionProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      claimTtlMs: 45_000,
      retryDelayMs: 5_000,
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
      observeLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      roomId: ROOM_ID,
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 1,
      reachedMaxActions: false,
      stopped: false,
      stopReason: null,
    });
    expect(claims).toEqual([
      expect.objectContaining({
        roomId: ROOM_ID,
        workerId: WORKER_ID,
        claimTtlMs: 45_000,
        roomWorkerFence: {
          leaseId: "room-worker-lease-1",
          holderId: WORKER_ID,
          hostId: HOST_ID,
          expectedEpoch: 7,
        },
      }),
    ]);
    expect(completions).toEqual([
      expect.objectContaining({
        actionId: "action-unconfigured",
        outcome: "retry",
        resultPayload: null,
        errorCode: "room_task_recovery_action_consumer_unconfigured",
        retryAt: RETRY_AT,
        idempotencyKey: "room-task-recovery-complete:room-task-recovery:action-unconfigured:claim-token-action-unconfigured",
      }),
    ]);
  });

  it("marks processed only when the consumer returns a complete durable result receipt", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-receipt"),
    ]);
    const receipt = resultReceipt();
    const consumeAction = vi.fn(async () => receipt);
    const processor = new RoomTaskRecoveryActionProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      maxActions: 1,
      claimTtlMs: 30_000,
      consumeAction,
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 1,
      retriedActionCount: 0,
      reachedMaxActions: true,
      stopped: false,
    });
    expect(consumeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "action-receipt",
        claimToken: "claim-token-action-receipt",
      }),
      expect.objectContaining({
        roomId: ROOM_ID,
        workerId: WORKER_ID,
        hostId: HOST_ID,
        now: NOW,
      }),
    );
    expect(claims).toHaveLength(1);
    expect(completions).toEqual([
      expect.objectContaining({
        actionId: "action-receipt",
        outcome: "processed",
        resultPayload: receipt,
        errorCode: null,
        idempotencyKey: "room-task-recovery-complete:room-task-recovery:action-receipt:claim-token-action-receipt",
      }),
    ]);
  });

  it("retries rather than acknowledging an invalid recovery result", async () => {
    const { store, completions } = createStore([
      claimedAction("action-invalid-receipt"),
    ]);
    const processor = new RoomTaskRecoveryActionProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      consumeAction: async () => resultReceipt("operator_approval_requested"),
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 1,
      stopped: false,
    });
    expect(completions).toEqual([
      expect.objectContaining({
        actionId: "action-invalid-receipt",
        outcome: "retry",
        resultPayload: null,
        errorCode: "room_task_recovery_action_invalid_result",
        retryAt: RETRY_AT,
        idempotencyKey: "room-task-recovery-complete:room-task-recovery:action-invalid-receipt:claim-token-action-invalid-receipt",
      }),
    ]);
  });

  it("retries with a sanitized code when the consumer throws", async () => {
    const { store, completions } = createStore([
      claimedAction("action-throws"),
    ]);
    const processor = new RoomTaskRecoveryActionProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      consumeAction: async () => {
        throw new Error("provider secret=must-not-reach-durable-error-code");
      },
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 1,
      stopped: false,
    });
    expect(completions).toEqual([
      expect.objectContaining({
        actionId: "action-throws",
        outcome: "retry",
        errorCode: "room_task_recovery_action_failed",
        idempotencyKey: "room-task-recovery-complete:room-task-recovery:action-throws:claim-token-action-throws",
      }),
    ]);
    expect(JSON.stringify(completions[0])).not.toContain("must-not-reach-durable-error-code");
  });

  it("does not complete a claimed action after its Room-worker fence is revoked", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-fenced"),
    ]);
    let observations = 0;
    const processor = new RoomTaskRecoveryActionProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      consumeAction: async () => resultReceipt(),
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
      observeLease: async (lease) => {
        observations += 1;
        return observations === 1 ? lease : null;
      },
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 0,
      reachedMaxActions: false,
      stopped: true,
      stopReason: "fence_revoked",
    });
    expect(claims).toHaveLength(1);
    expect(completions).toHaveLength(0);
  });
});
