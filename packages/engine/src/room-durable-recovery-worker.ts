import { randomUUID } from "node:crypto";

import {
  acquireRoomRecoverySenderLease,
  recoverRoomAfterCrash,
  type AsyncDataLayer,
  type AsyncRoomCheckpointStore,
  type AsyncRoomLeaseStore,
  type AsyncRoomStore,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  dispatchRoomDelivery,
  reconcileAmbiguousRoomDelivery,
} from "./room-delivery-coordinator.js";
import type { RoomWorker, RoomWorkerRunInput } from "./room-controller.js";
import type { SessionConnectorRegistry } from "./session-connector-registry.js";

const DEFAULT_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_SENDER_LEASE_DURATION_MS = 30_000;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_MAX_HISTORY_PAGES = 20;

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
}

/**
 * Production Room worker that continuously re-enters the PostgreSQL recovery
 * path under the controller's durable room-worker fence. Provider operations
 * are delegated to the certified Session Connector registry; this worker never
 * invents an acknowledgement or retries an ambiguous external send.
 */
export class DurableRoomRecoveryWorker implements RoomWorker {
  private readonly now: () => string;
  private readonly createSenderLeaseId: (roomId: string, bindingId: string) => string;
  private readonly recoveryIntervalMs: number;
  private readonly senderLeaseDurationMs: number;
  private readonly historyPageSize: number;
  private readonly maxHistoryPages: number;

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
            }),
            reconcile: (delivery) => reconcileAmbiguousRoomDelivery({
              ...delivery,
              registry: this.options.registry,
            }),
          },
          roomWorkerLease: authority.lease,
          senderLease: null,
          currentTime: this.now,
          signal: input.signal,
          assertAuthority: async () => {
            throwIfAborted(input.signal);
            const current = await input.assertAuthority();
            this.assertWorkerIdentity(roomId, current.lease);
            throwIfAborted(input.signal);
          },
          resolveSenderLease: async (bindingId) => {
            throwIfAborted(input.signal);
            const currentAuthority = await input.assertAuthority();
            this.assertWorkerIdentity(roomId, currentAuthority.lease);
            const now = this.now();
            const existing = resolvedSenderLeases.get(bindingId);
            if (existing) {
              try {
                await this.options.leaseStore.assertFence({
                  leaseId: existing.id,
                  roomId: existing.roomId,
                  kind: existing.kind,
                  resourceId: existing.resourceId,
                  holderId: existing.holderId,
                  hostId: existing.hostId,
                  expectedEpoch: existing.epoch,
                  now,
                });
                return existing;
              } catch (error) {
                if (!hasErrorCode(error, "stale_lease_fence")) throw error;
                resolvedSenderLeases.delete(bindingId);
              }
            }
            const leaseId = this.createSenderLeaseId(roomId, bindingId);
            const senderLease = await acquireRoomRecoverySenderLease({
              projectId: this.options.projectId,
              roomId,
              bindingId,
              workerId: this.options.workerId,
              hostId: this.options.hostId,
              leaseId,
              layer: this.options.layer,
              leaseStore: this.options.leaseStore,
              now,
              expiresAt: addMilliseconds(now, this.senderLeaseDurationMs),
            });
            if (senderLease) {
              resolvedSenderLeases.set(bindingId, senderLease);
              if (senderLease.id === leaseId) senderLeaseIdsAcquiredByRecovery.add(leaseId);
            }
            return senderLease;
          },
          historyPageSize: this.historyPageSize,
          maxHistoryPages: this.maxHistoryPages,
          now: this.now(),
          audit: {
            runId: `room-recovery:${roomId}:epoch:${authority.lease.epoch}`,
            agentId: this.options.workerId,
          },
        });
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
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
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
