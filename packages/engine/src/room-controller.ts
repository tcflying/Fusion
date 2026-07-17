import { randomUUID } from "node:crypto";

import type {
  RoomAggregateV1,
  RoomLifecycleState,
  RunAuditEventInput,
  StoredRoomLeaseV1,
} from "@fusion/core";

import { createLogger } from "./logger.js";

const roomControllerLog = createLogger("room-controller");

export interface RoomControllerRoomStore {
  listRunnableRooms(): Promise<readonly RoomAggregateV1[]>;
  getRecoveryPosture?(roomId: string): Promise<RoomControllerRecoveryPosture>;
  assertWorkerAuthority?(input: {
    readonly roomId: string;
    readonly lease: StoredRoomLeaseV1;
    readonly expectedAggregateVersion: number;
    readonly now: string;
  }): Promise<RoomWorkerAuthorityV1>;
  subscribe?(listener: () => void | Promise<void>): () => void;
}

export interface RoomControllerRecoveryPosture {
  readonly lifecycleState: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly humanPaused: boolean;
  readonly approvalState: "none" | "waiting" | "blocked";
}

export interface RoomWorkerAuthorityV1 {
  readonly lease: StoredRoomLeaseV1;
  readonly posture: RoomControllerRecoveryPosture;
}

class RoomWorkerAuthorityError extends Error {
  readonly code = "room_worker_authority_revoked" as const;

  constructor(
    readonly posture: RoomControllerRecoveryPosture,
    readonly reason: string,
  ) {
    super(`Room worker authority revoked: ${reason}`);
    this.name = "RoomWorkerAuthorityError";
  }
}

function isRoomWorkerAuthorityError(error: unknown): error is RoomWorkerAuthorityError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<RoomWorkerAuthorityError>;
  return candidate.code === "room_worker_authority_revoked"
    && typeof candidate.reason === "string"
    && Boolean(candidate.posture);
}

export type RoomControllerAuditMutationType =
  | "room:worker-lease-acquired"
  | "room:worker-lease-taken-over"
  | "room:worker-lease-lost"
  | "room:worker-started"
  | "room:worker-stopped"
  | "room:worker-stop-timeout"
  | "room:worker-recovery-failed"
  | "room:worker-recovery-withheld";

export type RoomControllerAuditEvent = Omit<RunAuditEventInput, "mutationType"> & {
  readonly id: string;
  readonly projectId: string;
  readonly timestamp: string;
  readonly mutationType: RoomControllerAuditMutationType;
};

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
  assertFence(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<StoredRoomLeaseV1>;
}

export interface RoomControllerCheckpointStore {
  replayProjection(roomId: string): Promise<{ readonly aggregate: RoomAggregateV1 }>;
}

export interface RoomWorkerRunInput {
  readonly room: RoomAggregateV1;
  readonly lease: StoredRoomLeaseV1;
  readonly signal: AbortSignal;
  /**
   * Worker-facing authorization seam backed by the durable lease fence. This
   * proves the caller still owns its epoch; Task 4.5/4.6 attach it to each
   * provider/store mutation transaction.
   */
  readonly assertAuthority: () => Promise<RoomWorkerAuthorityV1>;
  /** @deprecated Use assertAuthority; this alias now executes the same combined guard. */
  readonly assertLeaseAuthority: () => Promise<StoredRoomLeaseV1>;
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
  readonly workerRestartBaseDelayMs?: number;
  readonly workerRestartMaxDelayMs?: number;
  readonly workerRestartMaxRestarts?: number;
  readonly auditMaxAttempts?: number;
  /** Durable persistence seam; successful resolution means the event is committed to an outbox. */
  readonly recordRunAuditEvent: (event: RoomControllerAuditEvent) => Promise<void>;
}

