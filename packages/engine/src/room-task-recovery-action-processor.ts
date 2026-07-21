import {
  DEFAULT_ROOM_TASK_RECOVERY_ACTION_CLAIM_TTL_MS,
  hashRoomValue,
  type ClaimRoomTaskRecoveryActionInputV1,
  type CompleteRoomTaskRecoveryActionInputV1,
  type RoomTaskRecoveryActionResultV1,
  type RoomTaskRecoveryActionV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

export const DEFAULT_ROOM_TASK_RECOVERY_ACTION_MAX_ACTIONS = 8;
export const DEFAULT_ROOM_TASK_RECOVERY_ACTION_RETRY_DELAY_MS = 5_000;

export interface RoomTaskRecoveryActionStore {
  claimNextRoomTaskRecoveryAction(
    input: ClaimRoomTaskRecoveryActionInputV1,
  ): Promise<RoomTaskRecoveryActionV1 | null>;
  completeRoomTaskRecoveryAction(
    input: CompleteRoomTaskRecoveryActionInputV1,
  ): Promise<RoomTaskRecoveryActionV1>;
}

/**
 * The consumer is deliberately an explicit, backend-local handoff seam. It
 * must not perform a provider call: a successful result is only a durable
 * controller-plan, approval, or supersession receipt that Core can audit.
 */
export type RoomTaskRecoveryActionConsumer = (
  action: RoomTaskRecoveryActionV1,
  context: RoomTaskRecoveryActionConsumerContextV1,
) => RoomTaskRecoveryActionResultV1 | Promise<RoomTaskRecoveryActionResultV1>;

/**
 * Bound to the exact lease that owns the current claim. Consumers use this
 * context only to persist a provider-free controller-plan/approval handoff;
 * they cannot infer or mint a broader authority from a message payload.
 */
export interface RoomTaskRecoveryActionConsumerContextV1 {
  readonly roomId: string;
  readonly roomWorkerFence: ClaimRoomTaskRecoveryActionInputV1["roomWorkerFence"];
  readonly workerId: string;
  readonly hostId: string;
  readonly now: string;
}

export interface RoomTaskRecoveryActionProcessorOptions {
  readonly workerId: string;
  readonly hostId: string;
  readonly store: RoomTaskRecoveryActionStore;
  readonly now?: () => string;
  /** Bounds one pass so recovery work cannot starve independent Room work. */
  readonly maxActions?: number;
  /** Passed to Core on every claim; Core binds the resulting claim expiry. */
  readonly claimTtlMs?: number;
  /** Bounded local delay before a failed action becomes eligible again. */
  readonly retryDelayMs?: number;
  readonly consumeAction?: RoomTaskRecoveryActionConsumer;
}

export interface ProcessRoomTaskRecoveryActionsInput {
  readonly roomId: string;
  /** The current Room-worker lease is the only authority accepted by Core. */
  readonly lease: StoredRoomLeaseV1;
  /** Refreshes the fence immediately before each durable claim/completion. */
  readonly renewLease: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /** Optional post-renewal observation catches an external takeover before mutation. */
  readonly observeLease?: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /** Stops a draining pass without another durable write when the controller ends. */
  readonly canContinue?: () => boolean;
}

export type RoomTaskRecoveryActionStopReason = "controller_stopped" | "fence_revoked";

export interface RoomTaskRecoveryActionProcessSummary {
  readonly roomId: string;
  /** Last lease proven current before this pass returned. */
  readonly lease: StoredRoomLeaseV1;
  readonly claimedActionCount: number;
  readonly processedActionCount: number;
  readonly retriedActionCount: number;
  readonly reachedMaxActions: boolean;
  readonly stopped: boolean;
  readonly stopReason: RoomTaskRecoveryActionStopReason | null;
}

export class RoomTaskRecoveryActionProcessorError extends Error {
  readonly code:
    | "room_task_recovery_action_invalid_worker_lease"
    | "room_task_recovery_action_invalid_claim"
    | "room_task_recovery_action_invalid_clock"
    | "room_task_recovery_action_consumer_unconfigured"
    | "room_task_recovery_action_invalid_result";

  constructor(
    code: RoomTaskRecoveryActionProcessorError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RoomTaskRecoveryActionProcessorError";
    this.code = code;
  }
}

/**
 * FNXC:SessionRoomTaskRecoveryActionProcessor 2026-07-19:
 * The Core ledger has already determined that a recovery action is due before
 * this processor sees it. This component is a bounded, fence-aware coordinator
 * only: it does not create Sessions, choose providers, or invoke a model. A
 * durable `processed` transition is permitted solely after the pluggable
 * consumer returns an independently addressable, integrity-checked receipt.
 */
export class RoomTaskRecoveryActionProcessor {
  private readonly now: () => string;
  private readonly maxActions: number;
  private readonly claimTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly consumeAction: RoomTaskRecoveryActionConsumer | null;

  constructor(private readonly options: RoomTaskRecoveryActionProcessorOptions) {
    if (!options.workerId.trim() || !options.hostId.trim()) {
      throw new Error("RoomTaskRecoveryActionProcessor workerId and hostId are required");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxActions = positiveInteger(
      options.maxActions ?? DEFAULT_ROOM_TASK_RECOVERY_ACTION_MAX_ACTIONS,
      "maxActions",
    );
    this.claimTtlMs = positiveInteger(
      options.claimTtlMs ?? DEFAULT_ROOM_TASK_RECOVERY_ACTION_CLAIM_TTL_MS,
      "claimTtlMs",
    );
    this.retryDelayMs = positiveInteger(
      options.retryDelayMs ?? DEFAULT_ROOM_TASK_RECOVERY_ACTION_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    this.consumeAction = options.consumeAction ?? null;
  }

  async process(
    input: ProcessRoomTaskRecoveryActionsInput,
  ): Promise<RoomTaskRecoveryActionProcessSummary> {
    this.assertWorkerLease(input.roomId, input.lease);

    let activeLease = input.lease;
    let stopReason: RoomTaskRecoveryActionStopReason | null = null;
    let claimedActionCount = 0;
    let processedActionCount = 0;
    let retriedActionCount = 0;

    while (claimedActionCount < this.maxActions) {
      const refreshed = await this.refreshLease(input, activeLease);
      if (!refreshed.ok) {
        stopReason = refreshed.reason;
        break;
      }
      activeLease = refreshed.lease;

      let action: RoomTaskRecoveryActionV1 | null;
      try {
        action = await this.options.store.claimNextRoomTaskRecoveryAction({
          roomId: input.roomId,
          roomWorkerFence: roomWorkerFence(activeLease),
          workerId: this.options.workerId,
          claimTtlMs: this.claimTtlMs,
          now: this.currentTime(),
        });
      } catch (error) {
        const reason = stopReasonFor(error);
        if (!reason) throw error;
        stopReason = reason;
        break;
      }
      if (!action) break;

      this.assertClaimedAction(input.roomId, action);
      claimedActionCount += 1;

      const completion = await this.prepareCompletion(action, {
        roomId: input.roomId,
        roomWorkerFence: roomWorkerFence(activeLease),
        workerId: this.options.workerId,
        hostId: this.options.hostId,
        now: this.currentTime(),
      });
      if (completion.stopReason) {
        stopReason = completion.stopReason;
        break;
      }

      const refreshedBeforeCompletion = await this.refreshLease(input, activeLease);
      if (!refreshedBeforeCompletion.ok) {
        stopReason = refreshedBeforeCompletion.reason;
        break;
      }
      activeLease = refreshedBeforeCompletion.lease;

      try {
        await this.options.store.completeRoomTaskRecoveryAction({
          roomId: input.roomId,
          roomWorkerFence: roomWorkerFence(activeLease),
          actionId: action.id,
          claimToken: action.claimToken,
          idempotencyKey: completionIdempotencyKey(input.roomId, action.id, action.claimToken),
          outcome: completion.outcome,
          resultPayload: completion.resultPayload,
          errorCode: completion.errorCode,
          ...(completion.retryAt ? { retryAt: completion.retryAt } : {}),
          now: this.currentTime(),
        });
      } catch (error) {
        const reason = stopReasonFor(error);
        if (!reason) throw error;
        stopReason = reason;
        break;
      }

      if (completion.outcome === "processed") {
        processedActionCount += 1;
      } else {
        retriedActionCount += 1;
        // The retry action becomes immediately pending again. End the pass so
        // it cannot consume the complete recovery budget before a new reconcile.
        break;
      }
    }

    return Object.freeze({
      roomId: input.roomId,
      lease: activeLease,
      claimedActionCount,
      processedActionCount,
      retriedActionCount,
      reachedMaxActions: claimedActionCount === this.maxActions,
      stopped: stopReason !== null,
      stopReason,
    });
  }

  private async prepareCompletion(
    action: RoomTaskRecoveryActionV1 & { readonly claimToken: string },
    context: RoomTaskRecoveryActionConsumerContextV1,
  ): Promise<
    | {
        readonly stopReason: RoomTaskRecoveryActionStopReason;
        readonly outcome: "retry";
        readonly resultPayload: null;
        readonly errorCode: null;
        readonly retryAt: null;
      }
    | {
        readonly stopReason: null;
        readonly outcome: "processed" | "retry";
        readonly resultPayload: RoomTaskRecoveryActionResultV1 | null;
        readonly errorCode: string | null;
        readonly retryAt: string | null;
      }
  > {
    try {
      const result = await this.consumeRecoveryAction(action, context);
      if (!isRoomTaskRecoveryActionResult(result, action)) {
        throw new RoomTaskRecoveryActionProcessorError(
          "room_task_recovery_action_invalid_result",
          `Recovery action ${action.id} consumer returned an invalid result receipt`,
        );
      }
      return {
        stopReason: null,
        outcome: "processed",
        resultPayload: result,
        errorCode: null,
        retryAt: null,
      };
    } catch (error) {
      const stopReason = stopReasonFor(error);
      if (stopReason) {
        return {
          stopReason,
          outcome: "retry",
          resultPayload: null,
          errorCode: null,
          retryAt: null,
        };
      }
      return {
        stopReason: null,
        outcome: "retry",
        resultPayload: null,
        errorCode: actionFailureCodeFor(error),
        retryAt: retryAt(this.currentTime(), this.retryDelayMs),
      };
    }
  }

  private async consumeRecoveryAction(
    action: RoomTaskRecoveryActionV1,
    context: RoomTaskRecoveryActionConsumerContextV1,
  ): Promise<RoomTaskRecoveryActionResultV1> {
    if (!this.consumeAction) {
      throw new RoomTaskRecoveryActionProcessorError(
        "room_task_recovery_action_consumer_unconfigured",
        "Room task recovery action cannot complete without a configured consumer",
      );
    }
    return this.consumeAction(action, context);
  }

  private async refreshLease(
    input: ProcessRoomTaskRecoveryActionsInput,
    lease: StoredRoomLeaseV1,
  ): Promise<
    | { readonly ok: true; readonly lease: StoredRoomLeaseV1 }
    | { readonly ok: false; readonly reason: RoomTaskRecoveryActionStopReason }
  > {
    if (!(input.canContinue?.() ?? true)) {
      return { ok: false, reason: "controller_stopped" };
    }

    let renewed: StoredRoomLeaseV1 | null;
    try {
      renewed = await input.renewLease(lease);
    } catch (error) {
      const reason = stopReasonFor(error);
      if (!reason) throw error;
      return { ok: false, reason };
    }
    if (!renewed) return { ok: false, reason: "fence_revoked" };
    this.assertWorkerLease(input.roomId, renewed);
    if (!(input.canContinue?.() ?? true)) {
      return { ok: false, reason: "controller_stopped" };
    }

    if (!input.observeLease) return { ok: true, lease: renewed };
    let observed: StoredRoomLeaseV1 | null;
    try {
      observed = await input.observeLease(renewed);
    } catch (error) {
      const reason = stopReasonFor(error);
      if (!reason) throw error;
      return { ok: false, reason };
    }
    if (!observed) return { ok: false, reason: "fence_revoked" };
    this.assertWorkerLease(input.roomId, observed);
    if (!(input.canContinue?.() ?? true)) {
      return { ok: false, reason: "controller_stopped" };
    }
    return { ok: true, lease: observed };
  }

  private assertWorkerLease(roomId: string, lease: StoredRoomLeaseV1): void {
    if (
      lease.kind !== "room_worker"
      || lease.roomId !== roomId
      || lease.resourceId !== roomId
      || lease.holderId !== this.options.workerId
      || lease.hostId !== this.options.hostId
      || lease.releasedAt !== null
    ) {
      throw new RoomTaskRecoveryActionProcessorError(
        "room_task_recovery_action_invalid_worker_lease",
        `Room task recovery action processor requires the current room-worker lease for ${roomId}`,
      );
    }
  }

  private assertClaimedAction(
    roomId: string,
    action: RoomTaskRecoveryActionV1,
  ): asserts action is RoomTaskRecoveryActionV1 & { readonly claimToken: string } {
    if (
      action.roomId !== roomId
      || action.state !== "claimed"
      || action.claimedByWorkerId !== this.options.workerId
      || !isNonBlankString(action.claimToken)
      || !isCanonicalUtcIsoTimestamp(action.claimExpiresAt)
      || !isCanonicalUtcIsoTimestamp(action.claimedAt)
      || Date.parse(action.claimExpiresAt) <= Date.parse(this.currentTime())
    ) {
      throw new RoomTaskRecoveryActionProcessorError(
        "room_task_recovery_action_invalid_claim",
        `Room task recovery processor received an invalid claimed action for ${roomId}`,
      );
    }
  }

  private currentTime(): string {
    const now = this.now();
    if (!isCanonicalUtcIsoTimestamp(now)) {
      throw new RoomTaskRecoveryActionProcessorError(
        "room_task_recovery_action_invalid_clock",
        "Room task recovery action processor clock must return a canonical UTC ISO timestamp",
      );
    }
    return now;
  }
}

function roomWorkerFence(
  lease: StoredRoomLeaseV1,
): ClaimRoomTaskRecoveryActionInputV1["roomWorkerFence"] {
  return {
    leaseId: lease.id,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

function completionIdempotencyKey(roomId: string, actionId: string, claimToken: string): string {
  return `room-task-recovery-complete:${roomId}:${actionId}:${claimToken}`;
}

function retryAt(now: string, retryDelayMs: number): string {
  return new Date(Date.parse(now) + retryDelayMs).toISOString();
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomTaskRecoveryActionProcessor ${field} must be a positive safe integer`);
  }
  return value;
}

function isRoomTaskRecoveryActionResult(
  value: unknown,
  action: RoomTaskRecoveryActionV1,
): value is RoomTaskRecoveryActionResultV1 {
  if (
    !isRecord(value)
    || !hasExactObjectKeys(value, ["contractVersion", "kind", "receiptRef", "resultHash"])
    || value.contractVersion !== "room-task-recovery-action-result/v1"
    || !(
      value.kind === "controller_plan_submitted"
      || value.kind === "operator_approval_requested"
      || value.kind === "superseded"
    )
    || !isNonBlankString(value.receiptRef)
    || !isNonBlankString(value.resultHash)
  ) {
    return false;
  }
  if (
    (value.kind === "controller_plan_submitted" && action.actionSnapshot.executionMode !== "controller_plan")
    || (value.kind === "operator_approval_requested" && action.actionSnapshot.executionMode !== "operator_approval")
  ) {
    return false;
  }
  return value.resultHash === hashRoomValue({
    contractVersion: value.contractVersion,
    kind: value.kind,
    receiptRef: value.receiptRef,
  });
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

function isCanonicalUtcIsoTimestamp(value: string | null): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function stopReasonFor(error: unknown): RoomTaskRecoveryActionStopReason | null {
  if (hasErrorCode(error, "stale_lease_fence") || hasErrorCode(error, "room_worker_authority_revoked")) {
    return "fence_revoked";
  }
  return error instanceof Error && error.name === "AbortError" ? "controller_stopped" : null;
}

function actionFailureCodeFor(error: unknown): string {
  if (!(error instanceof RoomTaskRecoveryActionProcessorError)) {
    return "room_task_recovery_action_failed";
  }
  if (error.code === "room_task_recovery_action_consumer_unconfigured") {
    return "room_task_recovery_action_consumer_unconfigured";
  }
  if (error.code === "room_task_recovery_action_invalid_result") {
    return "room_task_recovery_action_invalid_result";
  }
  return "room_task_recovery_action_failed";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
