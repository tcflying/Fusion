import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import {
  assertRoomLeaseFence,
  lockRoomLeaseResourceWithinTransaction,
  type AssertRoomLeaseFenceInput,
  type StoredRoomLeaseV1,
} from "./async-room-lease-store.js";
import { recordRunAuditEventWithinTransaction, type AsyncDataLayer, type DbTransaction } from "./postgres/data-layer.js";
import {
  roomProviderAdmissionTimeoutTombstones,
  roomProviderAdmissionRecoveryReceipts,
  roomProviderBackpressureCleanupActions,
  roomProviderBackpressureReservations,
  roomLeases,
  roomOutbox,
  roomOutboxAttempts,
} from "./postgres/schema/room.js";
import type { RoomOutboxRecordV1 } from "./room-contracts/storage.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTIONS_CONTRACT_VERSION = 1 as const;
export const ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION = 1 as const;

export type RoomProviderBackpressureCleanupCompletionKindV1 =
  | "pre_send_not_started"
  | "pre_claim_not_started"
  | "late_admission_not_started";
export type RoomProviderBackpressureCleanupActionStateV1 = "pending" | "claimed" | "expired" | "released";
export type RoomProviderBackpressureCleanupOutboxFinalizationOutcomeV1 = "unblocked" | "withheld";
export type RoomProviderAdmissionTimeoutTombstoneStateV1 =
  | "pending"
  | "reservation_bound"
  | "terminal_outcome_recorded"
  | "terminal_outcome_claimed"
  | "terminal_without_permit";
export type RoomProviderAdmissionTerminalGateOutcomeV1 =
  | "deferred_without_permit"
  | "cancelled_without_permit"
  | "failed_without_permit"
  | "core_sender_fenced_no_reservation";
export type RoomProviderAdmissionTimeoutRecoveryProtocolV1 =
  | "opaque"
  | "core_sender_fenced_v1";

const ROOM_PROVIDER_ADMISSION_TERMINAL_GATE_OUTCOMES = new Set<RoomProviderAdmissionTerminalGateOutcomeV1>([
  "deferred_without_permit",
  "cancelled_without_permit",
  "failed_without_permit",
  "core_sender_fenced_no_reservation",
]);
const ROOM_PROVIDER_ADMISSION_TIMEOUT_RECOVERY_PROTOCOLS = new Set<RoomProviderAdmissionTimeoutRecoveryProtocolV1>([
  "opaque",
  "core_sender_fenced_v1",
]);

/*
FNXC:RoomProviderAdmissionRecoveryTransactionTimeout 2026-07-21-01:49:
Admission-timeout state transitions hold outbox, sender-resource, and tombstone
rows in a deliberate order. Bound every transition so a stalled database cannot
strand a worker indefinitely; SQLSTATE 57014 is handled by the worker as a
fail-closed retry boundary before any provider send is attempted.
*/
const ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS = {
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 1_000,
} as const;

export interface RoomProviderAdmissionTimeoutTombstoneV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptCount: number;
  readonly senderFence: {
    readonly leaseId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly epoch: number;
  };
  readonly timeoutErrorCode: string;
  readonly recoveryProtocol: RoomProviderAdmissionTimeoutRecoveryProtocolV1;
  readonly recoveryReceiptId: string | null;
  readonly state: RoomProviderAdmissionTimeoutTombstoneStateV1;
  readonly cleanupActionId: string | null;
  readonly reservationId: string | null;
  readonly terminalGateOutcomeId: string | null;
  readonly terminalGateOutcome: RoomProviderAdmissionTerminalGateOutcomeV1 | null;
  readonly terminalAt: string | null;
  readonly claimToken: string | null;
  readonly claimLeaseId: string | null;
  readonly claimLeaseEpoch: number | null;
  readonly claimedAt: string | null;
  readonly claimExpiresAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomProviderAdmissionRecoveryReceiptV1 {
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptCount: number;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly senderFence: {
    readonly leaseId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly epoch: number;
  };
  readonly issuedAt: string;
}

/**
 * FNXC:RoomProviderAdmissionTimeoutFence 2026-07-20-23:10:
 * The timeout path carries only immutable gate-request identity and the current
 * sender fence. It must not invent a provider reservation, claim, rejection, or
 * cancellation while the provider operation can still settle late.
 */
export interface FencePendingRoomProviderAdmissionTimeoutInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptCount: number;
  readonly senderFence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
  /**
   * Engine may request the Core receipt only after its factory-private standard
   * gate identity check. This value remains descriptive; every restart path
   * separately verifies the receipt persisted by this same transaction.
   */
  readonly recoveryProtocol?: RoomProviderAdmissionTimeoutRecoveryProtocolV1;
  readonly errorCode: string;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export type FencePendingRoomProviderAdmissionTimeoutResultV1 =
  | {
    readonly status: "created";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly outbox: RoomOutboxRecordV1;
  }
  | {
    readonly status: "replayed";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly outbox: RoomOutboxRecordV1;
  };

export interface BindRoomProviderAdmissionTimeoutReservationInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly cleanupAction: EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export type BindRoomProviderAdmissionTimeoutReservationResultV1 =
  | {
    readonly status: "bound";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly action: RoomProviderBackpressureCleanupActionV1;
    readonly outbox: RoomOutboxRecordV1;
  }
  | {
    readonly status: "replayed";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly action: RoomProviderBackpressureCleanupActionV1;
    readonly outbox: RoomOutboxRecordV1;
  };

export interface RoomProviderAdmissionTerminalGateOutcomeProofV1 {
  readonly outcomeId: string;
  readonly outcome: RoomProviderAdmissionTerminalGateOutcomeV1;
  readonly occurredAt: string;
}

export interface RecordRoomProviderAdmissionTimeoutTerminalOutcomeInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptCount: number;
  readonly senderFence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
  readonly terminalGateOutcome: RoomProviderAdmissionTerminalGateOutcomeProofV1;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export interface RecordRoomProviderAdmissionTimeoutTerminalOutcomeResultV1 {
  readonly status: "recorded" | "replayed";
  readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
  readonly outbox: RoomOutboxRecordV1;
}

export interface ClaimNextRoomProviderAdmissionTimeoutTerminalOutcomeInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly now: string;
  readonly claimTtlMs: number;
}

export interface ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly gateAttemptId: string;
  readonly requestHash: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly claimToken: string;
  readonly now: string;
  readonly nextAttemptAt: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export interface ResolveRoomProviderAdmissionTimeoutWithoutPermitResultV1 {
  readonly status: "resolved" | "replayed" | "retry_later";
  readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
  readonly outbox: RoomOutboxRecordV1;
}

export interface ReconcilePendingRoomProviderAdmissionTimeoutInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export type ReconcilePendingRoomProviderAdmissionTimeoutResultV1 =
  | {
    readonly status: "reservation_bound";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly action: RoomProviderBackpressureCleanupActionV1;
    readonly outbox: RoomOutboxRecordV1;
  }
  | {
    readonly status: "terminal_outcome_recorded";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly outbox: RoomOutboxRecordV1;
  }
  | {
    readonly status: "retry_later";
    readonly tombstone: RoomProviderAdmissionTimeoutTombstoneV1;
    readonly outbox: RoomOutboxRecordV1;
  };

export interface RoomProviderBackpressureCleanupActionV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTIONS_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly idempotencyKey: string;
  readonly outboxId: string | null;
  readonly outboxBindingId: string | null;
  readonly outboxAttemptId: string | null;
  readonly outboxAttemptCount: number | null;
  readonly reservationId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly originalWorkerFence: {
    readonly leaseId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly epoch: number;
  };
  readonly expectedAggregateVersion: number;
  readonly reservationExpiresAt: string;
  readonly completionKind: RoomProviderBackpressureCleanupCompletionKindV1;
  readonly state: RoomProviderBackpressureCleanupActionStateV1;
  readonly attemptCount: number;
  readonly claimToken: string | null;
  readonly claimLeaseId: string | null;
  readonly claimLeaseEpoch: number | null;
  readonly claimedAt: string | null;
  readonly claimExpiresAt: string | null;
  readonly lastErrorCode: string | null;
  readonly completedAt: string | null;
  readonly outboxUnblockedAt: string | null;
  readonly outboxFinalizedAt: string | null;
  readonly outboxFinalizationOutcome: RoomProviderBackpressureCleanupOutboxFinalizationOutcomeV1 | null;
  readonly outboxFinalizationReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RoomProviderBackpressureCleanupActionInputBaseV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly outboxId: string | null;
  readonly outboxBindingId: string | null;
  readonly outboxAttemptId: string | null;
  readonly outboxAttemptCount: number | null;
  readonly reservationId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly originalWorkerFence: RoomProviderBackpressureCleanupActionV1["originalWorkerFence"];
  readonly expectedAggregateVersion: number;
  readonly reservationExpiresAt: string;
  readonly completionKind: RoomProviderBackpressureCleanupCompletionKindV1;
  readonly createdAt: string;
}

/**
 * FNXC:RoomProviderPreClaimEnqueueBoundary 2026-07-20-22:48:
 * Generic cleanup enqueue is intentionally unable to create pre-claim evidence.
 * That evidence is valid only when fencePendingOutbox atomically fences the
 * matching pending generation under the current sender resource lock.
 */
export interface EnqueueRoomProviderBackpressureCleanupActionInputV1
  extends RoomProviderBackpressureCleanupActionInputBaseV1 {
  readonly completionKind: "pre_send_not_started" | "late_admission_not_started";
}

export interface EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1
  extends RoomProviderBackpressureCleanupActionInputBaseV1 {
  readonly completionKind: "pre_claim_not_started";
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptId: null;
  readonly outboxAttemptCount: number;
}

type RoomProviderBackpressureCleanupActionInputV1 =
  | EnqueueRoomProviderBackpressureCleanupActionInputV1
  | EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1;

/**
 * Atomically records an admitted-but-unreleased provider reservation and fences
 * the pending outbox generation that owns it. Unlike a pre-send attempt, this
 * target deliberately has no outbox-attempt row because no claim was started.
 */
export interface FencePendingRoomProviderBackpressureOutboxInputV1 {
  readonly action: EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1;
  readonly senderFence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
  readonly errorCode: string;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export type FencePendingRoomProviderBackpressureOutboxResultV1 =
  | {
    readonly status: "created";
    readonly action: RoomProviderBackpressureCleanupActionV1;
    readonly outbox: RoomOutboxRecordV1;
  }
  | {
    readonly status: "replayed";
    readonly action: RoomProviderBackpressureCleanupActionV1;
    readonly outbox: RoomOutboxRecordV1;
  };

export type EnqueueRoomProviderBackpressureCleanupActionResultV1 =
  | { readonly status: "created"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "replayed"; readonly action: RoomProviderBackpressureCleanupActionV1 };

export interface ClaimNextRoomProviderBackpressureCleanupActionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly now: string;
  readonly claimTtlMs: number;
}

export interface MarkRoomProviderBackpressureCleanupActionExpiredInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly actionId: string;
  readonly claimToken: string;
  readonly now: string;
}

export type MarkRoomProviderBackpressureCleanupActionExpiredResultV1 =
  | { readonly status: "expired"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "released"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "not_due"; readonly action: RoomProviderBackpressureCleanupActionV1 };

export interface FinalizeRoomProviderBackpressureCleanupOutboxInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly senderLease: StoredRoomLeaseV1;
  readonly actionId: string;
  readonly now: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

/**
 * Recovery resolves a terminal pre-claim fence under the Room-worker fence;
 * it never takes a sender lease and instead yields when a live sender exists.
 */
export interface FinalizeTerminalPreClaimOutboxInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly cleanupWorkerLease: StoredRoomLeaseV1;
  readonly actionId: string;
  readonly now: string;
  readonly nextAttemptAt: string;
  readonly audit: { readonly runId: string; readonly agentId: string; readonly taskId?: string };
}

export type FinalizeRoomProviderBackpressureCleanupOutboxResultV1 =
  | { readonly status: "unblocked"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "already_unblocked"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "withheld"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "already_withheld"; readonly action: RoomProviderBackpressureCleanupActionV1 }
  | { readonly status: "not_applicable"; readonly action: RoomProviderBackpressureCleanupActionV1 };

export type FinalizeTerminalPreClaimOutboxResultV1 =
  | FinalizeRoomProviderBackpressureCleanupOutboxResultV1
  | { readonly status: "retry_later"; readonly action: RoomProviderBackpressureCleanupActionV1 };

export interface RoomProviderBackpressureCleanupActions {
  enqueue(input: EnqueueRoomProviderBackpressureCleanupActionInputV1): Promise<EnqueueRoomProviderBackpressureCleanupActionResultV1>;
  fencePendingAdmissionTimeout(input: FencePendingRoomProviderAdmissionTimeoutInputV1): Promise<FencePendingRoomProviderAdmissionTimeoutResultV1>;
  bindAdmissionTimeoutReservation(input: BindRoomProviderAdmissionTimeoutReservationInputV1): Promise<BindRoomProviderAdmissionTimeoutReservationResultV1>;
  recordAdmissionTimeoutTerminalOutcome(input: RecordRoomProviderAdmissionTimeoutTerminalOutcomeInputV1): Promise<RecordRoomProviderAdmissionTimeoutTerminalOutcomeResultV1>;
  reconcilePendingAdmissionTimeout(input: ReconcilePendingRoomProviderAdmissionTimeoutInputV1): Promise<ReconcilePendingRoomProviderAdmissionTimeoutResultV1 | null>;
  claimNextAdmissionTimeoutTerminalOutcome(input: ClaimNextRoomProviderAdmissionTimeoutTerminalOutcomeInputV1): Promise<RoomProviderAdmissionTimeoutTombstoneV1 | null>;
  resolveAdmissionTimeoutWithoutPermit(input: ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1): Promise<ResolveRoomProviderAdmissionTimeoutWithoutPermitResultV1>;
  fencePendingOutbox(input: FencePendingRoomProviderBackpressureOutboxInputV1): Promise<FencePendingRoomProviderBackpressureOutboxResultV1>;
  claimNext(input: ClaimNextRoomProviderBackpressureCleanupActionInputV1): Promise<RoomProviderBackpressureCleanupActionV1 | null>;
  markExpired(input: MarkRoomProviderBackpressureCleanupActionExpiredInputV1): Promise<MarkRoomProviderBackpressureCleanupActionExpiredResultV1>;
  finalizeExactPreSendOutbox(input: FinalizeRoomProviderBackpressureCleanupOutboxInputV1): Promise<FinalizeRoomProviderBackpressureCleanupOutboxResultV1>;
  finalizeTerminalPreClaimOutbox(input: FinalizeTerminalPreClaimOutboxInputV1): Promise<FinalizeTerminalPreClaimOutboxResultV1>;
  get(input: { readonly projectId: string; readonly roomId: string; readonly actionId: string }): Promise<RoomProviderBackpressureCleanupActionV1 | null>;
}

