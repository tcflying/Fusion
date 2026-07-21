import {
  hashRoomValue,
  type RecordRoomTaskRecoveryPlanInputV1,
  type RoomTaskRecoveryActionV1,
  type RoomTaskRecoveryPlanV1,
} from "@fusion/core";
import type {
  RoomTaskRecoveryActionConsumer,
  RoomTaskRecoveryActionConsumerContextV1,
} from "./room-task-recovery-action-processor.js";

export interface RoomTaskRecoveryPlanStore {
  recordRoomTaskRecoveryPlan(
    input: RecordRoomTaskRecoveryPlanInputV1,
  ): Promise<RoomTaskRecoveryPlanV1>;
}

/**
 * The recovery processor supplies this only after it has claimed an action
 * under the current Room-worker lease. It is intentionally structural so this
 * consumer remains compatible with the processor's injected consumer seam.
 */
export type RoomTaskRecoveryActionConsumerContext = RoomTaskRecoveryActionConsumerContextV1;

export type RoomTaskRecoveryPlanConsumer = RoomTaskRecoveryActionConsumer;

export class RoomTaskRecoveryPlanConsumerError extends Error {
  readonly code:
    | "room_task_recovery_plan_invalid_action_context"
    | "room_task_recovery_plan_invalid_durable_plan";

  constructor(
    code: RoomTaskRecoveryPlanConsumerError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RoomTaskRecoveryPlanConsumerError";
    this.code = code;
  }
}

type ClaimedRoomTaskRecoveryAction = RoomTaskRecoveryActionV1 & {
  readonly state: "claimed";
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly claimedByWorkerId: string;
};

/**
 * FNXC:SessionRoomTaskRecoveryPlanConsumer 2026-07-19-09:27:
 * A claimed no-progress action may produce only Core's fenced, provider-free
 * recovery-plan handoff. The idempotency key names the immutable action rather
 * than its replaceable claim token, and this consumer never creates an
 * ApprovalRequest or invokes a provider directly.
 */
export function createRoomTaskRecoveryPlanConsumer(
  store: RoomTaskRecoveryPlanStore,
): RoomTaskRecoveryPlanConsumer {
  if (!store || typeof store.recordRoomTaskRecoveryPlan !== "function") {
    throw new Error("Room task recovery plan consumer requires recordRoomTaskRecoveryPlan");
  }

  return async (action, context) => {
    assertActionContextAlignment(action, context);
    const plan = await store.recordRoomTaskRecoveryPlan({
      roomId: action.roomId,
      roomWorkerFence: {
        leaseId: context.roomWorkerFence.leaseId,
        holderId: context.roomWorkerFence.holderId,
        hostId: context.roomWorkerFence.hostId,
        expectedEpoch: context.roomWorkerFence.expectedEpoch,
      },
      recoveryActionId: action.id,
      claimToken: action.claimToken,
      idempotencyKey: recoveryPlanIdempotencyKey(action),
      now: context.now,
    });
    assertDurablePlan(plan, action);

    return Object.freeze({
      contractVersion: plan.resultReceipt.contractVersion,
      kind: plan.resultReceipt.kind,
      receiptRef: plan.resultReceipt.receiptRef,
      resultHash: plan.resultReceipt.resultHash,
    });
  };
}

