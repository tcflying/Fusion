import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncRoomLeaseStore } from "../../async-room-lease-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomBindings, roomSeats } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-lease-store-"));
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
  contexts.push(context);
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    if (context.connections) {
      await context.connections.close();
      context.connections = null;
    }
    await context.lifecycle.stop();
    rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function createRoom(store: AsyncRoomStore, roomId: string, eventId: string): Promise<void> {
  await store.createRoom(
    {
      id: roomId,
      projectId: "project-1",
      objective: `Lease ${roomId}`,
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T05:00:00.000Z",
    },
    {
      eventId,
      actorType: "human",
      actorId: "operator-1",
      correlationId: eventId,
      causationId: null,
      occurredAt: "2026-07-17T05:00:00.000Z",
    },
  );
}

describe("AsyncRoomLeaseStore PostgreSQL fencing", () => {
  it("increments epochs on expired Room-worker takeover and rejects the stale writer", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    await createRoom(new AsyncRoomStore(layer), "room-lease-1", "event-room-lease-1");
    const firstStore = new AsyncRoomLeaseStore(layer);
    const takeoverStore = new AsyncRoomLeaseStore(layer);

    const acquired = await firstStore.acquireLease({
      leaseId: "lease-room-worker-1",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-1",
      hostId: "windows-host-1",
      expectedEpoch: null,
      now: "2026-07-17T05:01:00.000Z",
      expiresAt: "2026-07-17T05:03:00.000Z",
    });
    expect(acquired).toMatchObject({ ok: true, action: "acquired" });
    if (!acquired.ok) throw new Error("initial Room-worker lease was not acquired");
    expect(acquired.lease).toMatchObject({ epoch: 1, heartbeatAt: "2026-07-17T05:01:00.000Z" });

    const staleRenewal = await firstStore.renewLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 0,
      now: "2026-07-17T05:02:00.000Z",
      expiresAt: "2026-07-17T05:04:00.000Z",
    });
    expect(staleRenewal).toMatchObject({ ok: false, reason: "stale_fence" });

    const renewed = await firstStore.renewLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 1,
      now: "2026-07-17T05:02:00.000Z",
      expiresAt: "2026-07-17T05:04:00.000Z",
    });
    expect(renewed).toMatchObject({ ok: true, lease: { epoch: 1 } });

    const earlyTakeover = await takeoverStore.acquireLease({
      leaseId: "lease-room-worker-2-early",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-2",
      hostId: "windows-host-2",
      expectedEpoch: 1,
      now: "2026-07-17T05:03:00.000Z",
      expiresAt: "2026-07-17T05:06:00.000Z",
    });
    expect(earlyTakeover).toMatchObject({ ok: false, reason: "active" });

    const takeover = await takeoverStore.acquireLease({
      leaseId: "lease-room-worker-2",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-2",
      hostId: "windows-host-2",
      expectedEpoch: 1,
      now: "2026-07-17T05:05:00.000Z",
      expiresAt: "2026-07-17T05:08:00.000Z",
    });
    expect(takeover).toMatchObject({ ok: true, action: "taken_over", lease: { epoch: 2 } });
    if (!takeover.ok) throw new Error("expired Room-worker lease was not taken over");

    await expect(
      firstStore.assertFence({
        leaseId: acquired.lease.id,
        roomId: acquired.lease.roomId,
        kind: acquired.lease.kind,
        resourceId: acquired.lease.resourceId,
        holderId: acquired.lease.holderId,
        hostId: acquired.lease.hostId,
        expectedEpoch: 1,
        now: "2026-07-17T05:05:01.000Z",
      }),
    ).rejects.toThrow(/stale.*fence/i);
    await expect(
      takeoverStore.assertFence({
        leaseId: takeover.lease.id,
        roomId: takeover.lease.roomId,
        kind: takeover.lease.kind,
        resourceId: takeover.lease.resourceId,
        holderId: takeover.lease.holderId,
        hostId: takeover.lease.hostId,
        expectedEpoch: 2,
        now: "2026-07-17T05:05:01.000Z",
      }),
    ).resolves.toMatchObject({ epoch: 2 });

    const staleRelease = await firstStore.releaseLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 1,
      now: "2026-07-17T05:05:02.000Z",
    });
    expect(staleRelease).toMatchObject({ ok: false, reason: "stale_fence" });

    const history = await takeoverStore.listLeaseHistory("room_worker", "room-lease-1");
    expect(history.map((lease) => lease.epoch)).toEqual([1, 2]);
    expect(history[0]?.releasedAt).toBe("2026-07-17T05:05:00.000Z");
    expect(history[1]?.releasedAt).toBeNull();
  });

  it("serializes concurrent sender and project-wide workspace claimants", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    await createRoom(roomStore, "room-concurrency-1", "event-room-concurrency-1");
    await createRoom(roomStore, "room-concurrency-2", "event-room-concurrency-2");
    await layer.db.insert(roomSeats).values({
      id: "seat-concurrency-1",
      projectId: "project-1",
      roomId: "room-concurrency-1",
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["session:send"],
      state: "active",
      activeBindingId: "binding-concurrency-1",
      createdAt: "2026-07-17T06:00:00.000Z",
      updatedAt: "2026-07-17T06:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-concurrency-1",
      projectId: "project-1",
      roomId: "room-concurrency-1",
      seatId: "seat-concurrency-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-concurrency-1",
      happierSessionId: "happier-concurrency-1",
      serverProfileId: "server-1",
      machineId: "machine-concurrency-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T06:00:00.000Z",
    });

    const storeA = new AsyncRoomLeaseStore(layer);
    const storeB = new AsyncRoomLeaseStore(layer);
    await expect(
      storeB.acquireLease({
        leaseId: "lease-sender-wrong-host",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-wrong-host",
        hostId: "windows-host-2",
        expectedEpoch: null,
        now: "2026-07-17T06:00:30.000Z",
        expiresAt: "2026-07-17T06:02:30.000Z",
      }),
    ).rejects.toThrow(/host windows-host-1/i);
    const senderResults = await Promise.all([
      storeA.acquireLease({
        leaseId: "lease-sender-a",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-a",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
      storeB.acquireLease({
        leaseId: "lease-sender-b",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-b",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
    ]);
    expect(senderResults.filter((result) => result.ok)).toHaveLength(1);
    expect(senderResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(await storeA.listLeaseHistory("sender", "binding-concurrency-1")).toHaveLength(1);

    const workspaceResults = await Promise.all([
      storeA.acquireLease({
        leaseId: "lease-workspace-a",
        roomId: "room-concurrency-1",
        kind: "workspace",
        resourceId: "G:\\codex-project\\shared-workspace",
        holderId: "workspace-writer-a",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
      storeB.acquireLease({
        leaseId: "lease-workspace-b",
        roomId: "room-concurrency-2",
        kind: "workspace",
        resourceId: "G:\\codex-project\\shared-workspace",
        holderId: "workspace-writer-b",
        hostId: "windows-host-2",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
    ]);
    expect(workspaceResults.filter((result) => result.ok)).toHaveLength(1);
    expect(workspaceResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      await storeA.listLeaseHistory("workspace", "G:\\codex-project\\shared-workspace"),
    ).toHaveLength(1);
  });

  it("withholds sender takeover while a prior external delivery is dispatching or uncertain", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    const leaseStore = new AsyncRoomLeaseStore(layer);
    await createRoom(roomStore, "room-sender-dispatch-guard", "event-room-sender-dispatch-guard");
    const created = await roomStore.getRoom("room-sender-dispatch-guard");
    if (!created) throw new Error("sender dispatch guard Room was not created");
    const ready = await roomStore.transitionLifecycle(
      created.room.id,
      {
        to: "ready",
        expectedAggregateVersion: created.room.aggregateVersion,
        now: "2026-07-17T07:00:01.000Z",
      },
      {
        eventId: "event-room-sender-dispatch-guard-ready",
        actorType: "controller",
        actorId: "controller-1",
        correlationId: "event-room-sender-dispatch-guard-ready",
        causationId: null,
        occurredAt: "2026-07-17T07:00:01.000Z",
      },
    );
    const running = await roomStore.transitionLifecycle(
      created.room.id,
      {
        to: "running",
        expectedAggregateVersion: ready.room.aggregateVersion,
        now: "2026-07-17T07:00:02.000Z",
      },
      {
        eventId: "event-room-sender-dispatch-guard-running",
        actorType: "controller",
        actorId: "controller-1",
        correlationId: "event-room-sender-dispatch-guard-running",
        causationId: "event-room-sender-dispatch-guard-ready",
        occurredAt: "2026-07-17T07:00:02.000Z",
      },
    );
    await layer.db.insert(roomSeats).values({
      id: "seat-sender-dispatch-guard",
      projectId: "project-1",
      roomId: created.room.id,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["session:send"],
      state: "active",
      activeBindingId: "binding-sender-dispatch-guard",
      createdAt: "2026-07-17T07:00:00.000Z",
      updatedAt: "2026-07-17T07:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-sender-dispatch-guard",
      projectId: "project-1",
      roomId: created.room.id,
      seatId: "seat-sender-dispatch-guard",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-sender-dispatch-guard",
      happierSessionId: "happier-sender-dispatch-guard",
      serverProfileId: "server-1",
      machineId: "machine-sender-dispatch-guard",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T07:00:00.000Z",
    });
    await roomStore.enqueueMessage(
      {
        roomId: created.room.id,
        expectedAggregateVersion: running.room.aggregateVersion,
        idempotencyKey: "sender-dispatch-guard:message-1",
        message: {
          id: "message-sender-dispatch-guard",
          turnId: null,
          nodeId: null,
          originType: "controller",
          originId: "controller-1",
          targetSeatIds: ["seat-sender-dispatch-guard"],
          intent: "instruction",
          content: "Prove that an unresolved external send fences sender takeover.",
          authorityEnvelope: { allowedActions: ["session:send"] },
          createdAt: "2026-07-17T07:00:03.000Z",
        },
        deliveries: [{
          id: "outbox-sender-dispatch-guard",
          bindingId: "binding-sender-dispatch-guard",
        }],
      },
      {
        eventId: "event-message-sender-dispatch-guard",
        actorType: "controller",
        actorId: "controller-1",
        correlationId: "event-message-sender-dispatch-guard",
        causationId: "event-room-sender-dispatch-guard-running",
        occurredAt: "2026-07-17T07:00:03.000Z",
      },
    );

    const first = await leaseStore.acquireLease({
      leaseId: "lease-sender-dispatch-guard-1",
      roomId: created.room.id,
      kind: "sender",
      resourceId: "binding-sender-dispatch-guard",
      holderId: "sender-worker-1",
      hostId: "windows-host-1",
      expectedEpoch: null,
      now: "2026-07-17T07:00:04.000Z",
      expiresAt: "2026-07-17T07:00:10.000Z",
    });
    expect(first).toMatchObject({ ok: true, lease: { epoch: 1 } });
    if (!first.ok) throw new Error("initial sender lease was not acquired");
    await roomStore.beginDeliveryAttempt({
      outboxId: "outbox-sender-dispatch-guard",
      attemptId: "attempt-sender-dispatch-guard-1",
      senderFence: {
        leaseId: first.lease.id,
        roomId: first.lease.roomId,
        kind: "sender",
        resourceId: first.lease.resourceId,
        holderId: first.lease.holderId,
        hostId: first.lease.hostId,
        expectedEpoch: first.lease.epoch,
      },
      reconciliationFromCursor: null,
      now: "2026-07-17T07:00:05.000Z",
    });
    const afterFirstEnqueue = await roomStore.getRoom(created.room.id);
    if (!afterFirstEnqueue) throw new Error("sender dispatch guard Room projection disappeared");
    await roomStore.enqueueMessage(
      {
        roomId: created.room.id,
        expectedAggregateVersion: afterFirstEnqueue.room.aggregateVersion,
        idempotencyKey: "sender-dispatch-guard:message-2",
        message: {
          id: "message-sender-dispatch-guard-2",
          turnId: null,
          nodeId: null,
          originType: "controller",
          originId: "controller-1",
          targetSeatIds: ["seat-sender-dispatch-guard"],
          intent: "instruction",
          content: "Do not overlap this message with the unresolved predecessor.",
          authorityEnvelope: { allowedActions: ["session:send"] },
          createdAt: "2026-07-17T07:00:06.000Z",
        },
        deliveries: [{
          id: "outbox-sender-dispatch-guard-2",
          bindingId: "binding-sender-dispatch-guard",
        }],
      },
      {
        eventId: "event-message-sender-dispatch-guard-2",
        actorType: "controller",
        actorId: "controller-1",
        correlationId: "event-message-sender-dispatch-guard-2",
        causationId: "event-message-sender-dispatch-guard",
        occurredAt: "2026-07-17T07:00:06.000Z",
      },
    );
    const secondAttempt = {
      outboxId: "outbox-sender-dispatch-guard-2",
      attemptId: "attempt-sender-dispatch-guard-2",
      senderFence: {
        leaseId: first.lease.id,
        roomId: first.lease.roomId,
        kind: "sender" as const,
        resourceId: first.lease.resourceId,
        holderId: first.lease.holderId,
        hostId: first.lease.hostId,
        expectedEpoch: first.lease.epoch,
      },
      reconciliationFromCursor: null,
    };
    await expect(roomStore.beginDeliveryAttempt({
      ...secondAttempt,
      now: "2026-07-17T07:00:07.000Z",
    })).rejects.toThrow(/unresolved/i);

    const takeoverWhileDispatching = await leaseStore.acquireLease({
      leaseId: "lease-sender-dispatch-guard-2-dispatching",
      roomId: created.room.id,
      kind: "sender",
      resourceId: "binding-sender-dispatch-guard",
      holderId: "sender-worker-2",
      hostId: "windows-host-1",
      expectedEpoch: first.lease.epoch,
      now: "2026-07-17T07:00:11.000Z",
      expiresAt: "2026-07-17T07:01:11.000Z",
      denyTakeoverWhileDeliveryUnresolved: true,
    });
    expect(takeoverWhileDispatching).toMatchObject({ ok: false, reason: "active" });

    await roomStore.completeDeliveryAttempt({
      outboxId: "outbox-sender-dispatch-guard",
      attemptId: "attempt-sender-dispatch-guard-1",
      senderFence: secondAttempt.senderFence,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T07:00:12.000Z",
      audit: { runId: "run-sender-dispatch-guard", agentId: "sender-worker-1" },
    });
    const takeoverWhileUncertain = await leaseStore.acquireLease({
      leaseId: "lease-sender-dispatch-guard-2-uncertain",
      roomId: created.room.id,
      kind: "sender",
      resourceId: "binding-sender-dispatch-guard",
      holderId: "sender-worker-2",
      hostId: "windows-host-1",
      expectedEpoch: first.lease.epoch,
      now: "2026-07-17T07:00:13.000Z",
      expiresAt: "2026-07-17T07:01:13.000Z",
      denyTakeoverWhileDeliveryUnresolved: true,
    });
    expect(takeoverWhileUncertain).toMatchObject({ ok: false, reason: "active" });

    await roomStore.reconcileDelivery({
      outboxId: "outbox-sender-dispatch-guard",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: "ack-sender-dispatch-guard",
      nativeMessageId: "native-sender-dispatch-guard",
      nativeCursor: "cursor-sender-dispatch-guard",
      errorCode: null,
      evidenceRef: `room-history:sha256:${"b".repeat(64)}`,
      now: "2026-07-17T07:00:14.000Z",
      audit: { runId: "run-sender-dispatch-guard-reconciled", agentId: "sender-worker-2" },
    });
    const takeoverAfterConfirmation = await leaseStore.acquireLease({
      leaseId: "lease-sender-dispatch-guard-2-confirmed",
      roomId: created.room.id,
      kind: "sender",
      resourceId: "binding-sender-dispatch-guard",
      holderId: "sender-worker-2",
      hostId: "windows-host-1",
      expectedEpoch: first.lease.epoch,
      now: "2026-07-17T07:00:15.000Z",
      expiresAt: "2026-07-17T07:01:15.000Z",
      denyTakeoverWhileDeliveryUnresolved: true,
    });
    expect(takeoverAfterConfirmation).toMatchObject({
      ok: true,
      action: "taken_over",
      lease: { epoch: 2 },
    });
  });
});