export interface CreateRoomProviderBackpressureCleanupActionsInputV1 {
  readonly layer: AsyncDataLayer;
  readonly projectId?: string;
}

export class RoomProviderBackpressureCleanupActionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomProviderBackpressureCleanupActionsError";
  }
}

type CleanupActionRow = typeof roomProviderBackpressureCleanupActions.$inferSelect;
type AdmissionTimeoutTombstoneRow = typeof roomProviderAdmissionTimeoutTombstones.$inferSelect;
type AdmissionRecoveryReceiptRow = typeof roomProviderAdmissionRecoveryReceipts.$inferSelect;

export function createRoomProviderBackpressureCleanupActions(
  input: CreateRoomProviderBackpressureCleanupActionsInputV1,
): RoomProviderBackpressureCleanupActions {
  const implementation = new RoomProviderBackpressureCleanupActionsPostgres(input);
  return Object.freeze({
    enqueue: implementation.enqueue.bind(implementation),
    fencePendingAdmissionTimeout: implementation.fencePendingAdmissionTimeout.bind(implementation),
    bindAdmissionTimeoutReservation: implementation.bindAdmissionTimeoutReservation.bind(implementation),
    recordAdmissionTimeoutTerminalOutcome: implementation.recordAdmissionTimeoutTerminalOutcome.bind(implementation),
    reconcilePendingAdmissionTimeout: implementation.reconcilePendingAdmissionTimeout.bind(implementation),
    claimNextAdmissionTimeoutTerminalOutcome: implementation.claimNextAdmissionTimeoutTerminalOutcome.bind(implementation),
    resolveAdmissionTimeoutWithoutPermit: implementation.resolveAdmissionTimeoutWithoutPermit.bind(implementation),
    fencePendingOutbox: implementation.fencePendingOutbox.bind(implementation),
    claimNext: implementation.claimNext.bind(implementation),
    markExpired: implementation.markExpired.bind(implementation),
    finalizeExactPreSendOutbox: implementation.finalizeExactPreSendOutbox.bind(implementation),
    finalizeTerminalPreClaimOutbox: implementation.finalizeTerminalPreClaimOutbox.bind(implementation),
    get: implementation.get.bind(implementation),
  });
}

class RoomProviderBackpressureCleanupActionsPostgres {
  private readonly boundProjectId: string | undefined;

  constructor(private readonly input: CreateRoomProviderBackpressureCleanupActionsInputV1) {
    if (!input.layer) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup actions require a data layer");
    if (input.projectId && input.layer.projectId && input.projectId !== input.layer.projectId) {
      throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action factory project scope conflicts with its data layer");
    }
    this.boundProjectId = input.projectId ?? input.layer.projectId;
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutFence 2026-07-20-23:10:
  A provider gate timeout must atomically turn its exact pending outbox
  generation into delivery_uncertain before the caller can expose a retry. The
  tombstone stores only request identity, target generation, and the sender
  fence that authorized this transition; it never claims that a provider permit
  exists. Replaying the same immutable gate attempt returns the existing fence,
  while a second gate identity cannot claim the same outbox generation.
  */
  async fencePendingAdmissionTimeout(
    input: FencePendingRoomProviderAdmissionTimeoutInputV1,
  ): Promise<FencePendingRoomProviderAdmissionTimeoutResultV1> {
    validateFencePendingAdmissionTimeoutInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, input.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== input.outboxBindingId) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout target is not present in the requested room and binding");
      }