interface RoomWorkerHandle {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly projectionVersion: number;
  readonly source: string;
  readonly abortController: AbortController;
  lease: StoredRoomLeaseV1;
  runPromise: Promise<void>;
  completionPromise: Promise<void>;
  releasePromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  stopReason: string | null;
  stopSource: string | null;
  startAuditPromise: Promise<void> | null;
  terminationAuditPromise: Promise<void> | null;
  workerLaunchCommitted: boolean;
  released: boolean;
}

interface RoomRestartState {
  readonly projectionVersion: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_WORKER_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_WORKER_RESTART_MAX_DELAY_MS = 60_000;
const DEFAULT_WORKER_RESTART_MAX_RESTARTS = 5;
const DEFAULT_AUDIT_MAX_ATTEMPTS = 3;
const LEASE_RELEASE_MAX_ATTEMPTS = 3;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomController ${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RoomController ${name} must be a non-negative safe integer`);
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
  private readonly roomOperationBudgetMs: number;
  private readonly workerRestartBaseDelayMs: number;
  private readonly workerRestartMaxDelayMs: number;
  private readonly workerRestartMaxRestarts: number;
  private readonly auditMaxAttempts: number;
  private readonly handles = new Map<string, RoomWorkerHandle>();
  private readonly roomOperations = new Map<string, Promise<void>>();
  private readonly restartStates = new Map<string, RoomRestartState>();
  private readonly auditDeliveries = new Set<Promise<void>>();
  private readonly auditRunId = `room-controller:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private lifecycleWritesClosed = true;
  private lifecycleGeneration = 0;
  private stopInFlight: Promise<void> | null = null;

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
    this.roomOperationBudgetMs = Math.max(
      1,
      Math.min(this.pollIntervalMs, Math.floor(this.leaseDurationMs / 3)),
    );
    this.workerRestartBaseDelayMs = positiveInteger(
      options.workerRestartBaseDelayMs ?? DEFAULT_WORKER_RESTART_BASE_DELAY_MS,
      "workerRestartBaseDelayMs",
    );
    this.workerRestartMaxDelayMs = positiveInteger(
      options.workerRestartMaxDelayMs ?? DEFAULT_WORKER_RESTART_MAX_DELAY_MS,
      "workerRestartMaxDelayMs",
    );
    if (this.workerRestartMaxDelayMs < this.workerRestartBaseDelayMs) {
      throw new Error("RoomController workerRestartMaxDelayMs must be at least workerRestartBaseDelayMs");
    }
    this.workerRestartMaxRestarts = nonNegativeInteger(
      options.workerRestartMaxRestarts ?? DEFAULT_WORKER_RESTART_MAX_RESTARTS,
      "workerRestartMaxRestarts",
    );
    this.auditMaxAttempts = positiveInteger(
      options.auditMaxAttempts ?? DEFAULT_AUDIT_MAX_ATTEMPTS,
      "auditMaxAttempts",
    );
  }

  async start(): Promise<void> {
    if (this.stopInFlight) await this.stopInFlight;
    if (this.started) return;
    this.lifecycleGeneration += 1;
    this.lifecycleWritesClosed = false;
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
    if (this.stopInFlight) return this.stopInFlight;
    const operation = this.stopWithinBudget().finally(() => {
      if (this.stopInFlight === operation) this.stopInFlight = null;
    });
    this.stopInFlight = operation;
    return operation;
  }

  private async stopWithinBudget(): Promise<void> {
    if (
      !this.started
      && this.handles.size === 0
      && !this.reconcileInFlight
      && this.auditDeliveries.size === 0
    ) {
      this.lifecycleWritesClosed = true;
      return;
    }
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;

    const handles = [...this.handles.values()];
    const workerBudgetMs = this.shutdownGraceMs;
    const pending = [
      this.reconcileInFlight?.catch(() => undefined),
      ...this.roomOperations.values(),
      ...handles.map((handle) => this.stopHandle(
        handle,
        true,
        "controller_stop",
        "shutdown",
        workerBudgetMs,
      )),
    ].filter((value): value is Promise<void> => Boolean(value));
    await this.waitWithinBudget(Promise.allSettled(pending), workerBudgetMs);
    await this.drainAuditDeliveries();
    // No callback may create a fresh durable write after ProjectEngine is
    // allowed to stop the dispatcher and close the runtime data layer.
    this.lifecycleWritesClosed = true;

    this.handles.clear();
    this.roomOperations.clear();
    this.restartStates.clear();
    this.reconcileInFlight = null;
    this.stopping = false;
  }

