import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomMessages,
  roomOutbox,
  roomOutboxAttempts,
  roomProviderAdmissionRecoveryReceipts,
  roomProviderAdmissionTimeoutTombstones,
  roomProviderBackpressureCleanupActions,
  roomProviderBackpressureReservations,
  roomProviderBackpressureStates,
  roomSeats,
} from "../../postgres/schema/room.js";
import { hashRoomValue } from "../../room-integrity.js";
import { createRoomProviderBackpressureCleanupActions } from "../../room-provider-backpressure-cleanup-actions.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-provider-cleanup-a";
const PROJECT_B = "project-provider-cleanup-b";
const ROOM_A = "room-provider-cleanup-a";
const ROOM_B = "room-provider-cleanup-b";
const CREATED_AT = "2026-07-20T00:00:00.000Z";
const RESERVATION_EXPIRES_AT = "2026-07-20T00:05:00.000Z";
const OUTBOX_FINALIZED_AT = "2026-07-20T00:05:01.000Z";
const SEAT_A = "seat-provider-cleanup-a";
const BINDING_A = "binding-provider-cleanup-a";
const MESSAGE_A = "message-provider-cleanup-a";
const OUTBOX_A = "outbox-provider-cleanup-a";
const OUTBOX_ATTEMPT_A = "outbox-attempt-provider-cleanup-a";

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Provider cleanup action PostgreSQL fixture was not started");
  return sharedLayer;
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-provider-cleanup-actions-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 2 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

