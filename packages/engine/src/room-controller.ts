import { randomUUID } from "node:crypto";

import type { RoomAggregateV1, StoredRoomLeaseV1 } from "@fusion/core";

import { createLogger } from "./logger.js";

const roomControllerLog = createLogger("room-controller");

export interface RoomControllerRoomStore {
  listRunnableRooms(): Promise<readonly RoomAggregateV1[]>;
  subscribe?(listener: () => void | Promise<void>): () => void;
}

export interface RoomControllerLeaseStore {
  acquireLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number | null;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; action: "acquired" | "taken_over"; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "active" | "stale_epoch"; current: StoredRoomLeaseV1 | null }
  >;
  renewLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "not_found" | "stale_fence" | "expired"; current: StoredRoomLeaseV1 | null }
  >;
  releaseLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<unknown>;
}

export interface RoomControllerCheckpointStore {
  replayProjection(roomId: string): Promise<{ readonly aggregate: RoomAggregateV1 }>;
}

export interface RoomWorkerRunInput {
  readonly room: RoomAggregateV1;
  readonly lease: StoredRoomLeaseV1;
  readonly signal: AbortSignal;
}

export interface RoomWorker {
  runRoom(input: RoomWorkerRunInput): Promise<void>;
}

export interface RoomControllerOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly roomStore: RoomControllerRoomStore;
  readonly leaseStore: RoomControllerLeaseStore;
  readonly checkpointStore?: RoomControllerCheckpointStore;
  readonly worker: RoomWorker;
  readonly now?: () => string;
  readonly createLeaseId?: (roomId: string, workerId: string) => string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly shutdownGraceMs?: number;
}