      await lockRoomLeaseResourceWithinTransaction(tx, input.projectId, "sender", input.outboxBindingId);
      const existing = await loadAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        input.gateAttemptId,
      );
      if (existing) {
        assertSameImmutableAdmissionTimeoutTombstone(existing, input);
        if (existing.recoveryReceiptId !== null) {
          const receipt = await loadAdmissionRecoveryReceiptById(tx, input.projectId, existing.recoveryReceiptId);
          assertAdmissionRecoveryReceiptMatchesTombstone(receipt, existing);
        }
        if (!isExactFencedAdmissionTimeoutOutbox(outbox, existing)) {
          throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout fence changed before idempotent replay");
        }
        return {
          status: "replayed",
          tombstone: rowToAdmissionTimeoutTombstone(existing),
          outbox: rowToOutboxRecord(outbox),
        };
      }

      await assertRoomLeaseFence(tx, input.projectId, { ...input.senderFence, now: input.now });
      const duplicateTarget = await loadAdmissionTimeoutTombstoneByTarget(
        tx,
        input.projectId,
        input.roomId,
        input.outboxId,
        input.outboxAttemptCount,
      );
      if (duplicateTarget) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout target already belongs to another immutable gate attempt");
      }
      if (!isExactPendingAdmissionTimeoutOutbox(outbox, input)) {
        throw new RoomProviderBackpressureCleanupActionsError("Pending outbox generation changed before provider admission timeout fencing");
      }

      const recoveryProtocol = admissionTimeoutRecoveryProtocol(input.recoveryProtocol);
      const recoveryReceipt = recoveryProtocol === "core_sender_fenced_v1"
        ? await issueAdmissionRecoveryReceiptWithinTransaction(tx, input)
        : null;

      const inserted = await tx.insert(roomProviderAdmissionTimeoutTombstones).values({
        id: admissionTimeoutTombstoneId(input),
        projectId: input.projectId,
        roomId: input.roomId,
        gateAttemptId: input.gateAttemptId,
        requestHash: input.requestHash,
        outboxId: input.outboxId,
        outboxBindingId: input.outboxBindingId,
        outboxAttemptCount: input.outboxAttemptCount,
        senderLeaseId: input.senderFence.leaseId,
        senderLeaseHolderId: input.senderFence.holderId,
        senderLeaseHostId: input.senderFence.hostId,
        senderLeaseEpoch: input.senderFence.expectedEpoch,
        timeoutErrorCode: input.errorCode,
        recoveryProtocol,
        recoveryReceiptId: recoveryReceipt?.id ?? null,
        state: "pending",
        cleanupActionId: null,
        reservationId: null,
        terminalGateOutcomeId: null,
        terminalGateOutcome: null,
        terminalAt: null,
        claimToken: null,
        claimLeaseId: null,
        claimLeaseEpoch: null,
        claimedAt: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
        resolvedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }).onConflictDoNothing().returning();
      if (inserted.length !== 1) {
        const raced = await loadAdmissionTimeoutTombstoneByGateAttempt(
          tx,
          input.projectId,
          input.roomId,
          input.gateAttemptId,
        );
        if (raced) {
          assertSameImmutableAdmissionTimeoutTombstone(raced, input);
          if (raced.recoveryReceiptId !== null) {
            const receipt = await loadAdmissionRecoveryReceiptById(tx, input.projectId, raced.recoveryReceiptId);
            assertAdmissionRecoveryReceiptMatchesTombstone(receipt, raced);
          }
          if (!isExactFencedAdmissionTimeoutOutbox(outbox, raced)) {
            throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout fence changed during idempotent replay");
          }
          return {
            status: "replayed",
            tombstone: rowToAdmissionTimeoutTombstone(raced),
            outbox: rowToOutboxRecord(outbox),
          };
        }
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout identity conflicts with another tombstone");
      }

      const fenced = await tx.update(roomOutbox).set({
        deliveryState: "delivery_uncertain",
        nativeAcknowledgement: null,
        nativeCursor: null,
        reconciliationEvidenceRef: null,
        lastErrorCode: input.errorCode,
        nextAttemptAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, input.outboxId),
        eq(roomOutbox.deliveryState, "pending"),
        eq(roomOutbox.attemptCount, input.outboxAttemptCount),
      )).returning();
      if (fenced.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Pending outbox generation changed during provider admission timeout fencing");
      }
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-admission-timeout-tombstoned",
        target: input.outboxId,
        metadata: {
          roomId: input.roomId,
          bindingId: input.outboxBindingId,
          tombstoneId: inserted[0]!.id,
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          attemptCount: input.outboxAttemptCount,
          errorCode: input.errorCode,
          recoveryProtocol,
          recoveryReceiptId: recoveryReceipt?.id ?? null,
        },
      });
      return {
        status: "created",
        tombstone: rowToAdmissionTimeoutTombstone(inserted[0]!),
        outbox: rowToOutboxRecord(fenced[0]!),
      };
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutLatePermit 2026-07-20-23:18:
  A late permit does not replace or reopen the timeout fence. Under the same
  sender resource lock, bind the existing tombstone to the exact verified
  reservation and create/replay its pre-claim cleanup action in one transaction.
  The outbox remains delivery_uncertain until the established cleanup recovery
  path records a terminal reservation state.
  */
  async bindAdmissionTimeoutReservation(
    input: BindRoomProviderAdmissionTimeoutReservationInputV1,
  ): Promise<BindRoomProviderAdmissionTimeoutReservationResultV1> {
    validateBindAdmissionTimeoutReservationInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, input.cleanupAction.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== input.cleanupAction.outboxBindingId) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout late permit target is not present in the requested room and binding");
      }
      await lockRoomLeaseResourceWithinTransaction(
        tx,
        input.projectId,
        "sender",
        input.cleanupAction.outboxBindingId,
      );
      const tombstone = await loadAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        input.gateAttemptId,
      );
      if (!tombstone) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone is not present for the late permit");
      }
      assertAdmissionTimeoutGateIdentity(tombstone, input.gateAttemptId, input.requestHash);
      assertCleanupActionTargetsAdmissionTimeoutTombstone(tombstone, input.cleanupAction);

      if (tombstone.state === "terminal_outcome_recorded"
        || tombstone.state === "terminal_outcome_claimed"
        || tombstone.state === "terminal_without_permit") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout was already resolved by terminal no-permit proof");
      }
      if (tombstone.state === "reservation_bound") {
        const actionRows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
          eq(roomProviderBackpressureCleanupActions.id, input.cleanupAction.actionId),
          eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
          eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
        )).limit(1);
        const action = actionRows[0];
        if (!action || tombstone.cleanupActionId !== action.id || tombstone.reservationId !== action.reservationId) {
          throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout reservation binding changed before replay");
        }
        assertSameImmutableAction(action, input.cleanupAction);
        return {
          status: "replayed",
          tombstone: rowToAdmissionTimeoutTombstone(tombstone),
          action: rowToAction(action),
          outbox: rowToOutboxRecord(outbox),
        };
      }
      if (!isExactFencedAdmissionTimeoutOutbox(outbox, tombstone)) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout outbox generation changed before late permit binding");
      }

      const actionResult = await this.enqueueWithinTransaction(tx, input.cleanupAction);
      const bound = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
        state: "reservation_bound",
        cleanupActionId: actionResult.action.id,
        reservationId: actionResult.action.reservationId,
        resolvedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.id, tombstone.id),
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "pending"),
        isNull(roomProviderAdmissionTimeoutTombstones.cleanupActionId),
        isNull(roomProviderAdmissionTimeoutTombstones.reservationId),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).returning();
      if (bound.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone changed during late permit binding");
      }
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-admission-timeout-reservation-bound",
        target: tombstone.outboxId,
        metadata: {
          roomId: input.roomId,
          bindingId: tombstone.outboxBindingId,
          tombstoneId: tombstone.id,
          gateAttemptId: tombstone.gateAttemptId,
          requestHash: tombstone.requestHash,
          actionId: actionResult.action.id,
          reservationId: actionResult.action.reservationId,
          attemptCount: tombstone.outboxAttemptCount,
        },
      });
      return {
        status: "bound",
        tombstone: rowToAdmissionTimeoutTombstone(bound[0]!),
        action: actionResult.action,
        outbox: rowToOutboxRecord(outbox),
      };
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutTerminalProof 2026-07-20-23:25:
  The late gate callback may outlive its captured Room-worker lease. It can
  still persist an immutable terminal no-permit outcome against the already
  fenced tombstone using the original gate/request/target/sender identity.
  This transition never reopens delivery and does not require that historical
  sender lease to remain active; a future recovery worker supplies fresh
  authority when it consumes the proof.
  */
  async recordAdmissionTimeoutTerminalOutcome(
    input: RecordRoomProviderAdmissionTimeoutTerminalOutcomeInputV1,
  ): Promise<RecordRoomProviderAdmissionTimeoutTerminalOutcomeResultV1> {
    validateRecordAdmissionTimeoutTerminalOutcomeInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, input.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== input.outboxBindingId) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal proof target is not present in the requested room and binding");
      }
      await lockRoomLeaseResourceWithinTransaction(tx, input.projectId, "sender", input.outboxBindingId);
      const tombstone = await loadAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        input.gateAttemptId,
      );
      if (!tombstone) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone is not present for terminal gate proof");
      }
      assertAdmissionTimeoutCallbackIdentity(tombstone, input);
      if (tombstone.state === "reservation_bound") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout already has a verified late reservation");
      }
      if (tombstone.state === "terminal_outcome_recorded"
        || tombstone.state === "terminal_outcome_claimed"
        || tombstone.state === "terminal_without_permit") {
        assertSameRecordedTerminalAdmissionTimeoutOutcome(tombstone, input.terminalGateOutcome);
        return {
          status: "replayed",
          tombstone: rowToAdmissionTimeoutTombstone(tombstone),
          outbox: rowToOutboxRecord(outbox),
        };
      }
      if (timestamp(input.terminalGateOutcome.occurredAt, "terminalGateOutcome.occurredAt")
        < timestamp(tombstone.createdAt, "tombstone.createdAt")) {
        throw new RoomProviderBackpressureCleanupActionsError("Terminal no-permit gate proof cannot predate the timeout tombstone");
      }
      if (!isExactFencedAdmissionTimeoutOutbox(outbox, tombstone)) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout generation changed before terminal gate proof recording");
      }
      const recorded = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
        state: "terminal_outcome_recorded",
        terminalGateOutcomeId: input.terminalGateOutcome.outcomeId,
        terminalGateOutcome: input.terminalGateOutcome.outcome,
        terminalAt: input.terminalGateOutcome.occurredAt,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.id, tombstone.id),
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "pending"),
        isNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).returning();
      if (recorded.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone changed during terminal gate proof recording");
      }
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-admission-timeout-terminal-outcome-recorded",
        target: tombstone.outboxId,
        metadata: {
          roomId: input.roomId,
          bindingId: tombstone.outboxBindingId,
          tombstoneId: tombstone.id,
          gateAttemptId: tombstone.gateAttemptId,
          requestHash: tombstone.requestHash,
          terminalGateOutcomeId: input.terminalGateOutcome.outcomeId,
          terminalGateOutcome: input.terminalGateOutcome.outcome,
          attemptCount: tombstone.outboxAttemptCount,
        },
      });
      return {
        status: "recorded",
        tombstone: rowToAdmissionTimeoutTombstone(recorded[0]!),
        outbox: rowToOutboxRecord(outbox),
      };
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutCrashReconcile 2026-07-21-01:05:
  A recovery worker may reconcile a pending timeout only with a Core-issued,
  identity-matched receipt from the standard sender-fenced path. Once the original sender is no longer active, an
  in-flight Core commit cannot create a new reservation. Recovery therefore
  binds an already-persisted reservation to cleanup or records no-permit proof;
  it never asks the provider again and never reopens delivery in this step.
  */
  async reconcilePendingAdmissionTimeout(
    input: ReconcilePendingRoomProviderAdmissionTimeoutInputV1,
  ): Promise<ReconcilePendingRoomProviderAdmissionTimeoutResultV1 | null> {
    validateReconcilePendingAdmissionTimeoutInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(
        tx,
        input.projectId,
        input.roomId,
        input.cleanupWorkerLease,
        input.now,
      );
      const candidates = await tx.select().from(roomProviderAdmissionTimeoutTombstones).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "pending"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
        isNotNull(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId),
        isNull(roomProviderAdmissionTimeoutTombstones.cleanupActionId),
        isNull(roomProviderAdmissionTimeoutTombstones.reservationId),
        isNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).orderBy(
        asc(roomProviderAdmissionTimeoutTombstones.createdAt),
        asc(roomProviderAdmissionTimeoutTombstones.id),
      ).limit(1);
      const snapshot = candidates[0];
      if (!snapshot) return null;

      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, snapshot.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== snapshot.outboxBindingId) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout outbox target is not present for crash reconciliation");
      }
      const activeSender = await lockAndFindActiveSenderForPreClaimRecovery(
        tx,
        input.projectId,
        input.roomId,
        snapshot.outboxBindingId,
        input.now,
      );
      const tombstone = await loadAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        snapshot.gateAttemptId,
      );
      if (!tombstone) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone disappeared during crash reconciliation");
      }
      assertSameAdmissionTimeoutTargetSnapshot(tombstone, snapshot);
      if (
        tombstone.state !== "pending"
        || tombstone.recoveryProtocol !== "core_sender_fenced_v1"
        || tombstone.recoveryReceiptId === null
        || tombstone.cleanupActionId !== null
        || tombstone.reservationId !== null
        || tombstone.terminalGateOutcomeId !== null
        || tombstone.resolvedAt !== null
      ) {
        return null;
      }
      const recoveryReceipt = await loadAdmissionRecoveryReceiptById(
        tx,
        input.projectId,
        tombstone.recoveryReceiptId,
      );
      assertAdmissionRecoveryReceiptMatchesTombstone(recoveryReceipt, tombstone);
      if (!isExactFencedAdmissionTimeoutOutbox(outbox, tombstone)) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout generation changed before crash reconciliation");
      }
      if (activeSender) {
        return {
          status: "retry_later",
          tombstone: rowToAdmissionTimeoutTombstone(tombstone),
          outbox: rowToOutboxRecord(outbox),
        };
      }

      const requestId = `room-provider-capacity:${tombstone.outboxId}:${tombstone.gateAttemptId}`;
      const claimId = `${tombstone.outboxId}:${tombstone.gateAttemptId}`;
      const reservationRows = await tx.select().from(roomProviderBackpressureReservations).where(and(
        eq(roomProviderBackpressureReservations.projectId, input.projectId),
        eq(roomProviderBackpressureReservations.roomId, input.roomId),
        eq(roomProviderBackpressureReservations.requestId, requestId),
      )).limit(1).for("update");
      const reservation = reservationRows[0] ?? null;
      if (reservation && reservation.releasedAt === null && timestamp(reservation.expiresAt, "reservation.expiresAt") > timestamp(input.now, "now")) {
        if (reservation.claimId !== claimId) {
          throw new RoomProviderBackpressureCleanupActionsError("Core reservation claim identity conflicts with the admission timeout tombstone");
        }
        const historicalLeaseRows = await tx.select().from(roomLeases).where(and(
          eq(roomLeases.projectId, input.projectId),
          eq(roomLeases.id, reservation.leaseId),
          eq(roomLeases.roomId, input.roomId),
          eq(roomLeases.kind, "room_worker"),
          eq(roomLeases.resourceId, input.roomId),
          eq(roomLeases.epoch, reservation.leaseEpoch),
        )).limit(1).for("update");
        const historicalLease = historicalLeaseRows[0];
        if (!historicalLease) {
          return {
            status: "retry_later",
            tombstone: rowToAdmissionTimeoutTombstone(tombstone),
            outbox: rowToOutboxRecord(outbox),
          };
        }
        const actionIdentity = {
          projectId: input.projectId,
          roomId: input.roomId,
          outboxId: tombstone.outboxId,
          outboxBindingId: tombstone.outboxBindingId,
          outboxAttemptId: null,
          outboxAttemptCount: tombstone.outboxAttemptCount,
          reservationId: reservation.id,
          requestId,
          claimId,
          originalWorkerFence: {
            leaseId: historicalLease.id,
            holderId: historicalLease.holderId,
            hostId: historicalLease.hostId,
            epoch: historicalLease.epoch,
          },
          expectedAggregateVersion: reservation.expectedAggregateVersion,
          reservationExpiresAt: reservation.expiresAt,
          completionKind: "pre_claim_not_started" as const,
        };
        const actionId = `room-provider-cleanup:${hashRoomValue(actionIdentity)}`;
        const actionResult = await this.enqueueWithinTransaction(tx, {
          ...actionIdentity,
          actionId,
          idempotencyKey: actionId,
          createdAt: input.now,
        });
        const bound = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
          state: "reservation_bound",
          cleanupActionId: actionResult.action.id,
          reservationId: actionResult.action.reservationId,
          resolvedAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(roomProviderAdmissionTimeoutTombstones.id, tombstone.id),
          eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
          eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
          eq(roomProviderAdmissionTimeoutTombstones.state, "pending"),
          eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
          eq(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId, recoveryReceipt.id),
          isNull(roomProviderAdmissionTimeoutTombstones.cleanupActionId),
          isNull(roomProviderAdmissionTimeoutTombstones.reservationId),
          isNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
          isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
        )).returning();
        if (bound.length !== 1) {
          throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout changed during crash reservation reconciliation");
        }
        await recordRunAuditEventWithinTransaction(tx, {
          projectId: input.projectId,
          timestamp: input.now,
          taskId: input.audit.taskId,
          agentId: input.audit.agentId,
          runId: input.audit.runId,
          domain: "database",
          mutationType: "room:provider-admission-timeout-crash-reservation-bound",
          target: tombstone.outboxId,
          metadata: {
            roomId: input.roomId,
            bindingId: tombstone.outboxBindingId,
            tombstoneId: tombstone.id,
            gateAttemptId: tombstone.gateAttemptId,
            requestHash: tombstone.requestHash,
            recoveryReceiptId: recoveryReceipt.id,
            reservationId: actionResult.action.reservationId,
            actionId: actionResult.action.id,
          },
        });
        return {
          status: "reservation_bound",
          tombstone: rowToAdmissionTimeoutTombstone(bound[0]!),
          action: actionResult.action,
          outbox: rowToOutboxRecord(outbox),
        };
      }

      const terminalGateOutcome = {
        outcomeId: `room-provider-admission-terminal:${hashRoomValue({
          contractVersion: ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION,
          recoveryProtocol: tombstone.recoveryProtocol,
          recoveryReceiptId: recoveryReceipt.id,
          gateAttemptId: tombstone.gateAttemptId,
          requestHash: tombstone.requestHash,
          requestId,
          senderFence: {
            leaseId: tombstone.senderLeaseId,
            holderId: tombstone.senderLeaseHolderId,
            hostId: tombstone.senderLeaseHostId,
            epoch: tombstone.senderLeaseEpoch,
          },
        })}`,
        outcome: "core_sender_fenced_no_reservation" as const,
      };
      const recorded = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
        state: "terminal_outcome_recorded",
        terminalGateOutcomeId: terminalGateOutcome.outcomeId,
        terminalGateOutcome: terminalGateOutcome.outcome,
        terminalAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.id, tombstone.id),
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
          eq(roomProviderAdmissionTimeoutTombstones.state, "pending"),
          eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
          eq(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId, recoveryReceipt.id),
        isNull(roomProviderAdmissionTimeoutTombstones.cleanupActionId),
        isNull(roomProviderAdmissionTimeoutTombstones.reservationId),
        isNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).returning();
      if (recorded.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout changed during crash no-permit reconciliation");
      }
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-admission-timeout-crash-no-permit-recorded",
        target: tombstone.outboxId,
        metadata: {
          roomId: input.roomId,
          bindingId: tombstone.outboxBindingId,
          tombstoneId: tombstone.id,
          gateAttemptId: tombstone.gateAttemptId,
          requestHash: tombstone.requestHash,
          recoveryReceiptId: recoveryReceipt.id,
          terminalGateOutcomeId: terminalGateOutcome.outcomeId,
        },
      });
      return {
        status: "terminal_outcome_recorded",
        tombstone: rowToAdmissionTimeoutTombstone(recorded[0]!),
        outbox: rowToOutboxRecord(outbox),
      };
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutTerminalClaim 2026-07-20-23:43:
  A callback records proof without depending on its expired Room-worker lease.
  A successor recovery worker atomically claims the oldest recorded proof while
  fenced by its own current room lease. The claim is bound to that lease epoch
  and expires no later than the lease itself. Expiry only makes the same proof
  claimable again; it never reopens delivery or changes provider facts.
  */
  async claimNextAdmissionTimeoutTerminalOutcome(
    input: ClaimNextRoomProviderAdmissionTimeoutTerminalOutcomeInputV1,
  ): Promise<RoomProviderAdmissionTimeoutTombstoneV1 | null> {
    validateClaimNextAdmissionTimeoutTerminalOutcomeInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const currentCleanupWorkerLease = await assertCurrentCleanupWorkerFence(
        tx,
        input.projectId,
        input.roomId,
        input.cleanupWorkerLease,
        input.now,
      );
      await releaseExpiredAdmissionTimeoutTerminalClaims(tx, input.projectId, input.roomId, input.now);
      const rows = await tx.select().from(roomProviderAdmissionTimeoutTombstones).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "terminal_outcome_recorded"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
        isNotNull(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId),
        isNotNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
        isNull(roomProviderAdmissionTimeoutTombstones.claimToken),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).orderBy(
        asc(roomProviderAdmissionTimeoutTombstones.terminalAt),
        asc(roomProviderAdmissionTimeoutTombstones.createdAt),
        asc(roomProviderAdmissionTimeoutTombstones.id),
      ).limit(1);
      const candidate = rows[0];
      if (!candidate) return null;
      if (candidate.recoveryReceiptId === null) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout claim is missing its Core recovery receipt");
      }
      const recoveryReceipt = await loadAdmissionRecoveryReceiptById(
        tx,
        input.projectId,
        candidate.recoveryReceiptId,
      );
      assertAdmissionRecoveryReceiptMatchesTombstone(recoveryReceipt, candidate);

      const claimToken = `room-provider-admission-timeout-${randomUUID()}`;
      const claimExpiresAt = new Date(Math.min(
        timestamp(input.now, "now") + input.claimTtlMs,
        timestamp(currentCleanupWorkerLease.expiresAt, "cleanupWorkerLease.expiresAt"),
      )).toISOString();
      const claimed = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
        state: "terminal_outcome_claimed",
        claimToken,
        claimLeaseId: input.cleanupWorkerLease.id,
        claimLeaseEpoch: input.cleanupWorkerLease.epoch,
        claimedAt: input.now,
        claimExpiresAt,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.id, candidate.id),
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "terminal_outcome_recorded"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId, recoveryReceipt.id),
        isNull(roomProviderAdmissionTimeoutTombstones.claimToken),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).returning();
      if (claimed.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal outcome changed during claim");
      }
      return rowToAdmissionTimeoutTombstone(claimed[0]!);
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  /*
  FNXC:RoomProviderAdmissionTimeoutTerminalResolution 2026-07-20-23:21:
  Elapsed time alone cannot resolve a pre-permit timeout. Recovery may consume
  only an already-durable terminal gate outcome tied to the original
  gate/request identity. It holds the current Room-worker fence, yields to a
  live sender, and schedules the retry strictly after resolution so no immediate
  second admission can race this transition. After a non-locking identity read,
  it takes outbox, sender-resource, then tombstone locks in the same order as
  callback writers to avoid an inverse-lock deadlock.
  */
  async resolveAdmissionTimeoutWithoutPermit(
    input: ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1,
  ): Promise<ResolveRoomProviderAdmissionTimeoutWithoutPermitResultV1> {
    validateResolveAdmissionTimeoutWithoutPermitInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(
        tx,
        input.projectId,
        input.roomId,
        input.cleanupWorkerLease,
        input.now,
      );
      const tombstoneSnapshot = await readAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        input.gateAttemptId,
      );
      if (!tombstoneSnapshot) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone is not present for terminal resolution");
      }
      assertAdmissionTimeoutGateIdentity(tombstoneSnapshot, input.gateAttemptId, input.requestHash);
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, tombstoneSnapshot.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== tombstoneSnapshot.outboxBindingId) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout outbox target is not present for terminal resolution");
      }

      const activeSender = await lockAndFindActiveSenderForPreClaimRecovery(
        tx,
        input.projectId,
        input.roomId,
        tombstoneSnapshot.outboxBindingId,
        input.now,
      );
      const tombstone = await loadAdmissionTimeoutTombstoneByGateAttempt(
        tx,
        input.projectId,
        input.roomId,
        input.gateAttemptId,
      );
      if (!tombstone) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone disappeared during terminal resolution");
      }
      assertSameAdmissionTimeoutTargetSnapshot(tombstone, tombstoneSnapshot);
      assertAdmissionTimeoutGateIdentity(tombstone, input.gateAttemptId, input.requestHash);
      if (tombstone.recoveryReceiptId === null) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal resolution requires a Core recovery receipt");
      }
      const recoveryReceipt = await loadAdmissionRecoveryReceiptById(
        tx,
        input.projectId,
        tombstone.recoveryReceiptId,
      );
      assertAdmissionRecoveryReceiptMatchesTombstone(recoveryReceipt, tombstone);
      if (tombstone.state === "reservation_bound") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout has a verified reservation and must use the pre-claim cleanup path");
      }
      if (tombstone.state === "terminal_without_permit") {
        assertSameTerminalAdmissionTimeoutResolution(tombstone, input);
        return {
          status: "replayed",
          tombstone: rowToAdmissionTimeoutTombstone(tombstone),
          outbox: rowToOutboxRecord(outbox),
        };
      }
      if (tombstone.state === "pending") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal no-permit proof is not durably recorded");
      }
      if (tombstone.state !== "terminal_outcome_claimed") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal outcome must be claimed by the current recovery worker");
      }
      if (!tombstone.terminalGateOutcomeId || !tombstone.terminalGateOutcome || !tombstone.terminalAt) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout recorded terminal proof is incomplete");
      }
      assertAdmissionTimeoutTerminalClaim(tombstone, input);
      if (activeSender) {
        return {
          status: "retry_later",
          tombstone: rowToAdmissionTimeoutTombstone(tombstone),
          outbox: rowToOutboxRecord(outbox),
        };
      }
      const laterAttempt = await tx.select({ id: roomOutboxAttempts.id }).from(roomOutboxAttempts).where(and(
        eq(roomOutboxAttempts.projectId, input.projectId),
        eq(roomOutboxAttempts.outboxId, tombstone.outboxId),
        gt(roomOutboxAttempts.attempt, tombstone.outboxAttemptCount),
      )).limit(1).for("update");
      if (!isExactFencedAdmissionTimeoutOutbox(outbox, tombstone) || laterAttempt.length !== 0) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout generation is no longer safe to reopen from terminal no-permit proof");
      }

      const reopened = await tx.update(roomOutbox).set({
        deliveryState: "pending",
        nativeAcknowledgement: null,
        nativeCursor: null,
        reconciliationEvidenceRef: null,
        lastErrorCode: "provider_gate_terminal_without_permit",
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: input.now,
      }).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, tombstone.outboxId),
        eq(roomOutbox.deliveryState, "delivery_uncertain"),
        eq(roomOutbox.attemptCount, tombstone.outboxAttemptCount),
        isNull(roomOutbox.nativeAcknowledgement),
        isNull(roomOutbox.nativeCursor),
        isNull(roomOutbox.reconciliationEvidenceRef),
        isNull(roomOutbox.nextAttemptAt),
      )).returning();
      if (reopened.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout outbox generation changed during terminal resolution");
      }
      const resolved = await tx.update(roomProviderAdmissionTimeoutTombstones).set({
        state: "terminal_without_permit",
        nextAttemptAt: input.nextAttemptAt,
        resolvedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderAdmissionTimeoutTombstones.id, tombstone.id),
        eq(roomProviderAdmissionTimeoutTombstones.projectId, input.projectId),
        eq(roomProviderAdmissionTimeoutTombstones.roomId, input.roomId),
        eq(roomProviderAdmissionTimeoutTombstones.state, "terminal_outcome_claimed"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryProtocol, "core_sender_fenced_v1"),
        eq(roomProviderAdmissionTimeoutTombstones.recoveryReceiptId, recoveryReceipt.id),
        isNotNull(roomProviderAdmissionTimeoutTombstones.terminalGateOutcomeId),
        eq(roomProviderAdmissionTimeoutTombstones.claimToken, input.claimToken),
        eq(roomProviderAdmissionTimeoutTombstones.claimLeaseId, input.cleanupWorkerLease.id),
        eq(roomProviderAdmissionTimeoutTombstones.claimLeaseEpoch, input.cleanupWorkerLease.epoch),
        gt(roomProviderAdmissionTimeoutTombstones.claimExpiresAt, input.now),
        isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
      )).returning();
      if (resolved.length !== 1) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout tombstone changed during terminal resolution");
      }
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-admission-timeout-terminal-no-permit",
        target: tombstone.outboxId,
        metadata: {
          roomId: input.roomId,
          bindingId: tombstone.outboxBindingId,
          tombstoneId: tombstone.id,
          gateAttemptId: tombstone.gateAttemptId,
          requestHash: tombstone.requestHash,
          recoveryReceiptId: recoveryReceipt.id,
          terminalGateOutcomeId: tombstone.terminalGateOutcomeId,
          terminalGateOutcome: tombstone.terminalGateOutcome,
          attemptCount: tombstone.outboxAttemptCount,
          nextAttemptAt: input.nextAttemptAt,
        },
      });
      return {
        status: "resolved",
        tombstone: rowToAdmissionTimeoutTombstone(resolved[0]!),
        outbox: rowToOutboxRecord(reopened[0]!),
      };
    }, ROOM_PROVIDER_ADMISSION_RECOVERY_TRANSACTION_TIMEOUTS);
  }

  async enqueue(input: EnqueueRoomProviderBackpressureCleanupActionInputV1): Promise<EnqueueRoomProviderBackpressureCleanupActionResultV1> {
    validateGenericEnqueueInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate((tx) => this.enqueueWithinTransaction(tx, input));
  }

  /*
  FNXC:RoomProviderPreClaimCleanupFence 2026-07-20-22:48:
  An admitted provider reservation can time out before an outbox attempt is
  claimed. The action ledger and the pending→uncertain fence therefore commit
  in one Core transaction under the current sender lease; a crash cannot leave
  a fresh pending retry that acquires a second reservation. The action binds
  attempt generation zero (or another exact pending generation), but never
  fabricates an outbox-attempt row or a connector side effect. A same-action
  replay returns the exact already-fenced outbox record instead of re-fencing.
  */
  async fencePendingOutbox(
    input: FencePendingRoomProviderBackpressureOutboxInputV1,
  ): Promise<FencePendingRoomProviderBackpressureOutboxResultV1> {
    validateFencePendingInput(input);
    validatePreClaimEnqueueInput(input.action);
    assertProjectScope(this.boundProjectId, input.action.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const actionResult = await this.enqueueWithinTransaction(tx, input.action);
      const actionRows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
        eq(roomProviderBackpressureCleanupActions.id, input.action.actionId),
        eq(roomProviderBackpressureCleanupActions.projectId, input.action.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.action.roomId),
      )).limit(1).for("update");
      const action = actionRows[0];
      if (!action) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action disappeared before pending outbox fencing");
      assertSameImmutableAction(action, input.action);

      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.action.projectId),
        eq(roomOutbox.id, input.action.outboxId!),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      if (actionResult.status === "replayed") {
        await lockRoomLeaseResourceWithinTransaction(
          tx,
          input.action.projectId,
          "sender",
          input.action.outboxBindingId,
        );
        if (!isExactFencedPreClaimOutbox(outbox, input.action, input.errorCode)) {
          throw new RoomProviderBackpressureCleanupActionsError("Fenced pending outbox generation changed before provider cleanup replay");
        }
        return {
          status: "replayed",
          action: rowToAction(action),
          outbox: rowToOutboxRecord(outbox),
        };
      }
      if (action.state !== "pending" || !isExactPendingPreClaimOutbox(outbox, input.action)) {
        throw new RoomProviderBackpressureCleanupActionsError("Pending outbox generation changed before provider cleanup fencing");
      }
      await assertCurrentSenderFenceInput(
        tx,
        input.action.projectId,
        input.action.roomId,
        input.action.outboxBindingId,
        input.senderFence,
        input.now,
      );
      const updated = await tx.update(roomOutbox).set({
        deliveryState: "delivery_uncertain",
        nativeAcknowledgement: null,
        nativeCursor: null,
        reconciliationEvidenceRef: null,
        lastErrorCode: input.errorCode,
        nextAttemptAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(roomOutbox.projectId, input.action.projectId),
        eq(roomOutbox.id, outbox.id),
        eq(roomOutbox.deliveryState, "pending"),
        eq(roomOutbox.attemptCount, input.action.outboxAttemptCount!),
      )).returning();
      if (updated.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Pending outbox generation changed during provider cleanup fencing");
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.action.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:provider-cleanup-pending-outbox-fenced",
        target: outbox.id,
        metadata: {
          roomId: input.action.roomId,
          bindingId: outbox.bindingId,
          actionId: action.id,
          attemptCount: outbox.attemptCount,
          reservationId: action.reservationId,
          errorCode: input.errorCode,
        },
      });
      return {
        status: "created",
        action: rowToAction(action),
        outbox: rowToOutboxRecord(updated[0]!),
      };
    });
  }

  private async enqueueWithinTransaction(
    tx: DbTransaction,
    input: RoomProviderBackpressureCleanupActionInputV1,
  ): Promise<EnqueueRoomProviderBackpressureCleanupActionResultV1> {
    await assertInputMatchesReservation(tx, input);
    const existing = await loadByIdempotency(tx, input.projectId, input.roomId, input.idempotencyKey);
    if (existing) {
      assertSameImmutableAction(existing, input);
      return { status: "replayed", action: rowToAction(existing) };
    }
    const inserted = await tx.insert(roomProviderBackpressureCleanupActions).values({
      id: input.actionId,
      projectId: input.projectId,
      roomId: input.roomId,
      idempotencyKey: input.idempotencyKey,
      outboxId: input.outboxId,
      outboxBindingId: input.outboxBindingId,
      outboxAttemptId: input.outboxAttemptId,
      outboxAttemptCount: input.outboxAttemptCount,
      reservationId: input.reservationId,
      requestId: input.requestId,
      claimId: input.claimId,
      originalLeaseId: input.originalWorkerFence.leaseId,
      originalLeaseHolderId: input.originalWorkerFence.holderId,
      originalLeaseHostId: input.originalWorkerFence.hostId,
      originalLeaseEpoch: input.originalWorkerFence.epoch,
      expectedAggregateVersion: input.expectedAggregateVersion,
      reservationExpiresAt: input.reservationExpiresAt,
      completionKind: input.completionKind,
      state: "pending",
      attemptCount: 0,
      claimToken: null,
      claimLeaseId: null,
      claimLeaseEpoch: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      completedAt: null,
      outboxUnblockedAt: null,
      outboxFinalizedAt: null,
      outboxFinalizationOutcome: null,
      outboxFinalizationReason: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }).onConflictDoNothing().returning();
    if (inserted.length === 1) return { status: "created", action: rowToAction(inserted[0]!) };
    const raced = await loadByIdempotency(tx, input.projectId, input.roomId, input.idempotencyKey);
    if (raced) {
      assertSameImmutableAction(raced, input);
      return { status: "replayed", action: rowToAction(raced) };
    }
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action identity conflicts with another immutable action");
  }

  async claimNext(input: ClaimNextRoomProviderBackpressureCleanupActionInputV1): Promise<RoomProviderBackpressureCleanupActionV1 | null> {
    validateClaimInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(tx, input.projectId, input.roomId, input.cleanupWorkerLease, input.now);
      await releaseExpiredClaim(tx, input.projectId, input.roomId, input.now);
      const candidates = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
        eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
        or(
          eq(roomProviderBackpressureCleanupActions.state, "pending"),
          and(
            inArray(roomProviderBackpressureCleanupActions.state, ["released", "expired"]),
            inArray(roomProviderBackpressureCleanupActions.completionKind, ["pre_send_not_started", "pre_claim_not_started"]),
            isNull(roomProviderBackpressureCleanupActions.outboxFinalizedAt),
            isNotNull(roomProviderBackpressureCleanupActions.outboxId),
            isNotNull(roomProviderBackpressureCleanupActions.outboxBindingId),
            isNotNull(roomProviderBackpressureCleanupActions.outboxAttemptCount),
            or(
              and(
                eq(roomProviderBackpressureCleanupActions.completionKind, "pre_send_not_started"),
                isNotNull(roomProviderBackpressureCleanupActions.outboxAttemptId),
              ),
              and(
                eq(roomProviderBackpressureCleanupActions.completionKind, "pre_claim_not_started"),
                isNull(roomProviderBackpressureCleanupActions.outboxAttemptId),
              ),
            ),
          ),
        ),
      )).orderBy(
        asc(roomProviderBackpressureCleanupActions.reservationExpiresAt),
        asc(roomProviderBackpressureCleanupActions.createdAt),
        asc(roomProviderBackpressureCleanupActions.id),
      ).limit(8);
      for (const candidate of candidates) {
        if (candidate.state === "released" || candidate.state === "expired") {
          return rowToAction(candidate);
        }
        const claimToken = `room-provider-cleanup-${randomUUID()}`;
        const claimExpiresAt = new Date(timestamp(input.now, "now") + input.claimTtlMs).toISOString();
        const claimed = await tx.update(roomProviderBackpressureCleanupActions).set({
          state: "claimed",
          attemptCount: candidate.attemptCount + 1,
          claimToken,
          claimLeaseId: input.cleanupWorkerLease.id,
          claimLeaseEpoch: input.cleanupWorkerLease.epoch,
          claimedAt: input.now,
          claimExpiresAt,
          lastErrorCode: null,
          completedAt: null,
          updatedAt: input.now,
        }).where(and(
          eq(roomProviderBackpressureCleanupActions.id, candidate.id),
          eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
          eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
          eq(roomProviderBackpressureCleanupActions.state, "pending"),
        )).returning();
        if (claimed.length === 1) return rowToAction(claimed[0]!);
      }
      return null;
    });
  }

  async markExpired(
    input: MarkRoomProviderBackpressureCleanupActionExpiredInputV1,
  ): Promise<MarkRoomProviderBackpressureCleanupActionExpiredResultV1> {
    validateMarkExpiredInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(tx, input.projectId, input.roomId, input.cleanupWorkerLease, input.now);
      const rows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
        eq(roomProviderBackpressureCleanupActions.id, input.actionId),
        eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
      )).limit(1);
      const action = rows[0];
      if (!action) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action is not present in the requested scope");
      if (action.state !== "claimed" || action.claimToken !== input.claimToken
        || action.claimLeaseId !== input.cleanupWorkerLease.id
        || action.claimLeaseEpoch !== input.cleanupWorkerLease.epoch) {
        throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action claim is stale or belongs to another cleanup worker");
      }
      const reservation = await loadReservation(tx, input.projectId, action.reservationId);
      assertStoredActionMatchesReservation(action, reservation);
      if (reservation.releasedAt !== null) {
        /*
        FNXC:RoomProviderCleanupObservationTime 2026-07-20-01:25:
        A delayed permit completion may persist its historical release before
        this cleanup action is created. The action records when cleanup observed
        that durable fact, preserving the reservation's original releasedAt and
        satisfying the action ledger's monotonic completion constraint.
        */
        const updated = await tx.update(roomProviderBackpressureCleanupActions).set({
          state: "released",
          claimToken: null,
          claimLeaseId: null,
          claimLeaseEpoch: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          completedAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(roomProviderBackpressureCleanupActions.id, input.actionId),
          eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
          eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
          eq(roomProviderBackpressureCleanupActions.state, "claimed"),
          eq(roomProviderBackpressureCleanupActions.claimToken, input.claimToken),
          eq(roomProviderBackpressureCleanupActions.claimLeaseId, input.cleanupWorkerLease.id),
          eq(roomProviderBackpressureCleanupActions.claimLeaseEpoch, input.cleanupWorkerLease.epoch),
        )).returning();
        if (updated.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action changed before release could be recorded");
        return { status: "released", action: rowToAction(updated[0]!) };
      }
      const effectiveExpiry = Math.max(
        timestamp(action.reservationExpiresAt, "reservationExpiresAt"),
        timestamp(reservation.expiresAt, "reservation.expiresAt"),
      );
      if (timestamp(input.now, "now") < effectiveExpiry) {
        return { status: "not_due", action: rowToAction(action) };
      }
      const updated = await tx.update(roomProviderBackpressureCleanupActions).set({
        state: "expired",
        claimToken: null,
        claimLeaseId: null,
        claimLeaseEpoch: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastErrorCode: "reservation_expired_unreleased",
        completedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderBackpressureCleanupActions.id, input.actionId),
        eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
        eq(roomProviderBackpressureCleanupActions.state, "claimed"),
        eq(roomProviderBackpressureCleanupActions.claimToken, input.claimToken),
        eq(roomProviderBackpressureCleanupActions.claimLeaseId, input.cleanupWorkerLease.id),
        eq(roomProviderBackpressureCleanupActions.claimLeaseEpoch, input.cleanupWorkerLease.epoch),
      )).returning();
      if (updated.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action changed before expiry could be recorded");
      return { status: "expired", action: rowToAction(updated[0]!) };
    });
  }

  /*
  FNXC:RoomProviderPreSendFinalization 2026-07-20-22:48:
  A terminal pre-send cleanup action may reopen only the exact attempt it
  immutably names. This is one Core transaction under fresh Room-worker and
  sender fences; it never re-sends, releases an old permit, or fabricates a
  provider acknowledgement. It also repairs the narrow crash window where the
  action committed before the sender could mark its matching started attempt
  delivery_uncertain. Any changed generation or acknowledgement records a
  durable withheld finalization instead of allowing recovery to re-claim and
  throw on the same inert evidence forever. Pre-claim cleanup is deliberately
  rejected here after the terminal gate and handled by its separate recovery API.
  */
  async finalizeExactPreSendOutbox(
    input: FinalizeRoomProviderBackpressureCleanupOutboxInputV1,
  ): Promise<FinalizeRoomProviderBackpressureCleanupOutboxResultV1> {
    validateFinalizeInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(tx, input.projectId, input.roomId, input.cleanupWorkerLease, input.now);
      const rows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
        eq(roomProviderBackpressureCleanupActions.id, input.actionId),
        eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
      )).limit(1).for("update");
      const action = rows[0];
      if (!action) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action is not present in the requested scope");
      if (action.state !== "released" && action.state !== "expired") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action is not terminal before outbox finalization");
      }
      if (action.completionKind === "pre_claim_not_started") {
        throw new RoomProviderBackpressureCleanupActionsError("Pre-claim cleanup must use finalizeTerminalPreClaimOutbox");
      }
      if (action.completionKind !== "pre_send_not_started") return { status: "not_applicable", action: rowToAction(action) };
      if (action.outboxFinalizationOutcome === "unblocked" || action.outboxUnblockedAt !== null) {
        return { status: "already_unblocked", action: rowToAction(action) };
      }
      if (action.outboxFinalizationOutcome === "withheld") {
        return { status: "already_withheld", action: rowToAction(action) };
      }
      assertExactPreSendTarget(action);
      const reservation = await loadReservation(tx, input.projectId, action.reservationId);
      assertStoredActionMatchesReservation(action, reservation);
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, action.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      await assertCurrentSenderFence(tx, input.projectId, input.roomId, action.outboxBindingId, input.senderLease, input.now);
      if (!outbox || outbox.roomId !== input.roomId || outbox.bindingId !== action.outboxBindingId
        || (outbox.deliveryState !== "delivery_uncertain" && outbox.deliveryState !== "dispatching")
        || outbox.attemptCount !== action.outboxAttemptCount
        || outbox.nativeAcknowledgement !== null || outbox.nativeCursor !== null) {
        return finalizeExactPreSendOutboxAsWithheld(tx, input, action, "outbox_generation_not_reopenable");
      }
      const attempts = await tx.select().from(roomOutboxAttempts).where(and(
        eq(roomOutboxAttempts.projectId, input.projectId),
        eq(roomOutboxAttempts.outboxId, outbox.id),
        eq(roomOutboxAttempts.id, action.outboxAttemptId),
        eq(roomOutboxAttempts.attempt, action.outboxAttemptCount),
      )).limit(1).for("update");
      const attempt = attempts[0];
      const exactUncertainAttempt = outbox.deliveryState === "delivery_uncertain"
        && attempt?.endedAt !== null
        && attempt?.outcome === "delivery_uncertain";
      const recoverableDispatchingAttempt = outbox.deliveryState === "dispatching"
        && attempt?.endedAt === null
        && attempt?.outcome === "started";
      if (!exactUncertainAttempt && !recoverableDispatchingAttempt) {
        return finalizeExactPreSendOutboxAsWithheld(tx, input, action, "outbox_attempt_not_uncertain");
      }
      const nextErrorCode = action.state === "released" ? "provider_cleanup_released_before_send" : "provider_cleanup_expired_before_send";
      if (recoverableDispatchingAttempt) {
        const terminalizedAttempt = await tx.update(roomOutboxAttempts).set({
          endedAt: input.now,
          outcome: "delivery_uncertain",
          errorCode: nextErrorCode,
        }).where(and(
          eq(roomOutboxAttempts.projectId, input.projectId),
          eq(roomOutboxAttempts.outboxId, outbox.id),
          eq(roomOutboxAttempts.id, action.outboxAttemptId),
          eq(roomOutboxAttempts.attempt, action.outboxAttemptCount),
          isNull(roomOutboxAttempts.endedAt),
          eq(roomOutboxAttempts.outcome, "started"),
        )).returning({ id: roomOutboxAttempts.id });
        if (terminalizedAttempt.length !== 1) {
          throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup dispatching attempt changed before crash-window finalization");
        }
      }
      const reopened = await tx.update(roomOutbox).set({
        deliveryState: "pending", nativeAcknowledgement: null, nativeCursor: null,
        reconciliationEvidenceRef: null, lastErrorCode: nextErrorCode, nextAttemptAt: null, updatedAt: input.now,
      }).where(and(
        eq(roomOutbox.projectId, input.projectId), eq(roomOutbox.id, outbox.id),
        eq(roomOutbox.deliveryState, outbox.deliveryState), eq(roomOutbox.attemptCount, action.outboxAttemptCount),
      )).returning({ id: roomOutbox.id });
      if (reopened.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup outbox generation changed before finalization");
      const finalized = await tx.update(roomProviderBackpressureCleanupActions).set({
        outboxUnblockedAt: input.now,
        outboxFinalizedAt: input.now,
        outboxFinalizationOutcome: "unblocked",
        outboxFinalizationReason: null,
        updatedAt: input.now,
      }).where(and(
        eq(roomProviderBackpressureCleanupActions.id, action.id), eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        isNull(roomProviderBackpressureCleanupActions.outboxFinalizedAt),
      )).returning();
      if (finalized.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action changed before outbox finalization");
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: input.projectId, timestamp: input.now, taskId: input.audit.taskId, agentId: input.audit.agentId, runId: input.audit.runId,
        domain: "database", mutationType: "room:provider-cleanup-outbox-unblocked", target: outbox.id,
        metadata: { roomId: input.roomId, bindingId: outbox.bindingId, actionId: action.id, attemptId: action.outboxAttemptId, attemptCount: action.outboxAttemptCount, terminalState: action.state, recoveredDispatchingAttempt: recoverableDispatchingAttempt },
      });
      return { status: "unblocked", action: rowToAction(finalized[0]!) };
    });
  }

  /*
  FNXC:RoomProviderPreClaimRecovery 2026-07-20-22:48:
  A terminal pre-claim fence can outlive the sender lease because recovery
  correctly refuses to take that lease while delivery remains uncertain. This
  narrow recovery path holds the Room-worker fence, action/outbox rows, and the
  same sender advisory resource in order; it yields to a live sender and only
  reopens an exact generation with no later attempt on a future retry schedule.
  Historical attempts at or below the fenced count are not evidence that this
  pre-claim generation dispatched.
  */
  async finalizeTerminalPreClaimOutbox(
    input: FinalizeTerminalPreClaimOutboxInputV1,
  ): Promise<FinalizeTerminalPreClaimOutboxResultV1> {
    validateFinalizeTerminalPreClaimInput(input);
    assertProjectScope(this.boundProjectId, input.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      await assertCurrentCleanupWorkerFence(tx, input.projectId, input.roomId, input.cleanupWorkerLease, input.now);
      const rows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
        eq(roomProviderBackpressureCleanupActions.id, input.actionId),
        eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
        eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
      )).limit(1).for("update");
      const action = rows[0];
      if (!action) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action is not present in the requested scope");
      if (action.state !== "released" && action.state !== "expired") {
        throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action is not terminal before pre-claim outbox finalization");
      }
      if (action.completionKind !== "pre_claim_not_started") {
        return { status: "not_applicable", action: rowToAction(action) };
      }
      if (action.outboxFinalizationOutcome === "unblocked" || action.outboxUnblockedAt !== null) {
        return { status: "already_unblocked", action: rowToAction(action) };
      }
      if (action.outboxFinalizationOutcome === "withheld") {
        return { status: "already_withheld", action: rowToAction(action) };
      }
      assertPreClaimTarget(action);
      const reservation = await loadReservation(tx, input.projectId, action.reservationId);
      assertStoredActionMatchesReservation(action, reservation);
      const outboxRows = await tx.select().from(roomOutbox).where(and(
        eq(roomOutbox.projectId, input.projectId),
        eq(roomOutbox.id, action.outboxId),
      )).limit(1).for("update");
      const outbox = outboxRows[0];
      const activeSender = await lockAndFindActiveSenderForPreClaimRecovery(
        tx,
        input.projectId,
        input.roomId,
        action.outboxBindingId,
        input.now,
      );
      if (activeSender) return { status: "retry_later", action: rowToAction(action) };
      const laterAttempts = outbox
        ? await tx.select().from(roomOutboxAttempts).where(and(
          eq(roomOutboxAttempts.projectId, input.projectId),
          eq(roomOutboxAttempts.outboxId, outbox.id),
          gt(roomOutboxAttempts.attempt, action.outboxAttemptCount),
        )).limit(1).for("update")
        : [];
      if (!isExactUncertainPreClaimOutbox(outbox, action) || laterAttempts.length !== 0) {
        return finalizeExactPreSendOutboxAsWithheld(tx, input, action, "outbox_generation_not_reopenable");
      }
      return finalizeTerminalPreClaimOutboxUnderSenderResourceLock(tx, input, action, outbox);
    });
  }

  async get(input: { readonly projectId: string; readonly roomId: string; readonly actionId: string }): Promise<RoomProviderBackpressureCleanupActionV1 | null> {
    if (!canonicalString(input.projectId) || !canonicalString(input.roomId) || !canonicalString(input.actionId)) {
      throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action query scope is invalid");
    }
    assertProjectScope(this.boundProjectId, input.projectId);
    const rows = await this.input.layer.db.select().from(roomProviderBackpressureCleanupActions).where(and(
      eq(roomProviderBackpressureCleanupActions.id, input.actionId),
      eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
      eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
    )).limit(1);
    return rows[0] ? rowToAction(rows[0]) : null;
  }
}

