import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";

import type { AsyncRoomCheckpointStore } from "./async-room-checkpoint-store.js";
import type {
  AsyncRoomLeaseStore,
  StoredRoomLeaseV1,
} from "./async-room-lease-store.js";
import type { AsyncRoomStore } from "./async-room-store.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import {
  roomBindingIngestionState,
  roomBindings,
  roomLeases,
  roomMessages,
  roomOutbox,
} from "./postgres/schema/room.js";
import type {
  RoomOutboxRecordV1,
  SessionConnectorIdentityV1,
} from "./room-contracts/index.js";
import { hashRoomValue } from "./room-integrity.js";

export interface RoomRecoveryAuditIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly taskId?: string;
}

export interface RoomRecoveryDispatchInput {
  readonly store: AsyncRoomStore;
  readonly identity: SessionConnectorIdentityV1;
  readonly outboxId: string;
  readonly attemptId: string;
  readonly senderFence: {
    readonly leaseId: string;
    readonly roomId: string;
    readonly kind: "sender";
    readonly resourceId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly expectedEpoch: number;
  };
  readonly content: string;
  readonly reconciliationFromCursor: string | null;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomRecoveryAuditIdentity;
}

export interface RoomRecoveryReconcileInput {
  readonly store: AsyncRoomStore;
  readonly identity: SessionConnectorIdentityV1;
  readonly outboxId: string;
  readonly historyPageSize: number;
  readonly maxHistoryPages: number;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomRecoveryAuditIdentity;
}

/**
 * Engine supplies its already-certified RoomDeliveryCoordinator operations.
 * Core owns only durable restart discovery and fencing, so this port avoids a
 * Core -> Engine dependency and avoids a second provider dispatch algorithm.
 */
export interface RoomRecoveryDeliveryCoordinator {
  dispatch(input: RoomRecoveryDispatchInput): Promise<RoomOutboxRecordV1>;
  reconcile(input: RoomRecoveryReconcileInput): Promise<RoomOutboxRecordV1>;
}