interface RoomWorkerHandle {
  readonly roomId: string;
  readonly abortController: AbortController;
  lease: StoredRoomLeaseV1;
  runPromise: Promise<void>;
  released: boolean;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomController ${name} must be a positive safe integer`);
  }
  return value;
}

function leaseMutationInput(lease: StoredRoomLeaseV1, now: string) {
  return {
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: "room_worker" as const,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  };
}

/**
 * Backend-owned supervisor for durable operational Rooms. It owns only worker
 * lifecycle and lease fencing; task/DAG execution remains delegated to the
 * existing project runtime and scheduler.
 */
export class RoomController {
  private readonly now: () => string;
  private readonly createLeaseId: (roomId: string, workerId: string) => string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly handles = new Map<string, RoomWorkerHandle>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private started = false;
  private stopping = false;

  constructor(private readonly options: RoomControllerOptions) {
    if (!options.projectId.trim() || !options.workerId.trim() || !options.hostId.trim()) {
      throw new Error("RoomController projectId, workerId, and hostId are required");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.createLeaseId = options.createLeaseId ?? (() => randomUUID());
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.shutdownGraceMs = positiveInteger(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      "shutdownGraceMs",
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.unsubscribe = this.options.roomStore.subscribe?.(() => {
      void this.reconcile("committed-event");
    }) ?? null;
    try {
      await this.reconcile("startup");
      this.scheduleNextReconcile();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.handles.size === 0) return;
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.reconcileInFlight?.catch(() => undefined);
    await Promise.all([...this.handles.values()].map((handle) => this.stopHandle(handle, true)));
    this.handles.clear();
    this.stopping = false;
  }

  reconcile(reason = "manual"): Promise<void> {
    if (this.stopping || !this.started) return Promise.resolve();
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const operation = this.reconcileNow(reason)
      .catch((error) => {
        roomControllerLog.warn(
          `Room reconcile failed for ${this.options.projectId} (${reason}): ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.reconcileInFlight === operation) this.reconcileInFlight = null;
      });
    this.reconcileInFlight = operation;
    return operation;
  }

  private scheduleNextReconcile(): void {
    if (!this.started || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile("poll").finally(() => this.scheduleNextReconcile());
    }, this.pollIntervalMs);
  }

  private async reconcileNow(_reason: string): Promise<void> {
    const runnableRooms = await this.options.roomStore.listRunnableRooms();
    const runnableIds = new Set(runnableRooms.map((room) => room.room.id));
    for (const handle of [...this.handles.values()]) {
      if (!runnableIds.has(handle.roomId)) {
        await this.stopHandle(handle, true);
        continue;
      }
      await this.renewHandle(handle);
    }
    for (const room of runnableRooms) {
      if (this.stopping || this.handles.has(room.room.id)) continue;
      await this.claimRoom(room).catch((error) => {
        roomControllerLog.warn(
          `Room claim failed for ${room.room.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private async claimRoom(room: RoomAggregateV1): Promise<void> {
    const now = this.now();
    const leaseId = this.createLeaseId(room.room.id, this.options.workerId);
    const baseInput = {
      leaseId,
      roomId: room.room.id,
      kind: "room_worker" as const,
      resourceId: room.room.id,
      holderId: this.options.workerId,
      hostId: this.options.hostId,
      now,
      expiresAt: this.expiresAt(now),
    };
    let acquired = await this.options.leaseStore.acquireLease({
      ...baseInput,
      expectedEpoch: null,
    });
    if (!acquired.ok && acquired.reason === "stale_epoch" && acquired.current) {
      acquired = await this.options.leaseStore.acquireLease({
        ...baseInput,
        expectedEpoch: acquired.current.epoch,
      });
    }
    if (!acquired.ok) return;

    let authoritativeRoom = room;
    try {
      if (this.options.checkpointStore) {
        authoritativeRoom = (await this.options.checkpointStore.replayProjection(room.room.id)).aggregate;
      }
      if (authoritativeRoom.room.state !== "running" || this.stopping) {
        await this.options.leaseStore.releaseLease(leaseMutationInput(acquired.lease, this.now()));
        return;
      }
    } catch (error) {
      await this.options.leaseStore.releaseLease(leaseMutationInput(acquired.lease, this.now())).catch(() => undefined);
      throw error;
    }

    const abortController = new AbortController();
    const handle: RoomWorkerHandle = {
      roomId: authoritativeRoom.room.id,
      abortController,
      lease: acquired.lease,
      runPromise: Promise.resolve(),
      released: false,
    };
    this.handles.set(handle.roomId, handle);
    handle.runPromise = Promise.resolve().then(() => this.options.worker.runRoom({
      room: authoritativeRoom,
      lease: handle.lease,
      signal: abortController.signal,
    }));
    void handle.runPromise.then(
      () => this.finishHandle(handle),
      (error) => {
        if (!abortController.signal.aborted) {
          roomControllerLog.warn(
            `Room worker failed for ${handle.roomId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return this.finishHandle(handle);
      },
    );
  }

  private async renewHandle(handle: RoomWorkerHandle): Promise<void> {
    const now = this.now();
    const renewed = await this.options.leaseStore.renewLease({
      ...leaseMutationInput(handle.lease, now),
      expiresAt: this.expiresAt(now),
    });
    if (renewed.ok) {
      handle.lease = renewed.lease;
      return;
    }
    handle.released = true;
    handle.abortController.abort();
    if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
  }

  private async finishHandle(handle: RoomWorkerHandle): Promise<void> {
    if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
    await this.releaseHandle(handle);
  }

  private async stopHandle(handle: RoomWorkerHandle, release: boolean): Promise<void> {
    if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
    handle.abortController.abort();
    await this.waitForWorker(handle.runPromise);
    if (release) await this.releaseHandle(handle);
  }

  private async releaseHandle(handle: RoomWorkerHandle): Promise<void> {
    if (handle.released) return;
    handle.released = true;
    await this.options.leaseStore
      .releaseLease(leaseMutationInput(handle.lease, this.now()))
      .catch((error) => {
        roomControllerLog.warn(
          `Room lease release failed for ${handle.roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async waitForWorker(runPromise: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.shutdownGraceMs);
    });
    await Promise.race([runPromise.catch(() => undefined), bounded]);
    if (timeout) clearTimeout(timeout);
  }

  private expiresAt(now: string): string {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error(`RoomController received invalid time ${now}`);
    return new Date(timestamp + this.leaseDurationMs).toISOString();
  }
}

/** A fail-closed worker used until protocol/DAG execution is attached. */
export const PASSIVE_ROOM_WORKER: RoomWorker = Object.freeze({
  runRoom: ({ signal }) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  }),
});
