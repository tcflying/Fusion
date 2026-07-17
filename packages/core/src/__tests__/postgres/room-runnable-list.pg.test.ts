import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AsyncRoomStore, type RoomCommandContext } from "../../async-room-store.js";
import { AsyncRoomLeaseStore, RoomLeaseFenceError } from "../../async-room-lease-store.js";
import type { RoomAggregateV1 } from "../../room-domain.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import {
  createAsyncDataLayer,
  type AsyncDataLayer,
  type DbTransaction,
  recordGlobalRunAuditEventWithinTransaction,
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  RunAuditEventConflictError,
  RunAuditEventProjectScopeError,
  type TransactionOptions,
} from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { approvalRequests, tasks } from "../../postgres/schema/project.js";
import {
  queryRunAuditEvents,
  queryRunAuditEventsAdmin,
  RunAuditEventQueryScopeError,
} from "../../task-store/async-audit.js";
import { enqueueMergeQueue } from "../../task-store/async-merge-coordination.js";
import { upsertWorkflowWorkItem } from "../../task-store/async-workflow-workitems.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-runnable-list-"));
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

function command(eventId: string, occurredAt: string): RoomCommandContext {
  return {
    eventId,
    actorType: "controller",
    actorId: "room-controller-test",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

async function createRunningRoom(
  store: AsyncRoomStore,
  projectId: string,
  roomId: string,
  createdAt: string,
  readyAt: string,
  runningAt: string,
): Promise<RoomAggregateV1> {
  const created = await store.createRoom({
    id: roomId,
    projectId,
    objective: `Run ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    now: createdAt,
  }, command(`${roomId}-created`, createdAt));
  const ready = await store.transitionLifecycle(roomId, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: readyAt,
  }, command(`${roomId}-ready`, readyAt));
  return store.transitionLifecycle(roomId, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: runningAt,
  }, command(`${roomId}-running`, runningAt));
}

describe("AsyncRoomStore runnable Room discovery", () => {
  it("inherits the bound project identity for transaction-scoped run-audit writes", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });

    const inserted = await layer.transactionImmediate(async (tx) =>
      recordRunAuditEventWithinTransaction(tx, {
        id: "task-audit-inherits-project",
        timestamp: "2026-07-17T11:59:00.000Z",
        taskId: "task-1",
        agentId: "agent-1",
        runId: "run-task-1",
        domain: "database",
        mutationType: "task:update",
        target: "task-1",
        metadata: { source: "task-store" },
      }),
    );

    expect(inserted.projectId).toBe("project-1");
    await expect(queryRunAuditEvents(layer, {
      runId: "run-task-1",
    })).resolves.toEqual([expect.objectContaining({
      id: "task-audit-inherits-project",
      projectId: "project-1",
    })]);
  });

  it("rejects unscoped transaction audits unless the explicit global seam is used", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!);
    const event = {
      id: "global-audit-explicit-seam",
      timestamp: "2026-07-17T11:59:30.000Z",
      agentId: "admin",
      runId: "run-global",
      domain: "database",
      mutationType: "admin:maintenance",
      target: "fusion",
      metadata: { scope: "global" },
    } as const;

    await expect(layer.transactionImmediate(async (tx) =>
      recordRunAuditEventWithinTransaction(tx, event),
    )).rejects.toBeInstanceOf(RunAuditEventProjectScopeError);

    const inserted = await layer.transactionImmediate(async (tx) =>
      recordGlobalRunAuditEventWithinTransaction(tx, event),
    );
    expect(inserted.projectId).toBeNull();
  });

  it("keeps existing workflow-task and merge-queue audit callers project-bound", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    await layer.db.insert(tasks).values({
      id: "task-existing-audit-callers",
      projectId: "project-1",
      description: "Representative production audit callers",
      column: "in-review",
      createdAt: "2026-07-17T11:58:00.000Z",
      updatedAt: "2026-07-17T11:58:00.000Z",
    });

    await upsertWorkflowWorkItem(layer, {
      id: "work-item-existing-audit-caller",
      runId: "run-existing-task-audit",
      taskId: "task-existing-audit-callers",
      nodeId: "execute",
      kind: "task",
      now: "2026-07-17T11:58:10.000Z",
    });
    await enqueueMergeQueue(layer, "task-existing-audit-callers", {
      now: "2026-07-17T11:58:20.000Z",
    }, {
      agentId: "merge-agent",
      runId: "run-existing-merge-audit",
    });

    await expect(queryRunAuditEvents(layer, {
      taskId: "task-existing-audit-callers",
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: "project-1",
        mutationType: "workflowWorkItem:upsert",
      }),
      expect.objectContaining({
        projectId: "project-1",
        mutationType: "mergeQueue:enqueue",
      }),
    ]));
  });

  it("combines posture and lease authority and revokes the worker fence with a pause commit", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    const leaseStore = new AsyncRoomLeaseStore(layer);
    const running = await createRunningRoom(
      roomStore,
      "project-1",
      "room-combined-authority",
      "2026-07-17T11:50:00.000Z",
      "2026-07-17T11:51:00.000Z",
      "2026-07-17T11:52:00.000Z",
    );
    const acquired = await leaseStore.acquireLease({
      leaseId: "lease-combined-authority",
      roomId: running.room.id,
      kind: "room_worker",
      resourceId: running.room.id,
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: null,
      now: "2026-07-17T11:52:10.000Z",
      expiresAt: "2026-07-17T11:53:10.000Z",
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected Room worker lease acquisition");

    await expect(roomStore.assertWorkerAuthority({
      roomId: running.room.id,
      lease: acquired.lease,
      expectedAggregateVersion: running.room.aggregateVersion,
      now: "2026-07-17T11:52:20.000Z",
    })).resolves.toMatchObject({
      lease: { id: acquired.lease.id, epoch: acquired.lease.epoch },
      posture: { lifecycleState: "running", aggregateVersion: running.room.aggregateVersion },
    });

    await roomStore.transitionLifecycle(running.room.id, {
      to: "paused",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: "2026-07-17T11:52:30.000Z",
    }, {
      ...command("room-combined-authority-paused", "2026-07-17T11:52:30.000Z"),
      actorType: "human",
      actorId: "operator-1",
    });

    await expect(leaseStore.assertFence({
      leaseId: acquired.lease.id,
      roomId: running.room.id,
      kind: "room_worker",
      resourceId: running.room.id,
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: acquired.lease.epoch,
      now: "2026-07-17T11:52:31.000Z",
    })).rejects.toBeInstanceOf(RoomLeaseFenceError);
  }, 60_000);

  it("lists only this project's running Rooms in deterministic update order", async () => {
    const context = await startEmbeddedDatabase();
    const projectOne = new AsyncRoomStore(createAsyncDataLayer(context.connections!, { projectId: "project-1" }));
    const projectTwo = new AsyncRoomStore(createAsyncDataLayer(context.connections!, { projectId: "project-2" }));
    await createRunningRoom(
      projectOne,
      "project-1",
      "room-later",
      "2026-07-17T12:00:00.000Z",
      "2026-07-17T12:01:00.000Z",
      "2026-07-17T12:05:00.000Z",
    );
    const earlier = await createRunningRoom(
      projectOne,
      "project-1",
      "room-earlier",
      "2026-07-17T12:00:01.000Z",
      "2026-07-17T12:01:01.000Z",
      "2026-07-17T12:03:00.000Z",
    );
    await projectOne.createRoom({
      id: "room-draft",
      projectId: "project-1",
      objective: "Not runnable",
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T12:02:00.000Z",
    }, command("room-draft-created", "2026-07-17T12:02:00.000Z"));
    await createRunningRoom(
      projectTwo,
      "project-2",
      "room-other-project",
      "2026-07-17T12:00:02.000Z",
      "2026-07-17T12:01:02.000Z",
      "2026-07-17T12:02:02.000Z",
    );

    const listRunnableRooms = (projectOne as unknown as {
      listRunnableRooms?: () => Promise<readonly RoomAggregateV1[]>;
    }).listRunnableRooms;
    expect(listRunnableRooms, "Task 4.2 requires durable runnable-Room discovery").toBeTypeOf("function");
    await expect(listRunnableRooms!.call(projectOne)).resolves.toMatchObject([
      { room: { id: "room-earlier", state: "running" } },
      { room: { id: "room-later", state: "running" } },
    ]);

    await projectOne.transitionLifecycle("room-earlier", {
      to: "paused",
      expectedAggregateVersion: earlier.room.aggregateVersion,
      now: "2026-07-17T12:06:00.000Z",
    }, command("room-earlier-paused", "2026-07-17T12:06:00.000Z"));
    await expect(listRunnableRooms!.call(projectOne)).resolves.toMatchObject([
      { room: { id: "room-later", state: "running" } },
    ]);
  }, 60_000);

  it("re-reads a newer human-authored pause as a non-runnable recovery posture", async () => {
    const context = await startEmbeddedDatabase();
    const store = new AsyncRoomStore(
      createAsyncDataLayer(context.connections!, { projectId: "project-1" }),
    );
    const running = await createRunningRoom(
      store,
      "project-1",
      "room-human-pause",
      "2026-07-17T12:10:00.000Z",
      "2026-07-17T12:11:00.000Z",
      "2026-07-17T12:12:00.000Z",
    );

    await expect(store.getRecoveryPosture("room-human-pause")).resolves.toEqual({
      lifecycleState: "running",
      aggregateVersion: running.room.aggregateVersion,
      humanPaused: false,
      approvalState: "none",
    });

    await store.transitionLifecycle("room-human-pause", {
      to: "paused",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: "2026-07-17T12:13:00.000Z",
    }, {
      ...command("room-human-pause-paused", "2026-07-17T12:13:00.000Z"),
      actorType: "human",
      actorId: "operator-1",
    });

    await expect(store.getRecoveryPosture("room-human-pause")).resolves.toEqual({
      lifecycleState: "paused",
      aggregateVersion: running.room.aggregateVersion + 1,
      humanPaused: true,
      approvalState: "none",
    });
  }, 60_000);

  it("preserves pending and denied Room approval posture across restart discovery", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const running = await createRunningRoom(
      store,
      "project-1",
      "room-approval",
      "2026-07-17T12:20:00.000Z",
      "2026-07-17T12:21:00.000Z",
      "2026-07-17T12:22:00.000Z",
    );
    await layer.db.insert(approvalRequests).values({
      id: "approval-room-1",
      status: "pending",
      requesterActorId: "room-controller-test",
      requesterActorType: "controller",
      requesterActorName: "Room controller",
      targetActionCategory: "external_side_effect",
      targetActionOperation: "provider_send",
      targetActionSummary: "Room provider send",
      targetResourceType: "room",
      targetResourceId: "room-approval",
      targetContext: {},
      taskId: null,
      runId: "room-run-1",
      requestedAt: "2026-07-17T12:23:00.000Z",
      decidedAt: null,
      completedAt: null,
      createdAt: "2026-07-17T12:23:00.000Z",
      updatedAt: "2026-07-17T12:23:00.000Z",
    });

    await expect(store.getRecoveryPosture("room-approval")).resolves.toMatchObject({
      lifecycleState: "running",
      approvalState: "waiting",
    });

    await layer.db
      .update(approvalRequests)
      .set({
        status: "denied",
        decidedAt: "2026-07-17T12:24:00.000Z",
        updatedAt: "2026-07-17T12:24:00.000Z",
      })
      .where(eq(approvalRequests.id, "approval-room-1"));
    await store.transitionLifecycle("room-approval", {
      to: "blocked",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: "2026-07-17T12:24:00.000Z",
    }, command("room-approval-blocked", "2026-07-17T12:24:00.000Z"));

    await expect(store.getRecoveryPosture("room-approval")).resolves.toMatchObject({
      lifecycleState: "blocked",
      approvalState: "blocked",
    });

    await layer.db.insert(approvalRequests).values({
      id: "approval-room-2",
      status: "approved",
      requesterActorId: "room-controller-test",
      requesterActorType: "controller",
      requesterActorName: "Room controller",
      targetActionCategory: "external_side_effect",
      targetActionOperation: "provider_send",
      targetActionSummary: "Approved Room provider send",
      targetResourceType: "room",
      targetResourceId: "room-approval",
      targetContext: {},
      taskId: null,
      runId: "room-run-2",
      requestedAt: "2026-07-17T12:25:00.000Z",
      decidedAt: "2026-07-17T12:25:00.000Z",
      completedAt: null,
      createdAt: "2026-07-17T12:25:00.000Z",
      updatedAt: "2026-07-17T12:25:00.000Z",
    });

    await expect(store.getRecoveryPosture("room-approval")).resolves.toMatchObject({
      lifecycleState: "blocked",
      approvalState: "none",
    });
  }, 60_000);

  it("chooses the latest approval request instead of an older denied row with a later update timestamp", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const running = await createRunningRoom(
      store,
      "project-1",
      "room-approval-latest-request-wins",
      "2026-07-17T12:30:00.000Z",
      "2026-07-17T12:31:00.000Z",
      "2026-07-17T12:32:00.000Z",
    );

    await layer.db.insert(approvalRequests).values({
      id: "approval-denied-older",
      status: "denied",
      requesterActorId: "room-controller-test",
      requesterActorType: "controller",
      requesterActorName: "Room controller",
      targetActionCategory: "external_side_effect",
      targetActionOperation: "provider_send",
      targetActionSummary: "Older denied Room provider send",
      targetResourceType: "room",
      targetResourceId: "room-approval-latest-request-wins",
      targetContext: {},
      taskId: null,
      runId: "room-run-denied-older",
      requestedAt: "2026-07-17T12:33:00.000Z",
      decidedAt: "2026-07-17T12:34:00.000Z",
      completedAt: null,
      createdAt: "2026-07-17T12:33:00.000Z",
      updatedAt: "2026-07-17T12:36:00.000Z",
    });
    await store.transitionLifecycle("room-approval-latest-request-wins", {
      to: "blocked",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: "2026-07-17T12:34:00.000Z",
    }, command("room-approval-latest-request-wins-blocked", "2026-07-17T12:34:00.000Z"));
    await layer.db.insert(approvalRequests).values({
      id: "approval-approved-newer",
      status: "approved",
      requesterActorId: "room-controller-test",
      requesterActorType: "controller",
      requesterActorName: "Room controller",
      targetActionCategory: "external_side_effect",
      targetActionOperation: "provider_send",
      targetActionSummary: "Newer approved Room provider send",
      targetResourceType: "room",
      targetResourceId: "room-approval-latest-request-wins",
      targetContext: {},
      taskId: null,
      runId: "room-run-approved-newer",
      requestedAt: "2026-07-17T12:35:00.000Z",
      decidedAt: "2026-07-17T12:35:00.000Z",
      completedAt: null,
      createdAt: "2026-07-17T12:35:00.000Z",
      updatedAt: "2026-07-17T12:35:00.000Z",
    });

    await expect(
      store.getRecoveryPosture("room-approval-latest-request-wins"),
    ).resolves.toMatchObject({
      lifecycleState: "blocked",
      approvalState: "none",
    });
  }, 60_000);

  it("keeps Room run-audit rows inside the bound project instead of trusting metadata", async () => {
    const context = await startEmbeddedDatabase();
    const project1 = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const project2 = createAsyncDataLayer(context.connections!, { projectId: "project-2" });

    await recordRunAuditEvent(project1, {
      id: "room-audit-project-scope",
      timestamp: "2026-07-17T12:40:00.000Z",
      projectId: "project-1",
      agentId: "room-worker-1",
      runId: "room-controller:project-scope",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-project-1",
      metadata: {
        projectId: "project-2",
        roomId: "room-project-1",
      },
    });

    await expect(queryRunAuditEvents(project1, {
      projectId: "project-1",
      runId: "room-controller:project-scope",
    })).resolves.toMatchObject([{
      id: "room-audit-project-scope",
      projectId: "project-1",
    }]);
    await expect(queryRunAuditEvents(project2, {
      runId: "room-controller:project-scope",
    })).resolves.toEqual([]);
    await expect(queryRunAuditEvents(project2.db, {
      runId: "room-controller:project-scope",
    })).rejects.toBeInstanceOf(RunAuditEventQueryScopeError);
    await expect(queryRunAuditEventsAdmin(project2.db, {
      runId: "room-controller:project-scope",
    })).resolves.toMatchObject([{
      id: "room-audit-project-scope",
      projectId: "project-1",
    }]);
  }, 60_000);

  it("treats stable run-audit ids as idempotent only when the normalized payload matches", async () => {
    const context = await startEmbeddedDatabase();
    const project1 = createAsyncDataLayer(context.connections!, { projectId: "project-1" });

    await project1.transactionImmediate(async (tx) => {
      const inserted = await recordRunAuditEventWithinTransaction(tx, {
        id: "room-audit-stable-id",
        timestamp: "2026-07-17T12:45:00.000Z",
        projectId: "project-1",
        taskId: "ROOM-AUDIT-1",
        agentId: "room-worker-1",
        runId: "room-controller:stable-id",
        domain: "database",
        mutationType: "room:worker-started",
        target: "room-project-1",
        metadata: {
          roomId: "room-project-1",
          nested: {
            beta: 2,
            alpha: 1,
          },
        },
  });

      await expect(recordRunAuditEventWithinTransaction(tx, {
        id: "room-audit-stable-id",
        timestamp: "2026-07-17T12:45:00.000Z",
        projectId: "project-1",
        taskId: "ROOM-AUDIT-1",
        agentId: "room-worker-1",
        runId: "room-controller:stable-id",
        domain: "database",
        mutationType: "room:worker-started",
        target: "room-project-1",
        metadata: {
          nested: {
            alpha: 1,
            beta: 2,
          },
          roomId: "room-project-1",
        },
      })).resolves.toEqual(inserted);
    });

    await expect(queryRunAuditEvents(project1, {
      runId: "room-controller:stable-id",
    })).resolves.toMatchObject([{
      id: "room-audit-stable-id",
      projectId: "project-1",
      target: "room-project-1",
    }]);

    await expect(project1.transactionImmediate(async (tx) =>
      recordRunAuditEventWithinTransaction(tx, {
        id: "room-audit-stable-id",
        timestamp: "2026-07-17T12:45:00.000Z",
        projectId: "project-1",
        taskId: "ROOM-AUDIT-1",
        agentId: "room-worker-1",
        runId: "room-controller:stable-id",
        domain: "database",
        mutationType: "room:worker-started",
        target: "room-project-2",
        metadata: {
          roomId: "room-project-1",
          nested: {
            alpha: 1,
            beta: 2,
          },
        },
      }),
    )).rejects.toBeInstanceOf(RunAuditEventConflictError);

    await expect(queryRunAuditEvents(project1, {
      runId: "room-controller:stable-id",
    })).resolves.toHaveLength(1);
  }, 60_000);

  it("reuses the persisted timestamp when a stable-id retry omits timestamp", async () => {
    const context = await startEmbeddedDatabase();
    const project = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const event = {
      id: "room-audit-stable-id-without-timestamp",
      projectId: "project-1",
      agentId: "room-worker-1",
      runId: "room-controller-run-1",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-1",
      metadata: { roomId: "room-1", leaseEpoch: 1 },
    } as const;

    const first = await project.transactionImmediate(async (tx) =>
      recordRunAuditEventWithinTransaction(tx, event),
    );
    const retried = await project.transactionImmediate(async (tx) =>
      recordRunAuditEventWithinTransaction(tx, event),
    );

    expect(retried).toEqual(first);
  }, 60_000);

  it("replays a durable Room audit outbox row idempotently after controller loss", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const firstControllerStore = new AsyncRoomStore(layer);
    const event = {
      id: "room-audit-outbox-crash-replay",
      projectId: "project-1",
      timestamp: "2026-07-17T13:00:00.000Z",
      agentId: "room-worker-1",
      runId: "room-controller:crash-replay",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-crash-replay",
      metadata: { roomId: "room-crash-replay", leaseEpoch: 1 },
    } as const;

    await firstControllerStore.enqueueRunAuditEvent(event);

    const restartedControllerStore = new AsyncRoomStore(layer);
    const claimed = await restartedControllerStore.claimRunAuditEvents({
      claimToken: "controller-restart-claim",
      now: "2026-07-17T13:00:01.000Z",
      claimExpiresAt: "2026-07-17T13:00:31.000Z",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    await recordRunAuditEvent(layer, claimed[0]!.event);
    await recordRunAuditEvent(layer, claimed[0]!.event);
    await restartedControllerStore.markRunAuditEventDelivered({
      id: event.id,
      claimToken: "controller-restart-claim",
      now: "2026-07-17T13:00:02.000Z",
    });

    await expect(queryRunAuditEvents(layer, {
      runId: event.runId,
    })).resolves.toHaveLength(1);
    await expect(restartedControllerStore.claimRunAuditEvents({
      claimToken: "controller-restart-second-claim",
      now: "2026-07-17T13:00:03.000Z",
      claimExpiresAt: "2026-07-17T13:00:33.000Z",
      limit: 10,
    })).resolves.toEqual([]);
    await expect(restartedControllerStore.listRunAuditOutbox()).resolves.toEqual([
      expect.objectContaining({ id: event.id, state: "delivered", attemptCount: 1 }),
    ]);
  }, 60_000);

  it("persists run-audit delivery backoff and fences stale claimants", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const event = {
      id: "room-audit-outbox-failed-delivery",
      projectId: "project-1",
      timestamp: "2026-07-17T13:10:00.000Z",
      agentId: "room-worker-1",
      runId: "room-controller:failed-delivery",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-failed-delivery",
      metadata: { roomId: "room-failed-delivery", leaseEpoch: 1 },
    } as const;
    await store.enqueueRunAuditEvent(event);
    const firstClaim = await store.claimRunAuditEvents({
      claimToken: "first-claim",
      now: "2026-07-17T13:10:01.000Z",
      claimExpiresAt: "2026-07-17T13:10:31.000Z",
      limit: 10,
    });
    expect(firstClaim).toEqual([
      expect.objectContaining({ id: event.id, attemptCount: 1, state: "dispatching" }),
    ]);
    await store.markRunAuditEventFailed({
      id: event.id,
      claimToken: "first-claim",
      now: "2026-07-17T13:10:02.000Z",
      errorCode: "audit_sink_failed",
      nextAttemptAt: "2026-07-17T13:10:12.000Z",
      exhausted: false,
    });

    await expect(store.claimRunAuditEvents({
      claimToken: "too-early",
      now: "2026-07-17T13:10:11.999Z",
      claimExpiresAt: "2026-07-17T13:10:41.999Z",
      limit: 10,
    })).resolves.toEqual([]);
    const secondClaim = await store.claimRunAuditEvents({
      claimToken: "second-claim",
      now: "2026-07-17T13:10:12.000Z",
      claimExpiresAt: "2026-07-17T13:10:42.000Z",
      limit: 10,
    });
    expect(secondClaim).toEqual([
      expect.objectContaining({ id: event.id, attemptCount: 2, state: "dispatching" }),
    ]);
    await expect(store.markRunAuditEventDelivered({
      id: event.id,
      claimToken: "first-claim",
      now: "2026-07-17T13:10:13.000Z",
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    await store.markRunAuditEventFailed({
      id: event.id,
      claimToken: "second-claim",
      now: "2026-07-17T13:10:13.000Z",
      errorCode: "audit_sink_failed",
      nextAttemptAt: null,
      exhausted: true,
    });
    await expect(store.claimRunAuditEvents({
      claimToken: "after-exhaustion",
      now: "2026-07-17T13:11:00.000Z",
      claimExpiresAt: "2026-07-17T13:11:30.000Z",
      limit: 10,
    })).resolves.toEqual([]);
    await expect(store.listRunAuditOutbox()).resolves.toEqual([
      expect.objectContaining({
        id: event.id,
        state: "exhausted",
        attemptCount: 2,
        lastErrorCode: "audit_sink_failed",
      }),
    ]);
  }, 60_000);

  it("serializes uncommitted same-Room enqueues before causal dispatch", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    let markFirstTransactionReady!: () => void;
    let releaseFirstTransaction!: () => void;
    const firstTransactionReady = new Promise<void>((resolve) => {
      markFirstTransactionReady = resolve;
    });
    const firstTransactionRelease = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    const delayedCommitLayer: AsyncDataLayer = {
      ...layer,
      async transactionImmediate<T>(
        fn: (tx: DbTransaction) => Promise<T>,
        options?: TransactionOptions,
      ): Promise<T> {
        return layer.transactionImmediate(async (tx) => {
          const result = await fn(tx);
          markFirstTransactionReady();
          await firstTransactionRelease;
          return result;
        }, options);
      },
    };
    const firstStore = new AsyncRoomStore(delayedCommitLayer);
    const secondStore = new AsyncRoomStore(layer);
    const dispatcherStore = new AsyncRoomStore(layer);
    const started = {
      id: "room-audit-causal-started",
      projectId: "project-1",
      timestamp: "2026-07-17T13:15:00.000Z",
      agentId: "room-worker-1",
      runId: "room-controller:causal-order",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-causal-order",
      metadata: { roomId: "room-causal-order", leaseEpoch: 1 },
    } as const;
    const stopped = {
      ...started,
      id: "room-audit-causal-stopped",
      timestamp: "2026-07-17T13:15:01.000Z",
      mutationType: "room:worker-stopped",
    } as const;
    const firstEnqueue = firstStore.enqueueRunAuditEvent(started);
    await firstTransactionReady;
    let secondSettled = false;
    const secondEnqueue = secondStore.enqueueRunAuditEvent(stopped).finally(() => {
      secondSettled = true;
    });

    try {
      await expect(dispatcherStore.claimRunAuditEvents({
        claimToken: "causal-before-first-commit",
        now: "2026-07-17T13:15:01.500Z",
        claimExpiresAt: "2026-07-17T13:15:31.500Z",
        limit: 10,
      })).resolves.toEqual([]);
      expect(secondSettled).toBe(false);
    } finally {
      releaseFirstTransaction();
    }
    await firstEnqueue;
    await secondEnqueue;

    const firstClaim = await dispatcherStore.claimRunAuditEvents({
      claimToken: "causal-first",
      now: "2026-07-17T13:15:02.000Z",
      claimExpiresAt: "2026-07-17T13:15:32.000Z",
      limit: 10,
    });
    expect(firstClaim).toEqual([
      expect.objectContaining({ id: started.id }),
    ]);
    expect(firstClaim[0]?.event.mutationType).toBe("room:worker-started");
    await expect(dispatcherStore.claimRunAuditEvents({
      claimToken: "causal-too-early",
      now: "2026-07-17T13:15:03.000Z",
      claimExpiresAt: "2026-07-17T13:15:33.000Z",
      limit: 10,
    })).resolves.toEqual([]);

    await dispatcherStore.markRunAuditEventDelivered({
      id: started.id,
      claimToken: "causal-first",
      now: "2026-07-17T13:15:04.000Z",
    });
    const secondClaim = await dispatcherStore.claimRunAuditEvents({
      claimToken: "causal-second",
      now: "2026-07-17T13:15:05.000Z",
      claimExpiresAt: "2026-07-17T13:15:35.000Z",
      limit: 10,
    });
    expect(secondClaim).toEqual([
      expect.objectContaining({ id: stopped.id }),
    ]);
    expect(secondClaim[0]?.event.mutationType).toBe("room:worker-stopped");
  }, 60_000);

  it("lets a replacement dispatcher reclaim an expired in-flight audit claim", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const event = {
      id: "room-audit-outbox-expired-claim",
      projectId: "project-1",
      timestamp: "2026-07-17T13:20:00.000Z",
      agentId: "room-worker-1",
      runId: "room-controller:expired-claim",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-expired-claim",
      metadata: { roomId: "room-expired-claim", leaseEpoch: 1 },
    } as const;
    await store.enqueueRunAuditEvent(event);
    await expect(store.claimRunAuditEvents({
      claimToken: "crashed-dispatcher",
      now: "2026-07-17T13:20:01.000Z",
      claimExpiresAt: "2026-07-17T13:20:31.000Z",
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({ id: event.id, attemptCount: 1 }),
    ]);
    await expect(store.claimRunAuditEvents({
      claimToken: "replacement-too-early",
      now: "2026-07-17T13:20:30.999Z",
      claimExpiresAt: "2026-07-17T13:21:00.999Z",
      limit: 10,
    })).resolves.toEqual([]);

    await expect(store.claimRunAuditEvents({
      claimToken: "replacement-dispatcher",
      now: "2026-07-17T13:20:31.000Z",
      claimExpiresAt: "2026-07-17T13:21:01.000Z",
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({
        id: event.id,
        attemptCount: 2,
        claimToken: "replacement-dispatcher",
      }),
    ]);
    await expect(store.markRunAuditEventDelivered({
      id: event.id,
      claimToken: "crashed-dispatcher",
      now: "2026-07-17T13:20:32.000Z",
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    await store.markRunAuditEventDelivered({
      id: event.id,
      claimToken: "replacement-dispatcher",
      now: "2026-07-17T13:20:32.000Z",
    });
    await expect(store.listRunAuditOutbox()).resolves.toEqual([
      expect.objectContaining({ id: event.id, state: "delivered", attemptCount: 2 }),
    ]);
  }, 60_000);
});