async function seedReservation(projectId = PROJECT_A, roomId = ROOM_A, suffix = "a"): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: roomId,
    projectId,
    objective: `Keep provider cleanup durable for ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 3,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await requireLayer().db.insert(roomProviderBackpressureStates).values({
    projectId,
    scopeKey: `provider-cleanup-scope-${suffix}`,
    providerId: "happier",
    accountId: "account-a",
    modelId: "gpt-5.6",
    connectorId: "happier-direct-session",
    nodeId: "windows-a",
    circuitState: "closed",
    consecutiveFailures: 0,
    retryAttempt: 0,
    retryNotBefore: null,
    openUntil: null,
    revision: 1,
    lastUpdatedAt: CREATED_AT,
  });
  await requireLayer().db.insert(roomProviderBackpressureReservations).values({
    id: `reservation-${suffix}`,
    projectId,
    scopeKey: `provider-cleanup-scope-${suffix}`,
    roomId,
    requestId: `request-${suffix}`,
    claimId: `claim-${suffix}`,
    leaseId: `room-worker-lease-${suffix}`,
    leaseEpoch: 1,
    expectedAggregateVersion: 3,
    workClass: "normal",
    isHalfOpenProbe: false,
    circuitOpenMs: 5_000,
    acquiredAt: CREATED_AT,
    expiresAt: RESERVATION_EXPIRES_AT,
    releasedAt: null,
    releaseOutcome: null,
  });
}

interface ExactUncertainOutboxOptions {
  readonly attemptId?: string;
  readonly attemptCount?: number;
  readonly deliveryState?: "delivery_uncertain" | "dispatching" | "pending";
  readonly includeAttempt?: boolean;
  readonly attemptOutcome?: "delivery_uncertain" | "started";
  readonly attemptEndedAt?: string | null;
  readonly lastErrorCode?: string | null;
  readonly nativeAcknowledgement?: { readonly nativeMessageId: string } | null;
  readonly nativeCursor?: string | null;
}

async function seedExactUncertainOutbox(
  options: ExactUncertainOutboxOptions = {},
): Promise<{ readonly id: string; readonly bindingId: string; readonly attemptId: string; readonly attemptCount: number }> {
  const attemptId = options.attemptId ?? OUTBOX_ATTEMPT_A;
  const attemptCount = options.attemptCount ?? 1;
  const deliveryState = options.deliveryState ?? "delivery_uncertain";
  const attemptOutcome = options.attemptOutcome ?? "delivery_uncertain";
  const attemptEndedAt = options.attemptEndedAt === undefined
    ? "2026-07-20T00:00:02.000Z"
    : options.attemptEndedAt;
  const lastErrorCode = options.lastErrorCode === undefined ? "sender_crashed" : options.lastErrorCode;
  const nativeAcknowledgement = options.nativeAcknowledgement ?? null;
  const nativeCursor = options.nativeCursor ?? null;
  const includeAttempt = options.includeAttempt ?? true;
  const layer = requireLayer();
  await layer.db.insert(roomSeats).values({
    id: SEAT_A,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    role: "producer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["session:send"],
    state: "active",
    activeBindingId: BINDING_A,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await layer.db.insert(roomBindings).values({
    id: BINDING_A,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    seatId: SEAT_A,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "codex-thread-provider-cleanup-a",
    happierSessionId: "happier-session-provider-cleanup-a",
    serverProfileId: "server-profile-provider-cleanup-a",
    machineId: "machine-provider-cleanup-a",
    hostId: "windows-a",
    state: "attached",
    attachedAt: CREATED_AT,
  });
  await layer.db.insert(roomMessages).values({
    id: MESSAGE_A,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    turnId: null,
    nodeId: null,
    originType: "controller",
    originId: "controller-provider-cleanup-a",
    intent: "instruction",
    target: { kind: "seat", seatId: SEAT_A },
    targetSeatIds: [SEAT_A],
    authority: { allowedActions: ["session:send"] },
    idempotencyKey: "provider-cleanup-message-a",
    expectedAggregateVersion: 3,
    content: "Keep cleanup outbox state durable.",
    contentHash: "provider-cleanup-message-hash-a",
    evidenceRefs: [],
    createdAt: CREATED_AT,
  });
  await layer.db.insert(roomOutbox).values({
    id: OUTBOX_A,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    messageId: MESSAGE_A,
    bindingId: BINDING_A,
    logicalMessageId: "logical-message-provider-cleanup-a",
    localMessageId: "local-message-provider-cleanup-a",
    idempotencyKey: "provider-cleanup-outbox-a",
    payloadHash: "provider-cleanup-outbox-hash-a",
    deliveryState,
    nativeAcknowledgement,
    nativeCursor,
    reconciliationFromCursor: null,
    reconciliationEvidenceRef: "provider-cleanup-evidence-a",
    dispatchTaskNodeId: null,
    dispatchClaimNodeVersion: null,
    attemptCount,
    lastErrorCode,
    nextAttemptAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  if (includeAttempt) {
    await layer.db.insert(roomOutboxAttempts).values({
      id: attemptId,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      outboxId: OUTBOX_A,
      attempt: attemptCount,
      startedAt: "2026-07-20T00:00:01.000Z",
      endedAt: attemptEndedAt,
      outcome: attemptOutcome,
      errorCode: lastErrorCode,
      evidenceRef: "provider-cleanup-evidence-a",
    });
  }
  return { id: OUTBOX_A, bindingId: BINDING_A, attemptId, attemptCount };
}

async function acquireCleanupWorkerLease(options: {
  readonly leaseId?: string;
  readonly holderId?: string;
  readonly expectedEpoch?: number | null;
  readonly now?: string;
  readonly expiresAt?: string;
} = {}): Promise<StoredRoomLeaseV1> {
  const store = new AsyncRoomLeaseStore(
    createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
    { projectId: PROJECT_A },
  );
  const result = await store.acquireLease({
    leaseId: options.leaseId ?? "cleanup-worker-lease-a",
    roomId: ROOM_A,
    kind: "room_worker",
    resourceId: ROOM_A,
    holderId: options.holderId ?? "worker:cleanup-worker-lease-a",
    hostId: "windows-a",
    expectedEpoch: options.expectedEpoch ?? null,
    now: options.now ?? CREATED_AT,
    expiresAt: options.expiresAt ?? "2026-07-20T00:10:00.000Z",
  });
  if (!result.ok) throw new Error(`Could not acquire cleanup worker lease: ${result.reason}`);
  return result.lease;
}

async function acquireSenderLease(bindingId = BINDING_A): Promise<StoredRoomLeaseV1> {
  const store = new AsyncRoomLeaseStore(
    createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
    { projectId: PROJECT_A },
  );
  const result = await store.acquireLease({
    leaseId: "sender-lease-provider-cleanup-a",
    roomId: ROOM_A,
    kind: "sender",
    resourceId: bindingId,
    holderId: "worker:sender-lease-provider-cleanup-a",
    hostId: "windows-a",
    expectedEpoch: null,
    now: CREATED_AT,
    expiresAt: "2026-07-20T00:10:00.000Z",
  });
  if (!result.ok) throw new Error(`Could not acquire sender lease: ${result.reason}`);
  return result.lease;
}

async function releaseSenderLease(lease: StoredRoomLeaseV1, now: string): Promise<void> {
  const store = new AsyncRoomLeaseStore(
    createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
    { projectId: PROJECT_A },
  );
  const result = await store.releaseLease({
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: "sender",
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  });
  if (!result.ok) throw new Error(`Could not release sender lease: ${result.reason}`);
}

async function seedRecordedAdmissionTimeout(
  actions: ReturnType<typeof createRoomProviderBackpressureCleanupActions>,
  suffix: string,
) {
  const target = await seedExactUncertainOutbox({
    deliveryState: "pending",
    attemptCount: 0,
    includeAttempt: false,
    lastErrorCode: null,
  });
  await requireLayer().db.delete(roomProviderBackpressureReservations);
  const senderLease = await acquireSenderLease(target.bindingId);
  const gateAttemptId = `provider-admission:${target.id}:${suffix}`;
  const requestHash = hashRoomValue({ gateAttemptId, target });
  const senderFence = {
    leaseId: senderLease.id,
    roomId: ROOM_A,
    kind: "sender" as const,
    resourceId: target.bindingId,
    holderId: senderLease.holderId,
    hostId: senderLease.hostId,
    expectedEpoch: senderLease.epoch,
  };
  await actions.fencePendingAdmissionTimeout({
    projectId: PROJECT_A,
    roomId: ROOM_A,
    gateAttemptId,
    requestHash,
    outboxId: target.id,
    outboxBindingId: target.bindingId,
    outboxAttemptCount: target.attemptCount,
    senderFence,
    recoveryProtocol: "core_sender_fenced_v1" as const,
    errorCode: "provider_gate_timeout",
    now: CREATED_AT,
    audit: { runId: `run-provider-timeout-${suffix}-fence`, agentId: senderLease.holderId },
  });
  const terminalGateOutcome = {
    outcomeId: `provider-gate-terminal-${suffix}`,
    outcome: "cancelled_without_permit" as const,
    occurredAt: "2026-07-20T00:00:01.000Z",
  };
  const recordInput = {
    projectId: PROJECT_A,
    roomId: ROOM_A,
    gateAttemptId,
    requestHash,
    outboxId: target.id,
    outboxBindingId: target.bindingId,
    outboxAttemptCount: target.attemptCount,
    senderFence,
    terminalGateOutcome,
    now: "2026-07-20T00:00:02.000Z",
    audit: { runId: `run-provider-timeout-${suffix}-record`, agentId: senderLease.holderId },
  };
  await expect(actions.recordAdmissionTimeoutTerminalOutcome(recordInput))
    .resolves.toMatchObject({ status: "recorded", tombstone: { state: "terminal_outcome_recorded" } });
  return { target, senderLease, gateAttemptId, requestHash, terminalGateOutcome, recordInput };
}

async function restartSharedConnectionPool(): Promise<void> {
  const context = sharedContext;
  const oldConnections = context?.connections;
  if (!context || !oldConnections) throw new Error("Cannot restart an unavailable PostgreSQL fixture pool");
  const backend = oldConnections.backend;
  context.connections = null;
  sharedLayer = null;
  await oldConnections.close();
  await expect(oldConnections.ping()).rejects.toThrow();
  const restartedConnections = await createConnectionSetFromUrl(backend, { poolMax: 2 });
  context.connections = restartedConnections;
  sharedLayer = createAsyncDataLayer(restartedConnections, { projectId: PROJECT_A });
}

async function completesWithin<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Concurrent PostgreSQL transitions exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function expireExactPreSendAction(
  actionId: string,
  target: { readonly id: string; readonly bindingId: string; readonly attemptId: string; readonly attemptCount: number },
  cleanupWorkerLease: StoredRoomLeaseV1,
): Promise<void> {
  const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
  await actions.enqueue({
    projectId: PROJECT_A,
    roomId: ROOM_A,
    actionId,
    idempotencyKey: `cleanup-${actionId}`,
    outboxId: target.id,
    outboxBindingId: target.bindingId,
    outboxAttemptId: target.attemptId,
    outboxAttemptCount: target.attemptCount,
    reservationId: "reservation-a",
    requestId: "request-a",
    claimId: "claim-a",
    originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
    expectedAggregateVersion: 3,
    reservationExpiresAt: RESERVATION_EXPIRES_AT,
    completionKind: "pre_send_not_started",
    createdAt: CREATED_AT,
  });
  const claimed = await actions.claimNext({
    projectId: PROJECT_A,
    roomId: ROOM_A,
    cleanupWorkerLease,
    now: CREATED_AT,
    claimTtlMs: 60_000,
  });
  if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed exact pre-send cleanup action");
  await expect(actions.markExpired({
    projectId: PROJECT_A,
    roomId: ROOM_A,
    cleanupWorkerLease,
    actionId: claimed.id,
    claimToken: claimed.claimToken,
    now: RESERVATION_EXPIRES_AT,
  })).resolves.toMatchObject({ status: "expired", action: { state: "expired" } });
}

describe.sequential("provider backpressure cleanup action ledger", () => {
  beforeAll(async () => {
    sharedContext = await startEmbeddedDatabase();
    sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_A });
  }, 120_000);

  beforeEach(async () => {
    await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
    await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.room_provider_backpressure_states RESTART IDENTITY CASCADE"));
    await seedReservation();
  });

  /*
   * FNXC:EmbeddedPostgresShutdownBudget 2026-07-20-02:03:
   * Windows embedded PostgreSQL performs a durable checkpoint during shutdown.
   * On this fixture it can legitimately exceed Vitest's 15s default after all
   * assertions have finished; reserve an explicit teardown-only budget rather
   * than reporting a false functional failure or weakening product behavior.
   */
  afterAll(async () => {
    await sharedContext?.connections?.close();
    await sharedContext?.lifecycle.stop();
    if (sharedContext) rmSync(sharedContext.dataDir, { recursive: true, force: true });
    sharedContext = null;
    sharedLayer = null;
  }, 45_000);

  it("idempotently records one cleanup action for the immutable reservation fence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const input = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-a",
      idempotencyKey: "cleanup-reservation-a",
      outboxId: null,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: {
        leaseId: "room-worker-lease-a",
        holderId: "worker:room-worker-lease-a",
        hostId: "windows-a",
        epoch: 1,
      },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started" as const,
      createdAt: CREATED_AT,
    };

    const created = await actions.enqueue(input);
    const replayed = await actions.enqueue(input);

    expect(created).toMatchObject({ status: "created", action: { id: "cleanup-action-a", state: "pending" } });
    expect(replayed).toMatchObject({ status: "replayed", action: { id: "cleanup-action-a", state: "pending" } });
  });

  it("keeps identical cleanup idempotency keys isolated by project and room", async () => {
    await seedReservation(PROJECT_B, ROOM_B, "b");
    const actionsA = createRoomProviderBackpressureCleanupActions({
      layer: createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
    });
    const actionsB = createRoomProviderBackpressureCleanupActions({
      layer: createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_B }),
    });
    const sharedKey = "same-cleanup-key";

    const actionA = await actionsA.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-a",
      idempotencyKey: sharedKey,
      outboxId: null,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started",
      createdAt: CREATED_AT,
    });
    const actionB = await actionsB.enqueue({
      projectId: PROJECT_B,
      roomId: ROOM_B,
      actionId: "cleanup-action-b",
      idempotencyKey: sharedKey,
      outboxId: null,
      reservationId: "reservation-b",
      requestId: "request-b",
      claimId: "claim-b",
      originalWorkerFence: { leaseId: "room-worker-lease-b", holderId: "worker:room-worker-lease-b", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started",
      createdAt: CREATED_AT,
    });

    expect(actionA).toMatchObject({ status: "created", action: { projectId: PROJECT_A, id: "cleanup-action-a" } });
    expect(actionB).toMatchObject({ status: "created", action: { projectId: PROJECT_B, id: "cleanup-action-b" } });
  });

  it("does not mark a claimed cleanup action expired before the original reservation expires", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const lease = await acquireCleanupWorkerLease();
    await actions.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-a",
      idempotencyKey: "cleanup-reservation-a",
      outboxId: null,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started",
      createdAt: CREATED_AT,
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: { ...lease, epoch: lease.epoch + 1 },
      now: CREATED_AT,
      claimTtlMs: 60_000,
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed cleanup action");

    await expect(actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: "2026-07-20T00:04:59.999Z",
    })).resolves.toMatchObject({ status: "not_due", action: { state: "claimed" } });
  });

  it("records a late successful reservation release instead of falsely calling it an unreleased expiry", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const lease = await acquireCleanupWorkerLease();
    await actions.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-released",
      idempotencyKey: "cleanup-reservation-released",
      outboxId: "outbox-a",
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started",
      createdAt: CREATED_AT,
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed cleanup action");
    await requireLayer().db.update(roomProviderBackpressureReservations).set({
      releasedAt: "2026-07-20T00:00:01.000Z",
    }).where(eq(roomProviderBackpressureReservations.id, "reservation-a"));

    await expect(actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: "2026-07-20T00:00:02.000Z",
    })).resolves.toMatchObject({
      status: "released",
      action: {
        state: "released",
        lastErrorCode: null,
        completedAt: "2026-07-20T00:00:02.000Z",
      },
    });
  });

  it("records cleanup observation time when a late release predates action creation", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const lease = await acquireCleanupWorkerLease();
    const actionCreatedAt = "2026-07-20T00:00:02.000Z";
    const observedReleasedAt = "2026-07-20T00:00:01.000Z";
    const cleanupObservedAt = "2026-07-20T00:00:03.000Z";
    await actions.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-precreated-release",
      idempotencyKey: "cleanup-reservation-precreated-release",
      outboxId: "outbox-a",
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_send_not_started",
      createdAt: actionCreatedAt,
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      now: actionCreatedAt,
      claimTtlMs: 60_000,
    });
    if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed cleanup action");
    await requireLayer().db.update(roomProviderBackpressureReservations).set({
      releasedAt: observedReleasedAt,
    }).where(eq(roomProviderBackpressureReservations.id, "reservation-a"));

    await expect(actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: cleanupObservedAt,
    })).resolves.toMatchObject({
      status: "released",
      action: {
        state: "released",
        completedAt: cleanupObservedAt,
      },
    });
  });

  it("records only the original reservation expiry under the current cleanup-worker fence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const lease = await acquireCleanupWorkerLease();
    await actions.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-a",
      idempotencyKey: "cleanup-reservation-a",
      outboxId: "outbox-a",
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "late_admission_not_started",
      createdAt: CREATED_AT,
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed cleanup action");

    const expired = await actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: lease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: RESERVATION_EXPIRES_AT,
    });
    const stored = await actions.get({ projectId: PROJECT_A, roomId: ROOM_A, actionId: claimed.id });

    expect(expired).toMatchObject({
      status: "expired",
      action: {
        state: "expired",
        lastErrorCode: "reservation_expired_unreleased",
        completedAt: RESERVATION_EXPIRES_AT,
        claimToken: null,
      },
    });
    expect(stored).toMatchObject({
      state: "expired",
      reservationId: "reservation-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", epoch: 1 },
    });
  });

  it("unblocks only a terminal pre-send action's exact outbox attempt", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox();
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    await expireExactPreSendAction("cleanup-action-exact-outbox", target, cleanupWorkerLease);

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-exact-outbox",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-exact-outbox", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "unblocked",
      action: { id: "cleanup-action-exact-outbox", state: "expired", outboxUnblockedAt: OUTBOX_FINALIZED_AT },
    });

    const outbox = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, target.id)))[0];
    const attempt = (await requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.id, target.attemptId)))[0];
    expect(outbox).toMatchObject({
      id: target.id,
      deliveryState: "pending",
      attemptCount: target.attemptCount,
      nativeAcknowledgement: null,
      nativeCursor: null,
      lastErrorCode: "provider_cleanup_expired_before_send",
      nextAttemptAt: null,
      updatedAt: OUTBOX_FINALIZED_AT,
    });
    expect(attempt).toMatchObject({
      id: target.attemptId,
      attempt: target.attemptCount,
      outcome: "delivery_uncertain",
      endedAt: "2026-07-20T00:00:02.000Z",
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });

  it("durably tombstones a pre-permit timeout before a later retry can claim a second admission", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:generation-0";
    const requestHash = hashRoomValue({
      contractVersion: 1,
      gateAttemptId,
      outboxId: target.id,
      bindingId: target.bindingId,
      attemptCount: target.attemptCount,
    });

    await expect(actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      recoveryProtocol: "core_sender_fenced_v1",
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-tombstone", agentId: senderLease.holderId },
    })).resolves.toMatchObject({
      status: "created",
      tombstone: {
        state: "pending",
        gateAttemptId,
        requestHash,
        outboxId: target.id,
        outboxAttemptCount: 0,
        reservationId: null,
        cleanupActionId: null,
        terminalGateOutcome: null,
      },
      outbox: {
        id: target.id,
        state: "delivery_uncertain",
        attemptCount: 0,
        nextAttemptAt: null,
      },
    });

    const roomStore = new AsyncRoomStore(requireLayer(), { projectId: PROJECT_A });
    await expect(roomStore.beginDeliveryAttempt({
      outboxId: target.id,
      attemptId: "second-provider-admission-after-timeout",
      reconciliationFromCursor: null,
      now: "2026-07-20T00:30:00.000Z",
    })).rejects.toThrow(/delivery uncertain/i);
    await expect(requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.outboxId, target.id))).resolves.toHaveLength(0);
  });

  it("persists Core sender-fenced provenance without granting opaque gates automatic recovery", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:core-sender-fenced";

    const result = await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash: hashRoomValue({ gateAttemptId, target }),
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      recoveryProtocol: "core_sender_fenced_v1",
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-core-sender-fenced", agentId: senderLease.holderId },
    });

    expect(result.tombstone).toMatchObject({
      state: "pending",
      recoveryProtocol: "core_sender_fenced_v1",
    });
  });

  it("binds an existing Core sender-fenced reservation after a crashed late callback without reopening delivery", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const leaseStore = new AsyncRoomLeaseStore(
      createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
      { projectId: PROJECT_A },
    );
    const originalWorkerResult = await leaseStore.acquireLease({
      leaseId: "room-worker-before-admission-timeout",
      roomId: ROOM_A,
      kind: "room_worker",
      resourceId: ROOM_A,
      holderId: "worker:before-admission-timeout",
      hostId: "windows-a",
      expectedEpoch: null,
      now: CREATED_AT,
      expiresAt: "2026-07-20T00:10:00.000Z",
    });
    if (!originalWorkerResult.ok) throw new Error(`Could not acquire original worker lease: ${originalWorkerResult.reason}`);
    const originalWorkerLease = originalWorkerResult.lease;
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:crashed-late-callback";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    const requestId = `room-provider-capacity:${target.id}:${gateAttemptId}`;
    const fenced = await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      recoveryProtocol: "core_sender_fenced_v1",
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-crashed-late-callback", agentId: senderLease.holderId },
    });
    await requireLayer().db.insert(roomProviderBackpressureReservations).values({
      id: "reservation-crashed-late-callback",
      projectId: PROJECT_A,
      scopeKey: "provider-cleanup-scope-a",
      roomId: ROOM_A,
      requestId,
      claimId: `${target.id}:${gateAttemptId}`,
      leaseId: originalWorkerLease.id,
      leaseEpoch: originalWorkerLease.epoch,
      expectedAggregateVersion: 3,
      workClass: "normal",
      isHalfOpenProbe: false,
      circuitOpenMs: 5_000,
      acquiredAt: CREATED_AT,
      expiresAt: RESERVATION_EXPIRES_AT,
      releasedAt: null,
      releaseOutcome: null,
    });
    await releaseSenderLease(senderLease, "2026-07-20T00:00:01.000Z");
    const originalRelease = await leaseStore.releaseLease({
      leaseId: originalWorkerLease.id,
      roomId: ROOM_A,
      kind: "room_worker",
      resourceId: ROOM_A,
      holderId: originalWorkerLease.holderId,
      hostId: originalWorkerLease.hostId,
      expectedEpoch: originalWorkerLease.epoch,
      now: "2026-07-20T00:00:01.000Z",
    });
    if (!originalRelease.ok) throw new Error(`Could not release original worker lease: ${originalRelease.reason}`);
    const cleanupWorkerLease = await acquireCleanupWorkerLease({
      expectedEpoch: originalWorkerLease.epoch,
      now: "2026-07-20T00:00:02.000Z",
    });

    const recovered = await actions.reconcilePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:03.000Z",
      audit: { runId: "run-provider-timeout-reconcile", agentId: cleanupWorkerLease.holderId },
    });

    expect(recovered).toMatchObject({
      status: "reservation_bound",
      tombstone: {
        id: fenced.tombstone.id,
        state: "reservation_bound",
        reservationId: "reservation-crashed-late-callback",
      },
      action: {
        completionKind: "pre_claim_not_started",
        reservationId: "reservation-crashed-late-callback",
        originalWorkerFence: {
          leaseId: originalWorkerLease.id,
          epoch: originalWorkerLease.epoch,
        },
      },
      outbox: { id: target.id, state: "delivery_uncertain", nextAttemptAt: null },
    });
  });

  /*
  FNXC:RoomProviderAdmissionNoReservationRecovery 2026-07-21-01:51:
  A Core receipt without a durable reservation is not evidence that a provider
  send completed. Crash reconciliation records the explicit no-reservation
  terminal outcome and leaves delivery uncertain; only the existing claimed
  terminal path may schedule a future retry.
  */
  it("records a Core receipt-backed no-reservation timeout before the claimed terminal path may reopen", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:core-no-reservation";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    const senderFence = {
      leaseId: senderLease.id,
      roomId: ROOM_A,
      kind: "sender" as const,
      resourceId: target.bindingId,
      holderId: senderLease.holderId,
      hostId: senderLease.hostId,
      expectedEpoch: senderLease.epoch,
    };
    const fenced = await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence,
      recoveryProtocol: "core_sender_fenced_v1",
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-core-no-reservation-fence", agentId: senderLease.holderId },
    });
    const recoveryReceiptId = fenced.tombstone.recoveryReceiptId;
    if (!recoveryReceiptId) throw new Error("Expected Core sender-fenced timeout to persist a recovery receipt");
    await expect(requireLayer().db.select().from(roomProviderAdmissionRecoveryReceipts)).resolves.toMatchObject([{
      id: recoveryReceiptId,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      outboxId: target.id,
      gateAttemptId,
      requestHash,
      senderLeaseId: senderLease.id,
      senderLeaseEpoch: senderLease.epoch,
    }]);

    await releaseSenderLease(senderLease, "2026-07-20T00:00:01.000Z");
    const cleanupWorkerLease = await acquireCleanupWorkerLease({
      now: "2026-07-20T00:00:02.000Z",
    });
    const reconciled = await actions.reconcilePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:03.000Z",
      audit: { runId: "run-provider-timeout-core-no-reservation-reconcile", agentId: cleanupWorkerLease.holderId },
    });

    expect(reconciled).toMatchObject({
      status: "terminal_outcome_recorded",
      tombstone: {
        id: fenced.tombstone.id,
        recoveryProtocol: "core_sender_fenced_v1",
        recoveryReceiptId,
        state: "terminal_outcome_recorded",
        cleanupActionId: null,
        reservationId: null,
        terminalGateOutcome: "core_sender_fenced_no_reservation",
        terminalAt: "2026-07-20T00:00:03.000Z",
        nextAttemptAt: null,
        resolvedAt: null,
      },
      outbox: {
        id: target.id,
        state: "delivery_uncertain",
        attemptCount: target.attemptCount,
        nextAttemptAt: null,
      },
    });
    const terminalOutcomeId = reconciled?.tombstone.terminalGateOutcomeId;
    if (!terminalOutcomeId) throw new Error("Expected no-reservation reconciliation to persist a terminal outcome id");
    await expect(requireLayer().db.select().from(roomProviderBackpressureCleanupActions)).resolves.toHaveLength(0);
    await expect(requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.outboxId, target.id))).resolves.toHaveLength(0);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id)))
      .resolves.toMatchObject([{
        deliveryState: "delivery_uncertain",
        attemptCount: target.attemptCount,
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      }]);

    await expect(actions.resolveAdmissionTimeoutWithoutPermit({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      cleanupWorkerLease,
      claimToken: "unclaimed-core-no-reservation-terminal-outcome",
      now: "2026-07-20T00:00:04.000Z",
      nextAttemptAt: "2026-07-20T00:01:00.000Z",
      audit: { runId: "run-provider-timeout-core-no-reservation-unclaimed", agentId: cleanupWorkerLease.holderId },
    })).rejects.toThrow(/must be claimed/i);

    const claimed = await actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:05.000Z",
      claimTtlMs: 60_000,
    });
    expect(claimed).toMatchObject({
      id: fenced.tombstone.id,
      recoveryReceiptId,
      state: "terminal_outcome_claimed",
      terminalGateOutcomeId: terminalOutcomeId,
      terminalGateOutcome: "core_sender_fenced_no_reservation",
      claimLeaseId: cleanupWorkerLease.id,
      claimLeaseEpoch: cleanupWorkerLease.epoch,
    });
    if (!claimed?.claimToken) throw new Error("Expected claimed no-reservation terminal outcome to carry a claim token");

    const nextAttemptAt = "2026-07-20T00:01:00.000Z";
    await expect(actions.resolveAdmissionTimeoutWithoutPermit({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      cleanupWorkerLease,
      claimToken: claimed.claimToken,
      now: "2026-07-20T00:00:06.000Z",
      nextAttemptAt,
      audit: { runId: "run-provider-timeout-core-no-reservation-resolve", agentId: cleanupWorkerLease.holderId },
    })).resolves.toMatchObject({
      status: "resolved",
      tombstone: {
        state: "terminal_without_permit",
        recoveryReceiptId,
        terminalGateOutcomeId: terminalOutcomeId,
        terminalGateOutcome: "core_sender_fenced_no_reservation",
        nextAttemptAt,
        resolvedAt: "2026-07-20T00:00:06.000Z",
      },
      outbox: {
        id: target.id,
        state: "pending",
        attemptCount: target.attemptCount,
        lastErrorCode: "provider_gate_terminal_without_permit",
        nextAttemptAt,
      },
    });
    await expect(requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.outboxId, target.id))).resolves.toHaveLength(0);
  });

  it("replays one immutable timeout tombstone and rejects a duplicate gate target", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:replay";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    const input = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender" as const,
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-replay", agentId: senderLease.holderId },
    };

    const created = await actions.fencePendingAdmissionTimeout(input);
    await expect(actions.fencePendingAdmissionTimeout({
      ...input,
      gateAttemptId: `${gateAttemptId}:duplicate`,
      requestHash: hashRoomValue({ gateAttemptId: `${gateAttemptId}:duplicate`, target }),
      audit: { runId: "run-provider-timeout-duplicate-target", agentId: senderLease.holderId },
    })).rejects.toThrow(/another immutable gate attempt/i);
    await releaseSenderLease(senderLease, OUTBOX_FINALIZED_AT);
    const replayed = await actions.fencePendingAdmissionTimeout({
      ...input,
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-timeout-replayed", agentId: senderLease.holderId },
    });

    expect(replayed).toMatchObject({
      status: "replayed",
      tombstone: created.tombstone,
      outbox: created.outbox,
    });
    await expect(requireLayer().db.select().from(roomProviderAdmissionTimeoutTombstones))
      .resolves.toHaveLength(1);
  });

  it("rejects a stale sender fence without creating a timeout tombstone", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:stale-sender";

    await expect(actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash: hashRoomValue({ gateAttemptId, target }),
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch + 1,
      },
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-stale-sender", agentId: senderLease.holderId },
    })).rejects.toThrow(/fence|lease|epoch/i);

    await expect(requireLayer().db.select().from(roomProviderAdmissionTimeoutTombstones))
      .resolves.toHaveLength(0);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id)))
      .resolves.toMatchObject([{
        deliveryState: "pending",
        attemptCount: 0,
        lastErrorCode: null,
        nextAttemptAt: null,
      }]);
  });

  it("binds a late permit to the existing tombstone cleanup route without reopening delivery", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const reservation = (await requireLayer().db.select().from(roomProviderBackpressureReservations))[0]!;
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:late-permit";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-late-permit-fence", agentId: senderLease.holderId },
    });
    await requireLayer().db.insert(roomProviderBackpressureReservations).values(reservation);

    await expect(actions.bindAdmissionTimeoutReservation({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      cleanupAction: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        actionId: "cleanup-action-late-timeout-permit",
        idempotencyKey: "cleanup-action-late-timeout-permit",
        outboxId: target.id,
        outboxBindingId: target.bindingId,
        outboxAttemptId: null,
        outboxAttemptCount: target.attemptCount,
        reservationId: reservation.id,
        requestId: reservation.requestId,
        claimId: reservation.claimId,
        originalWorkerFence: {
          leaseId: reservation.leaseId,
          holderId: "worker:room-worker-lease-a",
          hostId: "windows-a",
          epoch: reservation.leaseEpoch,
        },
        expectedAggregateVersion: reservation.expectedAggregateVersion,
        reservationExpiresAt: reservation.expiresAt,
        completionKind: "pre_claim_not_started",
        createdAt: "2026-07-20T00:00:30.000Z",
      },
      now: "2026-07-20T00:00:30.000Z",
      audit: { runId: "run-provider-timeout-late-permit-bind", agentId: senderLease.holderId },
    })).resolves.toMatchObject({
      status: "bound",
      tombstone: {
        state: "reservation_bound",
        gateAttemptId,
        requestHash,
        reservationId: reservation.id,
        cleanupActionId: "cleanup-action-late-timeout-permit",
        resolvedAt: "2026-07-20T00:00:30.000Z",
      },
      action: {
        id: "cleanup-action-late-timeout-permit",
        completionKind: "pre_claim_not_started",
        state: "pending",
        reservationId: reservation.id,
      },
      outbox: {
        id: target.id,
        state: "delivery_uncertain",
        attemptCount: target.attemptCount,
        nextAttemptAt: null,
      },
    });
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id)))
      .resolves.toMatchObject([{
        deliveryState: "delivery_uncertain",
        attemptCount: target.attemptCount,
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      }]);
  });

  it("reopens a no-permit timeout only from explicit terminal gate proof at a future nextAttemptAt", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const expiredCleanupWorkerLease = await acquireCleanupWorkerLease({
      expiresAt: "2026-07-20T00:00:10.000Z",
    });
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:terminal-no-permit";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      recoveryProtocol: "core_sender_fenced_v1",
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-terminal-fence", agentId: senderLease.holderId },
    });
    const terminalGateOutcome = {
      outcomeId: "provider-gate-terminal-no-permit-a",
      outcome: "cancelled_without_permit" as const,
      occurredAt: "2026-07-20T00:00:20.000Z",
    };
    await expect(actions.recordAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      terminalGateOutcome,
      now: "2026-07-20T00:00:25.000Z",
      audit: { runId: "run-provider-timeout-terminal-record", agentId: senderLease.holderId },
    })).resolves.toMatchObject({
      status: "recorded",
      tombstone: {
        state: "terminal_outcome_recorded",
        terminalGateOutcomeId: terminalGateOutcome.outcomeId,
        terminalGateOutcome: terminalGateOutcome.outcome,
        terminalAt: terminalGateOutcome.occurredAt,
        nextAttemptAt: null,
        resolvedAt: null,
      },
      outbox: { state: "delivery_uncertain", nextAttemptAt: null },
    });
    await expect(actions.recordAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      terminalGateOutcome,
      now: "2026-07-20T00:00:26.000Z",
      audit: { runId: "run-provider-timeout-terminal-record-replay", agentId: senderLease.holderId },
    })).resolves.toMatchObject({
      status: "replayed",
      tombstone: {
        state: "terminal_outcome_recorded",
        terminalGateOutcomeId: terminalGateOutcome.outcomeId,
      },
      outbox: { state: "delivery_uncertain", nextAttemptAt: null },
    });
    await expect(actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: expiredCleanupWorkerLease,
      now: "2026-07-20T00:00:26.000Z",
      claimTtlMs: 60_000,
    })).rejects.toThrow(/expired|fence/i);
    const cleanupWorkerLease = await acquireCleanupWorkerLease({
      leaseId: "cleanup-worker-lease-b",
      holderId: "worker:cleanup-worker-lease-b",
      expectedEpoch: expiredCleanupWorkerLease.epoch,
      now: "2026-07-20T00:00:27.000Z",
      expiresAt: "2026-07-20T00:10:00.000Z",
    });
    const claimed = await actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:28.000Z",
      claimTtlMs: 60_000,
    });
    expect(claimed).toMatchObject({
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      state: "terminal_outcome_claimed",
      terminalGateOutcomeId: terminalGateOutcome.outcomeId,
      claimLeaseId: cleanupWorkerLease.id,
      claimLeaseEpoch: cleanupWorkerLease.epoch,
      claimedAt: "2026-07-20T00:00:28.000Z",
      claimExpiresAt: "2026-07-20T00:01:28.000Z",
    });
    if (!claimed?.claimToken) throw new Error("Expected the terminal outcome tombstone to carry a durable claim token");
    await expect(actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:29.000Z",
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
    const resolution = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      cleanupWorkerLease,
      claimToken: claimed.claimToken,
      now: "2026-07-20T00:00:30.000Z",
      nextAttemptAt: "2026-07-20T00:01:00.000Z",
      audit: { runId: "run-provider-timeout-terminal-resolve", agentId: cleanupWorkerLease.holderId },
    };

    await expect(actions.resolveAdmissionTimeoutWithoutPermit(resolution))
      .resolves.toMatchObject({ status: "retry_later", tombstone: { state: "terminal_outcome_claimed" } });
    await releaseSenderLease(senderLease, resolution.now);
    await expect(actions.resolveAdmissionTimeoutWithoutPermit({
      ...resolution,
      nextAttemptAt: resolution.now,
    })).rejects.toThrow(/future nextAttemptAt/i);
    await expect(actions.resolveAdmissionTimeoutWithoutPermit(resolution)).resolves.toMatchObject({
      status: "resolved",
      tombstone: {
        state: "terminal_without_permit",
        terminalGateOutcomeId: terminalGateOutcome.outcomeId,
        terminalGateOutcome: terminalGateOutcome.outcome,
        terminalAt: terminalGateOutcome.occurredAt,
        nextAttemptAt: resolution.nextAttemptAt,
        resolvedAt: resolution.now,
      },
      outbox: {
        id: target.id,
        state: "pending",
        attemptCount: target.attemptCount,
        lastErrorCode: "provider_gate_terminal_without_permit",
        nextAttemptAt: resolution.nextAttemptAt,
      },
    });
    await expect(actions.resolveAdmissionTimeoutWithoutPermit(resolution)).resolves.toMatchObject({
      status: "replayed",
      tombstone: { state: "terminal_without_permit", claimToken: claimed.claimToken },
    });
    await expect(actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:31.000Z",
      claimTtlMs: 60_000,
    })).resolves.toBeNull();

    const senderLeaseStore = new AsyncRoomLeaseStore(
      createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
      { projectId: PROJECT_A },
    );
    const replacementSender = await senderLeaseStore.acquireLease({
      leaseId: "sender-lease-provider-timeout-retry",
      roomId: ROOM_A,
      kind: "sender",
      resourceId: target.bindingId,
      holderId: "worker:sender-lease-provider-timeout-retry",
      hostId: "windows-a",
      expectedEpoch: senderLease.epoch,
      now: "2026-07-20T00:00:40.000Z",
      expiresAt: "2026-07-20T00:10:00.000Z",
    });
    if (!replacementSender.ok) throw new Error(`Could not acquire replacement sender lease: ${replacementSender.reason}`);
    const replacementSenderFence = {
      leaseId: replacementSender.lease.id,
      roomId: ROOM_A,
      kind: "sender" as const,
      resourceId: target.bindingId,
      holderId: replacementSender.lease.holderId,
      hostId: replacementSender.lease.hostId,
      expectedEpoch: replacementSender.lease.epoch,
    };
    const roomStore = new AsyncRoomStore(requireLayer(), { projectId: PROJECT_A });
    await expect(roomStore.beginDeliveryAttempt({
      outboxId: target.id,
      attemptId: "provider-admission-before-terminal-retry-window",
      senderFence: replacementSenderFence,
      reconciliationFromCursor: null,
      now: "2026-07-20T00:00:59.000Z",
    })).rejects.toThrow(/not due/i);
    await expect(roomStore.beginDeliveryAttempt({
      outboxId: target.id,
      attemptId: "provider-admission-after-terminal-retry-window",
      senderFence: replacementSenderFence,
      reconciliationFromCursor: null,
      now: resolution.nextAttemptAt,
    })).resolves.toMatchObject({
      state: "dispatching",
      attemptCount: target.attemptCount + 1,
    });
  });

  it("never reopens an unproven admission timeout from clock expiry alone", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    await requireLayer().db.delete(roomProviderBackpressureReservations);
    const senderLease = await acquireSenderLease(target.bindingId);
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const gateAttemptId = "provider-admission:outbox-provider-cleanup-a:unproven-expiry";
    const requestHash = hashRoomValue({ gateAttemptId, target });
    await actions.fencePendingAdmissionTimeout({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptCount: target.attemptCount,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_gate_timeout",
      now: CREATED_AT,
      audit: { runId: "run-provider-timeout-unproven-fence", agentId: senderLease.holderId },
    });
    await releaseSenderLease(senderLease, "2026-07-20T00:00:30.000Z");

    const senderLeaseStore = new AsyncRoomLeaseStore(
      createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
      { projectId: PROJECT_A },
    );
    const replacementSender = await senderLeaseStore.acquireLease({
      leaseId: "sender-lease-provider-timeout-unproven",
      roomId: ROOM_A,
      kind: "sender",
      resourceId: target.bindingId,
      holderId: "worker:sender-lease-provider-timeout-unproven",
      hostId: "windows-a",
      expectedEpoch: senderLease.epoch,
      now: "2026-07-20T00:01:00.000Z",
      expiresAt: "2026-07-20T00:10:00.000Z",
    });
    if (!replacementSender.ok) throw new Error(`Could not acquire replacement sender lease: ${replacementSender.reason}`);

    await expect(actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:09:00.000Z",
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
    await expect(actions.resolveAdmissionTimeoutWithoutPermit({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      gateAttemptId,
      requestHash,
      cleanupWorkerLease,
      claimToken: "unproven-terminal-outcome-claim",
      now: "2026-07-20T00:09:00.000Z",
      nextAttemptAt: "2026-07-20T00:09:30.000Z",
      audit: { runId: "run-provider-timeout-unproven-resolve", agentId: cleanupWorkerLease.holderId },
    })).rejects.toThrow(/Core recovery receipt/i);

    await expect(requireLayer().db.select().from(roomProviderAdmissionTimeoutTombstones))
      .resolves.toMatchObject([{
        gateAttemptId,
        requestHash,
        state: "pending",
        terminalGateOutcomeId: null,
        nextAttemptAt: null,
        resolvedAt: null,
      }]);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id)))
      .resolves.toMatchObject([{
        deliveryState: "delivery_uncertain",
        attemptCount: target.attemptCount,
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      }]);
    const roomStore = new AsyncRoomStore(requireLayer(), { projectId: PROJECT_A });
    await expect(roomStore.beginDeliveryAttempt({
      outboxId: target.id,
      attemptId: "provider-admission-unproven-expiry-retry",
      senderFence: {
        leaseId: replacementSender.lease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: replacementSender.lease.holderId,
        hostId: replacementSender.lease.hostId,
        expectedEpoch: replacementSender.lease.epoch,
      },
      reconciliationFromCursor: null,
      now: "2026-07-20T00:09:00.000Z",
    })).rejects.toThrow(/delivery uncertain/i);
  });

  it("restarts with a new pool and lets only one of two recovery workers claim and resolve the tombstone", async () => {
    const oldActions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const oldWorkerLease = await acquireCleanupWorkerLease({
      leaseId: "cleanup-worker-restart-old",
      holderId: "worker:cleanup-worker-restart-old",
      expiresAt: "2026-07-20T00:00:10.000Z",
    });
    const recorded = await seedRecordedAdmissionTimeout(oldActions, "restart-recovery");
    const abandonedClaim = await oldActions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease: oldWorkerLease,
      now: "2026-07-20T00:00:03.000Z",
      claimTtlMs: 60_000,
    });
    expect(abandonedClaim).toMatchObject({
      state: "terminal_outcome_claimed",
      claimLeaseId: oldWorkerLease.id,
      claimLeaseEpoch: oldWorkerLease.epoch,
      claimedAt: "2026-07-20T00:00:03.000Z",
      claimExpiresAt: oldWorkerLease.expiresAt,
    });
    if (!abandonedClaim?.claimToken) throw new Error("Old cleanup worker did not receive its terminal tombstone claim");
    await releaseSenderLease(recorded.senderLease, "2026-07-20T00:00:04.000Z");

    await restartSharedConnectionPool();
    const restartedLayer = requireLayer();
    const restartedLeaseStore = new AsyncRoomLeaseStore(restartedLayer, { projectId: PROJECT_A });
    const successor = await restartedLeaseStore.acquireLease({
      leaseId: "cleanup-worker-restart-new",
      roomId: ROOM_A,
      kind: "room_worker",
      resourceId: ROOM_A,
      holderId: "worker:cleanup-worker-restart-new",
      hostId: "windows-a",
      expectedEpoch: oldWorkerLease.epoch,
      now: "2026-07-20T00:00:20.000Z",
      expiresAt: "2026-07-20T00:10:00.000Z",
    });
    if (!successor.ok) throw new Error(`Could not acquire restarted cleanup worker lease: ${successor.reason}`);

    const independentConnections = await createConnectionSetFromUrl(
      sharedContext!.connections!.backend,
      { poolMax: 1 },
    );
    try {
      const actionsA = createRoomProviderBackpressureCleanupActions({ layer: restartedLayer });
      const actionsB = createRoomProviderBackpressureCleanupActions({
        layer: createAsyncDataLayer(independentConnections, { projectId: PROJECT_A }),
      });
      const claimInput = {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        cleanupWorkerLease: successor.lease,
        now: "2026-07-20T00:00:21.000Z",
        claimTtlMs: 60_000,
      };
      const claimResults = await completesWithin(Promise.all([
        actionsA.claimNextAdmissionTimeoutTerminalOutcome(claimInput),
        actionsB.claimNextAdmissionTimeoutTerminalOutcome(claimInput),
      ]));
      const claimed = claimResults.find((row) => row !== null);
      expect(claimResults.filter((row) => row !== null)).toHaveLength(1);
      expect(claimed).toMatchObject({
        gateAttemptId: recorded.gateAttemptId,
        requestHash: recorded.requestHash,
        outboxId: recorded.target.id,
        outboxBindingId: recorded.target.bindingId,
        outboxAttemptCount: recorded.target.attemptCount,
        state: "terminal_outcome_claimed",
        claimLeaseId: successor.lease.id,
        claimLeaseEpoch: successor.lease.epoch,
      });
      if (!claimed?.claimToken) throw new Error("Restarted cleanup worker did not receive a terminal tombstone claim");
      expect(claimed.claimToken).not.toBe(abandonedClaim.claimToken);

      const resolution = {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        gateAttemptId: claimed.gateAttemptId,
        requestHash: claimed.requestHash,
        cleanupWorkerLease: successor.lease,
        claimToken: claimed.claimToken,
        now: "2026-07-20T00:00:22.000Z",
        nextAttemptAt: "2026-07-20T00:01:00.000Z",
      };
      await expect(actionsB.resolveAdmissionTimeoutWithoutPermit({
        ...resolution,
        claimToken: abandonedClaim.claimToken,
        audit: { runId: "run-provider-timeout-restart-stale-claim", agentId: successor.lease.holderId },
      })).rejects.toThrow(/claim.*stale|another recovery worker/i);
      const resolutionResults = await completesWithin(Promise.all([
        actionsA.resolveAdmissionTimeoutWithoutPermit({
          ...resolution,
          audit: { runId: "run-provider-timeout-restart-resolve-a", agentId: successor.lease.holderId },
        }),
        actionsB.resolveAdmissionTimeoutWithoutPermit({
          ...resolution,
          audit: { runId: "run-provider-timeout-restart-resolve-b", agentId: successor.lease.holderId },
        }),
      ]));
      expect(resolutionResults.map((result) => result.status).sort()).toEqual(["replayed", "resolved"]);
      await expect(restartedLayer.db.select().from(roomProviderAdmissionTimeoutTombstones))
        .resolves.toMatchObject([{
          state: "terminal_without_permit",
          gateAttemptId: recorded.gateAttemptId,
          requestHash: recorded.requestHash,
          claimToken: claimed.claimToken,
          resolvedAt: resolution.now,
          nextAttemptAt: resolution.nextAttemptAt,
        }]);
      await expect(restartedLayer.db.select().from(roomOutbox).where(eq(roomOutbox.id, recorded.target.id)))
        .resolves.toMatchObject([{
          deliveryState: "pending",
          attemptCount: recorded.target.attemptCount,
          lastErrorCode: "provider_gate_terminal_without_permit",
          nextAttemptAt: resolution.nextAttemptAt,
        }]);
    } finally {
      await independentConnections.close();
    }
  });

  it("serializes terminal-proof replay against resolution across independent PostgreSQL connections", async () => {
    const setupActions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const recorded = await seedRecordedAdmissionTimeout(setupActions, "independent-interleave");
    const cleanupWorkerLease = await acquireCleanupWorkerLease({
      leaseId: "cleanup-worker-interleave",
      holderId: "worker:cleanup-worker-interleave",
    });
    const claimed = await setupActions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: "2026-07-20T00:00:03.000Z",
      claimTtlMs: 60_000,
    });
    if (!claimed?.claimToken) throw new Error("Expected a claimed terminal tombstone for connection interleaving");
    await releaseSenderLease(recorded.senderLease, "2026-07-20T00:00:04.000Z");

    const backend = sharedContext!.connections!.backend;
    const connectionsA = await createConnectionSetFromUrl(backend, { poolMax: 1 });
    const connectionsB = await createConnectionSetFromUrl(backend, { poolMax: 1 });
    try {
      const actionsA = createRoomProviderBackpressureCleanupActions({
        layer: createAsyncDataLayer(connectionsA, { projectId: PROJECT_A }),
      });
      const actionsB = createRoomProviderBackpressureCleanupActions({
        layer: createAsyncDataLayer(connectionsB, { projectId: PROJECT_A }),
      });
      const [proofReplay, resolution] = await completesWithin(Promise.all([
        actionsA.recordAdmissionTimeoutTerminalOutcome({
          ...recorded.recordInput,
          now: "2026-07-20T00:00:05.000Z",
          audit: {
            runId: "run-provider-timeout-independent-proof-replay",
            agentId: recorded.senderLease.holderId,
          },
        }),
        actionsB.resolveAdmissionTimeoutWithoutPermit({
          projectId: PROJECT_A,
          roomId: ROOM_A,
          gateAttemptId: claimed.gateAttemptId,
          requestHash: claimed.requestHash,
          cleanupWorkerLease,
          claimToken: claimed.claimToken,
          now: "2026-07-20T00:00:05.000Z",
          nextAttemptAt: "2026-07-20T00:01:00.000Z",
          audit: {
            runId: "run-provider-timeout-independent-resolve",
            agentId: cleanupWorkerLease.holderId,
          },
        }),
      ]));
      expect(proofReplay).toMatchObject({
        status: "replayed",
        tombstone: { terminalGateOutcomeId: recorded.terminalGateOutcome.outcomeId },
      });
      expect(resolution).toMatchObject({
        status: "resolved",
        tombstone: {
          state: "terminal_without_permit",
          claimToken: claimed.claimToken,
          resolvedAt: "2026-07-20T00:00:05.000Z",
          nextAttemptAt: "2026-07-20T00:01:00.000Z",
        },
        outbox: {
          state: "pending",
          attemptCount: recorded.target.attemptCount,
          nextAttemptAt: "2026-07-20T00:01:00.000Z",
        },
      });
      await expect(requireLayer().db.select().from(roomProviderAdmissionTimeoutTombstones))
        .resolves.toMatchObject([{
          state: "terminal_without_permit",
          terminalGateOutcomeId: recorded.terminalGateOutcome.outcomeId,
          claimToken: claimed.claimToken,
        }]);
      await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, recorded.target.id)))
        .resolves.toMatchObject([{
          deliveryState: "pending",
          attemptCount: recorded.target.attemptCount,
          nextAttemptAt: "2026-07-20T00:01:00.000Z",
        }]);
    } finally {
      await Promise.all([connectionsA.close(), connectionsB.close()]);
    }
  });

  it("retries terminal pre-claim recovery with historical attempts behind a live sender", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 1,
      includeAttempt: true,
      lastErrorCode: null,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    const actionInput = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-pre-claim-fence",
      idempotencyKey: "cleanup-action-pre-claim-fence",
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptId: null,
      outboxAttemptCount: target.attemptCount,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_claim_not_started" as const,
      createdAt: CREATED_AT,
    };

    await expect(actions.fencePendingOutbox({
      action: actionInput,
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_reservation_cleanup_timed_out",
      now: CREATED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-fence", agentId: "worker:sender-lease-provider-cleanup-a" },
    })).resolves.toMatchObject({
      status: "created",
      action: {
        id: actionInput.actionId,
        completionKind: "pre_claim_not_started",
        outboxAttemptId: null,
        outboxAttemptCount: target.attemptCount,
      },
    });

    const fenced = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, target.id)))[0];
    const attempts = await requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.outboxId, target.id));
    expect(fenced).toMatchObject({
      deliveryState: "delivery_uncertain",
      attemptCount: target.attemptCount,
      nativeAcknowledgement: null,
      nativeCursor: null,
      reconciliationEvidenceRef: null,
      lastErrorCode: "provider_reservation_cleanup_timed_out",
      nextAttemptAt: null,
    });
    expect(attempts).toMatchObject([{
      id: target.attemptId,
      attempt: target.attemptCount,
      outcome: "delivery_uncertain",
    }]);

    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed?.claimToken) throw new Error("Expected the pre-claim cleanup action to be claimable");
    await expect(actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: RESERVATION_EXPIRES_AT,
    })).resolves.toMatchObject({ status: "expired" });
    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: actionInput.actionId,
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-finalize", agentId: "worker:cleanup-worker-lease-a" },
    })).rejects.toThrow(/finalizeTerminalPreClaimOutbox/i);
    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: actionInput.actionId,
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-future-guard", agentId: "worker:cleanup-worker-lease-a" },
    })).rejects.toThrow(/future nextAttemptAt/i);
    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: actionInput.actionId,
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
      audit: { runId: "run-provider-cleanup-pre-claim-retry-later", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({ status: "retry_later" });
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id))).resolves.toMatchObject([
      { deliveryState: "delivery_uncertain", attemptCount: target.attemptCount, nextAttemptAt: null },
    ]);
    await releaseSenderLease(senderLease, OUTBOX_FINALIZED_AT);
    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: actionInput.actionId,
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
      audit: { runId: "run-provider-cleanup-pre-claim-finalize", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "unblocked",
      action: {
        outboxUnblockedAt: OUTBOX_FINALIZED_AT,
        outboxFinalizationOutcome: "unblocked",
      },
    });
    const reopened = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, target.id)))[0];
    expect(reopened).toMatchObject({
      deliveryState: "pending",
      attemptCount: target.attemptCount,
      lastErrorCode: "provider_cleanup_expired_before_send",
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
    });
  });

  it("rejects generic enqueue of pre-claim evidence before it can create a pending retry window", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const unsafePreClaim = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-generic-pre-claim",
      idempotencyKey: "cleanup-action-generic-pre-claim",
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptId: null,
      outboxAttemptCount: 0,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_claim_not_started" as const,
      createdAt: CREATED_AT,
    };

    await expect(actions.enqueue(unsafePreClaim as never)).rejects.toThrow(/pre-claim/i);
    await expect(actions.get({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: unsafePreClaim.actionId,
    })).resolves.toBeNull();
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id))).resolves.toMatchObject([
      { deliveryState: "pending", attemptCount: 0, nativeAcknowledgement: null, nativeCursor: null },
    ]);
  });

  it("withholds terminal pre-claim recovery once any outbox attempt exists", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    await actions.fencePendingOutbox({
      action: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        actionId: "cleanup-action-pre-claim-attempt-present",
        idempotencyKey: "cleanup-action-pre-claim-attempt-present",
        outboxId: target.id,
        outboxBindingId: target.bindingId,
        outboxAttemptId: null,
        outboxAttemptCount: 0,
        reservationId: "reservation-a",
        requestId: "request-a",
        claimId: "claim-a",
        originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
        expectedAggregateVersion: 3,
        reservationExpiresAt: RESERVATION_EXPIRES_AT,
        completionKind: "pre_claim_not_started",
        createdAt: CREATED_AT,
      },
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_reservation_cleanup_timed_out",
      now: CREATED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-attempt-present", agentId: "worker:sender-lease-provider-cleanup-a" },
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed?.claimToken) throw new Error("Expected the pre-claim cleanup action to be claimable");
    await actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: RESERVATION_EXPIRES_AT,
    });
    await releaseSenderLease(senderLease, OUTBOX_FINALIZED_AT);
    await requireLayer().db.insert(roomOutboxAttempts).values({
      id: "outbox-attempt-created-after-pre-claim",
      projectId: PROJECT_A,
      roomId: ROOM_A,
      outboxId: target.id,
      attempt: 1,
      startedAt: OUTBOX_FINALIZED_AT,
      endedAt: OUTBOX_FINALIZED_AT,
      outcome: "delivery_uncertain",
      errorCode: "unexpected_attempt_after_pre_claim",
      evidenceRef: "unexpected-attempt-evidence",
    });

    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: claimed.id,
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
      audit: { runId: "run-provider-cleanup-pre-claim-attempt-present-finalize", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "withheld",
      action: { outboxFinalizationOutcome: "withheld" },
    });
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id))).resolves.toMatchObject([
      { deliveryState: "delivery_uncertain", attemptCount: 0, nextAttemptAt: null },
    ]);
  });

  it("returns the exact fenced outbox snapshot when a pre-claim fence replays", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const senderLease = await acquireSenderLease(target.bindingId);
    const input = {
      action: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        actionId: "cleanup-action-pre-claim-replay",
        idempotencyKey: "cleanup-action-pre-claim-replay",
        outboxId: target.id,
        outboxBindingId: target.bindingId,
        outboxAttemptId: null,
        outboxAttemptCount: 0,
        reservationId: "reservation-a",
        requestId: "request-a",
        claimId: "claim-a",
        originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
        expectedAggregateVersion: 3,
        reservationExpiresAt: RESERVATION_EXPIRES_AT,
        completionKind: "pre_claim_not_started" as const,
        createdAt: CREATED_AT,
      },
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender" as const,
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_reservation_cleanup_timed_out",
      now: CREATED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-replay", agentId: "worker:sender-lease-provider-cleanup-a" },
    };

    const created = await actions.fencePendingOutbox(input);
    await releaseSenderLease(senderLease, OUTBOX_FINALIZED_AT);
    const replayed = await actions.fencePendingOutbox(input);

    expect(created).toMatchObject({
      status: "created",
      outbox: {
        id: target.id,
        roomId: ROOM_A,
        bindingId: target.bindingId,
        state: "delivery_uncertain",
        attemptCount: 0,
        connectorAcknowledgementId: null,
        nativeMessageId: null,
        nativeCursor: null,
        reconciliationEvidenceRef: null,
        lastErrorCode: "provider_reservation_cleanup_timed_out",
      },
    });
    expect(replayed).toMatchObject({ status: "replayed", outbox: created.outbox });
  });

  it("does not let a pending pre-claim action reopen an uncertainty fence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    await actions.fencePendingOutbox({
      action: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        actionId: "cleanup-action-pre-claim-pending-finalize",
        idempotencyKey: "cleanup-action-pre-claim-pending-finalize",
        outboxId: target.id,
        outboxBindingId: target.bindingId,
        outboxAttemptId: null,
        outboxAttemptCount: 0,
        reservationId: "reservation-a",
        requestId: "request-a",
        claimId: "claim-a",
        originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
        expectedAggregateVersion: 3,
        reservationExpiresAt: RESERVATION_EXPIRES_AT,
        completionKind: "pre_claim_not_started",
        createdAt: CREATED_AT,
      },
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_reservation_cleanup_timed_out",
      now: CREATED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-pending-finalize", agentId: "worker:sender-lease-provider-cleanup-a" },
    });

    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: "cleanup-action-pre-claim-pending-finalize",
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
      audit: { runId: "run-provider-cleanup-pre-claim-pending-finalize", agentId: "worker:cleanup-worker-lease-a" },
    })).rejects.toThrow(/terminal/i);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id))).resolves.toMatchObject([
      { deliveryState: "delivery_uncertain", attemptCount: 0 },
    ]);
  });

  it("does not let a claimed pre-claim action reopen an uncertainty fence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    await actions.fencePendingOutbox({
      action: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        actionId: "cleanup-action-pre-claim-claimed-finalize",
        idempotencyKey: "cleanup-action-pre-claim-claimed-finalize",
        outboxId: target.id,
        outboxBindingId: target.bindingId,
        outboxAttemptId: null,
        outboxAttemptCount: 0,
        reservationId: "reservation-a",
        requestId: "request-a",
        claimId: "claim-a",
        originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
        expectedAggregateVersion: 3,
        reservationExpiresAt: RESERVATION_EXPIRES_AT,
        completionKind: "pre_claim_not_started",
        createdAt: CREATED_AT,
      },
      senderFence: {
        leaseId: senderLease.id,
        roomId: ROOM_A,
        kind: "sender",
        resourceId: target.bindingId,
        holderId: senderLease.holderId,
        hostId: senderLease.hostId,
        expectedEpoch: senderLease.epoch,
      },
      errorCode: "provider_reservation_cleanup_timed_out",
      now: CREATED_AT,
      audit: { runId: "run-provider-cleanup-pre-claim-claimed-finalize", agentId: "worker:sender-lease-provider-cleanup-a" },
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed?.claimToken) throw new Error("Expected the pre-claim cleanup action to be claimed");

    await expect(actions.finalizeTerminalPreClaimOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: claimed.id,
      now: OUTBOX_FINALIZED_AT,
      nextAttemptAt: "2026-07-20T00:05:30.000Z",
      audit: { runId: "run-provider-cleanup-pre-claim-claimed-finalize", agentId: "worker:cleanup-worker-lease-a" },
    })).rejects.toThrow(/terminal/i);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, target.id))).resolves.toMatchObject([
      { deliveryState: "delivery_uncertain", attemptCount: 0 },
    ]);
  });

  it("rejects a pre-claim target that carries an outbox attempt at the database boundary", async () => {
    const target = await seedExactUncertainOutbox({
      deliveryState: "pending",
      attemptCount: 0,
      includeAttempt: false,
      lastErrorCode: null,
    });

    await expect(requireLayer().db.insert(roomProviderBackpressureCleanupActions).values({
      id: "cleanup-action-invalid-pre-claim-target",
      projectId: PROJECT_A,
      roomId: ROOM_A,
      idempotencyKey: "cleanup-action-invalid-pre-claim-target",
      outboxId: target.id,
      outboxBindingId: target.bindingId,
      outboxAttemptId: "outbox-attempt-must-not-exist",
      outboxAttemptCount: 0,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalLeaseId: "room-worker-lease-a",
      originalLeaseHolderId: "worker:room-worker-lease-a",
      originalLeaseHostId: "windows-a",
      originalLeaseEpoch: 1,
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "pre_claim_not_started",
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
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })).rejects.toThrow();
  });

  it("repairs the exact pre-send crash window after cleanup is terminal but outbox completion was not persisted", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const target = await seedExactUncertainOutbox({
      deliveryState: "dispatching",
      attemptOutcome: "started",
      attemptEndedAt: null,
      lastErrorCode: null,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(target.bindingId);
    await expireExactPreSendAction("cleanup-action-dispatching-crash-window", target, cleanupWorkerLease);

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-dispatching-crash-window",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-dispatching-crash-window", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "unblocked",
      action: {
        id: "cleanup-action-dispatching-crash-window",
        state: "expired",
        outboxUnblockedAt: OUTBOX_FINALIZED_AT,
      },
    });

    const outbox = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, target.id)))[0];
    const attempt = (await requireLayer().db.select().from(roomOutboxAttempts)
      .where(eq(roomOutboxAttempts.id, target.attemptId)))[0];
    expect(outbox).toMatchObject({
      id: target.id,
      deliveryState: "pending",
      attemptCount: target.attemptCount,
      nativeAcknowledgement: null,
      nativeCursor: null,
      lastErrorCode: "provider_cleanup_expired_before_send",
      nextAttemptAt: null,
      updatedAt: OUTBOX_FINALIZED_AT,
    });
    expect(attempt).toMatchObject({
      id: target.attemptId,
      attempt: target.attemptCount,
      outcome: "delivery_uncertain",
      errorCode: "provider_cleanup_expired_before_send",
      endedAt: OUTBOX_FINALIZED_AT,
    });
  });

  it("rejects a stale pre-send attempt id without changing the live outbox", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const liveTarget = await seedExactUncertainOutbox({ attemptId: "outbox-attempt-live-a" });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(liveTarget.bindingId);
    await expireExactPreSendAction("cleanup-action-stale-attempt-id", {
      ...liveTarget,
      attemptId: "outbox-attempt-stale-a",
    }, cleanupWorkerLease);
    const before = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    if (!before) throw new Error("Expected a live outbox before stale cleanup finalization");

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-stale-attempt-id",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-stale-attempt-id", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "withheld",
      action: {
        state: "expired",
        outboxUnblockedAt: null,
        outboxFinalizedAt: OUTBOX_FINALIZED_AT,
        outboxFinalizationOutcome: "withheld",
        outboxFinalizationReason: "outbox_attempt_not_uncertain",
      },
    });

    const after = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      deliveryState: "delivery_uncertain",
      attemptCount: 1,
      nativeAcknowledgement: null,
      nativeCursor: null,
    });
    await expect(actions.get({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-stale-attempt-id",
    })).resolves.toMatchObject({
      state: "expired",
      outboxUnblockedAt: null,
      outboxFinalizedAt: OUTBOX_FINALIZED_AT,
      outboxFinalizationOutcome: "withheld",
      outboxFinalizationReason: "outbox_attempt_not_uncertain",
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });

  it("rejects a stale pre-send attempt count without changing the live outbox", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const liveTarget = await seedExactUncertainOutbox({
      attemptId: "outbox-attempt-live-count-a",
      attemptCount: 2,
    });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(liveTarget.bindingId);
    await expireExactPreSendAction("cleanup-action-stale-attempt-count", {
      ...liveTarget,
      attemptCount: 1,
    }, cleanupWorkerLease);
    const before = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    if (!before) throw new Error("Expected a live outbox before stale cleanup finalization");

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-stale-attempt-count",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-stale-attempt-count", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "withheld",
      action: {
        state: "expired",
        outboxUnblockedAt: null,
        outboxFinalizedAt: OUTBOX_FINALIZED_AT,
        outboxFinalizationOutcome: "withheld",
        outboxFinalizationReason: "outbox_generation_not_reopenable",
      },
    });

    const after = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      deliveryState: "delivery_uncertain",
      attemptCount: 2,
      nativeAcknowledgement: null,
      nativeCursor: null,
    });
    await expect(actions.get({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-stale-attempt-count",
    })).resolves.toMatchObject({
      state: "expired",
      outboxUnblockedAt: null,
      outboxFinalizedAt: OUTBOX_FINALIZED_AT,
      outboxFinalizationOutcome: "withheld",
      outboxFinalizationReason: "outbox_generation_not_reopenable",
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });

  it("rejects an acknowledged pre-send outbox without changing its delivery evidence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const acknowledgement = { nativeMessageId: "native-message-provider-cleanup-a" };
    const liveTarget = await seedExactUncertainOutbox({ nativeAcknowledgement: acknowledgement });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(liveTarget.bindingId);
    await expireExactPreSendAction("cleanup-action-acknowledged-outbox", liveTarget, cleanupWorkerLease);
    const before = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    if (!before) throw new Error("Expected an acknowledged outbox before cleanup finalization");

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-acknowledged-outbox",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-acknowledged-outbox", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "withheld",
      action: {
        state: "expired",
        outboxUnblockedAt: null,
        outboxFinalizedAt: OUTBOX_FINALIZED_AT,
        outboxFinalizationOutcome: "withheld",
        outboxFinalizationReason: "outbox_generation_not_reopenable",
      },
    });

    const after = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      deliveryState: "delivery_uncertain",
      attemptCount: 1,
      nativeAcknowledgement: acknowledgement,
      nativeCursor: null,
    });
    await expect(actions.get({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-acknowledged-outbox",
    })).resolves.toMatchObject({
      state: "expired",
      outboxUnblockedAt: null,
      outboxFinalizedAt: OUTBOX_FINALIZED_AT,
      outboxFinalizationOutcome: "withheld",
      outboxFinalizationReason: "outbox_generation_not_reopenable",
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });

  it("rejects a cursor-confirmed pre-send outbox without changing its delivery evidence", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const nativeCursor = "cursor-provider-cleanup-a";
    const liveTarget = await seedExactUncertainOutbox({ nativeCursor });
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(liveTarget.bindingId);
    await expireExactPreSendAction("cleanup-action-cursor-confirmed-outbox", liveTarget, cleanupWorkerLease);
    const before = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    if (!before) throw new Error("Expected a cursor-confirmed outbox before cleanup finalization");

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-cursor-confirmed-outbox",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-cursor-confirmed-outbox", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "withheld",
      action: {
        state: "expired",
        outboxUnblockedAt: null,
        outboxFinalizedAt: OUTBOX_FINALIZED_AT,
        outboxFinalizationOutcome: "withheld",
        outboxFinalizationReason: "outbox_generation_not_reopenable",
      },
    });

    const after = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      deliveryState: "delivery_uncertain",
      attemptCount: 1,
      nativeAcknowledgement: null,
      nativeCursor,
    });
    await expect(actions.get({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-cursor-confirmed-outbox",
    })).resolves.toMatchObject({
      state: "expired",
      outboxUnblockedAt: null,
      outboxFinalizedAt: OUTBOX_FINALIZED_AT,
      outboxFinalizationOutcome: "withheld",
      outboxFinalizationReason: "outbox_generation_not_reopenable",
    });
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });

  it("never unblocks a terminal late-admission action without an outbox target", async () => {
    const actions = createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
    const liveTarget = await seedExactUncertainOutbox();
    const cleanupWorkerLease = await acquireCleanupWorkerLease();
    const senderLease = await acquireSenderLease(liveTarget.bindingId);
    await actions.enqueue({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      actionId: "cleanup-action-late-admission-no-target",
      idempotencyKey: "cleanup-late-admission-no-target",
      outboxId: null,
      outboxBindingId: null,
      outboxAttemptId: null,
      outboxAttemptCount: null,
      reservationId: "reservation-a",
      requestId: "request-a",
      claimId: "claim-a",
      originalWorkerFence: { leaseId: "room-worker-lease-a", holderId: "worker:room-worker-lease-a", hostId: "windows-a", epoch: 1 },
      expectedAggregateVersion: 3,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      completionKind: "late_admission_not_started",
      createdAt: CREATED_AT,
    });
    const claimed = await actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: CREATED_AT,
      claimTtlMs: 60_000,
    });
    if (!claimed || !claimed.claimToken) throw new Error("Expected a claimed late-admission cleanup action");
    await expect(actions.markExpired({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      actionId: claimed.id,
      claimToken: claimed.claimToken,
      now: RESERVATION_EXPIRES_AT,
    })).resolves.toMatchObject({ status: "expired", action: { state: "expired" } });
    const before = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    if (!before) throw new Error("Expected a live outbox before late-admission finalization");

    await expect(actions.finalizeExactPreSendOutbox({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      senderLease,
      actionId: "cleanup-action-late-admission-no-target",
      now: OUTBOX_FINALIZED_AT,
      audit: { runId: "run-provider-cleanup-late-admission-no-target", agentId: "worker:cleanup-worker-lease-a" },
    })).resolves.toMatchObject({
      status: "not_applicable",
      action: {
        state: "expired",
        completionKind: "late_admission_not_started",
        outboxId: null,
        outboxBindingId: null,
        outboxAttemptId: null,
        outboxAttemptCount: null,
        outboxUnblockedAt: null,
        outboxFinalizedAt: null,
      },
    });

    const after = (await requireLayer().db.select().from(roomOutbox)
      .where(eq(roomOutbox.id, liveTarget.id)))[0];
    expect(after).toEqual(before);
    await expect(actions.claimNext({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      cleanupWorkerLease,
      now: OUTBOX_FINALIZED_AT,
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
  });
});