export interface ReconcileNativeTakeoverAfterCrashInput {
  readonly roomId: string;
  readonly bindingId: string;
  readonly takeoverId: string;
  readonly idempotencyKey: string;
  readonly statusCursor: string;
  readonly roomWorkerLease: StoredRoomLeaseV1;
  readonly automaticSenderLease: StoredRoomLeaseV1;
  readonly humanHolderId: string;
  readonly hostId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface NativeTakeoverRecoveryResultV1 {
  readonly state: "blocked_delivery_uncertain" | "blocked_takeover_transfer";
  readonly automaticSender: "paused";
  readonly automaticSenderFenceActive: boolean;
  readonly takeoverEpoch: number;
  readonly confirmedCursor: string | null;
  readonly blockedOutboxIds: readonly string[];
  readonly senderLease: null;
}

export interface RecoverRoomAfterCrashInput {
  readonly projectId: string;
  readonly roomId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly layer: AsyncDataLayer;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly checkpointStore: AsyncRoomCheckpointStore;
  readonly deliveryCoordinator: RoomRecoveryDeliveryCoordinator;
  readonly roomWorkerLease: StoredRoomLeaseV1;
  readonly senderLease: StoredRoomLeaseV1 | null;
  readonly resolveSenderLease?: (
    bindingId: string,
  ) => Promise<StoredRoomLeaseV1 | null>;
  readonly historyPageSize: number;
  readonly maxHistoryPages: number;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomRecoveryAuditIdentity;
  readonly nativeTakeover?: ReconcileNativeTakeoverAfterCrashInput;
}

export interface RoomCrashRecoveryResultV1 {
  readonly deliveries: readonly RoomOutboxRecordV1[];
  readonly checkpointId: string | null;
  readonly nativeTakeover: NativeTakeoverRecoveryResultV1 | null;
}

export type RoomCrashRecoveryErrorCode =
  | "room_recovery_identity_conflict"
  | "room_recovery_sender_lease_required"
  | "room_recovery_delivery_missing"
  | "room_recovery_takeover_conflict";

export class RoomCrashRecoveryError extends Error {
  constructor(
    readonly code: RoomCrashRecoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomCrashRecoveryError";
  }
}

export interface AcquireRoomRecoverySenderLeaseInput {
  readonly projectId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly leaseId: string;
  readonly layer: AsyncDataLayer;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly now: string;
  readonly expiresAt: string;
}

/**
 * Claims the durable sender epoch needed by crash recovery. An active sender
 * owned by another actor is never stolen; an expired or released epoch may be
 * advanced only through AsyncRoomLeaseStore's serialized takeover path.
 */
export async function acquireRoomRecoverySenderLease(
  input: AcquireRoomRecoverySenderLeaseInput,
): Promise<StoredRoomLeaseV1 | null> {
  const latest = await findLatestRecoverySenderLease(input);
  if (latest && isMatchingActiveRecoverySender(latest, input)) {
    await assertLease(input.leaseStore, latest, input.now);
    return latest;
  }

  const acquired = await input.leaseStore.acquireLease({
    leaseId: input.leaseId,
    roomId: input.roomId,
    kind: "sender",
    resourceId: input.bindingId,
    holderId: input.workerId,
    hostId: input.hostId,
    expectedEpoch: latest?.epoch ?? null,
    now: input.now,
    expiresAt: input.expiresAt,
    denyTakeoverWhileDeliveryUnresolved: true,
  });
  if (acquired.ok) return acquired.lease;
  if (acquired.current && isMatchingActiveRecoverySender(acquired.current, input)) {
    await assertLease(input.leaseStore, acquired.current, input.now);
    return acquired.current;
  }
  return null;
}

interface RecoverableDeliveryRow {
  readonly outboxId: string;
  readonly content: string;
  readonly bindingId: string;
  readonly connectorId: string;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly hostId: string;
  readonly transcriptCursor: string | null;
  readonly deliveryState: string;
  readonly nextAttemptAt: string | null;
}

/*
FNXC:SessionRoomCrashRecovery 2026-07-17-23:30:
Recovery is driven from PostgreSQL, never browser memory. Pending delivery may
be dispatched once under current Room/sender fences. Dispatching or uncertain
delivery is history-reconciled and is never blindly sent. Confirmed delivery is
read-only recovery input. Native takeover never transfers a sender while any
delivery remains ambiguous or the old sender can still write.
*/
export async function recoverRoomAfterCrash(
  input: RecoverRoomAfterCrashInput,
): Promise<RoomCrashRecoveryResultV1> {
  validateRecoveryIdentity(input);
  const startNow = await assertRecoveryAuthority(input);
  await assertLease(input.leaseStore, input.roomWorkerLease, startNow);

  const latestCheckpoint = await input.checkpointStore.getLatestCheckpoint(input.roomId);
  const aggregate = latestCheckpoint
    ? (await input.checkpointStore.replayProjection(input.roomId)).aggregate
    : await input.roomStore.getRoom(input.roomId);
  if (!aggregate) {
    throw new RoomCrashRecoveryError(
      "room_recovery_identity_conflict",
      `Operational Room ${input.roomId} does not exist in project ${input.projectId}`,
    );
  }

  const rows = await listRecoverableDeliveries(input, latestCheckpoint);
  const deliveries: RoomOutboxRecordV1[] = [];
  const unresolvedBindingIds = new Set<string>();
  for (const row of rows) {
    const operationNow = await assertRecoveryAuthority(input);
    await assertLease(input.leaseStore, input.roomWorkerLease, operationNow);
    const current = await input.roomStore.getDelivery(row.outboxId);
    if (!current) {
      throw new RoomCrashRecoveryError(
        "room_recovery_delivery_missing",
        `Room recovery discovered missing outbox ${row.outboxId}`,
      );
    }
    const identity = identityFromRow(row);
    if (current.state === "pending") {
      if (unresolvedBindingIds.has(current.bindingId)) {
        deliveries.push(current);
        continue;
      }
      if (
        current.nextAttemptAt
        && Date.parse(current.nextAttemptAt) > Date.parse(operationNow)
      ) {
        deliveries.push(current);
        continue;
      }
      const senderLease = await requireSenderLease(input, current.bindingId);
      const dispatchNow = await assertRecoveryAuthority(input);
      await assertLease(input.leaseStore, input.roomWorkerLease, dispatchNow);
      await assertLease(input.leaseStore, senderLease, dispatchNow);
      const dispatched = await dispatchPending(
        input,
        row,
        current,
        identity,
        senderLease,
        dispatchNow,
      );
      deliveries.push(dispatched);
      if (dispatched.state === "dispatching" || dispatched.state === "delivery_uncertain") {
        unresolvedBindingIds.add(dispatched.bindingId);
      }
      continue;
    }
    if (current.state === "dispatching" || current.state === "delivery_uncertain") {
      const reconcileNow = await assertRecoveryAuthority(input);
      const reconciled = await input.deliveryCoordinator.reconcile({
        store: input.roomStore,
        identity,
        outboxId: current.id,
        historyPageSize: input.historyPageSize,
        maxHistoryPages: input.maxHistoryPages,
        now: reconcileNow,
        currentTime: input.currentTime,
        signal: input.signal,
        assertAuthority: input.assertAuthority,
        audit: input.audit,
      });
      deliveries.push(reconciled);
      if (reconciled.state === "dispatching" || reconciled.state === "delivery_uncertain") {
        unresolvedBindingIds.add(reconciled.bindingId);
      }
      continue;
    }
    if (current.state === "confirmed") deliveries.push(current);
  }

  const nativeTakeover = input.nativeTakeover
    ? await recoverNativeTakeover({ ...input, now: currentRecoveryTime(input) }, deliveries)
    : null;
  const checkpointId = await advanceRecoveryCheckpoint(
    { ...input, now: currentRecoveryTime(input) },
    aggregate.room.aggregateVersion,
    latestCheckpoint,
    deliveries,
  );
  if (checkpointId) await input.checkpointStore.replayProjection(input.roomId);

  return { deliveries, checkpointId, nativeTakeover };
}

async function dispatchPending(
  input: RecoverRoomAfterCrashInput,
  row: RecoverableDeliveryRow,
  current: RoomOutboxRecordV1,
  identity: SessionConnectorIdentityV1,
  senderLease: StoredRoomLeaseV1,
  now: string,
): Promise<RoomOutboxRecordV1> {
  try {
    return await input.deliveryCoordinator.dispatch({
      store: input.roomStore,
      identity,
      outboxId: current.id,
      attemptId: recoveryAttemptId(current),
      senderFence: senderFenceFromLease(senderLease),
      content: row.content,
      reconciliationFromCursor: row.transcriptCursor,
      now,
      currentTime: input.currentTime,
      signal: input.signal,
      assertAuthority: async () => {
        const authorityNow = await assertRecoveryAuthority(input);
        await assertLease(input.leaseStore, input.roomWorkerLease, authorityNow);
        await assertLease(input.leaseStore, senderLease, authorityNow);
      },
      audit: input.audit,
    });
  } catch (error) {
    const stranded = await input.roomStore.getDelivery(current.id);
    if (stranded?.state !== "dispatching" && stranded?.state !== "delivery_uncertain") {
      throw error;
    }
    return input.deliveryCoordinator.reconcile({
      store: input.roomStore,
      identity,
      outboxId: current.id,
      historyPageSize: input.historyPageSize,
      maxHistoryPages: input.maxHistoryPages,
      now: currentRecoveryTime(input),
      currentTime: input.currentTime,
      signal: input.signal,
      assertAuthority: input.assertAuthority,
      audit: input.audit,
    });
  }
}

function senderFenceFromLease(lease: StoredRoomLeaseV1): RoomRecoveryDispatchInput["senderFence"] {
  if (lease.kind !== "sender") {
    throw new RoomCrashRecoveryError(
      "room_recovery_sender_lease_required",
      `Room recovery lease ${lease.id} is not a sender lease`,
    );
  }
  return {
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: "sender",
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

async function listRecoverableDeliveries(
  input: RecoverRoomAfterCrashInput,
  latestCheckpoint: Awaited<ReturnType<AsyncRoomCheckpointStore["getLatestCheckpoint"]>>,
): Promise<readonly RecoverableDeliveryRow[]> {
  const unsettledDelivery = inArray(roomOutbox.deliveryState, [
    "pending",
    "dispatching",
    "delivery_uncertain",
  ]);
  const confirmedSinceCheckpoint = latestCheckpoint
    ? and(
      eq(roomOutbox.deliveryState, "confirmed"),
      latestCheckpoint.pendingOutboxIds.length > 0
        ? or(
          gt(roomOutbox.updatedAt, latestCheckpoint.createdAt),
          inArray(roomOutbox.id, latestCheckpoint.pendingOutboxIds),
        )
        : gt(roomOutbox.updatedAt, latestCheckpoint.createdAt),
    )
    : undefined;
  const rows = await input.layer.db
    .select({
      outboxId: roomOutbox.id,
      content: roomMessages.content,
      bindingId: roomBindings.id,
      connectorId: roomBindings.connectorId,
      providerId: roomBindings.providerId,
      nativeSessionId: roomBindings.nativeSessionId,
      happierSessionId: roomBindings.happierSessionId,
      serverProfileId: roomBindings.serverProfileId,
      machineId: roomBindings.machineId,
      hostId: roomBindings.hostId,
      transcriptCursor: roomBindingIngestionState.transcriptCursor,
      deliveryState: roomOutbox.deliveryState,
      nextAttemptAt: roomOutbox.nextAttemptAt,
    })
    .from(roomOutbox)
    .innerJoin(
      roomMessages,
      and(
        eq(roomMessages.projectId, roomOutbox.projectId),
        eq(roomMessages.roomId, roomOutbox.roomId),
        eq(roomMessages.id, roomOutbox.messageId),
      ),
    )
    .innerJoin(
      roomBindings,
      and(
        eq(roomBindings.projectId, roomOutbox.projectId),
        eq(roomBindings.roomId, roomOutbox.roomId),
        eq(roomBindings.id, roomOutbox.bindingId),
      ),
    )
    .leftJoin(
      roomBindingIngestionState,
      and(
        eq(roomBindingIngestionState.projectId, roomOutbox.projectId),
        eq(roomBindingIngestionState.roomId, roomOutbox.roomId),
        eq(roomBindingIngestionState.bindingId, roomOutbox.bindingId),
      ),
    )
    .where(and(
      eq(roomOutbox.projectId, input.projectId),
      eq(roomOutbox.roomId, input.roomId),
      confirmedSinceCheckpoint
        ? or(unsettledDelivery, confirmedSinceCheckpoint)
        : unsettledDelivery,
    ))
    .orderBy(asc(roomOutbox.createdAt), asc(roomOutbox.id));
  return [...rows].sort((left, right) => {
    return recoveryStatePriority(left.deliveryState)
      - recoveryStatePriority(right.deliveryState);
  });
}

async function advanceRecoveryCheckpoint(
  input: RecoverRoomAfterCrashInput,
  aggregateVersion: number,
  latest: Awaited<ReturnType<AsyncRoomCheckpointStore["getLatestCheckpoint"]>>,
  deliveries: readonly RoomOutboxRecordV1[],
): Promise<string | null> {
  if (!latest || latest.aggregateVersion > aggregateVersion) return latest?.id ?? null;

  const bindingCursors: Record<string, string | null> = { ...latest.bindingCursors };
  const confirmedDeliveries = deliveries
    .filter((delivery) => delivery.state === "confirmed" && delivery.nativeCursor)
    .sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    );
  for (const delivery of confirmedDeliveries) {
    bindingCursors[delivery.bindingId] = delivery.nativeCursor;
  }
  const currentPendingOutboxIds = deliveries
    .filter((delivery) =>
      delivery.state === "pending"
      || delivery.state === "dispatching"
      || delivery.state === "delivery_uncertain"
    )
    .map((delivery) => delivery.id)
    .sort();
  const deliveryStateHash = hashRoomValue({
    bindingCursors,
    currentPendingOutboxIds,
  }).slice("sha256:".length, "sha256:".length + 16);
  const checkpointInput = {
    id: `room-recovery-checkpoint:${input.roomId}:v${aggregateVersion}:${deliveryStateHash}`,
    roomId: input.roomId,
    turnId: latest.turnId,
    expectedAggregateVersion: aggregateVersion,
    protocolState: latest.protocolState,
    dagVersion: latest.dagVersion,
    bindingCursors,
    artifactRefs: latest.artifactRefs,
    now: input.now,
  } as const;
  const sameDeliveryState = hashRoomValue(latest.bindingCursors) === hashRoomValue(bindingCursors)
    && hashRoomValue([...latest.pendingOutboxIds].sort()) === hashRoomValue(currentPendingOutboxIds);
  if (latest.aggregateVersion === aggregateVersion) {
    if (sameDeliveryState) return latest.id;
    const checkpoint = await input.checkpointStore.replaceCheckpointAfterDeliveryRecovery({
      ...checkpointInput,
      previousCheckpointId: latest.id,
    });
    return checkpoint.id;
  }

  const checkpoint = await input.checkpointStore.createCheckpoint(checkpointInput);
  return checkpoint.id;
}

async function recoverNativeTakeover(
  input: RecoverRoomAfterCrashInput,
  deliveries: readonly RoomOutboxRecordV1[],
): Promise<NativeTakeoverRecoveryResultV1> {
  const takeover = input.nativeTakeover!;
  validateTakeover(input, takeover);
  await input.roomStore.recordConnectorIngestionMode({
    roomId: input.roomId,
    bindingId: takeover.bindingId,
    mode: "reconciling",
    occurredAt: input.now,
  });
  const ingestion = await input.roomStore.getConnectorIngestionState({
    roomId: input.roomId,
    bindingId: takeover.bindingId,
  });
  const blockedOutboxIds = deliveries
    .filter((delivery) =>
      delivery.bindingId === takeover.bindingId && delivery.state === "delivery_uncertain"
    )
    .map((delivery) => delivery.id)
    .sort();
  const oldSenderStillActive = await leaseIsActive(
    input.leaseStore,
    takeover.automaticSenderLease,
    input.now,
  );
  return {
    state: blockedOutboxIds.length > 0
      ? "blocked_delivery_uncertain"
      : "blocked_takeover_transfer",
    automaticSender: "paused",
    automaticSenderFenceActive: oldSenderStillActive,
    takeoverEpoch: takeover.automaticSenderLease.epoch,
    confirmedCursor: ingestion.transcriptCursor,
    blockedOutboxIds,
    senderLease: null,
  } satisfies NativeTakeoverRecoveryResultV1;
}

async function requireSenderLease(
  input: RecoverRoomAfterCrashInput,
  bindingId: string,
): Promise<StoredRoomLeaseV1> {
  const fixedLease = input.senderLease;
  const lease = fixedLease
    && fixedLease.kind === "sender"
    && fixedLease.roomId === input.roomId
    && fixedLease.resourceId === bindingId
    ? fixedLease
    : await input.resolveSenderLease?.(bindingId) ?? null;
  if (
    !lease
    || lease.kind !== "sender"
    || lease.roomId !== input.roomId
    || lease.resourceId !== bindingId
    || lease.holderId !== input.workerId
    || lease.hostId !== input.hostId
  ) {
    throw new RoomCrashRecoveryError(
      "room_recovery_sender_lease_required",
      `Pending Room delivery for binding ${bindingId} requires the current sender lease`,
    );
  }
  return lease;
}

async function findLatestRecoverySenderLease(
  input: AcquireRoomRecoverySenderLeaseInput,
): Promise<StoredRoomLeaseV1 | null> {
  const [row] = await input.layer.db
    .select()
    .from(roomLeases)
    .where(and(
      eq(roomLeases.projectId, input.projectId),
      eq(roomLeases.kind, "sender"),
      eq(roomLeases.resourceId, input.bindingId),
    ))
    .orderBy(desc(roomLeases.epoch))
    .limit(1);
  if (!row) return null;
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    kind: "sender",
    resourceId: row.resourceId,
    holderId: row.holderId,
    hostId: row.hostId,
    epoch: Number(row.epoch),
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  };
}

function isMatchingActiveRecoverySender(
  lease: StoredRoomLeaseV1,
  input: AcquireRoomRecoverySenderLeaseInput,
): boolean {
  return lease.kind === "sender"
    && lease.roomId === input.roomId
    && lease.resourceId === input.bindingId
    && lease.holderId === input.workerId
    && lease.hostId === input.hostId
    && lease.releasedAt === null
    && Date.parse(lease.expiresAt) > Date.parse(input.now);
}

async function assertLease(
  store: AsyncRoomLeaseStore,
  lease: StoredRoomLeaseV1,
  now: string,
): Promise<void> {
  await store.assertFence({
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: lease.kind,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  });
}

async function assertRecoveryAuthority(input: RecoverRoomAfterCrashInput): Promise<string> {
  throwIfRecoveryAborted(input.signal);
  await input.assertAuthority?.();
  throwIfRecoveryAborted(input.signal);
  return currentRecoveryTime(input);
}

function currentRecoveryTime(input: RecoverRoomAfterCrashInput): string {
  const now = input.currentTime?.() ?? input.now;
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== now) {
    throw new RoomCrashRecoveryError(
      "room_recovery_identity_conflict",
      `Room recovery clock returned invalid timestamp ${now}`,
    );
  }
  return now;
}

function throwIfRecoveryAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Room recovery aborted");
  error.name = "AbortError";
  throw error;
}

function recoveryStatePriority(state: string): number {
  if (state === "dispatching" || state === "delivery_uncertain") return 0;
  if (state === "pending") return 1;
  return 2;
}

async function leaseIsActive(
  store: AsyncRoomLeaseStore,
  lease: StoredRoomLeaseV1,
  now: string,
): Promise<boolean> {
  try {
    await assertLease(store, lease, now);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "stale_lease_fence")) return false;
    throw error;
  }
}

function validateRecoveryIdentity(input: RecoverRoomAfterCrashInput): void {
  if (
    !input.projectId.trim()
    || input.layer.projectId !== input.projectId
    || input.roomWorkerLease.kind !== "room_worker"
    || input.roomWorkerLease.roomId !== input.roomId
    || input.roomWorkerLease.resourceId !== input.roomId
    || input.roomWorkerLease.holderId !== input.workerId
    || input.roomWorkerLease.hostId !== input.hostId
  ) {
    throw new RoomCrashRecoveryError(
      "room_recovery_identity_conflict",
      "Room recovery project, Room, worker, host, and worker lease must identify one authority",
    );
  }
  if (!input.audit.runId.trim() || !input.audit.agentId.trim()) {
    throw new RoomCrashRecoveryError(
      "room_recovery_identity_conflict",
      "Room recovery requires durable run and agent audit identity",
    );
  }
  if (
    !Number.isSafeInteger(input.historyPageSize)
    || input.historyPageSize <= 0
    || !Number.isSafeInteger(input.maxHistoryPages)
    || input.maxHistoryPages <= 0
  ) {
    throw new RoomCrashRecoveryError(
      "room_recovery_identity_conflict",
      "Room recovery history bounds must be positive safe integers",
    );
  }
}