async function assertInputMatchesReservation(
  tx: DbTransaction,
  input: RoomProviderBackpressureCleanupActionInputV1,
): Promise<void> {
  const reservation = await loadReservation(tx, input.projectId, input.reservationId);
  const matches = reservation.roomId === input.roomId
    && reservation.requestId === input.requestId
    && reservation.claimId === input.claimId
    && reservation.leaseId === input.originalWorkerFence.leaseId
    && reservation.leaseEpoch === input.originalWorkerFence.epoch
    && reservation.expectedAggregateVersion === input.expectedAggregateVersion
    && reservation.expiresAt === input.reservationExpiresAt;
  if (!matches) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action does not match the immutable reservation fence");
  }
}

async function loadReservation(tx: DbTransaction, projectId: string, reservationId: string) {
  const rows = await tx.select().from(roomProviderBackpressureReservations).where(and(
    eq(roomProviderBackpressureReservations.id, reservationId),
    eq(roomProviderBackpressureReservations.projectId, projectId),
  )).limit(1);
  const reservation = rows[0];
  if (!reservation) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action reservation is not present in the requested project");
  return reservation;
}

function assertStoredActionMatchesReservation(
  action: CleanupActionRow,
  reservation: typeof roomProviderBackpressureReservations.$inferSelect,
): void {
  const matches = action.roomId === reservation.roomId
    && action.requestId === reservation.requestId
    && action.claimId === reservation.claimId
    && action.originalLeaseId === reservation.leaseId
    && action.originalLeaseEpoch === reservation.leaseEpoch
    && action.expectedAggregateVersion === reservation.expectedAggregateVersion;
  if (!matches) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action reservation fence was altered");
}

