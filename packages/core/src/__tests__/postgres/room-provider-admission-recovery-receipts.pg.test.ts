import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomMessages,
  roomOutbox,
  roomProviderAdmissionRecoveryReceipts,
  roomSeats,
} from "../../postgres/schema/room.js";
import { createRoomProviderBackpressureCleanupActions } from "../../room-provider-backpressure-cleanup-actions.js";
import { hashRoomValue } from "../../room-integrity.js";

const PROJECT_ID = "project-provider-admission-recovery-receipt";
const ROOM_ID = "room-provider-admission-recovery-receipt";
const SEAT_ID = "seat-provider-admission-recovery-receipt";
const BINDING_ID = "binding-provider-admission-recovery-receipt";
const MESSAGE_ID = "message-provider-admission-recovery-receipt";
const OUTBOX_ID = "outbox-provider-admission-recovery-receipt";
const GATE_ATTEMPT_ID = "provider-admission-gate-attempt-1";
const AS_OF = "2026-07-21T01:18:00.000Z";
const SENDER_EXPIRES_AT = "2026-07-21T01:23:00.000Z";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Admission recovery receipt PostgreSQL fixture was not started");
  return sharedLayer;
}

function createActions() {
  return createRoomProviderBackpressureCleanupActions({ layer: requireLayer() });
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-provider-admission-recovery-receipts-"));
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir, database: "fusion", user: "postgres", password: "password" });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 2 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

async function seedRoomAndPendingOutbox(): Promise<void> {
  const layer = requireLayer();
  await layer.db.insert(operationalRooms).values({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Keep admission recovery provenance fenced.",
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: AS_OF,
    updatedAt: AS_OF,
  });
  await layer.db.insert(roomSeats).values({
    id: SEAT_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    role: "producer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["session:send"],
    state: "active",
    activeBindingId: BINDING_ID,
    createdAt: AS_OF,
    updatedAt: AS_OF,
  });
  await layer.db.insert(roomBindings).values({
    id: BINDING_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    seatId: SEAT_ID,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "codex-thread-provider-admission-recovery-receipt",
    happierSessionId: "happier-session-provider-admission-recovery-receipt",
    serverProfileId: "server-profile-provider-admission-recovery-receipt",
    machineId: "machine-provider-admission-recovery-receipt",
    hostId: "windows-a",
    state: "attached",
    attachedAt: AS_OF,
  });
  await layer.db.insert(roomMessages).values({
    id: MESSAGE_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    turnId: null,
    nodeId: null,
    originType: "controller",
    originId: "controller-provider-admission-recovery-receipt",
    intent: "instruction",
    target: { kind: "seat", seatId: SEAT_ID },
    targetSeatIds: [SEAT_ID],
    authority: { allowedActions: ["session:send"] },
    idempotencyKey: "provider-admission-recovery-receipt-message",
    expectedAggregateVersion: 0,
    content: "Keep admission recovery provenance durable.",
    contentHash: "provider-admission-recovery-receipt-message-hash",
    evidenceRefs: [],
    createdAt: AS_OF,
  });
  await layer.db.insert(roomOutbox).values({
    id: OUTBOX_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    messageId: MESSAGE_ID,
    bindingId: BINDING_ID,
    logicalMessageId: "logical-provider-admission-recovery-receipt",
    localMessageId: "local-provider-admission-recovery-receipt",
    idempotencyKey: "provider-admission-recovery-receipt-outbox",
    payloadHash: "provider-admission-recovery-receipt-outbox-hash",
    deliveryState: "pending",
    nativeAcknowledgement: null,
    nativeCursor: null,
    reconciliationFromCursor: null,
    reconciliationEvidenceRef: null,
    dispatchTaskNodeId: null,
    dispatchClaimNodeVersion: null,
    attemptCount: 0,
    lastErrorCode: null,
    nextAttemptAt: null,
    createdAt: AS_OF,
    updatedAt: AS_OF,
  });
}

async function acquireLease(kind: "sender" | "room_worker", now = AS_OF): Promise<StoredRoomLeaseV1> {
  const store = new AsyncRoomLeaseStore(requireLayer(), { projectId: PROJECT_ID });
  const result = await store.acquireLease({
    leaseId: `lease-${kind}`,
    roomId: ROOM_ID,
    kind,
    resourceId: kind === "sender" ? BINDING_ID : ROOM_ID,
    holderId: `worker:${kind}`,
    hostId: "windows-a",
    expectedEpoch: null,
    now,
    expiresAt: kind === "sender" ? SENDER_EXPIRES_AT : "2026-07-21T01:30:00.000Z",
  });
  if (!result.ok) throw new Error(`Could not acquire ${kind} lease: ${result.reason}`);
  return result.lease;
}

async function releaseLease(lease: StoredRoomLeaseV1, now: string): Promise<void> {
  const store = new AsyncRoomLeaseStore(requireLayer(), { projectId: PROJECT_ID });
  const result = await store.releaseLease({
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: lease.kind,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  });
  if (!result.ok) throw new Error(`Could not release ${lease.kind} lease: ${result.reason}`);
}

