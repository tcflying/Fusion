import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AsyncRoomLeaseStore,
  type StoredRoomLeaseV1,
} from "../../async-room-lease-store.js";
import {
  type BeginRoomDeliveryAttemptInput,
} from "../../async-room-store.js";
import {
  AsyncRoomStore,
  type DeferPendingRoomDeliveryInput,
} from "../../index.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { runAuditEvents } from "../../postgres/schema/project.js";
import { roomBindings, roomOutboxAttempts, roomSeats } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface RoomSenderFixture {
  readonly layer: AsyncDataLayer;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly roomId: string;
  readonly seatId: string;
  readonly bindingId: string;
  readonly outboxId: string;
}

interface SenderFenceV1 {
  readonly leaseId: string;
  readonly roomId: string;
  readonly kind: "sender";
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number;
}

type FencedBeginRoomDeliveryAttemptInput = BeginRoomDeliveryAttemptInput & {
  readonly senderFence: SenderFenceV1;
};

interface NativeIdeTakeoverProjectionV1 {
  readonly takeoverId: string;
  readonly takeoverEpoch: number;
  readonly state: "reconciling" | "ready_for_transfer" | "human_active" | "releasing" | "automatic_resumed" | "blocked_delivery_uncertain";
  readonly automaticSender: "paused" | "active";
  readonly autoSenderLeaseEpoch: number;
  readonly reconcileFromCursor: string | null;
  readonly confirmedCursor: string | null;
  readonly blockedOutboxIds?: readonly string[];
}