async function releaseExpiredClaim(tx: DbTransaction, projectId: string, roomId: string, now: string): Promise<void> {
  await tx.update(roomProviderBackpressureCleanupActions).set({
    state: "pending",
    claimToken: null,
    claimLeaseId: null,
    claimLeaseEpoch: null,
    claimedAt: null,
    claimExpiresAt: null,
    lastErrorCode: null,
    completedAt: null,
    updatedAt: now,
  }).where(and(
    eq(roomProviderBackpressureCleanupActions.projectId, projectId),
    eq(roomProviderBackpressureCleanupActions.roomId, roomId),
    eq(roomProviderBackpressureCleanupActions.state, "claimed"),
    lte(roomProviderBackpressureCleanupActions.claimExpiresAt, now),
  ));
}

async function releaseExpiredAdmissionTimeoutTerminalClaims(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  now: string,
): Promise<void> {
  await tx.update(roomProviderAdmissionTimeoutTombstones).set({
    state: "terminal_outcome_recorded",
    claimToken: null,
    claimLeaseId: null,
    claimLeaseEpoch: null,
    claimedAt: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(roomProviderAdmissionTimeoutTombstones.projectId, projectId),
    eq(roomProviderAdmissionTimeoutTombstones.roomId, roomId),
    eq(roomProviderAdmissionTimeoutTombstones.state, "terminal_outcome_claimed"),
    lte(roomProviderAdmissionTimeoutTombstones.claimExpiresAt, now),
    isNull(roomProviderAdmissionTimeoutTombstones.resolvedAt),
  ));
}