function fenceInput(senderLease: StoredRoomLeaseV1, recoveryProtocol?: "core_sender_fenced_v1") {
  const requestHash = hashRoomValue({ projectId: PROJECT_ID, roomId: ROOM_ID, outboxId: OUTBOX_ID, gateAttemptId: GATE_ATTEMPT_ID });
  return {
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    gateAttemptId: GATE_ATTEMPT_ID,
    requestHash,
    outboxId: OUTBOX_ID,
    outboxBindingId: BINDING_ID,
    outboxAttemptCount: 0,
    senderFence: {
      leaseId: senderLease.id,
      roomId: ROOM_ID,
      kind: "sender" as const,
      resourceId: BINDING_ID,
      holderId: senderLease.holderId,
      hostId: senderLease.hostId,
      expectedEpoch: senderLease.epoch,
    },
    ...(recoveryProtocol ? { recoveryProtocol } : {}),
    errorCode: "provider_gate_timeout",
    now: AS_OF,
    audit: { runId: `run-${recoveryProtocol ?? "opaque"}`, agentId: senderLease.holderId },
  };
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  if (context.connections) await context.connections.close();
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
});

describe("Room provider admission recovery receipts", () => {
  it("issues one Core receipt in the timeout fence transaction and replays the exact identity", async () => {
    await seedRoomAndPendingOutbox();
    const senderLease = await acquireLease("sender");
    const input = fenceInput(senderLease, "core_sender_fenced_v1");

    const created = await createActions().fencePendingAdmissionTimeout(input);
    if (!created.tombstone.recoveryReceiptId) throw new Error("Expected the Core fence to issue a receipt");
    expect(created.tombstone).toMatchObject({
      recoveryProtocol: "core_sender_fenced_v1",
      recoveryReceiptId: created.tombstone.recoveryReceiptId,
    });
    const receipts = await requireLayer().db.select().from(roomProviderAdmissionRecoveryReceipts).where(eq(
      roomProviderAdmissionRecoveryReceipts.id,
      created.tombstone.recoveryReceiptId,
    ));
    expect(receipts).toEqual([expect.objectContaining({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      outboxId: OUTBOX_ID,
      outboxBindingId: BINDING_ID,
      outboxAttemptCount: 0,
      gateAttemptId: GATE_ATTEMPT_ID,
      requestHash: input.requestHash,
      senderLeaseId: senderLease.id,
      senderLeaseHolderId: senderLease.holderId,
      senderLeaseHostId: senderLease.hostId,
      senderLeaseEpoch: senderLease.epoch,
    })]);
    await expect(createActions().fencePendingAdmissionTimeout({
      ...input,
      audit: { runId: "run-core-replay", agentId: senderLease.holderId },
    })).resolves.toMatchObject({
      status: "replayed",
      tombstone: { recoveryReceiptId: created.tombstone.recoveryReceiptId },
    });
  });

  it("keeps an opaque terminal proof delivery_uncertain instead of automatically claiming it", async () => {
    await seedRoomAndPendingOutbox();
    const actions = createActions();
    const senderLease = await acquireLease("sender");
    const input = fenceInput(senderLease);
    const fenced = await actions.fencePendingAdmissionTimeout(input);
    expect(fenced.tombstone.recoveryReceiptId).toBeNull();
    await actions.recordAdmissionTimeoutTerminalOutcome({
      ...input,
      terminalGateOutcome: {
        outcomeId: "opaque-terminal-proof",
        outcome: "cancelled_without_permit",
        occurredAt: AS_OF,
      },
      audit: { runId: "run-opaque-terminal", agentId: senderLease.holderId },
    });
    const cleanupWorkerLease = await acquireLease("room_worker");
    await expect(actions.claimNextAdmissionTimeoutTerminalOutcome({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      cleanupWorkerLease,
      now: "2026-07-21T01:19:00.000Z",
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, OUTBOX_ID)))
      .resolves.toEqual([expect.objectContaining({ deliveryState: "delivery_uncertain", nextAttemptAt: null })]);
  });

  it("fails closed when a Core receipt no longer matches the immutable timeout identity", async () => {
    await seedRoomAndPendingOutbox();
    const actions = createActions();
    const senderLease = await acquireLease("sender");
    const fenced = await actions.fencePendingAdmissionTimeout(fenceInput(senderLease, "core_sender_fenced_v1"));
    if (!fenced.tombstone.recoveryReceiptId) throw new Error("Expected a Core recovery receipt");
    await requireLayer().db.update(roomProviderAdmissionRecoveryReceipts).set({
      requestHash: "sha256:" + "b".repeat(64),
    }).where(eq(roomProviderAdmissionRecoveryReceipts.id, fenced.tombstone.recoveryReceiptId));
    await releaseLease(senderLease, "2026-07-21T01:23:01.000Z");
    const cleanupWorkerLease = await acquireLease("room_worker", "2026-07-21T01:23:01.000Z");
    await expect(actions.reconcilePendingAdmissionTimeout({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      cleanupWorkerLease,
      now: "2026-07-21T01:23:02.000Z",
      audit: { runId: "run-receipt-mismatch", agentId: cleanupWorkerLease.holderId },
    })).rejects.toThrow(/receipt does not match/i);
    await expect(requireLayer().db.select().from(roomOutbox).where(eq(roomOutbox.id, OUTBOX_ID)))
      .resolves.toEqual([expect.objectContaining({ deliveryState: "delivery_uncertain", nextAttemptAt: null })]);
  });
});
