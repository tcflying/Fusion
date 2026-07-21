import { randomUUID } from "node:crypto";

import {
  acquireRoomRecoverySenderLease,
  createRoomProviderBackpressureCleanupActions,
  recoverRoomAfterCrash,
  type AsyncDataLayer,
  type AsyncRoomCheckpointStore,
  type AsyncRoomLeaseStore,
  type AsyncRoomStore,
  type RoomProviderAdmissionTimeoutTombstoneV1,
  type RoomProviderBackpressureCleanupActions,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  dispatchRoomDelivery,
  reconcileAmbiguousRoomDelivery,
} from "./room-delivery-coordinator.js";
import type { RoomProviderBackpressureSendGateV1 } from "./room-provider-backpressure-send-boundary.js";
import { RoomProviderBackpressureCleanupActionProcessor } from "./room-provider-backpressure-cleanup-action-processor.js";
import type { RoomWorker, RoomWorkerRunInput } from "./room-controller.js";
import {
  RoomTaskRecoveryActionProcessor,
  type RoomTaskRecoveryActionConsumer,
} from "./room-task-recovery-action-processor.js";
import { createRoomTaskRecoveryPlanConsumer } from "./room-task-recovery-plan-consumer.js";
import type { SessionConnectorRegistry } from "./session-connector-registry.js";

const DEFAULT_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_SENDER_LEASE_DURATION_MS = 30_000;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_MAX_HISTORY_PAGES = 20;
const DEFAULT_PROVIDER_ADMISSION_TIMEOUT_TERMINAL_CLAIM_TTL_MS = 60_000;
const DEFAULT_PROVIDER_ADMISSION_TIMEOUT_TERMINAL_RETRY_DELAY_MS = 1_000;

type DurableRoomProviderBackpressureCleanupActions = Pick<
  RoomProviderBackpressureCleanupActions,
  | "enqueue"
  | "fencePendingOutbox"
  | "claimNext"
  | "markExpired"
  | "finalizeExactPreSendOutbox"
  | "finalizeTerminalPreClaimOutbox"
  | "reconcilePendingAdmissionTimeout"
  | "claimNextAdmissionTimeoutTerminalOutcome"
  | "resolveAdmissionTimeoutWithoutPermit"
>;

export interface DurableRoomRecoveryWorkerOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly layer: AsyncDataLayer;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly checkpointStore: AsyncRoomCheckpointStore;
  readonly registry: SessionConnectorRegistry;
  readonly now?: () => string;
  readonly createSenderLeaseId?: (roomId: string, bindingId: string) => string;
  readonly recoveryIntervalMs?: number;
  readonly senderLeaseDurationMs?: number;
  readonly historyPageSize?: number;
  readonly maxHistoryPages?: number;
  /**
   * A Core-backed exact provider admission gate. This worker forwards it only;
   * it never derives provider account/model/node scope or telemetry itself.
   */
  readonly providerBackpressureSendGate?: RoomProviderBackpressureSendGateV1;
  /**
   * Durable cleanup ownership for a provider permit that completed late or
   * could not prove its pre-send release. Production defaults to Core's
   * reservation-backed implementation when a provider gate exists.
   */
  readonly providerBackpressureCleanupActions?: DurableRoomProviderBackpressureCleanupActions;
  /**
   * Backend-local handoff that returns a durable controller-plan/approval receipt.
   * No provider invocation is permitted on this recovery path.
   */
  readonly taskRecoveryActionConsumer?: RoomTaskRecoveryActionConsumer;
}

/**
 * Production Room worker that continuously re-enters the PostgreSQL recovery
 * path under the controller's durable room-worker fence. Provider operations
 * are delegated to the certified Session Connector registry; this worker never
 * invents an acknowledgement or retries an ambiguous external send.
 */
export class DurableRoomRecoveryWorker implements RoomWorker {
  readonly supportsDurableTaskDispatch = true;
  private readonly now: () => string;
  private readonly createSenderLeaseId: (roomId: string, bindingId: string) => string;
  private readonly recoveryIntervalMs: number;
  private readonly senderLeaseDurationMs: number;
  private readonly historyPageSize: number;
  private readonly maxHistoryPages: number;
  private readonly taskRecoveryActionProcessor: RoomTaskRecoveryActionProcessor | null;
  private readonly providerBackpressureCleanupActions: DurableRoomProviderBackpressureCleanupActions | null;
  private readonly providerBackpressureCleanupActionProcessor: RoomProviderBackpressureCleanupActionProcessor | null;