  reconcile(reason = "manual"): Promise<void> {
    if (this.stopping || !this.started) return Promise.resolve();
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const lifecycleGeneration = this.lifecycleGeneration;
    const operation = this.reconcileNow(reason, lifecycleGeneration)
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

  private async reconcileNow(reason: string, lifecycleGeneration: number): Promise<void> {
    const runnableRooms = await this.options.roomStore.listRunnableRooms();
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const runnableById = new Map(runnableRooms.map((room) => [room.room.id, room]));
    const runnableIds = new Set(runnableById.keys());
    const operations: Promise<void>[] = [];
    for (const handle of [...this.handles.values()]) {
      if (handle.lifecycleGeneration !== lifecycleGeneration) continue;
      if (!runnableIds.has(handle.roomId)) {
        operations.push(this.runRoomOperation(handle.roomId, () => (
          this.stopHandle(handle, true, "room_not_runnable", reason)
        )));
        continue;
      }
      operations.push(this.runRoomOperation(handle.roomId, () => (
        this.renewHandle(handle, reason, runnableById.get(handle.roomId))
      )));
    }
    for (const room of runnableRooms) {
      if (!this.canStartLeaseMutation(lifecycleGeneration) || this.handles.has(room.room.id)) continue;
      if (!this.canClaimRoom(room)) continue;
      operations.push(this.runRoomOperation(
        room.room.id,
        () => this.claimRoom(room, reason, lifecycleGeneration),
      ));
    }
    await Promise.all(operations);
  }

  private async claimRoom(
    room: RoomAggregateV1,
    source: string,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    if (this.options.roomStore.getRecoveryPosture) {
      const initialGuard = await this.readRunGuard(room.room.id);
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      const initialReason = initialGuard.reason
        ?? (initialGuard.posture.aggregateVersion === room.room.aggregateVersion
          ? null
          : "posture_version_changed");
      if (initialReason) {
        await this.recordRecoveryWithheld(
          room.room.id,
          initialGuard.posture,
          initialReason,
          source,
          lifecycleGeneration,
        );
        return;
      }
    }
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
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    if (!acquired.ok && acquired.reason === "stale_epoch" && acquired.current) {
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      acquired = await this.options.leaseStore.acquireLease({
        ...baseInput,
        expectedEpoch: acquired.current.epoch,
      });
      if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    }
    if (!acquired.ok) return;

    let authoritativeRoom = room;
    try {
      if (this.options.checkpointStore) {
        authoritativeRoom = (await this.options.checkpointStore.replayProjection(room.room.id)).aggregate;
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
      }
      if (authoritativeRoom.room.state !== "running" || this.stopping || !this.started) {
        await this.releaseLeaseIfOpen(acquired.lease, lifecycleGeneration);
        return;
      }

      if (this.options.roomStore.getRecoveryPosture) {
        const postLeasePosture = await this.options.roomStore.getRecoveryPosture(room.room.id);
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
        const withheldReason = this.recoveryWithheldReason(postLeasePosture);
        const postureChanged = postLeasePosture.aggregateVersion
          !== authoritativeRoom.room.aggregateVersion;
        if (withheldReason || postureChanged || this.stopping || !this.started) {
          await this.releaseLeaseIfOpen(acquired.lease, lifecycleGeneration);
          if (withheldReason || postureChanged) {
            await this.recordRecoveryWithheld(
              room.room.id,
              postLeasePosture,
              withheldReason ?? "posture_version_changed",
              source,
              lifecycleGeneration,
            );
          }
          return;
        }
      }
    } catch (error) {
      await this.releaseLeaseIfOpen(acquired.lease, lifecycleGeneration).catch(() => undefined);
      throw error;
    }

    if (!this.canStartLeaseMutation(lifecycleGeneration)) {
      await this.releaseLeaseIfOpen(acquired.lease, lifecycleGeneration);
      return;
    }

    const abortController = new AbortController();
    const handle: RoomWorkerHandle = {
      roomId: authoritativeRoom.room.id,
      lifecycleGeneration,
      projectionVersion: authoritativeRoom.room.aggregateVersion,
      source,
      abortController,
      lease: acquired.lease,
      runPromise: Promise.resolve(),
      completionPromise: Promise.resolve(),
      releasePromise: null,
      stopPromise: null,
      stopReason: null,
      stopSource: null,
      startAuditPromise: null,
      terminationAuditPromise: null,
      workerLaunchCommitted: false,
      released: false,
    };
    try {
      await this.recordLifecycleAudit(
        acquired.action === "taken_over"
          ? "room:worker-lease-taken-over"
          : "room:worker-lease-acquired",
        authoritativeRoom.room.id,
        {
          leaseId: acquired.lease.id,
          leaseEpoch: acquired.lease.epoch,
          source,
        },
        lifecycleGeneration,
      );
    } catch (error) {
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      throw error;
    }

    // Stop may have exhausted its bounded wait while the durable audit write
    // was in flight. Never register a new handle after shutdown cleanup; the
    // fenced lease will expire without issuing another store operation through
    // a runtime that may already be closing.
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    try {
      await this.assertCombinedAuthority(handle);
    } catch (error) {
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      throw error;
    }
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;

    const startAuditPromise = this.recordLifecycleAudit(
      "room:worker-started",
      handle.roomId,
      {
        leaseId: handle.lease.id,
        leaseEpoch: handle.lease.epoch,
        source,
      },
      handle.lifecycleGeneration,
    );
    handle.startAuditPromise = startAuditPromise;
    this.handles.set(handle.roomId, handle);
    try {
      await startAuditPromise;
    } catch (error) {
      if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      throw error;
    }
    if (
      !this.started
      || this.stopping
      || !this.isLifecycleGenerationOpen(lifecycleGeneration)
      || this.handles.get(handle.roomId) !== handle
      || abortController.signal.aborted
    ) {
      if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      return;
    }
    handle.workerLaunchCommitted = true;
    handle.runPromise = Promise.resolve().then(() => {
      if (
        !this.started
        || this.stopping
        || !this.isLifecycleGenerationOpen(lifecycleGeneration)
        || this.handles.get(handle.roomId) !== handle
        || abortController.signal.aborted
      ) return;
      return this.assertCombinedAuthority(handle).then((authority) => this.options.worker.runRoom({
        room: authoritativeRoom,
        lease: authority.lease,
        signal: abortController.signal,
        assertAuthority: () => this.assertCombinedAuthority(handle),
        assertLeaseAuthority: async () => (await this.assertCombinedAuthority(handle)).lease,
      })).catch(async (error) => {
        if (!isRoomWorkerAuthorityError(error)) throw error;
        if (error.reason === "controller_stopped") return;
        if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
        handle.stopReason = "recovery_withheld";
        handle.stopSource = source;
        if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
        abortController.abort();
        try {
          await this.recordRecoveryWithheld(
            handle.roomId,
            error.posture,
            error.reason,
            source,
            handle.lifecycleGeneration,
          );
        } finally {
          await this.releaseHandle(handle);
        }
      });
    });
    handle.completionPromise = handle.runPromise.then(
      () => this.finishHandle(handle, "worker_completed"),
      async (_error) => {
        try {
          if (!abortController.signal.aborted) {
            roomControllerLog.warn(
              `Room worker failed for ${handle.roomId}: code=room_worker_failed`,
            );
            await this.recordLifecycleAudit(
              "room:worker-recovery-failed",
              handle.roomId,
              {
                leaseId: handle.lease.id,
                leaseEpoch: handle.lease.epoch,
                errorCode: "room_worker_failed",
                recoverable: true,
                source: handle.source,
              },
              handle.lifecycleGeneration,
            );
          }
        } finally {
          await this.finishHandle(handle, "worker_failed");
        }
      },
    );
    void handle.completionPromise.catch(() => {
      roomControllerLog.warn(
        `Room worker completion failed for ${handle.roomId}: code=room_worker_completion_failed`,
      );
    });
  }

  private async renewHandle(
    handle: RoomWorkerHandle,
    source: string,
    room: RoomAggregateV1 | undefined,
  ): Promise<void> {
    const lifecycleGeneration = handle.lifecycleGeneration;
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    let preRenewPosture: RoomControllerRecoveryPosture | null = null;
    if (this.options.roomStore.getRecoveryPosture) {
      const guard = await this.readRunGuard(handle.roomId);
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      preRenewPosture = guard.posture;
      const reason = guard.reason
        ?? (room && guard.posture.aggregateVersion !== room.room.aggregateVersion
          ? "posture_version_changed"
          : null);
      if (reason) {
        const stopPromise = this.stopHandle(handle, true, "recovery_withheld", source);
        await this.recordRecoveryWithheld(
          handle.roomId,
          guard.posture,
          reason,
          source,
          lifecycleGeneration,
        );
        await stopPromise;
        return;
      }
    }
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const now = this.now();
    const renewed = await this.options.leaseStore.renewLease({
      ...leaseMutationInput(handle.lease, now),
      expiresAt: this.expiresAt(now),
    });
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    if (renewed.ok) {
      handle.lease = renewed.lease;
      if (this.options.roomStore.getRecoveryPosture && preRenewPosture) {
        const postRenewGuard = await this.readRunGuard(handle.roomId);
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
        const reason = postRenewGuard.reason
          ?? (postRenewGuard.posture.aggregateVersion === preRenewPosture.aggregateVersion
            ? null
            : "posture_version_changed");
        if (reason) {
          const stopPromise = this.stopHandle(handle, true, "recovery_withheld", source);
          await this.recordRecoveryWithheld(
            handle.roomId,
            postRenewGuard.posture,
            reason,
            source,
            lifecycleGeneration,
          );
          await stopPromise;
          return;
        }
      }
      if (!this.started || this.stopping || this.handles.get(handle.roomId) !== handle) {
        await this.stopHandle(handle, true, "renew_guard_lost", source);
      }
      return;
    }
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    handle.released = true;
    handle.releasePromise = Promise.resolve();
    const stopPromise = this.stopHandle(handle, false, "lease_lost", source);
    await this.recordLifecycleAudit(
      "room:worker-lease-lost",
      handle.roomId,
      {
        leaseId: handle.lease.id,
        leaseEpoch: handle.lease.epoch,
        reason: renewed.reason,
        source,
      },
      handle.lifecycleGeneration,
    );
    await stopPromise;
  }

  private async finishHandle(handle: RoomWorkerHandle, outcome: string): Promise<void> {
    const wasCurrent = this.handles.get(handle.roomId) === handle;
    if (wasCurrent) this.handles.delete(handle.roomId);
    if (wasCurrent && !handle.abortController.signal.aborted && this.started && !this.stopping) {
      this.recordAbnormalWorkerExit(handle);
    }
    if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
    const releasePromise = this.releaseHandle(handle);
    void releasePromise.catch(() => undefined);
    try {
      await this.recordWorkerStoppedOnce(
        handle,
        handle.stopReason ?? outcome,
        handle.stopSource ?? handle.source,
        "settled",
      );
    } finally {
      await releasePromise;
    }
  }

  private async stopHandle(
    handle: RoomWorkerHandle,
    release: boolean,
    reason = "controller_stop",
    source = "shutdown",
    budgetMs = this.roomOperationBudgetMs,
  ): Promise<void> {
    if (handle.stopPromise) return handle.stopPromise;
    handle.stopReason = reason;
    handle.stopSource = source;
    if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
    handle.abortController.abort();
    const releasePromise = release ? this.releaseHandle(handle) : Promise.resolve();
    void releasePromise.catch(() => undefined);
    const operation = (async () => {
      if (!handle.workerLaunchCommitted) {
        let startWasPersisted = false;
        if (handle.startAuditPromise) {
          try {
            await handle.startAuditPromise;
            startWasPersisted = true;
          } catch {
            // A failed start persistence creates no durable lifecycle fact, so
            // there is no started worker for a terminal event to close.
          }
        }
        if (startWasPersisted) {
          await this.recordWorkerStoppedOnce(handle, reason, source, "settled");
        }
        await this.waitWithinBudget(releasePromise, budgetMs);
        return;
      }
      const settled = await this.settlesWithinBudget(handle.runPromise, budgetMs);
      if (!settled) {
        await this.recordWorkerStopTimeoutOnce(handle, reason, source);
      } else {
        await handle.completionPromise;
      }
      await this.waitWithinBudget(releasePromise, budgetMs);
    })();
    handle.stopPromise = operation;
    return operation;
  }

  private async readRunGuard(roomId: string): Promise<{
    readonly posture: RoomControllerRecoveryPosture;
    readonly reason: string | null;
  }> {
    const posture = await this.options.roomStore.getRecoveryPosture!(roomId);
    return { posture, reason: this.recoveryWithheldReason(posture) };
  }

  private async assertCombinedAuthority(handle: RoomWorkerHandle): Promise<RoomWorkerAuthorityV1> {
    this.assertAuthorityRequestAllowed(handle);
    if (this.options.roomStore.assertWorkerAuthority) {
      const authority = await this.options.roomStore.assertWorkerAuthority({
        roomId: handle.roomId,
        lease: handle.lease,
        expectedAggregateVersion: handle.projectionVersion,
        now: this.now(),
      });
      this.assertAuthorityResultCurrent(handle);
      return authority;
    }
    const lease = await this.options.leaseStore.assertFence(
      leaseMutationInput(handle.lease, this.now()),
    );
    this.assertAuthorityResultCurrent(handle);
    if (!this.options.roomStore.getRecoveryPosture) {
      return {
        lease,
        posture: {
          lifecycleState: "running",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "none",
        },
      };
    }
    const guard = await this.readRunGuard(handle.roomId);
    this.assertAuthorityResultCurrent(handle);
    const reason = guard.reason
      ?? (guard.posture.aggregateVersion === handle.projectionVersion
        ? null
        : "posture_version_changed");
    if (reason) throw new RoomWorkerAuthorityError(guard.posture, reason);
    return { lease, posture: guard.posture };
  }

  private recordRecoveryWithheld(
    roomId: string,
    posture: RoomControllerRecoveryPosture,
    reason: string,
    source: string,
    lifecycleGeneration: number,
  ): Promise<void> {
    return this.recordLifecycleAudit("room:worker-recovery-withheld", roomId, {
      lifecycleState: posture.lifecycleState,
      aggregateVersion: posture.aggregateVersion,
      reason,
      source,
    }, lifecycleGeneration);
  }

  private recoveryWithheldReason(posture: RoomControllerRecoveryPosture): string | null {
    if (posture.humanPaused) return "human_paused";
    if (posture.approvalState === "waiting") return "approval_waiting";
    if (posture.approvalState === "blocked") return "approval_blocked";
    if ([
      "completed",
      "completed_with_risks",
      "partial",
      "cancelled",
      "failed",
      "archived",
    ].includes(posture.lifecycleState)) {
      return "terminal_state";
    }
    return posture.lifecycleState === "running" ? null : "lifecycle_not_running";
  }

  private recordWorkerStoppedOnce(
    handle: RoomWorkerHandle,
    reason: string,
    source: string,
    terminationOutcome: "settled",
  ): Promise<void> {
    if (handle.terminationAuditPromise) return handle.terminationAuditPromise;
    const persistence = this.recordLifecycleAudit("room:worker-stopped", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      reason,
      source,
      terminationOutcome,
    }, handle.lifecycleGeneration);
    const tracked = persistence.catch((error) => {
      handle.terminationAuditPromise = null;
      throw error;
    });
    handle.terminationAuditPromise = tracked;
    return tracked;
  }

