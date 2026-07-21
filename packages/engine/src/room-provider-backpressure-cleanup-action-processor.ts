import type {
  RoomProviderBackpressureCleanupActionV1,
  RoomProviderBackpressureCleanupActions,
  StoredRoomLeaseV1,
} from "@fusion/core";

export const DEFAULT_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTION_MAX_ACTIONS = 8;
export const DEFAULT_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTION_CLAIM_TTL_MS = 60_000;
export const DEFAULT_ROOM_PROVIDER_BACKPRESSURE_PRECLAIM_RETRY_DELAY_MS = 1_000;

type CleanupActions = Pick<
  RoomProviderBackpressureCleanupActions,
  "claimNext" | "markExpired" | "finalizeExactPreSendOutbox" | "finalizeTerminalPreClaimOutbox"
>;

export interface RoomProviderBackpressureCleanupActionProcessorOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  /** Core is the only durable action authority available to this processor. */
  readonly cleanupActions: CleanupActions;
  readonly now?: () => string;
  /** Bounds a pass so cleanup cannot starve current Room work. */
  readonly maxActions?: number;
  /** Passed to Core, which owns the claimed-action expiry and retry lifecycle. */
  readonly claimTtlMs?: number;
}

export interface ProcessRoomProviderBackpressureCleanupActionsInput {
  readonly roomId: string;
  /** The current Room-worker lease is the sole authority Core accepts. */
  readonly lease: StoredRoomLeaseV1;
  /** Refreshes the fence immediately before every durable claim or expiry mark. */
  readonly renewLease: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /** Optional post-renewal observation catches a concurrent takeover before mutation. */
  readonly observeLease?: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1 | null>;
  /** Ends the pass before its next durable mutation when the controller is cancelled. */
  readonly canContinue?: () => boolean;
  /** Acquires the current sender fence only for a terminal pre-send outbox target. */
  readonly resolveSenderLease: (bindingId: string) => Promise<StoredRoomLeaseV1 | null>;
}

export type RoomProviderBackpressureCleanupActionStopReason = "controller_stopped" | "fence_revoked";

export interface RoomProviderBackpressureCleanupActionProcessSummary {
  readonly roomId: string;
  /** Last lease proven current before this pass returned. */
  readonly lease: StoredRoomLeaseV1;
  readonly claimedActionCount: number;
  readonly expiredActionCount: number;
  /** A delayed original release eventually succeeded; no synthetic expiry was recorded. */
  readonly releasedActionCount: number;
  readonly unblockedOutboxCount: number;
  readonly withheldOutboxFinalizationCount: number;
  /** FNXC:RoomProviderPreClaimTerminalRecovery 2026-07-20-22:43: Core retained a live-sender boundary and scheduled a future normal retry. */
  readonly deferredOutboxRetryCount: number;
  readonly notDueActionCount: number;
  readonly reachedMaxActions: boolean;
  readonly stopped: boolean;
  readonly stopReason: RoomProviderBackpressureCleanupActionStopReason | null;
}

export class RoomProviderBackpressureCleanupActionProcessorError extends Error {
  readonly code:
    | "room_provider_backpressure_cleanup_action_invalid_worker_lease"
    | "room_provider_backpressure_cleanup_action_invalid_claim"
    | "room_provider_backpressure_cleanup_action_invalid_mark_result"
    | "room_provider_backpressure_cleanup_action_invalid_clock";

  constructor(
    code: RoomProviderBackpressureCleanupActionProcessorError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RoomProviderBackpressureCleanupActionProcessorError";
    this.code = code;
  }
}

/**
 * FNXC:RoomProviderBackpressureCleanup 2026-07-20-00:29:
 * Provider-backpressure cleanup is an Engine-only, bounded reconciliation pass
 * for a current Room-worker lease. Its dependency surface deliberately exposes
 * only Core's cleanup operations: it cannot call a provider,
 * re-send work, or release the old provider reservation. Core alone decides
 * whether an already claimed action is due; a not_due result ends this pass
 * with the claim untouched so its fenced lifecycle remains durable.
 */
