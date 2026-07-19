import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncRoomStore, MAX_ROOM_EVENT_LIST_LIMIT } from "../../async-room-store.js";
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
  roomOutboxAttempts,
  roomSeats,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];
const HISTORY_EVIDENCE_ACCEPTED = `room-history:sha256:${"a".repeat(64)}`;
const HISTORY_EVIDENCE_CRASH = `room-history:sha256:${"b".repeat(64)}`;
const HISTORY_EVIDENCE_UNCERTAIN = `room-history:sha256:${"c".repeat(64)}`;
const HISTORY_EVIDENCE_CONFIRMED = `room-history:sha256:${"d".repeat(64)}`;
const HISTORY_EVIDENCE_STALE = `room-history:sha256:${"e".repeat(64)}`;

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

  it("bounds canonical Room event reads in database order after a durable cursor", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const created = await store.createRoom(
      {
        id: "room-bounded-events-1",
        projectId: "project-1",
        objective: "Replay only the requested canonical event page",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-19T18:00:00.000Z",
      },
      {
        eventId: "event-bounded-events-created",
        actorType: "human",
        actorId: "operator-bounded-events",
        correlationId: "correlation-bounded-events-created",
        causationId: null,
        occurredAt: "2026-07-19T18:00:00.000Z",
      },
    );
    await store.transitionLifecycle(
      created.room.id,
      {
        to: "ready",
        expectedAggregateVersion: 0,
        now: "2026-07-19T18:01:00.000Z",
      },
      {
        eventId: "event-bounded-events-ready",
        actorType: "controller",
        actorId: "controller-bounded-events",
        correlationId: "correlation-bounded-events-ready",
        causationId: "event-bounded-events-created",
        occurredAt: "2026-07-19T18:01:00.000Z",
      },
    );
    await store.transitionLifecycle(
      created.room.id,
      {
        to: "running",
        expectedAggregateVersion: 1,
        now: "2026-07-19T18:02:00.000Z",
      },
      {
        eventId: "event-bounded-events-running",
        actorType: "controller",
        actorId: "controller-bounded-events",
        correlationId: "correlation-bounded-events-running",
        causationId: "event-bounded-events-ready",
        occurredAt: "2026-07-19T18:02:00.000Z",
      },
    );

    const firstPage = await store.listEvents(created.room.id, undefined, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage.map((event) => event.aggregateVersion)).toEqual([0, 1]);
    expect(Number(firstPage[0]?.cursor)).toBeLessThan(Number(firstPage[1]?.cursor));

    const afterCursor = firstPage[1]?.cursor;
    if (!afterCursor) throw new Error("Bounded canonical replay did not return a cursor");
    const secondPage = await store.listEvents(created.room.id, afterCursor, { limit: 1 });
    expect(secondPage).toHaveLength(1);
    expect(secondPage.map((event) => event.aggregateVersion)).toEqual([2]);
    expect(Number(secondPage[0]?.cursor)).toBeGreaterThan(Number(afterCursor));

    await expect(store.listEvents(created.room.id, undefined, { limit: 0 }))
      .rejects.toMatchObject({ code: "room_event_list_invalid" });
    await expect(store.listEvents(created.room.id, undefined, { limit: MAX_ROOM_EVENT_LIST_LIMIT + 1 }))
      .rejects.toMatchObject({ code: "room_event_list_invalid" });
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
      machineId: "machine-delivery-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T03:00:00.000Z",
    });
    expect(await store.getBinding("binding-delivery-1")).toMatchObject({
      machineId: "machine-delivery-1",
      hostId: "windows-host-1",
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
      reconciliationFromCursor: "cursor-before-send",
      now: "2026-07-17T03:03:00.000Z",
    });
    expect(dispatching).toMatchObject({
      state: "dispatching",
      attemptCount: 1,
      reconciliationFromCursor: "cursor-before-send",
    });
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
      reconciliationFromCursor: "cursor-before-send",
    });
    await expect(
      store.beginDeliveryAttempt({
        outboxId: "outbox-1",
        attemptId: "attempt-2",
        reconciliationFromCursor: "cursor-before-send",
        now: "2026-07-17T03:05:00.000Z",
      }),
    ).rejects.toThrow(/uncertain/i);

    const reconciled = await store.reconcileDelivery({
      outboxId: "outbox-1",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: "fusion-reconciliation-ack-1",
      nativeMessageId: "native-reconciled-1",
      nativeCursor: "cursor-accepted",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_ACCEPTED,
      now: "2026-07-17T03:05:10.000Z",
      audit: { runId: "room-run-reconciled", agentId: "room-recovery-worker-1" },
    });
    expect(reconciled).toMatchObject({
      state: "confirmed",
      connectorAcknowledgementId: "fusion-reconciliation-ack-1",
      nativeMessageId: "native-reconciled-1",
      nativeCursor: "cursor-accepted",
      reconciliationFromCursor: "cursor-before-send",
      reconciliationEvidenceRef: HISTORY_EVIDENCE_ACCEPTED,
    });
    expect(await store.getDelivery("outbox-1")).toEqual(reconciled);
    await expect(
      store.beginDeliveryAttempt({
        outboxId: "outbox-1",
        attemptId: "attempt-after-reconciliation",
        reconciliationFromCursor: "cursor-accepted",
        now: "2026-07-17T03:05:20.000Z",
      }),
    ).rejects.toThrow(/confirmed/i);

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
      reconciliationFromCursor: "cursor-before-confirmed",
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

    const crashQueued = await store.enqueueMessage({
      ...input,
      expectedAggregateVersion: 2,
      idempotencyKey: "operator-device-1:message-accepted-before-crash",
      message: {
        ...input.message,
        id: "message-accepted-before-crash",
        content: "Persist the pre-send cursor, then reconcile the accepted provider record.",
        createdAt: "2026-07-17T03:05:55.000Z",
      },
      deliveries: [{ id: "outbox-accepted-before-crash", bindingId: "binding-delivery-1" }],
    }, {
      eventId: "event-message-accepted-before-crash",
      actorType: "controller",
      actorId: "room-controller-1",
      correlationId: "correlation-accepted-before-crash",
      causationId: "event-message-confirmed",
      occurredAt: "2026-07-17T03:05:55.000Z",
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-accepted-before-crash",
      attemptId: "attempt-accepted-before-crash",
      reconciliationFromCursor: "cursor-immediately-before-send",
      now: "2026-07-17T03:05:56.000Z",
    });
    const recoveredAfterCrash = await store.reconcileDelivery({
      outboxId: "outbox-accepted-before-crash",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: null,
      nativeMessageId: "native-accepted-before-crash",
      nativeCursor: "cursor-after-accepted-message",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_CRASH,
      now: "2026-07-17T03:05:57.000Z",
      audit: { runId: "room-run-accepted-before-crash", agentId: "room-recovery-worker-1" },
    });
    expect(recoveredAfterCrash).toMatchObject({
      logicalMessageId: crashQueued.message.id,
      localMessageId: crashQueued.deliveries[0]?.localMessageId,
      state: "confirmed",
      attemptCount: 1,
      nativeMessageId: "native-accepted-before-crash",
      nativeCursor: "cursor-after-accepted-message",
      reconciliationFromCursor: "cursor-immediately-before-send",
      reconciliationEvidenceRef: HISTORY_EVIDENCE_CRASH,
    });
    expect(await store.reconcileDelivery({
      outboxId: "outbox-accepted-before-crash",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: null,
      nativeMessageId: "native-accepted-before-crash",
      nativeCursor: "cursor-after-accepted-message",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_CRASH,
      now: "2026-07-17T03:05:58.000Z",
      audit: { runId: "room-run-accepted-before-crash-replay", agentId: "room-recovery-worker-1" },
    })).toEqual(recoveredAfterCrash);
    const crashAttempt = (await layer.db.select().from(roomOutboxAttempts))
      .find((row) => row.id === "attempt-accepted-before-crash");
    expect(crashAttempt).toMatchObject({
      endedAt: "2026-07-17T03:05:57.000Z",
      outcome: "confirmed",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_CRASH,
    });
    const reconciliationAudit = (await layer.db.select().from(runAuditEvents))
      .find((row) => row.runId === "room-run-accepted-before-crash");
    expect(reconciliationAudit).toMatchObject({
      mutationType: "room:connector-delivery-reconciliation",
      target: "outbox-accepted-before-crash",
      metadata: expect.objectContaining({
        fromState: "dispatching",
        outcome: "confirmed",
        reconciliationFromCursor: "cursor-immediately-before-send",
        evidenceRef: HISTORY_EVIDENCE_CRASH,
      }),
    });

    await store.enqueueMessage({
      ...input,
      expectedAggregateVersion: 3,
      idempotencyKey: "operator-device-1:message-concurrent-reconciliation",
      message: {
        ...input.message,
        id: "message-concurrent-reconciliation",
        content: "Serialize competing uncertain and confirmed reconciliation outcomes.",
        createdAt: "2026-07-17T03:05:59.000Z",
      },
      deliveries: [{ id: "outbox-concurrent-reconciliation", bindingId: "binding-delivery-1" }],
    }, {
      eventId: "event-message-concurrent-reconciliation",
      actorType: "controller",
      actorId: "room-controller-1",
      correlationId: "correlation-concurrent-reconciliation",
      causationId: "event-message-accepted-before-crash",
      occurredAt: "2026-07-17T03:05:59.000Z",
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-concurrent-reconciliation",
      attemptId: "attempt-concurrent-reconciliation",
      reconciliationFromCursor: "cursor-before-concurrent-send",
      now: "2026-07-17T03:06:00.000Z",
    });
    const competingReconciliations = await Promise.allSettled([
      store.reconcileDelivery({
        outboxId: "outbox-concurrent-reconciliation",
        expectedAttemptCount: 1,
        outcome: "delivery_uncertain",
        connectorAcknowledgementId: null,
        nativeMessageId: null,
        nativeCursor: null,
        errorCode: "history_match_not_found",
        evidenceRef: HISTORY_EVIDENCE_UNCERTAIN,
        now: "2026-07-17T03:06:01.000Z",
        audit: { runId: "room-run-concurrent-uncertain", agentId: "room-recovery-worker-1" },
      }),
      store.reconcileDelivery({
        outboxId: "outbox-concurrent-reconciliation",
        expectedAttemptCount: 1,
        outcome: "confirmed",
        connectorAcknowledgementId: null,
        nativeMessageId: "native-concurrent-confirmed",
        nativeCursor: "cursor-concurrent-confirmed",
        errorCode: null,
        evidenceRef: HISTORY_EVIDENCE_CONFIRMED,
        now: "2026-07-17T03:06:02.000Z",
        audit: { runId: "room-run-concurrent-confirmed", agentId: "room-recovery-worker-2" },
      }),
    ]);
    expect(competingReconciliations[1]?.status).toBe("fulfilled");
    expect(await store.getDelivery("outbox-concurrent-reconciliation")).toMatchObject({
      state: "confirmed",
      nativeMessageId: "native-concurrent-confirmed",
      nativeCursor: "cursor-concurrent-confirmed",
      reconciliationEvidenceRef: HISTORY_EVIDENCE_CONFIRMED,
    });

    await store.enqueueMessage({
      ...input,
      expectedAggregateVersion: 4,
      idempotencyKey: "operator-device-1:message-stale-reconciliation",
      message: {
        ...input.message,
        id: "message-stale-reconciliation",
        content: "Reject reconciliation evidence captured for an older delivery attempt.",
        createdAt: "2026-07-17T03:06:03.000Z",
      },
      deliveries: [{ id: "outbox-stale-reconciliation", bindingId: "binding-delivery-1" }],
    }, {
      eventId: "event-message-stale-reconciliation",
      actorType: "controller",
      actorId: "room-controller-1",
      correlationId: "correlation-stale-reconciliation",
      causationId: "event-message-concurrent-reconciliation",
      occurredAt: "2026-07-17T03:06:03.000Z",
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-stale-reconciliation",
      attemptId: "attempt-stale-1",
      reconciliationFromCursor: "cursor-before-stale-attempt-1",
      now: "2026-07-17T03:06:04.000Z",
    });
    await store.completeDeliveryAttempt({
      outboxId: "outbox-stale-reconciliation",
      attemptId: "attempt-stale-1",
      outcome: "retryable_failure",
      connectorAcknowledgementId: "ack-stale-attempt-1",
      nativeMessageId: "native-stale-attempt-1",
      nativeCursor: "cursor-stale-attempt-1",
      errorCode: "pre_send_transport",
      nextAttemptAt: "2026-07-17T03:06:05.000Z",
      now: "2026-07-17T03:06:04.500Z",
      audit: { runId: "room-run-stale-attempt-1", agentId: "room-worker-1" },
    });
    await expect(store.beginDeliveryAttempt({
      outboxId: "outbox-stale-reconciliation",
      attemptId: "attempt-stale-2",
      reconciliationFromCursor: "cursor-before-stale-attempt-2",
      now: "2026-07-17T03:06:05.000Z",
    })).rejects.toThrow(/uncertain|reconcile/i);
    expect(await store.getDelivery("outbox-stale-reconciliation")).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
      connectorAcknowledgementId: "ack-stale-attempt-1",
      nativeMessageId: "native-stale-attempt-1",
      nativeCursor: "cursor-stale-attempt-1",
      reconciliationEvidenceRef: null,
      lastErrorCode: "pre_send_transport",
      nextAttemptAt: null,
    });
    await expect(store.reconcileDelivery({
      outboxId: "outbox-stale-reconciliation",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: null,
      nativeMessageId: "native-invalid-evidence",
      nativeCursor: "cursor-invalid-evidence",
      errorCode: null,
      evidenceRef: "Bearer audit-secret-must-not-persist",
      now: "2026-07-17T03:06:06.000Z",
      audit: { runId: "room-run-invalid-evidence", agentId: "room-recovery-worker-1" },
    })).rejects.toThrow(/evidence/i);
    await expect(store.reconcileDelivery({
      outboxId: "outbox-stale-reconciliation",
      expectedAttemptCount: 1,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "Bearer audit-secret-must-not-persist",
      evidenceRef: HISTORY_EVIDENCE_STALE,
      now: "2026-07-17T03:06:06.500Z",
      audit: { runId: "room-run-invalid-error", agentId: "room-recovery-worker-1" },
    })).rejects.toThrow(/error code/i);
    await expect(store.reconcileDelivery({
      outboxId: "outbox-stale-reconciliation",
      expectedAttemptCount: 2,
      outcome: "confirmed",
      connectorAcknowledgementId: null,
      nativeMessageId: "native-stale-attempt-1",
      nativeCursor: "cursor-stale-attempt-1",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_STALE,
      now: "2026-07-17T03:06:07.000Z",
      audit: { runId: "room-run-stale-evidence", agentId: "room-recovery-worker-1" },
    })).rejects.toThrow(/attempt/i);
    expect(await store.getDelivery("outbox-stale-reconciliation")).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
      reconciliationFromCursor: "cursor-before-stale-attempt-1",
    });
    expect(await store.reconcileDelivery({
      outboxId: "outbox-stale-reconciliation",
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: null,
      nativeMessageId: "native-stale-attempt-1",
      nativeCursor: "cursor-stale-attempt-1",
      errorCode: null,
      evidenceRef: HISTORY_EVIDENCE_STALE,
      now: "2026-07-17T03:06:08.000Z",
      audit: { runId: "room-run-current-evidence", agentId: "room-recovery-worker-2" },
    })).toMatchObject({ state: "confirmed", attemptCount: 1 });

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

  /*
  FNXC:SessionRoomDeliveryRetry 2026-07-17-23:48:
  Task 4.7 RED keeps retryable delivery failures fail-closed. A future
  nextAttemptAt must gate redispatch from the durable outbox, and any accepted
  connector/native evidence on a retryable failure must stay ambiguous instead
  of dropping back to pending for a blind resend.
  */
  it("fails closed on retryable delivery failures until retry time elapses and keeps accepted evidence out of pending", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const created = await store.createRoom(
      {
        id: "room-retry-boundary-1",
        projectId: "project-1",
        objective: "Retry only when the durable retry window is open",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T04:00:00.000Z",
      },
      {
        eventId: "event-retry-boundary-room-created",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-retry-boundary-room-created",
        causationId: null,
        occurredAt: "2026-07-17T04:00:00.000Z",
      },
    );
    await layer.db.insert(roomSeats).values({
      id: "seat-retry-boundary-1",
      projectId: "project-1",
      roomId: created.room.id,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: "binding-retry-boundary-1",
      createdAt: "2026-07-17T04:00:00.000Z",
      updatedAt: "2026-07-17T04:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-retry-boundary-1",
      projectId: "project-1",
      roomId: created.room.id,
      seatId: "seat-retry-boundary-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-retry-boundary-1",
      happierSessionId: "happier-retry-boundary-1",
      serverProfileId: "server-retry-boundary-1",
      machineId: "machine-retry-boundary-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T04:00:00.000Z",
    });

    const queuedNoEvidence = await store.enqueueMessage({
      roomId: created.room.id,
      expectedAggregateVersion: 0,
      idempotencyKey: "retry-boundary:no-evidence",
      message: {
        id: "message-retry-boundary-no-evidence",
        turnId: null,
        nodeId: null,
        originType: "controller",
        originId: "room-controller-1",
        targetSeatIds: ["seat-retry-boundary-1"],
        intent: "instruction",
        content: "Do not retry before the durable retry window opens.",
        authorityEnvelope: { allowedActions: ["session:send"] },
        createdAt: "2026-07-17T04:00:01.000Z",
      },
      deliveries: [{ id: "outbox-retry-boundary-no-evidence", bindingId: "binding-retry-boundary-1" }],
    }, {
      eventId: "event-retry-boundary-no-evidence",
      actorType: "controller",
      actorId: "room-controller-1",
      correlationId: "correlation-retry-boundary-no-evidence",
      causationId: "event-retry-boundary-room-created",
      occurredAt: "2026-07-17T04:00:01.000Z",
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-retry-boundary-no-evidence",
      attemptId: "attempt-retry-boundary-no-evidence-1",
      reconciliationFromCursor: "cursor-before-retry-boundary-1",
      now: "2026-07-17T04:00:02.000Z",
    });
    const retryScheduled = await store.completeDeliveryAttempt({
      outboxId: "outbox-retry-boundary-no-evidence",
      attemptId: "attempt-retry-boundary-no-evidence-1",
      outcome: "retryable_failure",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "transport_retryable",
      nextAttemptAt: "2026-07-17T04:05:00.000Z",
      now: "2026-07-17T04:00:03.000Z",
      audit: { runId: "room-run-retry-boundary-no-evidence", agentId: "room-worker-1" },
    });
    expect(retryScheduled).toMatchObject({
      state: "pending",
      nextAttemptAt: "2026-07-17T04:05:00.000Z",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
    });
    await expect(store.beginDeliveryAttempt({
      outboxId: "outbox-retry-boundary-no-evidence",
      attemptId: "attempt-retry-boundary-no-evidence-2",
      reconciliationFromCursor: "cursor-before-retry-boundary-2",
      now: "2026-07-17T04:04:59.000Z",
    })).rejects.toThrow(/nextattemptat|retry window|not due/i);
  });

  it("keeps retryable failures with accepted evidence out of pending so recovery cannot blind-resend them", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const created = await store.createRoom(
      {
        id: "room-retry-boundary-accepted",
        projectId: "project-1",
        objective: "Accepted evidence must stay ambiguous until reconciled",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T04:10:00.000Z",
      },
      {
        eventId: "event-retry-boundary-accepted-room-created",
        actorType: "human",
        actorId: "operator-1",
        correlationId: "correlation-retry-boundary-accepted-room-created",
        causationId: null,
        occurredAt: "2026-07-17T04:10:00.000Z",
      },
    );
    await layer.db.insert(roomSeats).values({
      id: "seat-retry-boundary-accepted",
      projectId: "project-1",
      roomId: created.room.id,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: "binding-retry-boundary-accepted",
      createdAt: "2026-07-17T04:10:00.000Z",
      updatedAt: "2026-07-17T04:10:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-retry-boundary-accepted",
      projectId: "project-1",
      roomId: created.room.id,
      seatId: "seat-retry-boundary-accepted",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-retry-boundary-accepted",
      happierSessionId: "happier-retry-boundary-accepted",
      serverProfileId: "server-retry-boundary-accepted",
      machineId: "machine-retry-boundary-accepted",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T04:10:00.000Z",
    });

    const queuedAccepted = await store.enqueueMessage({
      roomId: created.room.id,
      expectedAggregateVersion: 0,
      idempotencyKey: "retry-boundary:accepted-evidence",
      message: {
        id: "message-retry-boundary-accepted",
        turnId: null,
        nodeId: null,
        originType: "controller",
        originId: "room-controller-1",
        targetSeatIds: ["seat-retry-boundary-accepted"],
        intent: "instruction",
        content: "Accepted evidence must stay ambiguous, never blind-pending.",
        authorityEnvelope: { allowedActions: ["session:send"] },
        createdAt: "2026-07-17T04:10:01.000Z",
      },
      deliveries: [{ id: "outbox-retry-boundary-accepted", bindingId: "binding-retry-boundary-accepted" }],
    }, {
      eventId: "event-retry-boundary-accepted",
      actorType: "controller",
      actorId: "room-controller-1",
      correlationId: "correlation-retry-boundary-accepted",
      causationId: "event-retry-boundary-accepted-room-created",
      occurredAt: "2026-07-17T04:10:01.000Z",
    });
    await store.beginDeliveryAttempt({
      outboxId: "outbox-retry-boundary-accepted",
      attemptId: "attempt-retry-boundary-accepted-1",
      reconciliationFromCursor: "cursor-before-retry-boundary-accepted",
      now: "2026-07-17T04:10:02.000Z",
    });
    const acceptedFailure = await store.completeDeliveryAttempt({
      outboxId: "outbox-retry-boundary-accepted",
      attemptId: "attempt-retry-boundary-accepted-1",
      outcome: "retryable_failure",
      connectorAcknowledgementId: "ack-retry-boundary-accepted-1",
      nativeMessageId: "native-retry-boundary-accepted-1",
      nativeCursor: "cursor-retry-boundary-accepted-1",
      errorCode: "transport_retryable",
      nextAttemptAt: "2026-07-17T04:16:00.000Z",
      now: "2026-07-17T04:10:03.000Z",
      audit: { runId: "room-run-retry-boundary-accepted", agentId: "room-worker-1" },
    });
    expect(acceptedFailure).toMatchObject({
      logicalMessageId: queuedAccepted.message.id,
      localMessageId: queuedAccepted.deliveries[0]?.localMessageId,
      state: "delivery_uncertain",
      connectorAcknowledgementId: "ack-retry-boundary-accepted-1",
      nativeMessageId: "native-retry-boundary-accepted-1",
      nativeCursor: "cursor-retry-boundary-accepted-1",
      nextAttemptAt: null,
    });
    await expect(store.beginDeliveryAttempt({
      outboxId: "outbox-retry-boundary-accepted",
      attemptId: "attempt-retry-boundary-accepted-2",
      reconciliationFromCursor: "cursor-after-accepted-evidence",
      now: "2026-07-17T04:16:01.000Z",
    })).rejects.toThrow(/uncertain|accepted evidence|reconcile/i);
  });
});