/*
FNXC:RoomProviderCleanupWorkerSerialization 2026-07-20-22:48:
Cleanup state transitions lock the Room-worker resource before asserting its
fence, so terminal pre-claim recovery has a stable first lock before action,
outbox, and sender-resource serialization.
*/
async function assertCurrentCleanupWorkerFence(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  lease: StoredRoomLeaseV1,
  now: string,
): Promise<StoredRoomLeaseV1> {
  if (lease.kind !== "room_worker" || lease.roomId !== roomId || lease.resourceId !== roomId) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup actions require the current Room worker fence for the same room");
  }
  await lockRoomLeaseResourceWithinTransaction(tx, projectId, "room_worker", roomId);
  return assertRoomLeaseFence(tx, projectId, {
    leaseId: lease.id,
    roomId,
    kind: "room_worker",
    resourceId: roomId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  });
}

/*
FNXC:RoomProviderCleanupSenderSerialization 2026-07-20-22:48:
Fencing and all cleanup finalization outcomes share the sender resource advisory
lock with sender acquisition/takeover. A fence assertion alone is not enough:
the lock makes its read and the outbox mutation one serialized ownership step.
*/
async function lockAndFindActiveSenderForPreClaimRecovery(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  bindingId: string,
  now: string,
): Promise<typeof roomLeases.$inferSelect | null> {
  await lockRoomLeaseResourceWithinTransaction(tx, projectId, "sender", bindingId);
  const rows = await tx.select().from(roomLeases).where(and(
    eq(roomLeases.projectId, projectId),
    eq(roomLeases.roomId, roomId),
    eq(roomLeases.kind, "sender"),
    eq(roomLeases.resourceId, bindingId),
    isNull(roomLeases.releasedAt),
    gt(roomLeases.expiresAt, now),
  )).limit(1).for("update");
  return rows[0] ?? null;
}

type FinalizeCleanupOutboxContextV1 = Pick<
  FinalizeRoomProviderBackpressureCleanupOutboxInputV1,
  "projectId" | "roomId" | "now" | "audit"
>;

async function finalizeTerminalPreClaimOutboxUnderSenderResourceLock(
  tx: DbTransaction,
  input: FinalizeTerminalPreClaimOutboxInputV1,
  action: CleanupActionRow & {
    readonly outboxId: string;
    readonly outboxBindingId: string;
    readonly outboxAttemptId: null;
    readonly outboxAttemptCount: number;
  },
  outbox: typeof roomOutbox.$inferSelect,
): Promise<FinalizeTerminalPreClaimOutboxResultV1> {
  const nextErrorCode = action.state === "released" ? "provider_cleanup_released_before_send" : "provider_cleanup_expired_before_send";
  const reopened = await tx.update(roomOutbox).set({
    deliveryState: "pending",
    nativeAcknowledgement: null,
    nativeCursor: null,
    reconciliationEvidenceRef: null,
    lastErrorCode: nextErrorCode,
    nextAttemptAt: input.nextAttemptAt,
    updatedAt: input.now,
  }).where(and(
    eq(roomOutbox.projectId, input.projectId),
    eq(roomOutbox.id, outbox.id),
    eq(roomOutbox.deliveryState, "delivery_uncertain"),
    eq(roomOutbox.attemptCount, action.outboxAttemptCount),
    isNull(roomOutbox.nativeAcknowledgement),
    isNull(roomOutbox.nativeCursor),
    isNull(roomOutbox.reconciliationEvidenceRef),
    isNull(roomOutbox.nextAttemptAt),
  )).returning({ id: roomOutbox.id });
  if (reopened.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup pending outbox generation changed before terminal pre-claim finalization");
  const finalized = await tx.update(roomProviderBackpressureCleanupActions).set({
    outboxUnblockedAt: input.now,
    outboxFinalizedAt: input.now,
    outboxFinalizationOutcome: "unblocked",
    outboxFinalizationReason: null,
    updatedAt: input.now,
  }).where(and(
    eq(roomProviderBackpressureCleanupActions.id, action.id),
    eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
    isNull(roomProviderBackpressureCleanupActions.outboxFinalizedAt),
  )).returning();
  if (finalized.length !== 1) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action changed before terminal pre-claim finalization");
  await recordRunAuditEventWithinTransaction(tx, {
    projectId: input.projectId, timestamp: input.now, taskId: input.audit.taskId, agentId: input.audit.agentId, runId: input.audit.runId,
    domain: "database", mutationType: "room:provider-cleanup-pending-outbox-unblocked", target: outbox.id,
    metadata: {
      roomId: input.roomId, bindingId: outbox.bindingId, actionId: action.id,
      attemptId: null, attemptCount: action.outboxAttemptCount, terminalState: action.state,
      recoveredPreClaimFence: true, nextAttemptAt: input.nextAttemptAt,
    },
  });
  return { status: "unblocked", action: rowToAction(finalized[0]!) };
}

async function finalizeExactPreSendOutboxAsWithheld(
  tx: DbTransaction,
  input: FinalizeCleanupOutboxContextV1,
  action: CleanupActionRow & {
    readonly outboxId: string;
    readonly outboxBindingId: string;
    readonly outboxAttemptCount: number;
  },
  reason: "outbox_generation_not_reopenable" | "outbox_attempt_not_uncertain",
): Promise<FinalizeRoomProviderBackpressureCleanupOutboxResultV1> {
  const finalized = await tx.update(roomProviderBackpressureCleanupActions).set({
    outboxFinalizedAt: input.now,
    outboxFinalizationOutcome: "withheld",
    outboxFinalizationReason: reason,
    updatedAt: input.now,
  }).where(and(
    eq(roomProviderBackpressureCleanupActions.id, action.id),
    eq(roomProviderBackpressureCleanupActions.projectId, input.projectId),
    eq(roomProviderBackpressureCleanupActions.roomId, input.roomId),
    isNull(roomProviderBackpressureCleanupActions.outboxFinalizedAt),
  )).returning();
  if (finalized.length !== 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action changed before withheld outbox finalization");
  }
  await recordRunAuditEventWithinTransaction(tx, {
    projectId: input.projectId,
    timestamp: input.now,
    taskId: input.audit.taskId,
    agentId: input.audit.agentId,
    runId: input.audit.runId,
    domain: "database",
    mutationType: "room:provider-cleanup-outbox-finalization-withheld",
    target: action.outboxId,
    metadata: {
      roomId: input.roomId,
      bindingId: action.outboxBindingId,
      actionId: action.id,
      attemptId: action.outboxAttemptId,
      attemptCount: action.outboxAttemptCount,
      terminalState: action.state,
      reason,
    },
  });
  return { status: "withheld", action: rowToAction(finalized[0]!) };
}

async function loadAdmissionTimeoutTombstoneByGateAttempt(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  gateAttemptId: string,
): Promise<AdmissionTimeoutTombstoneRow | null> {
  const rows = await tx.select().from(roomProviderAdmissionTimeoutTombstones).where(and(
    eq(roomProviderAdmissionTimeoutTombstones.projectId, projectId),
    eq(roomProviderAdmissionTimeoutTombstones.roomId, roomId),
    eq(roomProviderAdmissionTimeoutTombstones.gateAttemptId, gateAttemptId),
  )).limit(1).for("update");
  return rows[0] ?? null;
}

async function readAdmissionTimeoutTombstoneByGateAttempt(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  gateAttemptId: string,
): Promise<AdmissionTimeoutTombstoneRow | null> {
  const rows = await tx.select().from(roomProviderAdmissionTimeoutTombstones).where(and(
    eq(roomProviderAdmissionTimeoutTombstones.projectId, projectId),
    eq(roomProviderAdmissionTimeoutTombstones.roomId, roomId),
    eq(roomProviderAdmissionTimeoutTombstones.gateAttemptId, gateAttemptId),
  )).limit(1);
  return rows[0] ?? null;
}

async function loadAdmissionTimeoutTombstoneByTarget(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  outboxId: string,
  outboxAttemptCount: number,
): Promise<AdmissionTimeoutTombstoneRow | null> {
  const rows = await tx.select().from(roomProviderAdmissionTimeoutTombstones).where(and(
    eq(roomProviderAdmissionTimeoutTombstones.projectId, projectId),
    eq(roomProviderAdmissionTimeoutTombstones.roomId, roomId),
    eq(roomProviderAdmissionTimeoutTombstones.outboxId, outboxId),
    eq(roomProviderAdmissionTimeoutTombstones.outboxAttemptCount, outboxAttemptCount),
  )).limit(1).for("update");
  return rows[0] ?? null;
}

function admissionTimeoutTombstoneId(input: Pick<
  FencePendingRoomProviderAdmissionTimeoutInputV1,
  "projectId" | "roomId" | "gateAttemptId" | "requestHash"
>): string {
  const digest = hashRoomValue({
    contractVersion: ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION,
    projectId: input.projectId,
    roomId: input.roomId,
    gateAttemptId: input.gateAttemptId,
    requestHash: input.requestHash,
  }).slice("sha256:".length);
  return `room-provider-admission-timeout:${digest}`;
}

function admissionRecoveryReceiptId(input: Pick<
  FencePendingRoomProviderAdmissionTimeoutInputV1,
  | "projectId"
  | "roomId"
  | "outboxId"
  | "outboxBindingId"
  | "outboxAttemptCount"
  | "gateAttemptId"
  | "requestHash"
  | "senderFence"
>): string {
  const digest = hashRoomValue({
    contractVersion: ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION,
    projectId: input.projectId,
    roomId: input.roomId,
    outboxId: input.outboxId,
    outboxBindingId: input.outboxBindingId,
    outboxAttemptCount: input.outboxAttemptCount,
    gateAttemptId: input.gateAttemptId,
    requestHash: input.requestHash,
    senderFence: {
      leaseId: input.senderFence.leaseId,
      holderId: input.senderFence.holderId,
      hostId: input.senderFence.hostId,
      epoch: input.senderFence.expectedEpoch,
    },
  }).slice("sha256:".length);
  return `room-provider-admission-recovery:${digest}`;
}

async function issueAdmissionRecoveryReceiptWithinTransaction(
  tx: DbTransaction,
  input: FencePendingRoomProviderAdmissionTimeoutInputV1,
): Promise<AdmissionRecoveryReceiptRow> {
  const id = admissionRecoveryReceiptId(input);
  const inserted = await tx.insert(roomProviderAdmissionRecoveryReceipts).values({
    id,
    projectId: input.projectId,
    roomId: input.roomId,
    outboxId: input.outboxId,
    outboxBindingId: input.outboxBindingId,
    outboxAttemptCount: input.outboxAttemptCount,
    gateAttemptId: input.gateAttemptId,
    requestHash: input.requestHash,
    senderLeaseId: input.senderFence.leaseId,
    senderLeaseHolderId: input.senderFence.holderId,
    senderLeaseHostId: input.senderFence.hostId,
    senderLeaseEpoch: input.senderFence.expectedEpoch,
    issuedAt: input.now,
  }).onConflictDoNothing().returning();
  if (inserted.length === 1) return inserted[0]!;
  const rows = await tx.select().from(roomProviderAdmissionRecoveryReceipts).where(and(
    eq(roomProviderAdmissionRecoveryReceipts.projectId, input.projectId),
    eq(roomProviderAdmissionRecoveryReceipts.id, id),
  )).limit(1).for("update");
  const existing = rows[0];
  if (!existing) {
    throw new RoomProviderBackpressureCleanupActionsError("Core admission recovery receipt conflicts with another immutable identity");
  }
  assertSameAdmissionRecoveryReceiptInput(existing, input);
  return existing;
}

async function loadAdmissionRecoveryReceiptById(
  tx: DbTransaction,
  projectId: string,
  receiptId: string,
): Promise<AdmissionRecoveryReceiptRow | null> {
  const rows = await tx.select().from(roomProviderAdmissionRecoveryReceipts).where(and(
    eq(roomProviderAdmissionRecoveryReceipts.projectId, projectId),
    eq(roomProviderAdmissionRecoveryReceipts.id, receiptId),
  )).limit(1).for("update");
  return rows[0] ?? null;
}

function assertSameAdmissionRecoveryReceiptInput(
  receipt: AdmissionRecoveryReceiptRow,
  input: FencePendingRoomProviderAdmissionTimeoutInputV1,
): void {
  const exact = receipt.id === admissionRecoveryReceiptId(input)
    && receipt.projectId === input.projectId
    && receipt.roomId === input.roomId
    && receipt.outboxId === input.outboxId
    && receipt.outboxBindingId === input.outboxBindingId
    && receipt.outboxAttemptCount === input.outboxAttemptCount
    && receipt.gateAttemptId === input.gateAttemptId
    && receipt.requestHash === input.requestHash
    && receipt.senderLeaseId === input.senderFence.leaseId
    && receipt.senderLeaseHolderId === input.senderFence.holderId
    && receipt.senderLeaseHostId === input.senderFence.hostId
    && receipt.senderLeaseEpoch === input.senderFence.expectedEpoch;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Core admission recovery receipt conflicts with immutable fence evidence");
  }
}