  constructor(private readonly options: DurableRoomRecoveryWorkerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createSenderLeaseId = options.createSenderLeaseId
      ?? ((roomId, bindingId) => `room-recovery-sender:${roomId}:${bindingId}:${randomUUID()}`);
    this.recoveryIntervalMs = positiveInteger(
      options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
      "recoveryIntervalMs",
    );
    this.senderLeaseDurationMs = positiveInteger(
      options.senderLeaseDurationMs ?? DEFAULT_SENDER_LEASE_DURATION_MS,
      "senderLeaseDurationMs",
    );
    this.historyPageSize = positiveInteger(
      options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
      "historyPageSize",
    );
    this.maxHistoryPages = positiveInteger(
      options.maxHistoryPages ?? DEFAULT_MAX_HISTORY_PAGES,
      "maxHistoryPages",
    );
    const cleanupActions = options.providerBackpressureCleanupActions
      ?? (options.providerBackpressureSendGate
        ? createRoomProviderBackpressureCleanupActions({
            layer: options.layer,
            projectId: options.projectId,
          })
        : null);
    /*
    FNXC:RoomProviderPreClaimTerminalRecovery 2026-07-20-22:38:
    A recovery adapter without Core's direct pre-claim finalizer would force a
    delivery-uncertain pre-claim fence through sender-lease acquisition and can
    deadlock behind the very live sender it must respect. Refuse that adapter
    before any recovery pass starts.
    */
    if (
      cleanupActions
      && (
        typeof cleanupActions.enqueue !== "function"
        || typeof cleanupActions.fencePendingOutbox !== "function"
        || typeof cleanupActions.claimNext !== "function"
        || typeof cleanupActions.markExpired !== "function"
        || typeof cleanupActions.finalizeExactPreSendOutbox !== "function"
        || typeof cleanupActions.finalizeTerminalPreClaimOutbox !== "function"
        || typeof cleanupActions.reconcilePendingAdmissionTimeout !== "function"
        || typeof cleanupActions.claimNextAdmissionTimeoutTerminalOutcome !== "function"
        || typeof cleanupActions.resolveAdmissionTimeoutWithoutPermit !== "function"
      )
    ) {
      throw new Error("DurableRoomRecoveryWorker providerBackpressureCleanupActions require enqueue, fencePendingOutbox, claimNext, markExpired, finalizeExactPreSendOutbox, finalizeTerminalPreClaimOutbox, reconcilePendingAdmissionTimeout, claimNextAdmissionTimeoutTerminalOutcome, and resolveAdmissionTimeoutWithoutPermit");
    }
    this.providerBackpressureCleanupActions = cleanupActions;
    this.providerBackpressureCleanupActionProcessor = cleanupActions
      ? new RoomProviderBackpressureCleanupActionProcessor({
          projectId: options.projectId,
          workerId: options.workerId,
          hostId: options.hostId,
          cleanupActions,
          now: this.now,
        })
      : null;
    const taskRecoveryActionConsumer = options.taskRecoveryActionConsumer
      ?? (hasRecoveryPlanStore(options.roomStore)
        ? createRoomTaskRecoveryPlanConsumer(options.roomStore)
        : null);
    this.taskRecoveryActionProcessor = taskRecoveryActionConsumer
      ? new RoomTaskRecoveryActionProcessor({
          workerId: options.workerId,
          hostId: options.hostId,
          store: options.roomStore,
          now: this.now,
          consumeAction: taskRecoveryActionConsumer,
        })
      : null;
  }