interface NativeIdeSenderTakeoverPort {
  transferNativeIdeSenderLease(input: {
    readonly roomId: string;
    readonly bindingId: string;
    readonly takeoverId: string;
    readonly expectedTakeoverEpoch: number;
    readonly fromSenderFence: SenderFenceV1;
    readonly humanHolderId: string;
    readonly hostId: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<{
    readonly takeover: NativeIdeTakeoverProjectionV1;
    readonly senderLease: StoredRoomLeaseV1;
  }>;
  resumeAutomaticSenderAfterNativeIde(input: {
    readonly roomId: string;
    readonly bindingId: string;
    readonly takeoverId: string;
    readonly expectedTakeoverEpoch: number;
    readonly confirmedCursor: string;
    readonly fromHumanFence: SenderFenceV1;
    readonly automaticHolderId: string;
    readonly hostId: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<{
    readonly takeover: NativeIdeTakeoverProjectionV1;
    readonly senderLease: StoredRoomLeaseV1;
  }>;
}

let sharedContext: EmbeddedTestContext | null = null;
const PROJECT_ID = "project-room-sender-takeover";
const HOST_ID = "windows-host-room-sender";

/*
FNXC:SessionRoomSenderTakeover 2026-07-17-20:30:
Provider writes require the active binding-scoped sender fence even while observers continue ingesting history. Native IDE takeover must be a durable, epoch-fenced state machine that reconciles uncertain delivery and transcript cursors before lease transfer or automated resume.
*/

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-sender-takeover-"));
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
    connections: await createConnectionSetFromUrl(backend, { poolMax: 8 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
}, 60_000);

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 60_000);

function commandContext(eventId: string, occurredAt: string) {
  return {
    eventId,
    actorType: "controller" as const,
    actorId: "room-controller-1",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

async function createRoomSenderFixture(suffix: string): Promise<RoomSenderFixture> {
  const context = sharedContext;
  if (!context?.connections) throw new Error("shared embedded PostgreSQL fixture is not running");
  const layer = createAsyncDataLayer(context.connections!, { projectId: PROJECT_ID });
  const roomStore = new AsyncRoomStore(layer);
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const roomId = `room-sender-${suffix}`;
  const seatId = `seat-sender-${suffix}`;
  const bindingId = `binding-sender-${suffix}`;
  const outboxId = `outbox-sender-${suffix}`;
  const createdAt = "2026-07-17T12:00:00.000Z";

  await roomStore.createRoom(
    {
      id: roomId,
      projectId: PROJECT_ID,
      objective: `Fence sender takeover ${suffix}`,
      protocolId: "implementation",
      protocolVersion: 1,
      now: createdAt,
    },
    commandContext(`event-room-created-${suffix}`, createdAt),
  );
  await layer.db.insert(roomSeats).values({
    id: seatId,
    projectId: PROJECT_ID,
    roomId,
    role: "producer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["session:send"],
    state: "active",
    activeBindingId: bindingId,
    createdAt,
    updatedAt: createdAt,
  });
  await layer.db.insert(roomBindings).values({
    id: bindingId,
    projectId: PROJECT_ID,
    roomId,
    seatId,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: `codex-thread-${suffix}`,
    happierSessionId: `happier-session-${suffix}`,
    serverProfileId: "server-profile-room-sender",
    machineId: "machine-room-sender",
    hostId: HOST_ID,
    state: "attached",
    attachedAt: createdAt,
  });
  await roomStore.enqueueMessage(
    {
      roomId,
      expectedAggregateVersion: 0,
      idempotencyKey: `sender-takeover:${suffix}`,
      message: {
        id: `message-sender-${suffix}`,
        turnId: null,
        nodeId: null,
        originType: "controller",
        originId: "room-controller-1",
        targetSeatIds: [seatId],
        intent: "instruction",
        content: `Continue native Session ${suffix}.`,
        authorityEnvelope: { allowedActions: ["session:send"] },
        createdAt: "2026-07-17T12:00:10.000Z",
      },
      deliveries: [{ id: outboxId, bindingId }],
    },
    commandContext(`event-message-enqueued-${suffix}`, "2026-07-17T12:00:10.000Z"),
  );

  return { layer, roomStore, leaseStore, roomId, seatId, bindingId, outboxId };
}

function senderFence(lease: StoredRoomLeaseV1): SenderFenceV1 {
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

function beginDeliveryWithSenderFence(
  store: AsyncRoomStore,
  input: FencedBeginRoomDeliveryAttemptInput,
) {
  return store.beginDeliveryAttempt(input);
}

function nativeIdeSenderTakeoverPort(store: AsyncRoomStore): NativeIdeSenderTakeoverPort {
  return store as unknown as NativeIdeSenderTakeoverPort;
}

describe("Session Room sender lease and native IDE takeover", () => {
  it("enforces one active sender lease per binding and rejects provider writes from the losing claimant", async () => {
    const fixture = await createRoomSenderFixture("single-active");
    const contenders = await Promise.all([
      fixture.leaseStore.acquireLease({
        leaseId: "lease-auto-sender-a",
        roomId: fixture.roomId,
        kind: "sender",
        resourceId: fixture.bindingId,
        holderId: "room-worker-a",
        hostId: HOST_ID,
        expectedEpoch: null,
        now: "2026-07-17T12:01:00.000Z",
        expiresAt: "2026-07-17T12:03:00.000Z",
      }),
      fixture.leaseStore.acquireLease({
        leaseId: "lease-auto-sender-b",
        roomId: fixture.roomId,
        kind: "sender",
        resourceId: fixture.bindingId,
        holderId: "room-worker-b",
        hostId: HOST_ID,
        expectedEpoch: null,
        now: "2026-07-17T12:01:00.000Z",
        expiresAt: "2026-07-17T12:03:00.000Z",
      }),
    ]);

    expect(contenders.filter((result) => result.ok)).toHaveLength(1);
    expect(contenders.filter((result) => !result.ok)).toHaveLength(1);
    expect(await fixture.leaseStore.listLeaseHistory("sender", fixture.bindingId)).toHaveLength(1);
    const winner = contenders.find((result) => result.ok);
    if (!winner?.ok) throw new Error("sender lease fixture did not produce one winner");
    const losingHolderId = winner.lease.holderId === "room-worker-a" ? "room-worker-b" : "room-worker-a";

    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-losing-sender",
      reconciliationFromCursor: null,
      now: "2026-07-17T12:01:10.000Z",
      senderFence: {
        ...senderFence(winner.lease),
        leaseId: `lease-${losingHolderId}`,
        holderId: losingHolderId,
      },
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({ state: "pending" });
  });

  /*
  FNXC:SessionRoomDelivery 2026-07-19-19:54:
  A sender that has not begun its external write must durably defer the pending
  outbox row under its exact lease and attempt fence. The retry window survives
  a new store instance, while stale authority cannot alter the unsent payload.
  */
  it("durably defers an unsent pending delivery only for the current sender and attempt", async () => {
    const fixture = await createRoomSenderFixture("pre-send-deferral");
    const initial = await fixture.roomStore.getDelivery(fixture.outboxId);
    if (!initial) throw new Error("pre-send deferral fixture did not create an outbox delivery");
    const automatic = await fixture.leaseStore.acquireLease({
      leaseId: "lease-pre-send-deferral-auto",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-pre-send-deferral-auto",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:08:00.000Z",
      expiresAt: "2026-07-17T12:20:00.000Z",
    });
    expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!automatic.ok) throw new Error("pre-send deferral sender lease was not acquired");

    await expect(fixture.roomStore.deferPendingDelivery({
      outboxId: fixture.outboxId,
      expectedAttemptCount: 1,
      senderFence: senderFence(automatic.lease),
      nextAttemptAt: "2026-07-17T12:08:10.000Z",
      reasonCode: "provider_backpressure",
      now: "2026-07-17T12:08:01.000Z",
      audit: { runId: "room-run-pre-send-deferral-stale-attempt", agentId: automatic.lease.holderId },
    })).rejects.toMatchObject({ code: "delivery_attempt_conflict" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toEqual(initial);

    await fixture.leaseStore.releaseLease({
      ...senderFence(automatic.lease),
      now: "2026-07-17T12:08:02.000Z",
    });
    const replacement = await fixture.leaseStore.acquireLease({
      leaseId: "lease-pre-send-deferral-replacement",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-pre-send-deferral-replacement",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:08:03.000Z",
      expiresAt: "2026-07-17T12:20:00.000Z",
    });
    expect(replacement).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!replacement.ok) throw new Error("pre-send deferral replacement lease was not acquired");

    await expect(fixture.roomStore.deferPendingDelivery({
      outboxId: fixture.outboxId,
      expectedAttemptCount: 0,
      senderFence: senderFence(automatic.lease),
      nextAttemptAt: "2026-07-17T12:08:10.000Z",
      reasonCode: "provider_backpressure",
      now: "2026-07-17T12:08:04.000Z",
      audit: { runId: "room-run-pre-send-deferral-stale-sender", agentId: automatic.lease.holderId },
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toEqual(initial);

    const currentSenderDeferral: DeferPendingRoomDeliveryInput = {
      outboxId: fixture.outboxId,
      expectedAttemptCount: 0,
      senderFence: senderFence(replacement.lease),
      nextAttemptAt: "2026-07-17T12:08:10.000Z",
      reasonCode: "provider_backpressure",
      now: "2026-07-17T12:08:05.000Z",
      audit: {
        runId: "room-run-pre-send-deferral",
        agentId: replacement.lease.holderId,
        taskId: "task-pre-send-deferral",
      },
    };
    const deferred = await fixture.roomStore.deferPendingDelivery(currentSenderDeferral);
    expect(deferred).toMatchObject({
      state: "pending",
      attemptCount: 0,
      idempotencyKey: initial.idempotencyKey,
      payloadHash: initial.payloadHash,
      logicalMessageId: initial.logicalMessageId,
      localMessageId: initial.localMessageId,
      lastErrorCode: "provider_backpressure",
      nextAttemptAt: "2026-07-17T12:08:10.000Z",
      updatedAt: "2026-07-17T12:08:05.000Z",
    });
    expect((await fixture.layer.db.select().from(roomOutboxAttempts))
      .filter((attempt) => attempt.outboxId === fixture.outboxId)).toEqual([]);

    const audit = (await fixture.layer.db.select().from(runAuditEvents))
      .find((event) => event.runId === "room-run-pre-send-deferral");
    expect(audit).toMatchObject({
      taskId: "task-pre-send-deferral",
      agentId: replacement.lease.holderId,
      domain: "database",
      mutationType: "room:connector-delivery-deferred",
      target: fixture.outboxId,
      metadata: expect.objectContaining({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        payloadHash: initial.payloadHash,
        attempt: 0,
        fromState: "pending",
        reasonCode: "provider_backpressure",
        nextAttemptAt: "2026-07-17T12:08:10.000Z",
      }),
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("Continue native Session pre-send-deferral.");

    const recoveredStore = new AsyncRoomStore(fixture.layer);
    await expect(beginDeliveryWithSenderFence(recoveredStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-pre-send-deferral-too-early",
      reconciliationFromCursor: null,
      now: "2026-07-17T12:08:09.000Z",
      senderFence: senderFence(replacement.lease),
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    expect(await beginDeliveryWithSenderFence(recoveredStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-pre-send-deferral-due",
      reconciliationFromCursor: null,
      now: "2026-07-17T12:08:10.000Z",
      senderFence: senderFence(replacement.lease),
    })).toMatchObject({ state: "dispatching", attemptCount: 1 });
    await expect(recoveredStore.deferPendingDelivery({
      outboxId: fixture.outboxId,
      expectedAttemptCount: 1,
      senderFence: senderFence(replacement.lease),
      nextAttemptAt: "2026-07-17T12:08:12.000Z",
      reasonCode: "provider_backpressure",
      now: "2026-07-17T12:08:11.000Z",
      audit: { runId: "room-run-pre-send-deferral-dispatching", agentId: replacement.lease.holderId },
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    expect(await recoveredStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "dispatching",
      attemptCount: 1,
      idempotencyKey: initial.idempotencyKey,
      payloadHash: initial.payloadHash,
    });
  });

  it("allows concurrent observation without a sender lease but fences provider writes", async () => {
    const fixture = await createRoomSenderFixture("observer-fence");
    const acquired = await fixture.leaseStore.acquireLease({
      leaseId: "lease-observer-fence-auto",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-sender",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:02:00.000Z",
      expiresAt: "2026-07-17T12:04:00.000Z",
    });
    expect(acquired).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!acquired.ok) throw new Error("automated sender lease was not acquired");

    const observed = await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "event",
      fromCursor: null,
      nextCursor: "cursor-observed-1",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T12:02:05.000Z",
      items: [{
        nativeMessageId: "native-observed-1",
        logicalMessageId: null,
        nativeCursor: "cursor-observed-1",
        payloadHash: "sha256:observer-only-payload",
        role: "assistant",
        occurredAt: "2026-07-17T12:02:04.000Z",
      }],
    });
    expect(observed).toMatchObject({
      insertedCount: 1,
      state: { transcriptCursor: "cursor-observed-1" },
    });
    expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
      .toMatchObject({ holderId: "room-worker-sender", epoch: 1 });

    await expect(fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-without-required-sender-fence",
      reconciliationFromCursor: "cursor-observed-1",
      now: "2026-07-17T12:02:09.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });

    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-observer-without-sender-authority",
      reconciliationFromCursor: "cursor-observed-1",
      now: "2026-07-17T12:02:10.000Z",
      senderFence: {
        ...senderFence(acquired.lease),
        leaseId: "lease-observer-only",
        holderId: "history-observer-1",
      },
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
  });

  it("pauses the automated sender, persists takeover intent and epoch, reconciles history, then requires explicit transfer", async () => {
    const fixture = await createRoomSenderFixture("native-sequence");
    const automatic = await fixture.leaseStore.acquireLease({
      leaseId: "lease-native-sequence-auto",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-native-sequence",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:03:00.000Z",
      expiresAt: "2026-07-17T12:06:00.000Z",
    });
    expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!automatic.ok) throw new Error("automated sender lease was not acquired");
    await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-before-native-takeover",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T12:03:05.000Z",
      items: [{
        nativeMessageId: "native-before-takeover",
        logicalMessageId: null,
        nativeCursor: "cursor-before-native-takeover",
        payloadHash: "sha256:before-native-takeover",
        role: "assistant",
        occurredAt: "2026-07-17T12:03:04.000Z",
      }],
    });

    await expect(fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-invalid-time",
      nativeWriterDetected: true,
      occurredAt: "not-a-timestamp",
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    const detected = await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-native-writer-detected",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T12:03:10.000Z",
    });
    expect.soft(detected).toMatchObject({
      mode: "reconciling",
      nativeWriterDetected: true,
      senderTakeover: {
        takeoverId: "native-writer:status-native-writer-detected",
        takeoverEpoch: 1,
        state: "reconciling",
        automaticSender: "paused",
        autoSenderLeaseEpoch: 1,
        reconcileFromCursor: "cursor-before-native-takeover",
        confirmedCursor: null,
      } satisfies NativeIdeTakeoverProjectionV1,
    });
    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-auto-while-native-takeover-reconciling",
      reconciliationFromCursor: "cursor-before-native-takeover",
      now: "2026-07-17T12:03:11.000Z",
      senderFence: senderFence(automatic.lease),
    })).rejects.toMatchObject({ code: "sender_takeover_conflict" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({ state: "pending" });

    const reconciled = await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: "cursor-before-native-takeover",
      nextCursor: "cursor-native-human-input",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:03:20.000Z",
      items: [{
        nativeMessageId: "native-human-input",
        logicalMessageId: null,
        nativeCursor: "cursor-native-human-input",
        payloadHash: "sha256:native-human-input",
        role: "user",
        occurredAt: "2026-07-17T12:03:15.000Z",
      }],
    });
    expect.soft(reconciled.state).toMatchObject({
      transcriptCursor: "cursor-native-human-input",
      senderTakeover: {
        takeoverId: "native-writer:status-native-writer-detected",
        takeoverEpoch: 1,
        state: "ready_for_transfer",
        automaticSender: "paused",
        autoSenderLeaseEpoch: 1,
        reconcileFromCursor: "cursor-before-native-takeover",
        confirmedCursor: "cursor-native-human-input",
      } satisfies NativeIdeTakeoverProjectionV1,
    });
    expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
      .toMatchObject({ holderId: "room-worker-native-sequence", epoch: 1 });
    const transferPort = nativeIdeSenderTakeoverPort(fixture.roomStore);
    expect.soft(typeof transferPort.transferNativeIdeSenderLease).toBe("function");
    await expect(transferPort.transferNativeIdeSenderLease({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-native-writer-detected",
      expectedTakeoverEpoch: 1,
      fromSenderFence: { ...senderFence(automatic.lease), expectedEpoch: 2 },
      humanHolderId: "native-ide-human-sequence",
      hostId: HOST_ID,
      now: "2026-07-17T12:03:21.000Z",
      expiresAt: "2026-07-17T12:08:00.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    const transferred = await transferPort.transferNativeIdeSenderLease({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-native-writer-detected",
      expectedTakeoverEpoch: 1,
      fromSenderFence: senderFence(automatic.lease),
      humanHolderId: "native-ide-human-sequence",
      hostId: HOST_ID,
      now: "2026-07-17T12:03:21.000Z",
      expiresAt: "2026-07-17T12:08:00.000Z",
    });
    expect.soft(transferred).toMatchObject({
      takeover: { state: "human_active", confirmedCursor: "cursor-native-human-input" },
      senderLease: { holderId: "native-ide-human-sequence", epoch: 2 },
    });
    const replayedTransfer = await transferPort.transferNativeIdeSenderLease({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-native-writer-detected",
      expectedTakeoverEpoch: 1,
      fromSenderFence: senderFence(automatic.lease),
      humanHolderId: "native-ide-human-sequence",
      hostId: HOST_ID,
      now: "2026-07-17T12:03:21.500Z",
      expiresAt: "2026-07-17T12:08:00.000Z",
    });
    expect(replayedTransfer.senderLease.id).toBe(transferred.senderLease.id);
    await expect(transferPort.transferNativeIdeSenderLease({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-native-writer-detected",
      expectedTakeoverEpoch: 1,
      fromSenderFence: {
        ...senderFence(automatic.lease),
        leaseId: "lease-unrelated-auto-replay",
        holderId: "unrelated-auto-holder",
      },
      humanHolderId: "native-ide-human-sequence",
      hostId: HOST_ID,
      now: "2026-07-17T12:03:21.750Z",
      expiresAt: "2026-07-17T12:08:00.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
      .toMatchObject({ holderId: "native-ide-human-sequence", epoch: 2 });
    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    expect(await restartedRoomStore.getConnectorIngestionState({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
    })).toMatchObject({
      mode: "reconciling",
      senderTakeover: {
        takeoverId: "native-writer:status-native-writer-detected",
        state: "human_active",
        confirmedCursor: "cursor-native-human-input",
      },
    });
    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-old-auto-after-explicit-transfer",
      reconciliationFromCursor: "cursor-native-human-input",
      now: "2026-07-17T12:03:22.000Z",
      senderFence: senderFence(automatic.lease),
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-current-human-after-explicit-transfer",
      reconciliationFromCursor: "cursor-native-human-input",
      now: "2026-07-17T12:03:23.000Z",
      senderFence: senderFence(transferred.senderLease),
    })).toMatchObject({ state: "dispatching", attemptCount: 1 });
  });

  it("rejects provider writes from the old worker and old sender epoch after takeover", async () => {
    const fixture = await createRoomSenderFixture("stale-epoch");
    const automatic = await fixture.leaseStore.acquireLease({
      leaseId: "lease-stale-epoch-auto",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-stale-epoch",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:04:00.000Z",
      expiresAt: "2026-07-17T12:07:00.000Z",
    });
    expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!automatic.ok) throw new Error("automated sender lease was not acquired");
    await beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-stale-auto-before-human-takeover",
      reconciliationFromCursor: null,
      now: "2026-07-17T12:04:05.000Z",
      senderFence: senderFence(automatic.lease),
    });
    expect(await fixture.leaseStore.releaseLease({
      ...senderFence(automatic.lease),
      now: "2026-07-17T12:04:10.000Z",
    })).toMatchObject({ ok: true, lease: { epoch: 1 } });

    const human = await fixture.leaseStore.acquireLease({
      leaseId: "lease-stale-epoch-human",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "native-ide-human-1",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:04:11.000Z",
      expiresAt: "2026-07-17T12:09:00.000Z",
    });
    expect(human).toMatchObject({ ok: true, lease: { epoch: 2 } });
    expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
      .toMatchObject({ holderId: "native-ide-human-1", epoch: 2 });

    await expect(fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-stale-auto-before-human-takeover",
      senderFence: senderFence(automatic.lease),
      outcome: "confirmed",
      connectorAcknowledgementId: "ack-stale-auto-after-human-takeover",
      nativeMessageId: "native-stale-auto-after-human-takeover",
      nativeCursor: "cursor-stale-auto-after-human-takeover",
      errorCode: null,
      nextAttemptAt: null,
      now: "2026-07-17T12:04:12.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({ state: "dispatching" });
  });

  it("keeps an ambiguous send visibly uncertain during takeover without resend or silent success", async () => {
    const fixture = await createRoomSenderFixture("ambiguous-send");
    const automatic = await fixture.leaseStore.acquireLease({
      leaseId: "lease-ambiguous-auto",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-ambiguous",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:05:00.000Z",
      expiresAt: "2026-07-17T12:08:00.000Z",
    });
    expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!automatic.ok) throw new Error("automated sender lease was not acquired");
    await beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-ambiguous-before-takeover",
      reconciliationFromCursor: "cursor-before-ambiguous-send",
      now: "2026-07-17T12:05:01.000Z",
      senderFence: senderFence(automatic.lease),
    });
    await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-ambiguous-before-takeover",
      senderFence: senderFence(automatic.lease),
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T12:05:02.000Z",
      audit: { runId: "run-ambiguous-before-takeover", agentId: "room-worker-ambiguous" },
    });

    const detected = await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-ambiguous-native-writer",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T12:05:03.000Z",
    });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
      reconciliationFromCursor: "cursor-before-ambiguous-send",
    });
    expect(await fixture.leaseStore.releaseLease({
      ...senderFence(automatic.lease),
      now: "2026-07-17T12:05:04.000Z",
    })).toMatchObject({ ok: true });
    const human = await fixture.leaseStore.acquireLease({
      leaseId: "lease-ambiguous-human",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "native-ide-ambiguous-human",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:05:05.000Z",
      expiresAt: "2026-07-17T12:10:00.000Z",
    });
    expect(human).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!human.ok) throw new Error("human sender lease was not acquired");

    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-forbidden-ambiguous-resend",
      reconciliationFromCursor: "cursor-before-ambiguous-send",
      now: "2026-07-17T12:05:06.000Z",
      senderFence: senderFence(human.lease),
    })).rejects.toThrow(/uncertain/i);
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
    });

    expect.soft(detected).toMatchObject({
      senderTakeover: {
        state: "blocked_delivery_uncertain",
        blockedOutboxIds: [fixture.outboxId],
      },
    });
    expect.soft(await fixture.roomStore.listEvents(fixture.roomId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "sender_takeover_blocked_delivery_uncertain",
        payload: expect.objectContaining({
          bindingId: fixture.bindingId,
          outboxIds: [fixture.outboxId],
        }),
      }),
    ]));
    await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-ambiguous-human-input",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:05:07.000Z",
      items: [{
        nativeMessageId: "native-ambiguous-human-input",
        logicalMessageId: null,
        nativeCursor: "cursor-ambiguous-human-input",
        payloadHash: "sha256:ambiguous-human-input",
        role: "user",
        occurredAt: "2026-07-17T12:05:07.000Z",
      }],
    });
    expect(await fixture.roomStore.getConnectorIngestionState({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
    })).toMatchObject({
      senderTakeover: {
        state: "blocked_delivery_uncertain",
        confirmedCursor: "cursor-ambiguous-human-input",
      },
    });
    await fixture.roomStore.reconcileDelivery({
      outboxId: fixture.outboxId,
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: "ack-ambiguous-reconciled",
      nativeMessageId: "native-ambiguous-reconciled",
      nativeCursor: "cursor-ambiguous-reconciled",
      errorCode: null,
      evidenceRef: `room-history:sha256:${"a".repeat(64)}`,
      now: "2026-07-17T12:05:08.000Z",
      audit: { runId: "run-ambiguous-reconciled", agentId: "history-reconciler" },
    });
    expect(await fixture.roomStore.getConnectorIngestionState({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
    })).toMatchObject({
      senderTakeover: {
        state: "ready_for_transfer",
        blockedOutboxIds: [],
        confirmedCursor: "cursor-ambiguous-human-input",
      },
    });
  });

  it("reconciles and restores the original automatic sender when the native writer exits before transfer", async () => {
    for (const phase of ["reconciling", "ready_for_transfer", "blocked_delivery_uncertain"] as const) {
      const suffix = `pre-transfer-exit-${phase}`;
      const fixture = await createRoomSenderFixture(suffix);
      const automatic = await fixture.leaseStore.acquireLease({
        leaseId: `lease-${suffix}-auto`,
        roomId: fixture.roomId,
        kind: "sender",
        resourceId: fixture.bindingId,
        holderId: `room-worker-${suffix}`,
        hostId: HOST_ID,
        expectedEpoch: null,
        now: "2026-07-17T12:05:20.000Z",
        expiresAt: "2026-07-17T12:15:00.000Z",
      });
      expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
      if (!automatic.ok) throw new Error(`automatic sender was not acquired for ${phase}`);

      await fixture.roomStore.recordConnectorTranscriptBatch({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        source: "history",
        fromCursor: null,
        nextCursor: `cursor-${suffix}-baseline`,
        truncated: false,
        modeAfterCommit: "streaming",
        receivedAt: "2026-07-17T12:05:21.000Z",
        items: [{
          nativeMessageId: `native-${suffix}-baseline`,
          logicalMessageId: null,
          nativeCursor: `cursor-${suffix}-baseline`,
          payloadHash: `sha256:${suffix}-baseline`,
          role: "assistant",
          occurredAt: "2026-07-17T12:05:21.000Z",
        }],
      });
      if (phase === "blocked_delivery_uncertain") {
        await beginDeliveryWithSenderFence(fixture.roomStore, {
          outboxId: fixture.outboxId,
          attemptId: `attempt-${suffix}`,
          reconciliationFromCursor: `cursor-${suffix}-baseline`,
          now: "2026-07-17T12:05:21.500Z",
          senderFence: senderFence(automatic.lease),
        });
      }
      expect(await fixture.roomStore.recordConnectorStatus({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        state: "running",
        statusCursor: `status-${suffix}-writer`,
        nativeWriterDetected: true,
        occurredAt: "2026-07-17T12:05:22.000Z",
      })).toMatchObject({
        senderTakeover: {
          state: phase === "blocked_delivery_uncertain"
            ? "blocked_delivery_uncertain"
            : "reconciling",
        },
      });
      if (phase === "ready_for_transfer") {
        expect(await fixture.roomStore.recordConnectorTranscriptBatch({
          roomId: fixture.roomId,
          bindingId: fixture.bindingId,
          source: "history",
          fromCursor: `cursor-${suffix}-baseline`,
          nextCursor: `cursor-${suffix}-ready`,
          truncated: false,
          modeAfterCommit: "reconciling",
          receivedAt: "2026-07-17T12:05:22.500Z",
          items: [{
            nativeMessageId: `native-${suffix}-ready`,
            logicalMessageId: null,
            nativeCursor: `cursor-${suffix}-ready`,
            payloadHash: `sha256:${suffix}-ready`,
            role: "user",
            occurredAt: "2026-07-17T12:05:22.500Z",
          }],
        })).toMatchObject({ state: { senderTakeover: { state: "ready_for_transfer" } } });
      }

      const exited = await fixture.roomStore.recordConnectorStatus({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        state: "idle",
        statusCursor: `status-${suffix}-writer-exited`,
        nativeWriterDetected: false,
        occurredAt: "2026-07-17T12:05:23.000Z",
      });
      expect(exited).toMatchObject({
        nativeWriterDetected: false,
        senderTakeover: {
          state: phase === "blocked_delivery_uncertain"
            ? "blocked_delivery_uncertain"
            : "reconciling",
          confirmedCursor: null,
        },
      });

      if (phase === "blocked_delivery_uncertain") {
        await fixture.roomStore.reconcileDelivery({
          outboxId: fixture.outboxId,
          expectedAttemptCount: 1,
          outcome: "confirmed",
          connectorAcknowledgementId: `ack-${suffix}`,
          nativeMessageId: `native-${suffix}-confirmed`,
          nativeCursor: `cursor-${suffix}-confirmed-delivery`,
          errorCode: null,
          evidenceRef: `room-history:sha256:${"b".repeat(64)}`,
          now: "2026-07-17T12:05:23.500Z",
          audit: { runId: `run-${suffix}`, agentId: "history-reconciler" },
        });
        expect(await fixture.roomStore.getConnectorIngestionState({
          roomId: fixture.roomId,
          bindingId: fixture.bindingId,
        })).toMatchObject({
          nativeWriterDetected: false,
          senderTakeover: { state: "reconciling", confirmedCursor: null },
        });
      }

      const beforeExitCursor = phase === "ready_for_transfer"
        ? `cursor-${suffix}-ready`
        : `cursor-${suffix}-baseline`;
      expect(await fixture.roomStore.recordConnectorTranscriptBatch({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        source: "history",
        fromCursor: beforeExitCursor,
        nextCursor: beforeExitCursor,
        truncated: false,
        modeAfterCommit: "reconciling",
        receivedAt: "2026-07-17T12:05:24.000Z",
        items: [],
      })).toMatchObject({
        state: {
          mode: "streaming",
          nativeWriterDetected: false,
          senderTakeover: {
            state: "automatic_resumed",
            automaticSender: "active",
            autoSenderLeaseEpoch: 1,
            confirmedCursor: beforeExitCursor,
          },
        },
      });
      expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
        .toMatchObject({ id: automatic.lease.id, epoch: 1, holderId: automatic.lease.holderId });
    }
  });

  it("binds pre-transfer automatic recovery to the current non-expired sender lease", async () => {
    async function prepare(suffix: string) {
      const fixture = await createRoomSenderFixture(suffix);
      const automatic = await fixture.leaseStore.acquireLease({
        leaseId: `lease-${suffix}-auto-before`,
        roomId: fixture.roomId,
        kind: "sender",
        resourceId: fixture.bindingId,
        holderId: `room-worker-${suffix}-before`,
        hostId: HOST_ID,
        expectedEpoch: null,
        now: "2026-07-17T12:05:30.000Z",
        expiresAt: "2026-07-17T12:20:00.000Z",
      });
      expect(automatic).toMatchObject({ ok: true, lease: { epoch: 1 } });
      if (!automatic.ok) throw new Error(`automatic sender was not acquired for ${suffix}`);
      await fixture.roomStore.recordConnectorTranscriptBatch({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        source: "history",
        fromCursor: null,
        nextCursor: `cursor-${suffix}-baseline`,
        truncated: false,
        modeAfterCommit: "streaming",
        receivedAt: "2026-07-17T12:05:31.000Z",
        items: [{
          nativeMessageId: `native-${suffix}-baseline`,
          logicalMessageId: null,
          nativeCursor: `cursor-${suffix}-baseline`,
          payloadHash: `sha256:${suffix}-baseline`,
          role: "assistant",
          occurredAt: "2026-07-17T12:05:31.000Z",
        }],
      });
      await fixture.roomStore.recordConnectorStatus({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        state: "running",
        statusCursor: `status-${suffix}-writer`,
        nativeWriterDetected: true,
        occurredAt: "2026-07-17T12:05:32.000Z",
      });
      await fixture.roomStore.recordConnectorStatus({
        roomId: fixture.roomId,
        bindingId: fixture.bindingId,
        state: "idle",
        statusCursor: `status-${suffix}-writer-exited`,
        nativeWriterDetected: false,
        occurredAt: "2026-07-17T12:05:33.000Z",
      });
      return { fixture, automatic, cursor: `cursor-${suffix}-baseline` };
    }

    const replaced = await prepare("pre-transfer-current-lease");
    await replaced.fixture.leaseStore.releaseLease({
      ...senderFence(replaced.automatic.lease),
      now: "2026-07-17T12:05:34.000Z",
    });
    const replacement = await replaced.fixture.leaseStore.acquireLease({
      leaseId: "lease-pre-transfer-current-lease-auto-after",
      roomId: replaced.fixture.roomId,
      kind: "sender",
      resourceId: replaced.fixture.bindingId,
      holderId: "room-worker-pre-transfer-current-lease-after",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:05:34.500Z",
      expiresAt: "2026-07-17T12:20:00.000Z",
    });
    expect(replacement).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!replacement.ok) throw new Error("replacement automatic sender was not acquired");
    expect(await replaced.fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: replaced.fixture.roomId,
      bindingId: replaced.fixture.bindingId,
      source: "history",
      fromCursor: replaced.cursor,
      nextCursor: replaced.cursor,
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:05:35.000Z",
      items: [],
    })).toMatchObject({
      state: {
        senderTakeover: {
          state: "automatic_resumed",
          autoSenderLeaseEpoch: 2,
        },
      },
    });
    await expect(beginDeliveryWithSenderFence(replaced.fixture.roomStore, {
      outboxId: replaced.fixture.outboxId,
      attemptId: "attempt-pre-transfer-stale-old-lease",
      reconciliationFromCursor: replaced.cursor,
      now: "2026-07-17T12:05:35.500Z",
      senderFence: senderFence(replaced.automatic.lease),
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await beginDeliveryWithSenderFence(replaced.fixture.roomStore, {
      outboxId: replaced.fixture.outboxId,
      attemptId: "attempt-pre-transfer-current-lease",
      reconciliationFromCursor: replaced.cursor,
      now: "2026-07-17T12:05:36.000Z",
      senderFence: senderFence(replacement.lease),
    })).toMatchObject({ state: "dispatching" });

    const reacquired = await prepare("pre-transfer-lazy-reacquire");
    await reacquired.fixture.leaseStore.releaseLease({
      ...senderFence(reacquired.automatic.lease),
      now: "2026-07-17T12:05:34.000Z",
    });
    expect(await reacquired.fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: reacquired.fixture.roomId,
      bindingId: reacquired.fixture.bindingId,
      source: "history",
      fromCursor: reacquired.cursor,
      nextCursor: reacquired.cursor,
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:05:35.000Z",
      items: [],
    })).toMatchObject({
      state: {
        senderTakeover: {
          state: "reconciling",
          automaticSender: "paused",
          confirmedCursor: reacquired.cursor,
        },
      },
    });
    const lazyReplacement = await reacquired.fixture.leaseStore.acquireLease({
      leaseId: "lease-pre-transfer-lazy-reacquire-auto-after",
      roomId: reacquired.fixture.roomId,
      kind: "sender",
      resourceId: reacquired.fixture.bindingId,
      holderId: "room-worker-pre-transfer-lazy-reacquire-after",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:05:35.500Z",
      expiresAt: "2026-07-17T12:20:00.000Z",
    });
    expect(lazyReplacement).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!lazyReplacement.ok) throw new Error("lazy replacement automatic sender was not acquired");
    expect(await beginDeliveryWithSenderFence(reacquired.fixture.roomStore, {
      outboxId: reacquired.fixture.outboxId,
      attemptId: "attempt-pre-transfer-lazy-current-lease",
      reconciliationFromCursor: reacquired.cursor,
      now: "2026-07-17T12:05:36.000Z",
      senderFence: senderFence(lazyReplacement.lease),
    })).toMatchObject({ state: "dispatching" });
    expect(await reacquired.fixture.roomStore.getConnectorIngestionState({
      roomId: reacquired.fixture.roomId,
      bindingId: reacquired.fixture.bindingId,
    })).toMatchObject({
      senderTakeover: {
        state: "automatic_resumed",
        automaticSender: "active",
        autoSenderLeaseEpoch: 2,
      },
    });

    const rotated = await prepare("pre-transfer-post-resume-rotation");
    expect(await rotated.fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: rotated.fixture.roomId,
      bindingId: rotated.fixture.bindingId,
      source: "history",
      fromCursor: rotated.cursor,
      nextCursor: rotated.cursor,
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:05:34.000Z",
      items: [],
    })).toMatchObject({
      state: { senderTakeover: { state: "automatic_resumed", autoSenderLeaseEpoch: 1 } },
    });
    await rotated.fixture.leaseStore.releaseLease({
      ...senderFence(rotated.automatic.lease),
      now: "2026-07-17T12:05:34.500Z",
    });
    const rotatedReplacement = await rotated.fixture.leaseStore.acquireLease({
      leaseId: "lease-pre-transfer-post-resume-rotation-auto-after",
      roomId: rotated.fixture.roomId,
      kind: "sender",
      resourceId: rotated.fixture.bindingId,
      holderId: "room-worker-pre-transfer-post-resume-rotation-after",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T12:05:35.000Z",
      expiresAt: "2026-07-17T12:20:00.000Z",
    });
    expect(rotatedReplacement).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!rotatedReplacement.ok) throw new Error("rotated replacement automatic sender was not acquired");
    expect(await beginDeliveryWithSenderFence(rotated.fixture.roomStore, {
      outboxId: rotated.fixture.outboxId,
      attemptId: "attempt-pre-transfer-post-resume-rotation",
      reconciliationFromCursor: rotated.cursor,
      now: "2026-07-17T12:05:35.500Z",
      senderFence: senderFence(rotatedReplacement.lease),
    })).toMatchObject({ state: "dispatching" });
    expect(await rotated.fixture.roomStore.getConnectorIngestionState({
      roomId: rotated.fixture.roomId,
      bindingId: rotated.fixture.bindingId,
    })).toMatchObject({
      senderTakeover: {
        state: "automatic_resumed",
        automaticSender: "active",
        autoSenderLeaseEpoch: 2,
      },
    });
  });

  it("resumes the automated sender after human release only from the confirmed reconciliation cursor", async () => {
    const fixture = await createRoomSenderFixture("human-release-cursor");
    const automaticBeforeTakeover = await fixture.leaseStore.acquireLease({
      leaseId: "lease-human-release-auto-before",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-before-human",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T12:06:00.000Z",
      expiresAt: "2026-07-17T12:09:00.000Z",
    });
    expect(automaticBeforeTakeover).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!automaticBeforeTakeover.ok) throw new Error("pre-takeover sender lease was not acquired");

    await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-before-human-takeover",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T12:06:01.000Z",
      items: [{
        nativeMessageId: "native-before-human-takeover",
        logicalMessageId: null,
        nativeCursor: "cursor-before-human-takeover",
        payloadHash: "sha256:before-human-takeover",
        role: "assistant",
        occurredAt: "2026-07-17T12:06:01.000Z",
      }],
    });
    const detected = await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-human-release-native-writer",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T12:06:02.000Z",
    });
    expect(detected).toMatchObject({
      senderTakeover: {
        takeoverId: "native-writer:status-human-release-native-writer",
        state: "reconciling",
        autoSenderLeaseEpoch: 1,
      },
    });
    await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: "cursor-before-human-takeover",
      nextCursor: "cursor-ready-for-human-transfer",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:06:03.000Z",
      items: [{
        nativeMessageId: "native-ready-for-human-transfer",
        logicalMessageId: null,
        nativeCursor: "cursor-ready-for-human-transfer",
        payloadHash: "sha256:ready-for-human-transfer",
        role: "user",
        occurredAt: "2026-07-17T12:06:03.000Z",
      }],
    });
    const takeoverPort = nativeIdeSenderTakeoverPort(fixture.roomStore);
    const human = await takeoverPort.transferNativeIdeSenderLease({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      fromSenderFence: senderFence(automaticBeforeTakeover.lease),
      humanHolderId: "native-ide-human-release",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:04.000Z",
      expiresAt: "2026-07-17T12:10:00.000Z",
    });
    expect(human).toMatchObject({ senderLease: { epoch: 2, holderId: "native-ide-human-release" } });

    await expect(takeoverPort.resumeAutomaticSenderAfterNativeIde({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      confirmedCursor: "cursor-ready-for-human-transfer",
      fromHumanFence: senderFence(human.senderLease),
      automaticHolderId: "room-worker-after-human",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:05.000Z",
      expiresAt: "2026-07-17T12:11:00.000Z",
    })).rejects.toMatchObject({ code: "resume_cursor_conflict" });
    expect(await fixture.leaseStore.getActiveLease("sender", fixture.bindingId))
      .toMatchObject({ epoch: 2, holderId: "native-ide-human-release" });

    expect(await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-human-release-complete",
      nativeWriterDetected: false,
      occurredAt: "2026-07-17T12:06:05.500Z",
    })).toMatchObject({
      nativeWriterDetected: false,
      senderTakeover: {
        state: "releasing",
        reconcileFromCursor: "cursor-ready-for-human-transfer",
        confirmedCursor: null,
      },
    });
    await expect(takeoverPort.resumeAutomaticSenderAfterNativeIde({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      confirmedCursor: "cursor-ready-for-human-transfer",
      fromHumanFence: senderFence(human.senderLease),
      automaticHolderId: "room-worker-after-human",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:06.000Z",
      expiresAt: "2026-07-17T12:11:00.000Z",
    })).rejects.toMatchObject({ code: "resume_cursor_conflict" });

    expect(await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: "cursor-ready-for-human-transfer",
      nextCursor: "cursor-ready-for-human-transfer",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:06:06.250Z",
      items: [],
    })).toMatchObject({
      state: {
        senderTakeover: {
          state: "releasing",
          confirmedCursor: "cursor-ready-for-human-transfer",
        },
      },
    });
    expect(await fixture.roomStore.recordConnectorTranscriptBatch({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      source: "history",
      fromCursor: "cursor-ready-for-human-transfer",
      nextCursor: "cursor-confirmed-after-human",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T12:06:06.500Z",
      items: [{
        nativeMessageId: "native-confirmed-after-human",
        logicalMessageId: null,
        nativeCursor: "cursor-confirmed-after-human",
        payloadHash: "sha256:confirmed-after-human",
        role: "assistant",
        occurredAt: "2026-07-17T12:06:06.500Z",
      }],
    })).toMatchObject({
      state: {
        senderTakeover: {
          state: "releasing",
          confirmedCursor: "cursor-confirmed-after-human",
        },
      },
    });

    const automaticAfterRelease = await takeoverPort.resumeAutomaticSenderAfterNativeIde({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      confirmedCursor: "cursor-confirmed-after-human",
      fromHumanFence: senderFence(human.senderLease),
      automaticHolderId: "room-worker-after-human",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:07.000Z",
      expiresAt: "2026-07-17T12:11:00.000Z",
    });
    expect(automaticAfterRelease).toMatchObject({
      takeover: { state: "automatic_resumed", automaticSender: "active", autoSenderLeaseEpoch: 3 },
      senderLease: { epoch: 3, holderId: "room-worker-after-human" },
    });
    const replayedResume = await takeoverPort.resumeAutomaticSenderAfterNativeIde({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      confirmedCursor: "cursor-confirmed-after-human",
      fromHumanFence: senderFence(human.senderLease),
      automaticHolderId: "room-worker-after-human",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:07.500Z",
      expiresAt: "2026-07-17T12:11:00.000Z",
    });
    expect(replayedResume.senderLease.id).toBe(automaticAfterRelease.senderLease.id);
    await expect(takeoverPort.resumeAutomaticSenderAfterNativeIde({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-human-release-native-writer",
      expectedTakeoverEpoch: 1,
      confirmedCursor: "cursor-confirmed-after-human",
      fromHumanFence: {
        ...senderFence(human.senderLease),
        leaseId: "lease-unrelated-human-replay",
        holderId: "unrelated-human-holder",
        expectedEpoch: 999,
      },
      automaticHolderId: "room-worker-after-human",
      hostId: HOST_ID,
      now: "2026-07-17T12:06:07.750Z",
      expiresAt: "2026-07-17T12:11:00.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });

    await expect(beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-resume-from-stale-cursor",
      reconciliationFromCursor: "cursor-before-human-takeover",
      now: "2026-07-17T12:06:08.000Z",
      senderFence: senderFence(automaticAfterRelease.senderLease),
    })).rejects.toMatchObject({ code: "resume_cursor_conflict" });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({ state: "pending" });
    expect(await beginDeliveryWithSenderFence(fixture.roomStore, {
      outboxId: fixture.outboxId,
      attemptId: "attempt-resume-from-confirmed-cursor",
      reconciliationFromCursor: "cursor-confirmed-after-human",
      now: "2026-07-17T12:06:09.000Z",
      senderFence: senderFence(automaticAfterRelease.senderLease),
    })).toMatchObject({ state: "dispatching", attemptCount: 1 });
    expect(await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-second-native-writer",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T12:06:10.000Z",
    })).toMatchObject({
      senderTakeover: {
        takeoverId: "native-writer:status-second-native-writer",
        takeoverEpoch: 2,
        state: "blocked_delivery_uncertain",
        autoSenderLeaseEpoch: 3,
        blockedOutboxIds: [fixture.outboxId],
      },
    });
  });
});
