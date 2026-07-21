import { describe, expect, it, vi } from "vitest";
import {
  hashRoomValue,
  type RecordRoomTaskRecoveryPlanInputV1,
  type RoomTaskRecoveryActionV1,
  type RoomTaskRecoveryPlanV1,
} from "@fusion/core";

import {
  RoomTaskRecoveryPlanConsumerError,
  createRoomTaskRecoveryPlanConsumer,
  type RoomTaskRecoveryActionConsumerContext,
  type RoomTaskRecoveryPlanStore,
} from "../room-task-recovery-plan-consumer.js";

const ROOM_ID = "room-task-recovery";
const WORKER_ID = "room-worker-1";
const HOST_ID = "host-controller";
const NOW = "2026-07-19T02:00:00.000Z";

function claimedAction(
  executionMode: "controller_plan" | "operator_approval" = "controller_plan",
): RoomTaskRecoveryActionV1 {
  const recoveryAction = {
    id: executionMode === "controller_plan" ? "replace-participant" : "request-operator",
  } as RoomTaskRecoveryActionV1["actionSnapshot"]["recoveryAction"];
  const actionSnapshot = {
    contractVersion: "room-task-no-progress-recovery-action/v1",
    protocolId: "implementation",
    protocolVersion: 1,
    turnId: "turn-1",
    phaseId: "phase-1",
    nodeId: "node-1",
    nodeVersion: 3,
    observationId: "observation-1",
    recoveryAction,
    recoveryActionHash: hashRoomValue(recoveryAction),
    ladderOrder: 1,
    minimumConsecutiveUnchangedRounds: 2,
    executionMode,
  } as RoomTaskRecoveryActionV1["actionSnapshot"];

  return {
    id: "recovery-action-1",
    roomId: ROOM_ID,
    nodeId: "node-1",
    nodeVersion: 3,
    observationId: "observation-1",
    actionId: recoveryAction.id,
    actionSnapshot,
    policySnapshot: {} as RoomTaskRecoveryActionV1["policySnapshot"],
    state: "claimed",
    attemptCount: 1,
    claimToken: "claim-token-1",
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

function consumerContext(
  overrides: Partial<RoomTaskRecoveryActionConsumerContext> = {},
): RoomTaskRecoveryActionConsumerContext {
  return {
    roomId: ROOM_ID,
    roomWorkerFence: {
      leaseId: "room-worker-lease-1",
      holderId: WORKER_ID,
      hostId: HOST_ID,
      expectedEpoch: 7,
    },
    workerId: WORKER_ID,
    hostId: HOST_ID,
    now: NOW,
    ...overrides,
  };
}

function durablePlan(action: RoomTaskRecoveryActionV1): RoomTaskRecoveryPlanV1 {
  const id = `room-task-recovery-plan:${action.id}`;
  const kind = action.actionSnapshot.executionMode === "controller_plan"
    ? "controller_plan_submitted"
    : "operator_approval_requested";
  const resultReceipt = {
    contractVersion: "room-task-recovery-action-result/v1" as const,
    kind,
    receiptRef: id,
    resultHash: hashRoomValue({
      contractVersion: "room-task-recovery-action-result/v1",
      kind,
      receiptRef: id,
    }),
  };
  return {
    contractVersion: "room-task-recovery-plan/v1",
    id,
    roomId: action.roomId,
    recoveryActionId: action.id,
    executionMode: action.actionSnapshot.executionMode,
    actionSnapshot: structuredClone(action.actionSnapshot),
    actionSnapshotHash: hashRoomValue(action.actionSnapshot),
    resultReceipt,
    createdAt: NOW,
  };
}

function coreLikeStore(plan: RoomTaskRecoveryPlanV1): {
  readonly store: RoomTaskRecoveryPlanStore;
  readonly recordRoomTaskRecoveryPlan: ReturnType<typeof vi.fn>;
  readonly invokeProvider: ReturnType<typeof vi.fn>;
  readonly createApprovalRequest: ReturnType<typeof vi.fn>;
} {
  const recordRoomTaskRecoveryPlan = vi.fn(async (
    _input: RecordRoomTaskRecoveryPlanInputV1,
  ) => plan);
  const invokeProvider = vi.fn();
  const createApprovalRequest = vi.fn();
  return {
    store: {
      recordRoomTaskRecoveryPlan,
    },
    recordRoomTaskRecoveryPlan,
    invokeProvider,
    createApprovalRequest,
  };
}

describe("createRoomTaskRecoveryPlanConsumer", () => {
  it.each([
    ["controller_plan", "controller_plan_submitted"],
    ["operator_approval", "operator_approval_requested"],
  ] as const)("records a %s action and returns its exact %s durable receipt", async (
    executionMode,
    expectedKind,
  ) => {
    const action = claimedAction(executionMode);
    const plan = durablePlan(action);
    const core = coreLikeStore(plan);
    const consume = createRoomTaskRecoveryPlanConsumer(core.store);

    const receipt = await consume(action, consumerContext());

    expect(core.recordRoomTaskRecoveryPlan).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      roomWorkerFence: {
        leaseId: "room-worker-lease-1",
        holderId: WORKER_ID,
        hostId: HOST_ID,
        expectedEpoch: 7,
      },
      recoveryActionId: action.id,
      claimToken: action.claimToken,
      idempotencyKey: "room-task-recovery-plan:room-task-recovery:recovery-action-1",
      now: NOW,
    });
    expect(receipt).toEqual({
      contractVersion: "room-task-recovery-action-result/v1",
      kind: expectedKind,
      receiptRef: plan.id,
      resultHash: hashRoomValue({
        contractVersion: "room-task-recovery-action-result/v1",
        kind: expectedKind,
        receiptRef: plan.id,
      }),
    });
    expect(receipt).toEqual(plan.resultReceipt);
    expect(core.invokeProvider).not.toHaveBeenCalled();
    expect(core.createApprovalRequest).not.toHaveBeenCalled();
  });

  it("uses an action-identity idempotency key across a replaced claim", async () => {
    const action = claimedAction();
    const replacement = {
      ...action,
      claimToken: "claim-token-replaced",
      claimedAt: "2026-07-19T02:01:00.000Z",
      claimExpiresAt: "2026-07-19T02:06:00.000Z",
    } as RoomTaskRecoveryActionV1;
    const core = coreLikeStore(durablePlan(action));
    const consume = createRoomTaskRecoveryPlanConsumer(core.store);

    await consume(action, consumerContext());
    await consume(replacement, consumerContext());

    const inputs = core.recordRoomTaskRecoveryPlan.mock.calls
      .map(([input]) => input as RecordRoomTaskRecoveryPlanInputV1);
    expect(inputs.map((input) => input.idempotencyKey)).toEqual([
      "room-task-recovery-plan:room-task-recovery:recovery-action-1",
      "room-task-recovery-plan:room-task-recovery:recovery-action-1",
    ]);
    expect(inputs.map((input) => input.claimToken)).toEqual([
      "claim-token-1",
      "claim-token-replaced",
    ]);
  });

  it("fails closed before Core for forged actions or mismatched consumer context", async () => {
    const action = claimedAction();
    const core = coreLikeStore(durablePlan(action));
    const consume = createRoomTaskRecoveryPlanConsumer(core.store);
    const cases: ReadonlyArray<{
      readonly action: RoomTaskRecoveryActionV1;
      readonly context: RoomTaskRecoveryActionConsumerContext;
    }> = [
      {
        action: { ...action, state: "pending" } as RoomTaskRecoveryActionV1,
        context: consumerContext(),
      },
      {
        action: {
          ...action,
          actionSnapshot: { ...action.actionSnapshot, nodeId: "forged-node" },
        } as RoomTaskRecoveryActionV1,
        context: consumerContext(),
      },
      {
        action,
        context: consumerContext({ roomId: "other-room" }),
      },
      {
        action: { ...action, claimedByWorkerId: "other-worker" } as RoomTaskRecoveryActionV1,
        context: consumerContext(),
      },
      {
        action,
        context: consumerContext({
          roomWorkerFence: {
            ...consumerContext().roomWorkerFence,
            holderId: "other-worker",
          },
        }),
      },
    ];

    for (const candidate of cases) {
      await expect(consume(candidate.action, candidate.context)).rejects.toBeInstanceOf(
        RoomTaskRecoveryPlanConsumerError,
      );
    }

    expect(core.recordRoomTaskRecoveryPlan).not.toHaveBeenCalled();
  });
});