  async runRoom(input: RoomWorkerRunInput): Promise<void> {
    if (input.signal.aborted) return;
    const roomId = input.room.room.id;
    this.assertWorkerIdentity(roomId, input.lease);

    while (!input.signal.aborted) {
      const authority = await input.assertAuthority();
      this.assertWorkerIdentity(roomId, authority.lease);
      const resolvedSenderLeases = new Map<string, StoredRoomLeaseV1>();
      const senderLeaseIdsAcquiredByRecovery = new Set<string>();
      const resolveRecoverySenderLease = async (bindingId: string): Promise<StoredRoomLeaseV1 | null> => {
        throwIfAborted(input.signal);
        const currentAuthority = await input.assertAuthority();
        this.assertWorkerIdentity(roomId, currentAuthority.lease);
        const now = this.now();
        const existing = resolvedSenderLeases.get(bindingId);
        if (existing) {
          try {
            await this.options.leaseStore.assertFence({ leaseId: existing.id, roomId: existing.roomId, kind: existing.kind, resourceId: existing.resourceId, holderId: existing.holderId, hostId: existing.hostId, expectedEpoch: existing.epoch, now });
            return existing;
          } catch (error) {
            if (!hasErrorCode(error, "stale_lease_fence")) throw error;
            resolvedSenderLeases.delete(bindingId);
          }
        }
        const leaseId = this.createSenderLeaseId(roomId, bindingId);
        const senderLease = await acquireRoomRecoverySenderLease({ projectId: this.options.projectId, roomId, bindingId, workerId: this.options.workerId, hostId: this.options.hostId, leaseId, layer: this.options.layer, leaseStore: this.options.leaseStore, now, expiresAt: addMilliseconds(now, this.senderLeaseDurationMs) });
        if (senderLease) {
          resolvedSenderLeases.set(bindingId, senderLease);
          if (senderLease.id === leaseId) senderLeaseIdsAcquiredByRecovery.add(leaseId);
        }
        return senderLease;
      };
      try {
        let admissionTimeoutPreflightHandled: boolean;
        try {
          admissionTimeoutPreflightHandled = await this.reconcilePendingAdmissionTimeout(
            input,
            roomId,
            authority.lease,
          );
        } catch (error) {
          if (hasErrorCode(error, "57014")) return;
          throw error;
        }
        /*
        FNXC:RoomProviderAdmissionTimeoutReceiptPreflight 2026-07-21-01:52:
        Core owns the receipt-backed pending-timeout transition. A non-null
        preflight result has durably bound a reservation, recorded no-permit
        evidence, or yielded to a live sender; stop this pass before claim,
        sender acquisition, connector dispatch, or ordinary crash recovery.
        */
        if (admissionTimeoutPreflightHandled) return;

        let admissionTimeoutRecovery: "continue" | "retry_later";
        try {
          admissionTimeoutRecovery = await this.recoverRecordedAdmissionTimeoutTerminalProof(
            input,
            roomId,
            authority.lease,
          );
        } catch (error) {
          if (hasErrorCode(error, "57014")) return;
          throw error;
        }
        /*
        FNXC:RoomProviderAdmissionTimeoutRetryLaterStop 2026-07-21-00:00:
        A live sender made Core retain this exact terminal-proof claim. Do not
        spin the same Room worker into ordinary recovery: a later claim lookup
        would only report null while the claim is still fenced. Return so the
        claim can expire with this worker lease and be rediscovered under a
        fresh fenced authority, never by an Engine-local timer workaround.
        */
        if (admissionTimeoutRecovery === "retry_later") return;

        if (this.providerBackpressureCleanupActionProcessor && !input.signal.aborted) {
          /*
          FNXC:RoomProviderCleanupRecoveryPriority 2026-07-20-01:15:
          A stuck connector-history reconciliation must never starve a durable
          permit cleanup action. Run the provider-only cleanup pass first under
          the current Room-worker fence; it cannot contact a provider or revive
          the original send, so it is safe to prioritize ahead of crash
          reconciliation. Reassert the fence before any later recovery work.
          */
          const cleanup = await this.providerBackpressureCleanupActionProcessor.process({
            roomId,
            lease: authority.lease,
            renewLease: async () => {
              const renewed = await input.assertAuthority();
              this.assertWorkerIdentity(roomId, renewed.lease);
              return renewed.lease;
            },
            observeLease: async () => {
              const observed = await input.assertAuthority();
              this.assertWorkerIdentity(roomId, observed.lease);
              return observed.lease;
            },
            resolveSenderLease: resolveRecoverySenderLease,
            canContinue: () => !input.signal.aborted,
          });
          if (cleanup.stopped) return;
        }
        const recoveryStartAuthority = await input.assertAuthority();
        this.assertWorkerIdentity(roomId, recoveryStartAuthority.lease);
        try {
          await recoverRoomAfterCrash({
            projectId: this.options.projectId,
            roomId,
            workerId: this.options.workerId,
            hostId: this.options.hostId,
            layer: this.options.layer,
            roomStore: this.options.roomStore,
            leaseStore: this.options.leaseStore,
            checkpointStore: this.options.checkpointStore,
            deliveryCoordinator: {
              dispatch: (delivery) => dispatchRoomDelivery({
                ...delivery,
                registry: this.options.registry,
                providerBackpressure: this.options.providerBackpressureSendGate,
                ...(this.providerBackpressureCleanupActions
                  ? {
                      providerBackpressureCleanupActions: this.providerBackpressureCleanupActions,
                      providerBackpressureCleanupContext: { projectId: this.options.projectId },
                    }
                  : {}),
              }),
              reconcile: (delivery) => reconcileAmbiguousRoomDelivery({
                ...delivery,
                registry: this.options.registry,
              }),
            },
            roomWorkerLease: recoveryStartAuthority.lease,
            senderLease: null,
            currentTime: this.now,
            signal: input.signal,
            assertAuthority: async () => {
              throwIfAborted(input.signal);
              const current = await input.assertAuthority();
              this.assertWorkerIdentity(roomId, current.lease);
              throwIfAborted(input.signal);
            },
            resolveSenderLease: resolveRecoverySenderLease,
            historyPageSize: this.historyPageSize,
            maxHistoryPages: this.maxHistoryPages,
            now: this.now(),
            audit: {
              runId: `room-recovery:${roomId}:epoch:${recoveryStartAuthority.lease.epoch}`,
              agentId: this.options.workerId,
            },
          });
        } catch (error) {
          /*
          FNXC:RoomDurableRecoveryPostgresTimeout 2026-07-21-01:15:
          SQLSTATE 57014 leaves Core crash recovery without a safe completion
          result. End this worker round before any follow-on recovery can
          acquire sender authority or dispatch a connector; stale fences and
          every other failure remain visible to their existing recovery path.
          */
          if (hasErrorCode(error, "57014")) return;
          throw error;
        }
        if (input.signal.aborted) break;
        const recoveryAuthority = await input.assertAuthority();
        this.assertWorkerIdentity(roomId, recoveryAuthority.lease);
        await this.options.roomStore.recoverNoProgressTaskDispatches({
          roomId,
          roomWorkerFence: {
            leaseId: recoveryAuthority.lease.id,
            holderId: recoveryAuthority.lease.holderId,
            hostId: recoveryAuthority.lease.hostId,
            expectedEpoch: recoveryAuthority.lease.epoch,
          },
          now: this.now(),
        });
        if (this.taskRecoveryActionProcessor && !input.signal.aborted) {
          /*
          FNXC:SessionRoomTaskProgressRecovery 2026-07-18-08:09:
          No-progress action execution remains inside the existing durable Room
          worker, never a second scheduler. The optional consumer can only
          produce a hash-checked controller-plan or approval receipt; without
          that configured handoff the worker leaves the pending action visible
          instead of fabricating a provider-side recovery.
          */
          await this.taskRecoveryActionProcessor.process({
            roomId,
            lease: recoveryAuthority.lease,
            renewLease: async () => {
              const renewed = await input.assertAuthority();
              this.assertWorkerIdentity(roomId, renewed.lease);
              return renewed.lease;
            },
            observeLease: async () => {
              const observed = await input.assertAuthority();
              this.assertWorkerIdentity(roomId, observed.lease);
              return observed.lease;
            },
            canContinue: () => !input.signal.aborted,
          });
        }
      } finally {
        for (const senderLease of resolvedSenderLeases.values()) {
          if (!senderLeaseIdsAcquiredByRecovery.has(senderLease.id)) continue;
          await this.options.leaseStore.releaseLease({
            leaseId: senderLease.id,
            roomId: senderLease.roomId,
            kind: "sender",
            resourceId: senderLease.resourceId,
            holderId: senderLease.holderId,
            hostId: senderLease.hostId,
            expectedEpoch: senderLease.epoch,
            now: this.now(),
          });
        }
      }

      if (input.signal.aborted) return;
      await waitForIntervalOrAbort(input.signal, this.recoveryIntervalMs);
    }
  }