function assertAdmissionRecoveryReceiptMatchesTombstone(
  receipt: AdmissionRecoveryReceiptRow | null,
  tombstone: AdmissionTimeoutTombstoneRow,
): asserts receipt is AdmissionRecoveryReceiptRow {
  const exact = receipt !== null
    && tombstone.recoveryProtocol === "core_sender_fenced_v1"
    && tombstone.recoveryReceiptId !== null
    && receipt.id === tombstone.recoveryReceiptId
    && receipt.projectId === tombstone.projectId
    && receipt.roomId === tombstone.roomId
    && receipt.outboxId === tombstone.outboxId
    && receipt.outboxBindingId === tombstone.outboxBindingId
    && receipt.outboxAttemptCount === tombstone.outboxAttemptCount
    && receipt.gateAttemptId === tombstone.gateAttemptId
    && receipt.requestHash === tombstone.requestHash
    && receipt.senderLeaseId === tombstone.senderLeaseId
    && receipt.senderLeaseHolderId === tombstone.senderLeaseHolderId
    && receipt.senderLeaseHostId === tombstone.senderLeaseHostId
    && receipt.senderLeaseEpoch === tombstone.senderLeaseEpoch;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Core admission recovery receipt does not match its timeout tombstone");
  }
}

function assertSameImmutableAdmissionTimeoutTombstone(
  row: AdmissionTimeoutTombstoneRow,
  input: FencePendingRoomProviderAdmissionTimeoutInputV1,
): void {
  const recoveryProtocol = admissionTimeoutRecoveryProtocol(input.recoveryProtocol);
  const recoveryReceiptId = recoveryProtocol === "core_sender_fenced_v1"
    ? admissionRecoveryReceiptId(input)
    : null;
  const exact = row.id === admissionTimeoutTombstoneId(input)
    && row.requestHash === input.requestHash
    && row.outboxId === input.outboxId
    && row.outboxBindingId === input.outboxBindingId
    && row.outboxAttemptCount === input.outboxAttemptCount
    && row.senderLeaseId === input.senderFence.leaseId
    && row.senderLeaseHolderId === input.senderFence.holderId
    && row.senderLeaseHostId === input.senderFence.hostId
    && row.senderLeaseEpoch === input.senderFence.expectedEpoch
    && row.timeoutErrorCode === input.errorCode
    && row.recoveryProtocol === recoveryProtocol
    && row.recoveryReceiptId === recoveryReceiptId;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout gate attempt conflicts with immutable tombstone evidence");
  }
}

function assertAdmissionTimeoutGateIdentity(
  row: AdmissionTimeoutTombstoneRow,
  gateAttemptId: string,
  requestHash: string,
): void {
  if (row.gateAttemptId !== gateAttemptId || row.requestHash !== requestHash) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout gate identity conflicts with its durable tombstone");
  }
}

function assertSameAdmissionTimeoutTargetSnapshot(
  row: AdmissionTimeoutTombstoneRow,
  snapshot: AdmissionTimeoutTombstoneRow,
): void {
  const exact = row.id === snapshot.id
    && row.projectId === snapshot.projectId
    && row.roomId === snapshot.roomId
    && row.gateAttemptId === snapshot.gateAttemptId
    && row.requestHash === snapshot.requestHash
    && row.outboxId === snapshot.outboxId
    && row.outboxBindingId === snapshot.outboxBindingId
    && row.outboxAttemptCount === snapshot.outboxAttemptCount
    && row.recoveryProtocol === snapshot.recoveryProtocol
    && row.recoveryReceiptId === snapshot.recoveryReceiptId;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout target changed during terminal resolution");
  }
}

function assertAdmissionTimeoutCallbackIdentity(
  row: AdmissionTimeoutTombstoneRow,
  input: RecordRoomProviderAdmissionTimeoutTerminalOutcomeInputV1,
): void {
  const exact = row.requestHash === input.requestHash
    && row.outboxId === input.outboxId
    && row.outboxBindingId === input.outboxBindingId
    && row.outboxAttemptCount === input.outboxAttemptCount
    && row.senderLeaseId === input.senderFence.leaseId
    && row.senderLeaseHolderId === input.senderFence.holderId
    && row.senderLeaseHostId === input.senderFence.hostId
    && row.senderLeaseEpoch === input.senderFence.expectedEpoch;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal callback conflicts with immutable tombstone evidence");
  }
}

function assertSameRecordedTerminalAdmissionTimeoutOutcome(
  tombstone: AdmissionTimeoutTombstoneRow,
  proof: RoomProviderAdmissionTerminalGateOutcomeProofV1,
): void {
  const exact = tombstone.terminalGateOutcomeId === proof.outcomeId
    && tombstone.terminalGateOutcome === proof.outcome
    && tombstone.terminalAt === proof.occurredAt;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Terminal no-permit gate proof conflicts with the recorded timeout tombstone");
  }
}

function assertSameTerminalAdmissionTimeoutResolution(
  tombstone: AdmissionTimeoutTombstoneRow,
  input: ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1,
): void {
  const exact = tombstone.terminalGateOutcomeId !== null
    && tombstone.terminalGateOutcome !== null
    && tombstone.terminalAt !== null
    && tombstone.claimToken === input.claimToken
    && tombstone.nextAttemptAt === input.nextAttemptAt;
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Terminal no-permit retry schedule conflicts with the resolved timeout tombstone");
  }
}

function assertAdmissionTimeoutTerminalClaim(
  tombstone: AdmissionTimeoutTombstoneRow,
  input: ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1,
): void {
  const exact = tombstone.claimToken === input.claimToken
    && tombstone.claimLeaseId === input.cleanupWorkerLease.id
    && tombstone.claimLeaseEpoch === input.cleanupWorkerLease.epoch
    && tombstone.claimedAt !== null
    && tombstone.claimExpiresAt !== null
    && timestamp(tombstone.claimExpiresAt, "tombstone.claimExpiresAt") > timestamp(input.now, "now");
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal claim is stale or belongs to another recovery worker");
  }
}

function assertCleanupActionTargetsAdmissionTimeoutTombstone(
  tombstone: AdmissionTimeoutTombstoneRow,
  action: EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1,
): void {
  const exact = action.projectId === tombstone.projectId
    && action.roomId === tombstone.roomId
    && action.outboxId === tombstone.outboxId
    && action.outboxBindingId === tombstone.outboxBindingId
    && action.outboxAttemptId === null
    && action.outboxAttemptCount === tombstone.outboxAttemptCount
    && action.completionKind === "pre_claim_not_started";
  if (!exact) {
    throw new RoomProviderBackpressureCleanupActionsError("Late provider permit cleanup action does not target the tombstoned outbox generation");
  }
}

function isExactPendingAdmissionTimeoutOutbox(
  outbox: typeof roomOutbox.$inferSelect,
  input: FencePendingRoomProviderAdmissionTimeoutInputV1,
): boolean {
  return outbox.roomId === input.roomId
    && outbox.bindingId === input.outboxBindingId
    && outbox.deliveryState === "pending"
    && outbox.attemptCount === input.outboxAttemptCount
    && outbox.nativeAcknowledgement === null
    && outbox.nativeCursor === null;
}

function isExactFencedAdmissionTimeoutOutbox(
  outbox: typeof roomOutbox.$inferSelect,
  tombstone: AdmissionTimeoutTombstoneRow,
): boolean {
  return outbox.id === tombstone.outboxId
    && outbox.roomId === tombstone.roomId
    && outbox.bindingId === tombstone.outboxBindingId
    && outbox.deliveryState === "delivery_uncertain"
    && outbox.attemptCount === tombstone.outboxAttemptCount
    && outbox.nativeAcknowledgement === null
    && outbox.nativeCursor === null
    && outbox.reconciliationEvidenceRef === null
    && outbox.lastErrorCode === tombstone.timeoutErrorCode
    && outbox.nextAttemptAt === null;
}

async function loadByIdempotency(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  idempotencyKey: string,
): Promise<CleanupActionRow | null> {
  const rows = await tx.select().from(roomProviderBackpressureCleanupActions).where(and(
    eq(roomProviderBackpressureCleanupActions.projectId, projectId),
    eq(roomProviderBackpressureCleanupActions.roomId, roomId),
    eq(roomProviderBackpressureCleanupActions.idempotencyKey, idempotencyKey),
  )).orderBy(asc(roomProviderBackpressureCleanupActions.id)).limit(1);
  return rows[0] ?? null;
}

function assertSameImmutableAction(row: CleanupActionRow, input: RoomProviderBackpressureCleanupActionInputV1): void {
  const exact = row.id === input.actionId
    && row.outboxId === input.outboxId
    && row.outboxBindingId === (input.outboxBindingId ?? null)
    && row.outboxAttemptId === (input.outboxAttemptId ?? null)
    && row.outboxAttemptCount === (input.outboxAttemptCount ?? null)
    && row.reservationId === input.reservationId
    && row.requestId === input.requestId
    && row.claimId === input.claimId
    && row.originalLeaseId === input.originalWorkerFence.leaseId
    && row.originalLeaseHolderId === input.originalWorkerFence.holderId
    && row.originalLeaseHostId === input.originalWorkerFence.hostId
    && row.originalLeaseEpoch === input.originalWorkerFence.epoch
    && row.expectedAggregateVersion === input.expectedAggregateVersion
    && row.reservationExpiresAt === input.reservationExpiresAt
    && row.completionKind === input.completionKind;
  if (!exact) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action idempotency key conflicts with immutable cleanup evidence");
}

function isExactPendingPreClaimOutbox(
  outbox: typeof roomOutbox.$inferSelect | undefined,
  action: EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1,
): outbox is typeof roomOutbox.$inferSelect {
  return outbox !== undefined
    && outbox.roomId === action.roomId
    && outbox.bindingId === action.outboxBindingId
    && outbox.deliveryState === "pending"
    && outbox.attemptCount === action.outboxAttemptCount
    && outbox.nativeAcknowledgement === null
    && outbox.nativeCursor === null;
}

function isExactFencedPreClaimOutbox(
  outbox: typeof roomOutbox.$inferSelect | undefined,
  action: EnqueuePreClaimRoomProviderBackpressureCleanupActionInputV1,
  errorCode: string,
): outbox is typeof roomOutbox.$inferSelect {
  return outbox !== undefined
    && outbox.roomId === action.roomId
    && outbox.bindingId === action.outboxBindingId
    && outbox.deliveryState === "delivery_uncertain"
    && outbox.attemptCount === action.outboxAttemptCount
    && outbox.nativeAcknowledgement === null
    && outbox.nativeCursor === null
    && outbox.reconciliationEvidenceRef === null
    && outbox.lastErrorCode === errorCode
    && outbox.nextAttemptAt === null;
}

function isExactUncertainPreClaimOutbox(
  outbox: typeof roomOutbox.$inferSelect | undefined,
  action: CleanupActionRow & {
    readonly outboxId: string;
    readonly outboxBindingId: string;
    readonly outboxAttemptId: null;
    readonly outboxAttemptCount: number;
  },
): outbox is typeof roomOutbox.$inferSelect {
  return outbox !== undefined
    && outbox.id === action.outboxId
    && outbox.roomId === action.roomId
    && outbox.bindingId === action.outboxBindingId
    && outbox.deliveryState === "delivery_uncertain"
    && outbox.attemptCount === action.outboxAttemptCount
    && outbox.nativeAcknowledgement === null
    && outbox.nativeCursor === null
    && outbox.reconciliationEvidenceRef === null
    && outbox.nextAttemptAt === null;
}

function rowToAdmissionTimeoutTombstone(
  row: AdmissionTimeoutTombstoneRow,
): RoomProviderAdmissionTimeoutTombstoneV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONE_CONTRACT_VERSION,
    id: row.id,
    projectId: row.projectId,
    roomId: row.roomId,
    gateAttemptId: row.gateAttemptId,
    requestHash: row.requestHash,
    outboxId: row.outboxId,
    outboxBindingId: row.outboxBindingId,
    outboxAttemptCount: row.outboxAttemptCount,
    senderFence: Object.freeze({
      leaseId: row.senderLeaseId,
      holderId: row.senderLeaseHolderId,
      hostId: row.senderLeaseHostId,
      epoch: row.senderLeaseEpoch,
    }),
    timeoutErrorCode: row.timeoutErrorCode,
    recoveryProtocol: row.recoveryProtocol as RoomProviderAdmissionTimeoutRecoveryProtocolV1,
    recoveryReceiptId: row.recoveryReceiptId,
    state: row.state as RoomProviderAdmissionTimeoutTombstoneStateV1,
    cleanupActionId: row.cleanupActionId,
    reservationId: row.reservationId,
    terminalGateOutcomeId: row.terminalGateOutcomeId,
    terminalGateOutcome: row.terminalGateOutcome as RoomProviderAdmissionTerminalGateOutcomeV1 | null,
    terminalAt: row.terminalAt,
    claimToken: row.claimToken,
    claimLeaseId: row.claimLeaseId,
    claimLeaseEpoch: row.claimLeaseEpoch,
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    nextAttemptAt: row.nextAttemptAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function rowToOutboxRecord(row: typeof roomOutbox.$inferSelect): RoomOutboxRecordV1 {
  const acknowledgement = asRecord(row.nativeAcknowledgement);
  return Object.freeze({
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    logicalMessageId: row.logicalMessageId,
    localMessageId: row.localMessageId,
    bindingId: row.bindingId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    state: row.deliveryState as RoomOutboxRecordV1["state"],
    attemptCount: row.attemptCount,
    connectorAcknowledgementId: typeof acknowledgement.connectorAcknowledgementId === "string"
      ? acknowledgement.connectorAcknowledgementId
      : typeof acknowledgement.id === "string"
        ? acknowledgement.id
        : null,
    nativeMessageId: typeof acknowledgement.nativeMessageId === "string"
      ? acknowledgement.nativeMessageId
      : null,
    nativeCursor: row.nativeCursor,
    reconciliationFromCursor: row.reconciliationFromCursor,
    reconciliationEvidenceRef: row.reconciliationEvidenceRef,
    lastErrorCode: row.lastErrorCode,
    nextAttemptAt: row.nextAttemptAt,
    updatedAt: row.updatedAt,
  });
}