function validateTakeover(
  input: RecoverRoomAfterCrashInput,
  takeover: ReconcileNativeTakeoverAfterCrashInput,
): void {
  if (
    takeover.roomId !== input.roomId
    || takeover.roomWorkerLease.id !== input.roomWorkerLease.id
    || takeover.roomWorkerLease.epoch !== input.roomWorkerLease.epoch
    || takeover.automaticSenderLease.kind !== "sender"
    || takeover.automaticSenderLease.roomId !== input.roomId
    || takeover.automaticSenderLease.resourceId !== takeover.bindingId
    || takeover.hostId !== input.hostId
    || takeover.takeoverId !== `native-writer:${takeover.statusCursor}`
    || !takeover.idempotencyKey.trim()
    || !takeover.humanHolderId.trim()
  ) {
    throw new RoomCrashRecoveryError(
      "room_recovery_takeover_conflict",
      "Native takeover recovery identity or lease lineage does not match the Room",
    );
  }
}

function identityFromRow(row: RecoverableDeliveryRow): SessionConnectorIdentityV1 {
  return {
    connectorId: row.connectorId,
    providerId: row.providerId,
    nativeSessionId: row.nativeSessionId,
    happierSessionId: row.happierSessionId,
    serverProfileId: row.serverProfileId,
    machineId: row.machineId,
    hostId: row.hostId,
  };
}

function recoveryAttemptId(delivery: RoomOutboxRecordV1): string {
  return `room-recovery-attempt:${delivery.id}:${delivery.attemptCount + 1}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