  private assertWorkerIdentity(roomId: string, lease: StoredRoomLeaseV1): void {
    if (
      lease.kind !== "room_worker"
      || lease.roomId !== roomId
      || lease.resourceId !== roomId
      || lease.holderId !== this.options.workerId
      || lease.hostId !== this.options.hostId
    ) {
      throw new Error(`Durable Room recovery worker received an invalid authority fence for ${roomId}`);
    }
  }

  private async reconcilePendingAdmissionTimeout(
    input: RoomWorkerRunInput,
    roomId: string,
    cleanupWorkerLease: StoredRoomLeaseV1,
  ): Promise<boolean> {
    const actions = this.providerBackpressureCleanupActions;
    if (!actions) return false;
    throwIfAborted(input.signal);
    const reconciliation = await actions.reconcilePendingAdmissionTimeout({
      projectId: this.options.projectId,
      roomId,
      cleanupWorkerLease,
      now: this.now(),
      audit: {
        runId: `room-provider-admission-timeout-reconcile:${roomId}:epoch:${cleanupWorkerLease.epoch}`,
        agentId: this.options.workerId,
      },
    });
    return reconciliation !== null;
  }

  private async recoverRecordedAdmissionTimeoutTerminalProof(
    input: RoomWorkerRunInput,
    roomId: string,
    cleanupWorkerLease: StoredRoomLeaseV1,
  ): Promise<"continue" | "retry_later"> {
    const actions = this.providerBackpressureCleanupActions;
    if (!actions) return "continue";
    throwIfAborted(input.signal);
    const claimNow = this.now();
    const claimed = await actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: this.options.projectId,
      roomId,
      cleanupWorkerLease,
      now: claimNow,
      claimTtlMs: DEFAULT_PROVIDER_ADMISSION_TIMEOUT_TERMINAL_CLAIM_TTL_MS,
    });
    if (claimed === null) return "continue";
    this.assertClaimedAdmissionTimeoutTerminalProof(roomId, cleanupWorkerLease, claimed, claimNow);

    /*
    FNXC:RoomProviderAdmissionTimeoutRestartFence 2026-07-20-23:59:
    The claim is bound to the exact fresh Room-worker lease. Re-prove that
    lease before resolution; if another worker took it over, leave the durable
    claim untouched for Core expiry/reclaim rather than resolving under a
    replacement fence or inventing a sender lease.
    */
    throwIfAborted(input.signal);
    const resolutionAuthority = await input.assertAuthority();
    this.assertWorkerIdentity(roomId, resolutionAuthority.lease);
    if (!sameLeaseFence(cleanupWorkerLease, resolutionAuthority.lease)) return "retry_later";

    const resolutionNow = this.now();
    const result = await actions.resolveAdmissionTimeoutWithoutPermit({
      projectId: this.options.projectId,
      roomId,
      gateAttemptId: claimed.gateAttemptId,
      requestHash: claimed.requestHash,
      cleanupWorkerLease,
      claimToken: claimed.claimToken!,
      now: resolutionNow,
      nextAttemptAt: addMilliseconds(
        resolutionNow,
        DEFAULT_PROVIDER_ADMISSION_TIMEOUT_TERMINAL_RETRY_DELAY_MS,
      ),
      audit: {
        runId: `room-provider-admission-timeout-recovery:${claimed.id}:epoch:${cleanupWorkerLease.epoch}`,
        agentId: this.options.workerId,
      },
    });
    if (result.status === "retry_later") {
      this.assertRetainedAdmissionTimeoutTerminalProof(roomId, cleanupWorkerLease, claimed, result.tombstone);
      return "retry_later";
    }
    this.assertResolvedAdmissionTimeoutTerminalProof(roomId, result.tombstone, result.outbox.nextAttemptAt);
    return "continue";
  }

  private assertClaimedAdmissionTimeoutTerminalProof(
    roomId: string,
    cleanupWorkerLease: StoredRoomLeaseV1,
    tombstone: RoomProviderAdmissionTimeoutTombstoneV1,
    now: string,
  ): void {
    if (
      tombstone.roomId !== roomId
      || tombstone.projectId !== this.options.projectId
      || tombstone.state !== "terminal_outcome_claimed"
      || tombstone.cleanupActionId !== null
      || tombstone.reservationId !== null
      || !nonBlankString(tombstone.gateAttemptId)
      || !nonBlankString(tombstone.requestHash)
      || !nonBlankString(tombstone.terminalGateOutcomeId)
      || tombstone.terminalGateOutcome === null
      || !nonBlankString(tombstone.terminalAt)
      || !nonBlankString(tombstone.claimToken)
      || tombstone.claimLeaseId !== cleanupWorkerLease.id
      || tombstone.claimLeaseEpoch !== cleanupWorkerLease.epoch
      || !nonBlankString(tombstone.claimExpiresAt)
      || Date.parse(tombstone.claimExpiresAt) <= Date.parse(now)
      || tombstone.nextAttemptAt !== null
      || tombstone.resolvedAt !== null
    ) {
      throw new Error("Durable Room recovery received an invalid claimed provider admission-timeout terminal proof");
    }
  }

  private assertRetainedAdmissionTimeoutTerminalProof(
    roomId: string,
    cleanupWorkerLease: StoredRoomLeaseV1,
    claimed: RoomProviderAdmissionTimeoutTombstoneV1,
    tombstone: RoomProviderAdmissionTimeoutTombstoneV1,
  ): void {
    if (
      tombstone.roomId !== roomId
      || tombstone.projectId !== this.options.projectId
      || tombstone.id !== claimed.id
      || tombstone.state !== "terminal_outcome_claimed"
      || tombstone.claimToken !== claimed.claimToken
      || tombstone.claimLeaseId !== cleanupWorkerLease.id
      || tombstone.claimLeaseEpoch !== cleanupWorkerLease.epoch
      || tombstone.cleanupActionId !== null
      || tombstone.reservationId !== null
      || tombstone.nextAttemptAt !== null
      || tombstone.resolvedAt !== null
    ) {
      throw new Error("Core retry_later did not retain the claimed provider admission-timeout proof");
    }
  }

  private assertResolvedAdmissionTimeoutTerminalProof(
    roomId: string,
    tombstone: RoomProviderAdmissionTimeoutTombstoneV1,
    outboxNextAttemptAt: string | null,
  ): void {
    if (
      tombstone.roomId !== roomId
      || tombstone.projectId !== this.options.projectId
      || tombstone.state !== "terminal_without_permit"
      || tombstone.cleanupActionId !== null
      || tombstone.reservationId !== null
      || !nonBlankString(tombstone.terminalGateOutcomeId)
      || tombstone.terminalGateOutcome === null
      || !nonBlankString(tombstone.terminalAt)
      || !nonBlankString(tombstone.nextAttemptAt)
      || !nonBlankString(tombstone.resolvedAt)
      || tombstone.nextAttemptAt !== outboxNextAttemptAt
    ) {
      throw new Error("Core admission-timeout resolution did not return a future-gated no-permit terminal state");
    }
  }
}

function hasRecoveryPlanStore(
  store: AsyncRoomStore,
): store is AsyncRoomStore & {
  readonly recordRoomTaskRecoveryPlan: AsyncRoomStore["recordRoomTaskRecoveryPlan"];
} {
  return typeof (store as unknown as { readonly recordRoomTaskRecoveryPlan?: unknown })
    .recordRoomTaskRecoveryPlan === "function";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function sameLeaseFence(left: StoredRoomLeaseV1, right: StoredRoomLeaseV1): boolean {
  return left.id === right.id
    && left.roomId === right.roomId
    && left.kind === right.kind
    && left.resourceId === right.resourceId
    && left.holderId === right.holderId
    && left.hostId === right.hostId
    && left.epoch === right.epoch;
}

function nonBlankString(value: string | null): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`Room recovery now() must return a canonical ISO timestamp, received ${timestamp}`);
  }
  return new Date(parsed + milliseconds).toISOString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Room recovery aborted");
  error.name = "AbortError";
  throw error;
}

function waitForIntervalOrAbort(signal: AbortSignal, intervalMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