export class RoomProviderBackpressureCleanupActionProcessor {
  private readonly now: () => string;
  private readonly maxActions: number;
  private readonly claimTtlMs: number;

  constructor(private readonly options: RoomProviderBackpressureCleanupActionProcessorOptions) {
    if (!isNonBlankString(options.projectId) || !isNonBlankString(options.workerId) || !isNonBlankString(options.hostId)) {
      throw new Error("RoomProviderBackpressureCleanupActionProcessor projectId, workerId, and hostId are required");
    }
    if (!options.cleanupActions) {
      throw new Error("RoomProviderBackpressureCleanupActionProcessor requires Core cleanup actions");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxActions = positiveInteger(
      options.maxActions ?? DEFAULT_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTION_MAX_ACTIONS,
      "maxActions",
    );
    this.claimTtlMs = positiveInteger(
      options.claimTtlMs ?? DEFAULT_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTION_CLAIM_TTL_MS,
      "claimTtlMs",
    );
  }

  async process(
    input: ProcessRoomProviderBackpressureCleanupActionsInput,
  ): Promise<RoomProviderBackpressureCleanupActionProcessSummary> {
    this.assertWorkerLease(input.roomId, input.lease);

    let activeLease = input.lease;
    let stopReason: RoomProviderBackpressureCleanupActionStopReason | null = null;
    let claimedActionCount = 0;
    let expiredActionCount = 0;
    let releasedActionCount = 0;
    let unblockedOutboxCount = 0;
    let withheldOutboxFinalizationCount = 0;
    let deferredOutboxRetryCount = 0;
    let notDueActionCount = 0;

    while (claimedActionCount < this.maxActions) {
      const refreshed = await this.refreshLease(input, activeLease);
      if (!refreshed.ok) {
        stopReason = refreshed.reason;
        break;
      }
      activeLease = refreshed.lease;

      let action: RoomProviderBackpressureCleanupActionV1 | null;
      try {
        action = await this.options.cleanupActions.claimNext({
          projectId: this.options.projectId,
          roomId: input.roomId,
          cleanupWorkerLease: activeLease,
          now: this.currentTime(),
          claimTtlMs: this.claimTtlMs,
        });
      } catch (error) {
        const reason = stopReasonFor(error);
        if (!reason) throw error;
        stopReason = reason;
        break;
      }
      if (!action) break;

      claimedActionCount += 1;

      if (action.state === "released" || action.state === "expired") {
        const finalization = await this.finalizeTerminalOutboxAction(input, activeLease, action);
        if (finalization === "unblocked") unblockedOutboxCount += 1;
        if (finalization === "retry_later") deferredOutboxRetryCount += 1;
        if (finalization === "finalized_without_outbox_change") withheldOutboxFinalizationCount += 1;
        if (finalization === "withheld") {
          withheldOutboxFinalizationCount += 1;
          break;
        }
        continue;
      }
      this.assertClaimedAction(input.roomId, activeLease, action);

      const refreshedBeforeExpiry = await this.refreshLease(input, activeLease);
      if (!refreshedBeforeExpiry.ok) {
        stopReason = refreshedBeforeExpiry.reason;
        break;
      }
      if (!sameLeaseFence(activeLease, refreshedBeforeExpiry.lease)) {
        stopReason = "fence_revoked";
        break;
      }
      activeLease = refreshedBeforeExpiry.lease;

      let result: Awaited<ReturnType<CleanupActions["markExpired"]>>;
      try {
        result = await this.options.cleanupActions.markExpired({
          projectId: this.options.projectId,
          roomId: input.roomId,
          cleanupWorkerLease: activeLease,
          actionId: action.id,
          claimToken: action.claimToken,
          now: this.currentTime(),
        });
      } catch (error) {
        const reason = stopReasonFor(error);
        if (!reason) throw error;
        stopReason = reason;
        break;
      }

      this.assertMarkResult(action, result);
      if (result.status === "not_due") {
        notDueActionCount += 1;
        // Core retains this claim. Do not re-claim, release, or otherwise alter it.
        break;
      }
      if (result.status === "released") {
        releasedActionCount += 1;
      } else {
        expiredActionCount += 1;
      }
      const finalization = await this.finalizeTerminalOutboxAction(input, activeLease, result.action);
      if (finalization === "unblocked") unblockedOutboxCount += 1;
      if (finalization === "retry_later") deferredOutboxRetryCount += 1;
      if (finalization === "finalized_without_outbox_change") withheldOutboxFinalizationCount += 1;
      if (finalization === "withheld") {
        withheldOutboxFinalizationCount += 1;
        break;
      }
    }

    return Object.freeze({
      roomId: input.roomId,
      lease: activeLease,
      claimedActionCount,
      expiredActionCount,
      releasedActionCount,
      unblockedOutboxCount,
      withheldOutboxFinalizationCount,
      deferredOutboxRetryCount,
      notDueActionCount,
      reachedMaxActions: claimedActionCount === this.maxActions,
      stopped: stopReason !== null,
      stopReason,
    });
  }

  private async finalizeTerminalOutboxAction(
    input: ProcessRoomProviderBackpressureCleanupActionsInput,
    lease: StoredRoomLeaseV1,
    action: RoomProviderBackpressureCleanupActionV1,
  ): Promise<"unblocked" | "retry_later" | "finalized_without_outbox_change" | "none" | "withheld"> {
    /*
    FNXC:RoomProviderPreClaimTerminalRecovery 2026-07-20-22:38:
    A terminal pre-claim fence is not a pre-send attempt: recovery must never
    acquire a sender lease, contact a provider, or make another admission for it.
    Core atomically checks for a live sender under the current Room-worker lease
    and either opens a future-gated normal retry or returns retry_later.
    */
    if (action.completionKind === "pre_claim_not_started") {
      const refreshed = await this.refreshLease(input, lease);
      if (!refreshed.ok) return "withheld";
      const now = this.currentTime();
      const result = await this.options.cleanupActions.finalizeTerminalPreClaimOutbox({
        projectId: this.options.projectId,
        roomId: input.roomId,
        cleanupWorkerLease: refreshed.lease,
        actionId: action.id,
        now,
        nextAttemptAt: addMilliseconds(now, DEFAULT_ROOM_PROVIDER_BACKPRESSURE_PRECLAIM_RETRY_DELAY_MS),
        audit: { runId: `room-provider-cleanup:${action.id}`, agentId: this.options.workerId },
      });
      if (result.status === "unblocked" || result.status === "already_unblocked") return "unblocked";
      if (
        result.status === "withheld"
        || result.status === "already_withheld"
      ) {
        return "finalized_without_outbox_change";
      }
      if (result.status === "retry_later") return "retry_later";
      return "none";
    }

    if (action.completionKind !== "pre_send_not_started") return "none";
    if (!isNonBlankString(action.outboxBindingId)) {
      // Rolling-upgrade action rows lack exact attempt identity and are terminal
      // evidence only; never infer a target from their outboxId.
      return "none";
    }
    const senderLease = await input.resolveSenderLease(action.outboxBindingId);
    if (!senderLease) return "withheld";
    const refreshed = await this.refreshLease(input, lease);
    if (!refreshed.ok) return "withheld";
    const result = await this.options.cleanupActions.finalizeExactPreSendOutbox({
      projectId: this.options.projectId,
      roomId: input.roomId,
      cleanupWorkerLease: refreshed.lease,
      senderLease,
      actionId: action.id,
      now: this.currentTime(),
      audit: { runId: `room-provider-cleanup:${action.id}`, agentId: this.options.workerId },
    });
    if (result.status === "unblocked") return "unblocked";
    if (result.status === "withheld" || result.status === "already_withheld") {
      return "finalized_without_outbox_change";
    }
    return "none";
  }

  private async refreshLease(
    input: ProcessRoomProviderBackpressureCleanupActionsInput,
    lease: StoredRoomLeaseV1,
  ): Promise<
    | { readonly ok: true; readonly lease: StoredRoomLeaseV1 }
    | { readonly ok: false; readonly reason: RoomProviderBackpressureCleanupActionStopReason }
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
      !isNonBlankString(lease.id)
      || lease.kind !== "room_worker"
      || lease.roomId !== roomId
      || lease.resourceId !== roomId
      || lease.holderId !== this.options.workerId
      || lease.hostId !== this.options.hostId
      || !Number.isSafeInteger(lease.epoch)
      || lease.epoch < 1
      || lease.releasedAt !== null
    ) {
      throw new RoomProviderBackpressureCleanupActionProcessorError(
        "room_provider_backpressure_cleanup_action_invalid_worker_lease",
        `Provider cleanup action processor requires the current room-worker lease for ${roomId}`,
      );
    }
  }

  private assertClaimedAction(
    roomId: string,
    lease: StoredRoomLeaseV1,
    action: RoomProviderBackpressureCleanupActionV1,
  ): asserts action is RoomProviderBackpressureCleanupActionV1 & { readonly claimToken: string } {
    if (
      action.projectId !== this.options.projectId
      || action.roomId !== roomId
      || action.state !== "claimed"
      || !isNonBlankString(action.claimToken)
      || action.claimLeaseId !== lease.id
      || action.claimLeaseEpoch !== lease.epoch
      || !isCanonicalUtcIsoTimestamp(action.claimedAt)
      || !isCanonicalUtcIsoTimestamp(action.claimExpiresAt)
      || Date.parse(action.claimExpiresAt) <= Date.parse(this.currentTime())
    ) {
      throw new RoomProviderBackpressureCleanupActionProcessorError(
        "room_provider_backpressure_cleanup_action_invalid_claim",
        `Provider cleanup action processor received an invalid claimed action for ${roomId}`,
      );
    }
  }

  private assertMarkResult(
    action: RoomProviderBackpressureCleanupActionV1 & { readonly claimToken: string },
    result: Awaited<ReturnType<CleanupActions["markExpired"]>>,
  ): void {
    if (
      !isRecord(result)
      || !isRecord(result.action)
      || result.action.id !== action.id
      || result.action.projectId !== action.projectId
      || result.action.roomId !== action.roomId
    ) {
      throw new RoomProviderBackpressureCleanupActionProcessorError(
        "room_provider_backpressure_cleanup_action_invalid_mark_result",
        `Provider cleanup action ${action.id} returned an invalid Core expiry result`,
      );
    }
    if (result.status === "expired" && result.action.state === "expired") return;
    if (result.status === "released" && result.action.state === "released") return;
    if (
      result.status === "not_due"
      && result.action.state === "claimed"
      && result.action.claimToken === action.claimToken
      && result.action.claimLeaseId === action.claimLeaseId
      && result.action.claimLeaseEpoch === action.claimLeaseEpoch
    ) return;
    throw new RoomProviderBackpressureCleanupActionProcessorError(
      "room_provider_backpressure_cleanup_action_invalid_mark_result",
      `Provider cleanup action ${action.id} returned an inconsistent Core expiry result`,
    );
  }

  private currentTime(): string {
    const now = this.now();
    if (!isCanonicalUtcIsoTimestamp(now)) {
      throw new RoomProviderBackpressureCleanupActionProcessorError(
        "room_provider_backpressure_cleanup_action_invalid_clock",
        "Provider cleanup action processor clock must return a canonical UTC ISO timestamp",
      );
    }
    return now;
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomProviderBackpressureCleanupActionProcessor ${field} must be a positive safe integer`);
  }
  return value;
}

function sameLeaseFence(left: StoredRoomLeaseV1, right: StoredRoomLeaseV1): boolean {
  return left.id === right.id && left.epoch === right.epoch;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalUtcIsoTimestamp(value: string | null): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stopReasonFor(error: unknown): RoomProviderBackpressureCleanupActionStopReason | null {
  if (hasErrorCode(error, "stale_lease_fence") || hasErrorCode(error, "room_worker_authority_revoked")) {
    return "fence_revoked";
  }
  if (hasErrorCode(error, "ABORT_ERR")) return "controller_stopped";
  return error instanceof Error && error.name === "AbortError" ? "controller_stopped" : null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
