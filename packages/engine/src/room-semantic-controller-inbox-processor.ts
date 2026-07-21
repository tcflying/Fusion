import type {
  ClaimRoomSemanticControllerActionInputV1,
  CompleteRoomSemanticControllerActionInputV1,
  RoomSemanticControllerActionV1,
  StoredRoomLeaseV1,
} from "@fusion/core";

export const DEFAULT_ROOM_SEMANTIC_CONTROLLER_INBOX_MAX_ACTIONS = 16;

const ACTION_LOCAL_FAILURE_CODE = "semantic_controller_action_failed";
const ACTION_CONSUMER_UNCONFIGURED_FAILURE_CODE = "semantic_controller_action_consumer_unconfigured";

type RoomSemanticControllerActionKind = RoomSemanticControllerActionV1["actionKind"];

export interface RoomSemanticControllerInboxStore {
  claimNextRoomSemanticControllerAction(
    input: ClaimRoomSemanticControllerActionInputV1,
  ): Promise<RoomSemanticControllerActionV1 | null>;
  completeRoomSemanticControllerAction(
    input: CompleteRoomSemanticControllerActionInputV1,
  ): Promise<RoomSemanticControllerActionV1>;
}

export interface RoomSemanticControllerInboxProcessorOptions {
  readonly workerId: string;
  readonly hostId: string;
  readonly store: RoomSemanticControllerInboxStore;
  readonly now?: () => string;
  /** Bounds one controller pass so other Room work cannot be starved. */
  readonly maxActions?: number;
  /**
   * Backend-local semantic preparation seam. It must not deliver to a provider
   * or perform another external effect; the durable completion below is the
   * only success acknowledgement owned by this processor. If it is absent,
   * claimed actions fail closed and are durably returned to pending.
   */
  readonly consumeAction?: (action: RoomSemanticControllerActionV1) => void | Promise<void>;
}

export interface ProcessRoomSemanticControllerInboxInput {
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  /**
   * Called immediately before every claim and completion. It may return null
   * when the controller can no longer renew its Room-worker fence.
   */
  readonly renewLease: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /**
   * Optional current-fence observation after renewal. A null result means an
   * external takeover/revocation won before the pending durable mutation.
   */
  readonly observeLease?: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /** Controller lifecycle guard; false stops without another durable write. */
  readonly canContinue?: () => boolean;
}

export type RoomSemanticControllerInboxStopReason = "controller_stopped" | "fence_revoked";

export interface RoomSemanticControllerInboxProcessSummary {
  readonly roomId: string;
  /** Last lease proven current before this pass returned. */
  readonly lease: StoredRoomLeaseV1;
  readonly claimedActionCount: number;
  readonly processedActionCount: number;
  readonly retriedActionCount: number;
  readonly processedActionKinds: Readonly<Record<RoomSemanticControllerActionKind, number>>;
  readonly retriedActionKinds: Readonly<Record<RoomSemanticControllerActionKind, number>>;
  /** True only when this pass consumed its own configured work budget. */
  readonly reachedMaxActions: boolean;
  readonly stopped: boolean;
  readonly stopReason: RoomSemanticControllerInboxStopReason | null;
}

export class RoomSemanticControllerInboxProcessorError extends Error {
  readonly code:
    | "room_semantic_controller_invalid_worker_lease"
    | "room_semantic_controller_invalid_claim"
    | "room_semantic_controller_invalid_clock"
    | "room_semantic_controller_action_consumer_unconfigured";

  constructor(
    code: RoomSemanticControllerInboxProcessorError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RoomSemanticControllerInboxProcessorError";
    this.code = code;
  }
}

/**
 * FNXC:SessionRoomSemanticControllerInbox 2026-07-19:
 * Semantic routing has already committed the controller-directed intent before
 * this processor sees it. Therefore this component never sends to a provider:
 * its only successful effect is a fenced durable `processed` acknowledgement.
 * Every claim and completion refreshes then observes the Room-worker fence so
 * a stopped or taken-over controller leaves an unfinished claim reclaimable.
 */
export class RoomSemanticControllerInboxProcessor {
  private readonly now: () => string;
  private readonly maxActions: number;
  private readonly consumeAction: ((action: RoomSemanticControllerActionV1) => void | Promise<void>) | null;

