import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { runAuditEvents } from "../../postgres/schema/project.js";
import {
  roomBindings,
  roomIdempotencyKeys,
  roomInboxReceipts,
  roomMessages,
  roomOutbox,
  roomSeats,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-async-room-store-"));
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
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
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
    rmSync(context.dataDir, { recursive: true, force: true });
  }
});

describe("AsyncRoomStore PostgreSQL transactions", () => {
  it("atomically updates projections/events and notifies only after commit", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const notifiedVersions: number[] = [];
    let resolveCreatedNotification: () => void = () => undefined;
    let resolveTransitionNotification: () => void = () => undefined;
    const createdNotification = new Promise<void>((resolve) => {
      resolveCreatedNotification = resolve;
    });
    const transitionNotification = new Promise<void>((resolve) => {
      resolveTransitionNotification = resolve;
    });
    let store: AsyncRoomStore;
    store = new AsyncRoomStore(layer, {
      onCommittedEvent: async (event) => {
        const committed = await store.getRoom(event.roomId);
        expect(committed?.room.aggregateVersion).toBeGreaterThanOrEqual(event.aggregateVersion);
        notifiedVersions.push(event.aggregateVersion);
        if (event.aggregateVersion === 0) resolveCreatedNotification();
        if (event.aggregateVersion === 1) resolveTransitionNotification();
      },
    });

    const created = await store.createRoom(
      {
        id: "room-store-1",
        projectId: "project-1",
        objective: "Persist one operational Room",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T02:00:00.000Z",
      },
      {
        eventId: "event-created",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-created",
        causationId: null,
        occurredAt: "2026-07-17T02:00:00.000Z",
      },
    );

    expect(created.room.aggregateVersion).toBe(0);
    await createdNotification;
    expect(notifiedVersions).toEqual([0]);

    await expect(
      store.transitionLifecycle(
        created.room.id,
        {
          to: "ready",
          expectedAggregateVersion: 0,
          now: "2026-07-17T02:01:00.000Z",
        },
        {
          eventId: "event-created",
          actorType: "human",
          actorId: "operator-1",
          correlationId: "correlation-duplicate-event",
          causationId: "event-created",
          occurredAt: "2026-07-17T02:01:00.000Z",
        },
      ),
    ).rejects.toThrow();
    expect((await store.getRoom(created.room.id))?.room).toMatchObject({
      state: "draft",
      aggregateVersion: 0,
    });
    expect(notifiedVersions).toEqual([0]);

    const contenders = await Promise.allSettled([
      store.transitionLifecycle(
        created.room.id,
        {
          to: "ready",
          expectedAggregateVersion: 0,
          now: "2026-07-17T02:02:00.000Z",
        },
        {
          eventId: "event-contender-ready",
          actorType: "controller",
          actorId: "controller-1",
          correlationId: "correlation-ready",
          causationId: "event-created",
          occurredAt: "2026-07-17T02:02:00.000Z",
        },
      ),
      store.transitionLifecycle(
        created.room.id,
        {
          to: "cancelled",
          expectedAggregateVersion: 0,
          now: "2026-07-17T02:02:00.000Z",
        },
        {
          eventId: "event-contender-cancelled",
          actorType: "controller",
          actorId: "controller-2",
          correlationId: "correlation-cancelled",
          causationId: "event-created",
          occurredAt: "2026-07-17T02:02:00.000Z",
        },
      ),
    ]);

    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
    await transitionNotification;
    const persisted = await store.getRoom(created.room.id);
    expect(persisted?.room.aggregateVersion).toBe(1);
    expect(["ready", "cancelled"]).toContain(persisted?.room.state);

    const events = await store.listEvents(created.room.id);
    expect(events.map((event) => event.aggregateVersion)).toEqual([0, 1]);
    expect(events.every((event) => Number(event.cursor) > 0)).toBe(true);
    expect(notifiedVersions).toEqual([0, 1]);
  });

  it("deduplicates concurrent commands and never blindly retries uncertain delivery", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const created = await store.createRoom(
      {
        id: "room-delivery-1",
        projectId: "project-1",
        objective: "Deliver one message exactly once",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T03:00:00.000Z",
      },
      {
        eventId: "event-delivery-room-created",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-delivery-room-created",
        causationId: null,
        occurredAt: "2026-07-17T03:00:00.000Z",
      },
    );
    await layer.db.insert(roomSeats).values({
      id: "seat-delivery-1",
      projectId: "project-1",
      roomId: created.room.id,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: "binding-delivery-1",
      createdAt: "2026-07-17T03:00:00.000Z",
      updatedAt: "2026-07-17T03:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-delivery-1",
      projectId: "project-1",
      roomId: created.room.id,
      seatId: "seat-delivery-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-delivery-1",
      happierSessionId: "happier-delivery-1",
      serverProfileId: "server-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T03:00:00.000Z",
    });

    const input = {
      roomId: created.room.id,
      expectedAggregateVersion: 0,
      idempotencyKey: "operator-device-1:message-1",
      message: {
        id: "message-1",
        turnId: null,
        nodeId: null,
        originType: "operator" as const,
        originId: "operator-1",
        targetSeatIds: ["seat-delivery-1"],
        intent: "instruction",
        content: "Continue the exact native Session.",
        authorityEnvelope: { allowedActions: ["session:send"] },
        createdAt: "2026-07-17T03:01:00.000Z",
      },
      deliveries: [{ id: "outbox-1", bindingId: "binding-delivery-1" }],
    };
    const [first, second] = await Promise.all([
      store.enqueueMessage(input, {
        eventId: "event-message-contender-1",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-message-1",
        causationId: "event-delivery-room-created",
        occurredAt: "2026-07-17T03:01:00.000Z",
      }),
      store.enqueueMessage(input, {
        eventId: "event-message-contender-2",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-message-2",
        causationId: "event-delivery-room-created",
        occurredAt: "2026-07-17T03:01:00.000Z",
      }),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.event.id).toBe(second.event.id);
    expect(first.message.contentHash).toMatch(/^sha256:/);
    expect(first.deliveries[0]?.localMessageId).toMatch(/^fusion-room-[a-f0-9]{64}$/u);
    expect((await layer.db.select().from(roomMessages))).toHaveLength(1);
    expect((await layer.db.select().from(roomOutbox))).toHaveLength(1);
    expect((await layer.db.select().from(roomIdempotencyKeys))).toHaveLength(1);
    expect((await store.getRoom(created.room.id))?.room.aggregateVersion).toBe(1);

    await expect(
      store.enqueueMessage(
        {
          ...input,
          message: { ...input.message, content: "Different content under the same key." },
        },
        {
          eventId: "event-message-conflict",
          actorType: "human",
          actorId: "operator-1",
          correlationId: "correlation-message-conflict",
          causationId: "event-delivery-room-created",
          occurredAt: "2026-07-17T03:02:00.000Z",
        },
      ),
    ).rejects.toThrow(/idempotency/i);

    const dispatching = await store.beginDeliveryAttempt({
      outboxId: "outbox-1",
      attemptId: "attempt-1",
      now: "2026-07-17T03:03:00.000Z",
    });
    expect(dispatching).toMatchObject({ state: "dispatching", attemptCount: 1 });
    const uncertain = await store.completeDeliveryAttempt({
      outboxId: "outbox-1",
      attemptId: "attempt-1",
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T03:04:00.000Z",
      audit: { runId: "room-run-uncertain", agentId: "room-worker-1" },
    });
    expect(uncertain).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
      lastErrorCode: "ack_timeout",
      nextAttemptAt: null,
    });
    await expect(
      store.beginDeliveryAttempt({
        outboxId: "outbox-1",
        attemptId: "attempt-2",
        now: "2026-07-17T03:05:00.000Z",
      }),
    ).rejects.toThrow(/uncertain/i);

    const protectedContent = "Bearer room-audit-secret must cross only the connector boundary.";
    const protectedCredentialReference = "credential://room-provider-secret";
    const confirmedQueued = await store.enqueueMessage({
      ...input,
      expectedAggregateVersion: 1,
      idempotencyKey: "operator-device-1:message-2",
      message: {
        ...input.message,
        id: "message-2",
        content: protectedContent,
        authorityEnvelope: {
          allowedActions: ["session:send"],
          credentialReference: protectedCredentialReference,
        },
        createdAt: "2026-07-17T03:05:30.000Z",
      },
      deliveries: [{ id: "outbox-2", bindingId: "binding-delivery-1" }],
    }, {
      eventId: "event-message-confirmed",
      actorType: "human",
      actorId: "operator-1",
      correlationId: "correlation-message-confirmed",
      causationId: "event-message-contender-1",
      occurredAt: "2026-07-17T03:05:30.000Z",
    });
    expect(confirmedQueued.deliveries[0]).toMatchObject({
      logicalMessageId: "message-2",
      localMessageId: expect.stringMatching(/^fusion-room-[a-f0-9]{64}$/u),
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-2",
      attemptId: "attempt-confirmed-1",
      now: "2026-07-17T03:05:40.000Z",
    });
    const confirmed = await store.completeDeliveryAttempt({
      outboxId: "outbox-2",
      attemptId: "attempt-confirmed-1",
      outcome: "confirmed",
      connectorAcknowledgementId: "happier-local-ack-2",
      nativeMessageId: "native-message-confirmed-2",
      nativeCursor: "native-cursor-confirmed-2",
      errorCode: null,
      nextAttemptAt: null,
      now: "2026-07-17T03:05:50.000Z",
      audit: { runId: "room-run-confirmed", agentId: "room-worker-1", taskId: "task-room-dispatch" },
    });
    expect(confirmed).toMatchObject({
      logicalMessageId: "message-2",
      localMessageId: confirmedQueued.deliveries[0]?.localMessageId,
      state: "confirmed",
      connectorAcknowledgementId: "happier-local-ack-2",
      nativeMessageId: "native-message-confirmed-2",
      nativeCursor: "native-cursor-confirmed-2",
    });
    const auditRows = await layer.db.select().from(runAuditEvents);
    const confirmedAudit = auditRows.find((row) => row.runId === "room-run-confirmed");
    expect(confirmedAudit).toMatchObject({
      taskId: "task-room-dispatch",
      agentId: "room-worker-1",
      domain: "database",
      mutationType: "room:connector-delivery",
      target: "outbox-2",
      metadata: expect.objectContaining({
        roomId: created.room.id,
        bindingId: "binding-delivery-1",
        logicalMessageId: "message-2",
        localMessageId: confirmedQueued.deliveries[0]?.localMessageId,
        connectorAcknowledgementId: "happier-local-ack-2",
        nativeMessageId: "native-message-confirmed-2",
        nativeCursor: "native-cursor-confirmed-2",
      }),
    });
    expect(JSON.stringify(confirmedAudit)).not.toContain(protectedContent);
    expect(JSON.stringify(confirmedAudit)).not.toContain(protectedCredentialReference);

    const inboxInput = {
      id: "inbox-1",
      roomId: created.room.id,
      bindingId: "binding-delivery-1",
      nativeMessageId: "native-message-1",
      nativeCursor: "native-cursor-1",
      payloadHash: "sha256:native-payload",
      receivedAt: "2026-07-17T03:06:00.000Z",
    };
    const firstReceipt = await store.recordInboxReceipt(inboxInput);
    const replayedReceipt = await store.recordInboxReceipt({ ...inboxInput, id: "inbox-replayed" });
    expect(replayedReceipt.id).toBe(firstReceipt.id);
    expect((await layer.db.select().from(roomInboxReceipts))).toHaveLength(1);
    await expect(
      store.recordInboxReceipt({
        ...inboxInput,
        id: "inbox-conflict",
        payloadHash: "sha256:different-native-payload",
      }),
    ).rejects.toThrow(/payload hash/i);
  });
});