  private recordWorkerStopTimeoutOnce(
    handle: RoomWorkerHandle,
    reason: string,
    source: string,
  ): Promise<void> {
    if (handle.terminationAuditPromise) return handle.terminationAuditPromise;
    /*
    FNXC:SessionRoomWorkerTermination 2026-07-18-02:09:
    Abort timeout proves only that termination is unknown. Once this audit is
    durably persisted it is the final termination fact for this controller
    lifetime; a later in-memory settlement cannot write through a closed store.
    Outside controller shutdown, a rejected persistence attempt clears the slot
    so a late observed settlement may persist the truthful worker-stopped fact.
    During shutdown the failed slot remains final: stop closes lifecycle writes
    before ProjectEngine tears down the dispatcher and runtime data layer.
    */
    const persistence = this.recordLifecycleAudit("room:worker-stop-timeout", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      reason,
      source,
      terminationOutcome: "termination_unknown",
    }, handle.lifecycleGeneration);
    const tracked = persistence.catch((error) => {
      if (!this.stopping) handle.terminationAuditPromise = null;
      throw error;
    });
    handle.terminationAuditPromise = tracked;
    return tracked;
  }

  private recordLifecycleAudit(
    mutationType: RoomControllerAuditMutationType,
    roomId: string,
    metadata: Record<string, unknown>,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) {
      return Promise.reject(new Error("room_controller_lifecycle_writes_closed"));
    }
    const event: RoomControllerAuditEvent = {
      id: randomUUID(),
      projectId: this.options.projectId,
      timestamp: this.now(),
      agentId: this.options.workerId,
      runId: this.auditRunId,
      domain: "database",
      mutationType,
      target: roomId,
      metadata: {
        projectId: this.options.projectId,
        roomId,
        workerId: this.options.workerId,
        hostId: this.options.hostId,
        ...metadata,
      },
    };
    const delivery = this.deliverAudit(event).finally(() => {
      this.auditDeliveries.delete(delivery);
    });
    this.auditDeliveries.add(delivery);
    return delivery;
  }

  private async deliverAudit(event: RoomControllerAuditEvent): Promise<void> {
    for (let attempt = 1; attempt <= this.auditMaxAttempts; attempt += 1) {
      try {
        await this.options.recordRunAuditEvent(event);
        return;
      } catch {
        // Retry the exact same stable event id. The durable outbox makes this
        // idempotent; unlike an outer timeout, rejection proves the attempt has
        // actually settled and cannot commit after controller teardown.
      }
    }
    roomControllerLog.warn(
      `Room lifecycle audit failed for ${event.target} (${event.mutationType}): code=audit_delivery_exhausted`,
    );
    throw new Error("room_lifecycle_audit_persistence_failed");
  }

  private async drainAuditDeliveries(): Promise<void> {
    while (this.auditDeliveries.size > 0) {
      await Promise.allSettled([...this.auditDeliveries]);
    }
  }

  private async releaseHandle(handle: RoomWorkerHandle): Promise<void> {
    if (handle.releasePromise) return handle.releasePromise;
    if (handle.released || !this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
    const operation = (async () => {
      for (let attempt = 1; attempt <= LEASE_RELEASE_MAX_ATTEMPTS; attempt += 1) {
        if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
        try {
          await this.options.leaseStore.releaseLease(
            leaseMutationInput(handle.lease, this.now()),
          );
          if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
          handle.released = true;
          return;
        } catch (error) {
          if (attempt === LEASE_RELEASE_MAX_ATTEMPTS) throw error;
        }
      }
    })();
    handle.releasePromise = operation;
    try {
      await operation;
    } catch (error) {
      roomControllerLog.warn(
        `Room lease release failed for ${handle.roomId}: code=room_lease_release_failed`,
      );
      throw error;
    } finally {
      if (!handle.released && handle.releasePromise === operation) {
        handle.releasePromise = null;
      }
    }
  }

  private async settlesWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return outcome;
  }

  private async waitWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, budgetMs);
    });
    await Promise.race([promise.then(() => undefined, () => undefined), bounded]);
    if (timeout) clearTimeout(timeout);
  }

  private runRoomOperation(roomId: string, operation: () => Promise<void>): Promise<void> {
    if (this.roomOperations.has(roomId)) return Promise.resolve();
    const running = Promise.resolve()
      .then(operation)
      .catch((error) => {
        roomControllerLog.warn(
          `Room operation failed for ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.roomOperations.get(roomId) === running) this.roomOperations.delete(roomId);
      });
    this.roomOperations.set(roomId, running);
    return this.waitWithinBudget(running, this.roomOperationBudgetMs);
  }

  private canClaimRoom(room: RoomAggregateV1): boolean {
    const roomId = room.room.id;
    const restart = this.restartStates.get(roomId);
    if (!restart) return true;
    if (restart.projectionVersion !== room.room.aggregateVersion) {
      this.restartStates.delete(roomId);
      return true;
    }
    if (restart.failures > this.workerRestartMaxRestarts) return false;
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new Error(`RoomController received invalid time ${this.now()}`);
    return nowMs >= restart.nextAttemptAtMs;
  }

  private recordAbnormalWorkerExit(handle: RoomWorkerHandle): void {
    const previous = this.restartStates.get(handle.roomId);
    const failures = previous?.projectionVersion === handle.projectionVersion
      ? previous.failures + 1
      : 1;
    const delay = Math.min(
      this.workerRestartMaxDelayMs,
      this.workerRestartBaseDelayMs * (2 ** Math.max(0, failures - 1)),
    );
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) return;
    this.restartStates.set(handle.roomId, {
      projectionVersion: handle.projectionVersion,
      failures,
      nextAttemptAtMs: nowMs + delay,
    });
  }

  private expiresAt(now: string): string {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error(`RoomController received invalid time ${now}`);
    return new Date(timestamp + this.leaseDurationMs).toISOString();
  }

  private isLifecycleGenerationOpen(lifecycleGeneration: number): boolean {
    return lifecycleGeneration === this.lifecycleGeneration && !this.lifecycleWritesClosed;
  }

  private assertAuthorityRequestAllowed(handle: RoomWorkerHandle): void {
    if (this.canStartLeaseMutation(handle.lifecycleGeneration)) return;
    this.throwControllerStoppedAuthority(handle);
  }

  private assertAuthorityResultCurrent(handle: RoomWorkerHandle): void {
    const requiresCurrentRegistration = handle.startAuditPromise !== null
      || handle.workerLaunchCommitted;
    if (
      this.canStartLeaseMutation(handle.lifecycleGeneration)
      && !handle.abortController.signal.aborted
      && (!requiresCurrentRegistration || this.handles.get(handle.roomId) === handle)
    ) return;
    this.throwControllerStoppedAuthority(handle);
  }

  private throwControllerStoppedAuthority(handle: RoomWorkerHandle): never {
    throw new RoomWorkerAuthorityError({
      lifecycleState: "blocked",
      aggregateVersion: handle.projectionVersion,
      humanPaused: false,
      approvalState: "blocked",
    }, "controller_stopped");
  }

  private canStartLeaseMutation(lifecycleGeneration: number): boolean {
    return this.isLifecycleGenerationOpen(lifecycleGeneration) && this.started && !this.stopping;
  }

  private async releaseLeaseIfOpen(
    lease: StoredRoomLeaseV1,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    await this.options.leaseStore.releaseLease(leaseMutationInput(lease, this.now()));
  }
}

/** A fail-closed worker used until protocol/DAG execution is attached. */
export const PASSIVE_ROOM_WORKER: RoomWorker = Object.freeze({
  runRoom: ({ signal }: RoomWorkerRunInput) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  }),
});