  constructor(private readonly options: RoomSemanticControllerInboxProcessorOptions) {
    if (!options.workerId.trim() || !options.hostId.trim()) {
      throw new Error("RoomSemanticControllerInboxProcessor workerId and hostId are required");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxActions = positiveInteger(
      options.maxActions ?? DEFAULT_ROOM_SEMANTIC_CONTROLLER_INBOX_MAX_ACTIONS,
      "maxActions",
    );
    this.consumeAction = options.consumeAction ?? null;
  }

  async process(
    input: ProcessRoomSemanticControllerInboxInput,
  ): Promise<RoomSemanticControllerInboxProcessSummary> {
    this.assertWorkerLease(input.roomId, input.lease);

    let activeLease = input.lease;
    let stopReason: RoomSemanticControllerInboxStopReason | null = null;
    let claimedActionCount = 0;
    let processedActionCount = 0;
    let retriedActionCount = 0;
    const processedActionKinds = emptyActionKindCounts();
    const retriedActionKinds = emptyActionKindCounts();

    while (claimedActionCount < this.maxActions) {
      const refreshed = await this.refreshLease(input, activeLease);
      if (!refreshed.ok) {
        stopReason = refreshed.reason;
        break;
      }
      activeLease = refreshed.lease;

      let action: RoomSemanticControllerActionV1 | null;
      try {
        action = await this.options.store.claimNextRoomSemanticControllerAction({
          roomId: input.roomId,
          roomWorkerFence: roomWorkerFence(activeLease),
          workerId: this.options.workerId,
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

      let outcome: CompleteRoomSemanticControllerActionInputV1["outcome"] = "processed";
      let errorCode: string | null = null;
      try {
        await this.consumeSupportedAction(action);
      } catch (error) {
        const reason = stopReasonFor(error);
        if (reason) {
          stopReason = reason;
          break;
        }
        // Do not persist arbitrary exception text: it can contain connector,
        // provider, or user-controlled data. The fixed code is safe to audit.
        outcome = "retry";
        errorCode = actionFailureCodeFor(error);
      }

      const refreshedBeforeCompletion = await this.refreshLease(input, activeLease);
      if (!refreshedBeforeCompletion.ok) {
        stopReason = refreshedBeforeCompletion.reason;
        break;
      }
      activeLease = refreshedBeforeCompletion.lease;

      try {
        await this.options.store.completeRoomSemanticControllerAction({
          roomId: input.roomId,
          roomWorkerFence: roomWorkerFence(activeLease),
          actionId: action.id,
          claimToken: action.claimToken,
          outcome,
          errorCode,
          now: this.currentTime(),
        });
      } catch (error) {
        const reason = stopReasonFor(error);
        if (!reason) throw error;
        stopReason = reason;
        break;
      }

      if (outcome === "processed") {
        processedActionCount += 1;
        processedActionKinds[action.actionKind] += 1;
      } else {
        retriedActionCount += 1;
        retriedActionKinds[action.actionKind] += 1;
        // A retry is immediately pending again. End this pass so one poisoned
        // action cannot be re-claimed repeatedly and consume the Room's whole
        // semantic budget before the next scheduled reconciliation.
        break;
      }
    }

    return Object.freeze({
      roomId: input.roomId,
      lease: activeLease,
      claimedActionCount,
      processedActionCount,
      retriedActionCount,
      processedActionKinds: Object.freeze({ ...processedActionKinds }),
      retriedActionKinds: Object.freeze({ ...retriedActionKinds }),
      reachedMaxActions: claimedActionCount === this.maxActions,
      stopped: stopReason !== null,
      stopReason,
    });
  }

  private async refreshLease(
    input: ProcessRoomSemanticControllerInboxInput,
    lease: StoredRoomLeaseV1,
  ): Promise<
    | { readonly ok: true; readonly lease: StoredRoomLeaseV1 }
    | { readonly ok: false; readonly reason: RoomSemanticControllerInboxStopReason }
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

  private async consumeSupportedAction(action: RoomSemanticControllerActionV1): Promise<void> {
    switch (action.actionKind) {
      case "semantic_message":
      case "semantic_loop_break":
        if (!this.consumeAction) {
          throw new RoomSemanticControllerInboxProcessorError(
            "room_semantic_controller_action_consumer_unconfigured",
            "Semantic controller inbox cannot complete an action without a configured consumer",
          );
        }
        await this.consumeAction(action);
        return;
      default:
        throw new RoomSemanticControllerInboxProcessorError(
          "room_semantic_controller_invalid_claim",
          `Room semantic controller action ${action.id} has an unsupported action kind`,
        );
    }
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
      throw new RoomSemanticControllerInboxProcessorError(
        "room_semantic_controller_invalid_worker_lease",
        `Semantic controller inbox requires the current room-worker lease for ${roomId}`,
      );
    }
  }

  private assertClaimedAction(roomId: string, action: RoomSemanticControllerActionV1): asserts action is RoomSemanticControllerActionV1 & {
    readonly claimToken: string;
  } {
    if (
      action.roomId !== roomId
      || action.state !== "claimed"
      || !isNonBlankString(action.claimToken)
      || !(action.actionKind === "semantic_message" || action.actionKind === "semantic_loop_break")
    ) {
      throw new RoomSemanticControllerInboxProcessorError(
        "room_semantic_controller_invalid_claim",
        `Semantic controller inbox received an invalid claimed action for ${roomId}`,
      );
    }
  }

  private currentTime(): string {
    const now = this.now();
    if (!isCanonicalUtcIsoTimestamp(now)) {
      throw new RoomSemanticControllerInboxProcessorError(
        "room_semantic_controller_invalid_clock",
        "Room semantic controller inbox clock must return a canonical UTC ISO timestamp",
      );
    }
    return now;
  }
}

function emptyActionKindCounts(): Record<RoomSemanticControllerActionKind, number> {
  return {
    semantic_message: 0,
    semantic_loop_break: 0,
  };
}

function roomWorkerFence(lease: StoredRoomLeaseV1): ClaimRoomSemanticControllerActionInputV1["roomWorkerFence"] {
  return {
    leaseId: lease.id,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomSemanticControllerInboxProcessor ${field} must be a positive safe integer`);
  }
  return value;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function stopReasonFor(error: unknown): RoomSemanticControllerInboxStopReason | null {
  if (hasErrorCode(error, "stale_lease_fence") || hasErrorCode(error, "room_worker_authority_revoked")) {
    return "fence_revoked";
  }
  return error instanceof Error && error.name === "AbortError" ? "controller_stopped" : null;
}

function actionFailureCodeFor(error: unknown): string {
  return error instanceof RoomSemanticControllerInboxProcessorError
    && error.code === "room_semantic_controller_action_consumer_unconfigured"
    ? ACTION_CONSUMER_UNCONFIGURED_FAILURE_CODE
    : ACTION_LOCAL_FAILURE_CODE;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