function rowToAction(row: CleanupActionRow): RoomProviderBackpressureCleanupActionV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTIONS_CONTRACT_VERSION,
    id: row.id,
    projectId: row.projectId,
    roomId: row.roomId,
    idempotencyKey: row.idempotencyKey,
    outboxId: row.outboxId,
    outboxBindingId: row.outboxBindingId,
    outboxAttemptId: row.outboxAttemptId,
    outboxAttemptCount: row.outboxAttemptCount,
    reservationId: row.reservationId,
    requestId: row.requestId,
    claimId: row.claimId,
    originalWorkerFence: Object.freeze({
      leaseId: row.originalLeaseId,
      holderId: row.originalLeaseHolderId,
      hostId: row.originalLeaseHostId,
      epoch: row.originalLeaseEpoch,
    }),
    expectedAggregateVersion: row.expectedAggregateVersion,
    reservationExpiresAt: row.reservationExpiresAt,
    completionKind: row.completionKind as RoomProviderBackpressureCleanupCompletionKindV1,
    state: row.state as RoomProviderBackpressureCleanupActionStateV1,
    attemptCount: row.attemptCount,
    claimToken: row.claimToken,
    claimLeaseId: row.claimLeaseId,
    claimLeaseEpoch: row.claimLeaseEpoch,
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    lastErrorCode: row.lastErrorCode,
    completedAt: row.completedAt,
    outboxUnblockedAt: row.outboxUnblockedAt,
    outboxFinalizedAt: row.outboxFinalizedAt,
    outboxFinalizationOutcome: row.outboxFinalizationOutcome as RoomProviderBackpressureCleanupOutboxFinalizationOutcomeV1 | null,
    outboxFinalizationReason: row.outboxFinalizationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function validateGenericEnqueueInput(input: RoomProviderBackpressureCleanupActionInputBaseV1): void {
  validateCleanupActionInput(input);
  if (input.completionKind === "pre_claim_not_started") {
    throw new RoomProviderBackpressureCleanupActionsError("Pre-claim cleanup evidence must be created only by fencePendingOutbox");
  }
}

function validatePreClaimEnqueueInput(input: RoomProviderBackpressureCleanupActionInputBaseV1): void {
  validateCleanupActionInput(input);
  if (input.completionKind !== "pre_claim_not_started") {
    throw new RoomProviderBackpressureCleanupActionsError("Pending outbox fencing requires pre-claim cleanup evidence");
  }
}

function validateCleanupActionInput(input: RoomProviderBackpressureCleanupActionInputBaseV1): void {
  const strings = [
    input.projectId, input.roomId, input.actionId, input.idempotencyKey, input.reservationId,
    input.requestId, input.claimId, input.originalWorkerFence.leaseId,
    input.originalWorkerFence.holderId, input.originalWorkerFence.hostId,
    input.reservationExpiresAt, input.createdAt,
  ];
  if (strings.some((value) => !canonicalString(value)) || (input.outboxId !== null && !canonicalString(input.outboxId))) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action has an invalid required identity field");
  }
  if (!Number.isSafeInteger(input.originalWorkerFence.epoch) || input.originalWorkerFence.epoch < 1
    || !Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action has an invalid durable fence");
  }
  if (input.completionKind !== "pre_send_not_started"
    && input.completionKind !== "pre_claim_not_started"
    && input.completionKind !== "late_admission_not_started") {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action completion kind is invalid");
  }
  const exactPreSendTarget = input.outboxId != null && input.outboxBindingId != null
    && input.outboxAttemptId != null && input.outboxAttemptCount != null;
  const exactPreClaimTarget = input.outboxId != null && input.outboxBindingId != null
    && input.outboxAttemptId === null && input.outboxAttemptCount != null;
  const legacyTargetless = input.outboxBindingId == null
    && input.outboxAttemptId == null
    && input.outboxAttemptCount == null;
  const validTarget = (input.completionKind === "pre_send_not_started" && exactPreSendTarget)
    || (input.completionKind === "pre_send_not_started" && legacyTargetless)
    || (input.completionKind === "pre_claim_not_started" && exactPreClaimTarget)
    || (input.completionKind === "late_admission_not_started" && legacyTargetless);
  if (!validTarget
    || (input.outboxBindingId != null && !canonicalString(input.outboxBindingId))
    || (input.outboxAttemptId != null && !canonicalString(input.outboxAttemptId))
    || (input.outboxAttemptCount != null && (!Number.isSafeInteger(input.outboxAttemptCount)
      || input.outboxAttemptCount < (input.completionKind === "pre_claim_not_started" ? 0 : 1)))) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action must carry one immutable claimed attempt, one immutable pending generation, or no target for late admission evidence");
  }
  const createdAt = timestamp(input.createdAt, "createdAt");
  const expiresAt = timestamp(input.reservationExpiresAt, "reservationExpiresAt");
  if (expiresAt <= createdAt) throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action expiry must follow creation");
}

function validateFencePendingAdmissionTimeoutInput(
  input: FencePendingRoomProviderAdmissionTimeoutInputV1,
): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.gateAttemptId) || !roomHash(input.requestHash)
    || !canonicalString(input.outboxId) || !canonicalString(input.outboxBindingId)
    || !Number.isSafeInteger(input.outboxAttemptCount) || input.outboxAttemptCount < 0
    || !canonicalString(input.errorCode)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout fence has invalid immutable evidence");
  }
  admissionTimeoutRecoveryProtocol(input.recoveryProtocol);
  if (input.senderFence.kind !== "sender" || input.senderFence.roomId !== input.roomId
    || input.senderFence.resourceId !== input.outboxBindingId
    || !canonicalString(input.senderFence.leaseId)
    || !canonicalString(input.senderFence.holderId)
    || !canonicalString(input.senderFence.hostId)
    || !Number.isSafeInteger(input.senderFence.expectedEpoch) || input.senderFence.expectedEpoch < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout fence requires the exact current sender lease");
  }
  timestamp(input.now, "now");
}

function admissionTimeoutRecoveryProtocol(
  value: FencePendingRoomProviderAdmissionTimeoutInputV1["recoveryProtocol"],
): RoomProviderAdmissionTimeoutRecoveryProtocolV1 {
  const protocol = value ?? "opaque";
  if (!ROOM_PROVIDER_ADMISSION_TIMEOUT_RECOVERY_PROTOCOLS.has(protocol)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout recovery protocol is invalid");
  }
  return protocol;
}

function validateBindAdmissionTimeoutReservationInput(
  input: BindRoomProviderAdmissionTimeoutReservationInputV1,
): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.gateAttemptId) || !roomHash(input.requestHash)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)
    || input.cleanupAction.projectId !== input.projectId
    || input.cleanupAction.roomId !== input.roomId
    || input.cleanupAction.createdAt !== input.now) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout late permit binding has invalid immutable evidence");
  }
  validatePreClaimEnqueueInput(input.cleanupAction);
  timestamp(input.now, "now");
}

function validateRecordAdmissionTimeoutTerminalOutcomeInput(
  input: RecordRoomProviderAdmissionTimeoutTerminalOutcomeInputV1,
): void {
  const proof = input.terminalGateOutcome;
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.gateAttemptId) || !roomHash(input.requestHash)
    || !canonicalString(input.outboxId) || !canonicalString(input.outboxBindingId)
    || !Number.isSafeInteger(input.outboxAttemptCount) || input.outboxAttemptCount < 0
    || !proof || !canonicalString(proof.outcomeId)
    || !ROOM_PROVIDER_ADMISSION_TERMINAL_GATE_OUTCOMES.has(proof.outcome)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal outcome has invalid immutable evidence");
  }
  if (proof.outcome === "core_sender_fenced_no_reservation") {
    throw new RoomProviderBackpressureCleanupActionsError("Only Core crash reconciliation may record a no-reservation terminal outcome");
  }
  if (input.senderFence.kind !== "sender" || input.senderFence.roomId !== input.roomId
    || input.senderFence.resourceId !== input.outboxBindingId
    || !canonicalString(input.senderFence.leaseId)
    || !canonicalString(input.senderFence.holderId)
    || !canonicalString(input.senderFence.hostId)
    || !Number.isSafeInteger(input.senderFence.expectedEpoch) || input.senderFence.expectedEpoch < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal outcome requires the original sender fence identity");
  }
  const now = timestamp(input.now, "now");
  if (timestamp(proof.occurredAt, "terminalGateOutcome.occurredAt") > now) {
    throw new RoomProviderBackpressureCleanupActionsError("Terminal no-permit gate proof cannot occur after recording");
  }
}

function validateClaimNextAdmissionTimeoutTerminalOutcomeInput(
  input: ClaimNextRoomProviderAdmissionTimeoutTerminalOutcomeInputV1,
): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal claim scope is invalid");
  }
  timestamp(input.now, "now");
}

function validateReconcilePendingAdmissionTimeoutInput(
  input: ReconcilePendingRoomProviderAdmissionTimeoutInputV1,
): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout crash reconciliation has invalid immutable evidence");
  }
  timestamp(input.now, "now");
}

function validateResolveAdmissionTimeoutWithoutPermitInput(
  input: ResolveRoomProviderAdmissionTimeoutWithoutPermitInputV1,
): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.gateAttemptId) || !roomHash(input.requestHash)
    || !canonicalString(input.claimToken)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout terminal resolution has invalid immutable evidence");
  }
  const now = timestamp(input.now, "now");
  if (timestamp(input.nextAttemptAt, "nextAttemptAt") <= now) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider admission timeout resolution requires a future nextAttemptAt");
  }
}

function validateFencePendingInput(input: FencePendingRoomProviderBackpressureOutboxInputV1): void {
  if (input.action.completionKind !== "pre_claim_not_started"
    || !canonicalString(input.errorCode)
    || !canonicalString(input.audit.runId)
    || !canonicalString(input.audit.agentId)
    || input.action.createdAt !== input.now) {
    throw new RoomProviderBackpressureCleanupActionsError("Pending outbox cleanup fence has invalid immutable evidence");
  }
  if (input.senderFence.kind !== "sender" || input.senderFence.roomId !== input.action.roomId
    || input.senderFence.resourceId !== input.action.outboxBindingId
    || !canonicalString(input.senderFence.leaseId)
    || !canonicalString(input.senderFence.holderId)
    || !canonicalString(input.senderFence.hostId)
    || !Number.isSafeInteger(input.senderFence.expectedEpoch) || input.senderFence.expectedEpoch < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Pending outbox cleanup fence requires the exact current sender lease");
  }
  timestamp(input.now, "now");
}

function validateClaimInput(input: ClaimNextRoomProviderBackpressureCleanupActionInputV1): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action claim input is invalid");
  }
  timestamp(input.now, "now");
}

function validateMarkExpiredInput(input: MarkRoomProviderBackpressureCleanupActionExpiredInputV1): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId)
    || !canonicalString(input.actionId) || !canonicalString(input.claimToken)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action expiry input is invalid");
  }
  timestamp(input.now, "now");
}

function validateFinalizeInput(input: FinalizeRoomProviderBackpressureCleanupOutboxInputV1): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId) || !canonicalString(input.actionId)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup outbox finalization input is invalid");
  }
  timestamp(input.now, "now");
}

function validateFinalizeTerminalPreClaimInput(input: FinalizeTerminalPreClaimOutboxInputV1): void {
  if (!canonicalString(input.projectId) || !canonicalString(input.roomId) || !canonicalString(input.actionId)
    || !canonicalString(input.audit.runId) || !canonicalString(input.audit.agentId)) {
    throw new RoomProviderBackpressureCleanupActionsError("Terminal pre-claim outbox finalization input is invalid");
  }
  const now = timestamp(input.now, "now");
  if (timestamp(input.nextAttemptAt, "nextAttemptAt") <= now) {
    throw new RoomProviderBackpressureCleanupActionsError("Terminal pre-claim outbox finalization requires a future nextAttemptAt");
  }
}

function assertExactPreSendTarget(action: CleanupActionRow): asserts action is CleanupActionRow & {
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptId: string;
  readonly outboxAttemptCount: number;
} {
  const attemptCount = action.outboxAttemptCount;
  if (!canonicalString(action.outboxId ?? "") || !canonicalString(action.outboxBindingId ?? "")
    || !canonicalString(action.outboxAttemptId ?? "") || attemptCount === null || !Number.isSafeInteger(attemptCount)
    || attemptCount < 1) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action has no immutable pre-send outbox target");
  }
}

function assertPreClaimTarget(action: CleanupActionRow): asserts action is CleanupActionRow & {
  readonly outboxId: string;
  readonly outboxBindingId: string;
  readonly outboxAttemptId: null;
  readonly outboxAttemptCount: number;
} {
  const attemptCount = action.outboxAttemptCount;
  if (!canonicalString(action.outboxId ?? "") || !canonicalString(action.outboxBindingId ?? "")
    || action.outboxAttemptId !== null || attemptCount === null || !Number.isSafeInteger(attemptCount)
    || attemptCount < 0) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action has no immutable pending outbox generation");
  }
}

async function assertCurrentSenderFence(
  tx: DbTransaction, projectId: string, roomId: string, bindingId: string, lease: StoredRoomLeaseV1, now: string,
): Promise<void> {
  if (lease.kind !== "sender" || lease.roomId !== roomId || lease.resourceId !== bindingId) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup outbox finalization requires the current sender fence for its binding");
  }
  await lockRoomLeaseResourceWithinTransaction(tx, projectId, "sender", bindingId);
  await assertRoomLeaseFence(tx, projectId, {
    leaseId: lease.id, roomId, kind: "sender", resourceId: bindingId,
    holderId: lease.holderId, hostId: lease.hostId, expectedEpoch: lease.epoch, now,
  });
}

async function assertCurrentSenderFenceInput(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  bindingId: string,
  fence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" },
  now: string,
): Promise<void> {
  if (fence.kind !== "sender" || fence.roomId !== roomId || fence.resourceId !== bindingId) {
    throw new RoomProviderBackpressureCleanupActionsError("Pending outbox cleanup fencing requires the current sender fence for its binding");
  }
  await lockRoomLeaseResourceWithinTransaction(tx, projectId, "sender", bindingId);
  await assertRoomLeaseFence(tx, projectId, { ...fence, now });
}

function assertProjectScope(boundProjectId: string | undefined, projectId: string): void {
  if (boundProjectId && boundProjectId !== projectId) {
    throw new RoomProviderBackpressureCleanupActionsError("Provider cleanup action project scope conflicts with its data layer");
  }
}

function canonicalString(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function roomHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RoomProviderBackpressureCleanupActionsError(`Provider cleanup action ${name} must be an ISO timestamp`);
  return parsed;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}