function assertActionContextAlignment(
  action: RoomTaskRecoveryActionV1,
  context: RoomTaskRecoveryActionConsumerContext,
): asserts action is ClaimedRoomTaskRecoveryAction {
  const rawAction: unknown = action;
  const rawContext: unknown = context;
  if (!isRecord(rawAction) || !isRecord(rawContext)) {
    throw invalidActionContext();
  }
  const fence = rawContext.roomWorkerFence;
  const snapshot = rawAction.actionSnapshot;
  if (
    !isNonBlankString(rawAction.id)
    || !isNonBlankString(rawAction.roomId)
    || !isNonBlankString(rawAction.nodeId)
    || !isPositiveSafeInteger(rawAction.nodeVersion)
    || !isNonBlankString(rawAction.observationId)
    || !isNonBlankString(rawAction.actionId)
    || rawAction.state !== "claimed"
    || !isNonBlankString(rawAction.claimToken)
    || !isCanonicalUtcIsoTimestamp(rawAction.claimExpiresAt)
    || !isNonBlankString(rawAction.claimedByWorkerId)
    || !isRecord(snapshot)
    || snapshot.contractVersion !== "room-task-no-progress-recovery-action/v1"
    || !isNonBlankString(snapshot.nodeId)
    || !isPositiveSafeInteger(snapshot.nodeVersion)
    || !isNonBlankString(snapshot.observationId)
    || !isRecord(snapshot.recoveryAction)
    || !isNonBlankString(snapshot.recoveryAction.id)
    || !isNonBlankString(snapshot.recoveryActionHash)
    || snapshot.recoveryActionHash !== hashRoomValue(snapshot.recoveryAction)
    || !(snapshot.executionMode === "controller_plan" || snapshot.executionMode === "operator_approval")
    || !isNonBlankString(rawContext.roomId)
    || !isNonBlankString(rawContext.workerId)
    || !isNonBlankString(rawContext.hostId)
    || !isCanonicalUtcIsoTimestamp(rawContext.now)
    || !isRoomWorkerFence(fence)
    || rawAction.roomId !== rawContext.roomId
    || rawAction.claimedByWorkerId !== rawContext.workerId
    || fence.holderId !== rawContext.workerId
    || fence.hostId !== rawContext.hostId
    || snapshot.nodeId !== rawAction.nodeId
    || snapshot.nodeVersion !== rawAction.nodeVersion
    || snapshot.observationId !== rawAction.observationId
    || snapshot.recoveryAction.id !== rawAction.actionId
    || Date.parse(rawAction.claimExpiresAt) <= Date.parse(rawContext.now)
  ) {
    throw invalidActionContext();
  }
}

function assertDurablePlan(
  plan: RoomTaskRecoveryPlanV1,
  action: ClaimedRoomTaskRecoveryAction,
): void {
  const rawPlan: unknown = plan;
  const expectedPlanId = `room-task-recovery-plan:${action.id}`;
  const expectedKind = action.actionSnapshot.executionMode === "controller_plan"
    ? "controller_plan_submitted"
    : "operator_approval_requested";
  if (!isRecord(rawPlan) || !isRecord(rawPlan.resultReceipt) || !isRecord(rawPlan.actionSnapshot)) {
    throw invalidDurablePlan();
  }
  const receipt = rawPlan.resultReceipt;
  if (
    rawPlan.contractVersion !== "room-task-recovery-plan/v1"
    || rawPlan.id !== expectedPlanId
    || rawPlan.roomId !== action.roomId
    || rawPlan.recoveryActionId !== action.id
    || rawPlan.executionMode !== action.actionSnapshot.executionMode
    || !isCanonicalUtcIsoTimestamp(rawPlan.createdAt)
    || !isNonBlankString(rawPlan.actionSnapshotHash)
    || rawPlan.actionSnapshotHash !== hashRoomValue(action.actionSnapshot)
    || rawPlan.actionSnapshotHash !== hashRoomValue(rawPlan.actionSnapshot)
    || !hasExactObjectKeys(receipt, ["contractVersion", "kind", "receiptRef", "resultHash"])
    || receipt.contractVersion !== "room-task-recovery-action-result/v1"
    || receipt.kind !== expectedKind
    || receipt.receiptRef !== expectedPlanId
    || !isNonBlankString(receipt.resultHash)
    || receipt.resultHash !== hashRoomValue({
      contractVersion: receipt.contractVersion,
      kind: receipt.kind,
      receiptRef: receipt.receiptRef,
    })
  ) {
    throw invalidDurablePlan();
  }
}

function recoveryPlanIdempotencyKey(action: ClaimedRoomTaskRecoveryAction): string {
  return `room-task-recovery-plan:${action.roomId}:${action.id}`;
}

function invalidActionContext(): RoomTaskRecoveryPlanConsumerError {
  return new RoomTaskRecoveryPlanConsumerError(
    "room_task_recovery_plan_invalid_action_context",
    "Room task recovery plan consumer requires an aligned current claimed action and worker context",
  );
}

function invalidDurablePlan(): RoomTaskRecoveryPlanConsumerError {
  return new RoomTaskRecoveryPlanConsumerError(
    "room_task_recovery_plan_invalid_durable_plan",
    "Core returned a recovery plan that does not match the claimed action",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRoomWorkerFence(
  value: unknown,
): value is RecordRoomTaskRecoveryPlanInputV1["roomWorkerFence"] {
  return isRecord(value)
    && hasExactObjectKeys(value, ["leaseId", "holderId", "hostId", "expectedEpoch"])
    && isNonBlankString(value.leaseId)
    && isNonBlankString(value.holderId)
    && isNonBlankString(value.hostId)
    && isPositiveSafeInteger(value.expectedEpoch);
}
