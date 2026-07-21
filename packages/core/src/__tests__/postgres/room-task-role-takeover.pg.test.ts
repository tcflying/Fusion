import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import {
  AsyncRoomStore,
  type ClaimReadyRoomTaskDispatchInputV1,
  type RoomCommandContext,
  type RoomRoleAssignmentProjectionV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeDefinitionV1,
} from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomBindings, roomSeats } from "../../postgres/schema/room.js";
import type { RoomAuthorityEnvelopeV1 } from "../../room-contracts/controller.js";
import { hashRoomValue } from "../../room-integrity.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface RoleTakeoverFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly graph: RoomTaskGraphProjectionV1;
  readonly roleAssignment: RoomRoleAssignmentProjectionV1;
  readonly originalWorkerLease: StoredRoomLeaseV1;
}

const PROJECT_ID = "project-room-task-role-takeover";
const ROOM_ID = "room-task-role-takeover";
const NODE_ID = "node-role-takeover-ready";
const SEAT_ID = "seat-role-takeover-implementer";
const BINDING_ID = "binding-role-takeover-implementer";
const ORIGINAL_WORKER_ID = "controller-role-takeover-original";
const REPLACEMENT_WORKER_ID = "controller-role-takeover-replacement";
const ORIGINAL_HOST_ID = "windows-host-role-takeover-original";
const REPLACEMENT_HOST_ID = "windows-host-role-takeover-replacement";

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

/*
FNXC:SessionRoomTaskRoleTakeover 2026-07-19-05:47:
Task 5.7 requires a crash takeover to preserve the exact capability-aware role
revision and its dispatch provenance. A replacement worker may recover an
uncertain delivery, but an expired predecessor must not mutate the Room after
the lease epoch advances.
*/
function commandContext(label: string, occurredAt: string): RoomCommandContext {
  return {
    eventId: `event-role-takeover-${label}`,
    actorType: "controller",
    actorId: ORIGINAL_WORKER_ID,
    correlationId: `correlation-role-takeover-${label}`,
    causationId: null,
    occurredAt,
  };
}

function workerFence(lease: StoredRoomLeaseV1) {
  return {
    leaseId: lease.id,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

function readyTaskNode(): RoomTaskNodeDefinitionV1 {
  return {
    id: NODE_ID,
    parentNodeId: null,
    objective: "Fence one capability-authorized task through worker takeover",
    assignedSeatIds: [SEAT_ID],
    inputRefs: ["input:role-takeover"],
    outputRefs: ["artifact:role-takeover"],
    roleRequirements: ["implementer"],
    capabilityRequirements: ["workspace_write"],
    resourceHints: {
      estimatedDurationMs: 1_000,
      concurrencyClass: "parallel",
      preferredProviderIds: ["codex"],
    },
    authorityScope: {
      allowedActions: ["workspace:write"],
      readPaths: ["packages/core"],
      writePaths: ["packages/core"],
    },
    acceptanceGateIds: ["gate:role-takeover"],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "exponential",
      baseDelayMs: 1_000,
      recoveryActions: ["replan"],
    },
    progressSignature: "progress:role-takeover:ready",
  };
}

function dispatchAuthority(): RoomAuthorityEnvelopeV1 {
  return {
    actorType: "controller",
    actorId: ORIGINAL_WORKER_ID,
    deviceId: null,
    role: "controller",
    allowedActions: ["room:task:dispatch"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [NODE_ID],
    seatIds: [SEAT_ID],
    evidenceRefs: ["policy:role-takeover:v1"],
  };
}

function claimInput(fixture: RoleTakeoverFixture): ClaimReadyRoomTaskDispatchInputV1 {
  const node = fixture.graph.nodes.find((candidate) => candidate.id === NODE_ID);
  if (!node) throw new Error("Role-takeover fixture is missing its ready task node");
  const content = "Start the role-authorized task and retain recovery provenance.";
  return {
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    expectedAggregateVersion: fixture.graph.aggregateVersion,
    expectedDagVersion: fixture.graph.dagVersion,
    expectedNodeVersion: node.nodeVersion,
    owner: { seatId: SEAT_ID, bindingId: BINDING_ID },
    roleAssignment: {
      assignmentId: fixture.roleAssignment.id,
      revision: fixture.roleAssignment.revision,
      phaseId: fixture.roleAssignment.phaseId,
    },
    roomWorkerFence: workerFence(fixture.originalWorkerLease),
    idempotencyKey: "role-takeover-dispatch:node-role-takeover-ready:attempt-1",
    commandId: "command-role-takeover-dispatch-1",
    correlationId: "correlation-role-takeover-dispatch-1",
    issuedAt: "2026-07-19T12:05:00.000Z",
    authority: dispatchAuthority(),
    message: {
      intent: "instruction",
      content,
      contentHash: hashRoomValue(content),
    },
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-task-role-takeover-"));
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
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  if (!sharedLayer) throw new Error("Role-takeover PostgreSQL fixture was not started");
  await sharedLayer.db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
}, 60_000);

async function createFixture(): Promise<RoleTakeoverFixture> {
  if (!sharedLayer) throw new Error("Role-takeover PostgreSQL fixture was not started");
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, {
    currentTime: () => "2026-07-19T12:05:00.000Z",
  });
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const created = await store.createRoom({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Keep role-authorized dispatch safe through a worker crash",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-19T12:00:00.000Z",
  }, commandContext("created", "2026-07-19T12:00:00.000Z"));

  await layer.db.insert(roomSeats).values({
    id: SEAT_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    role: "implementer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["room:message:receive"],
    state: "active",
    activeBindingId: BINDING_ID,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
  });
  await layer.db.insert(roomBindings).values({
    id: BINDING_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    seatId: SEAT_ID,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "native-role-takeover-implementer",
    happierSessionId: "happier-role-takeover-implementer",
    serverProfileId: "server-role-takeover",
    machineId: ORIGINAL_HOST_ID,
    hostId: ORIGINAL_HOST_ID,
    state: "attached",
    attachedAt: "2026-07-19T12:00:00.000Z",
  });

  const ready = await store.transitionLifecycle(ROOM_ID, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: "2026-07-19T12:01:00.000Z",
  }, commandContext("ready", "2026-07-19T12:01:00.000Z"));
  const running = await store.transitionLifecycle(ROOM_ID, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: "2026-07-19T12:02:00.000Z",
  }, commandContext("running", "2026-07-19T12:02:00.000Z"));
  const seededGraph = await store.mutateTaskGraph({
    roomId: ROOM_ID,
    expectedAggregateVersion: running.room.aggregateVersion,
    expectedDagVersion: 0,
    idempotencyKey: "seed-role-takeover-ready-node",
    mutations: [{ action: "add_node", node: readyTaskNode() }],
    mutatedAt: "2026-07-19T12:03:00.000Z",
  }, commandContext("seed-node", "2026-07-19T12:03:00.000Z"));
  const roleAssignment = await store.activateRoomRoleAssignment({
    roomId: ROOM_ID,
    expectedAggregateVersion: seededGraph.aggregateVersion,
    idempotencyKey: "activate-role-takeover-assignment",
    capabilitySnapshot: {
      contractVersion: 1,
      snapshotId: "snapshot-role-takeover-v1",
      revision: 1,
      capturedAt: "2026-07-19T12:03:30.000Z",
      bindings: [{
        bindingId: BINDING_ID,
        availability: "eligible",
        capabilityRevision: "capability-role-takeover-v1",
        capabilities: [
          { name: "source_read", state: "verified" },
          { name: "workspace_write", state: "verified" },
        ],
      }],
    },
    constraints: {
      locks: [{ roleId: "implementer", bindingId: BINDING_ID }],
      forbids: [],
    },
    now: "2026-07-19T12:03:30.000Z",
  }, commandContext("activate-role-assignment", "2026-07-19T12:03:30.000Z"));
  const graph = await store.getTaskGraph(ROOM_ID);
  if (!graph) throw new Error("Role-takeover fixture task graph is missing after activation");

  const acquired = await leaseStore.acquireLease({
    leaseId: "lease-role-takeover-original",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: ORIGINAL_WORKER_ID,
    hostId: ORIGINAL_HOST_ID,
    expectedEpoch: null,
    now: "2026-07-19T12:04:00.000Z",
    expiresAt: "2026-07-19T12:10:00.000Z",
  });
  if (!acquired.ok) throw new Error("Original Room worker lease must be acquired for takeover regression");

  return { layer, store, leaseStore, graph, roleAssignment, originalWorkerLease: acquired.lease };
}

describe.sequential("Task 5.7 role-aware dispatch takeover", () => {
  it("preserves active role provenance through replacement recovery and rejects the crashed worker fence", async () => {
    const fixture = await createFixture();
    const roleBeforeCrash = await fixture.store.getActiveRoomRoleAssignment(ROOM_ID);
    if (!roleBeforeCrash) throw new Error("Active capability-aware role assignment is required before dispatch");
    expect(roleBeforeCrash).toMatchObject({
      id: fixture.roleAssignment.id,
      revision: 1,
      phaseId: "plan",
      authoritativeProducerBindingIds: [BINDING_ID],
      capabilitySnapshot: {
        snapshotId: "snapshot-role-takeover-v1",
        revision: 1,
      },
    });

    const claimed = await fixture.store.claimReadyTaskDispatch(claimInput(fixture));
    expect(claimed).toMatchObject({
      nodeId: NODE_ID,
      ownerSeatId: SEAT_ID,
      ownerBindingId: BINDING_ID,
      delivery: { state: "pending", bindingId: BINDING_ID },
      event: {
        eventType: "room_task_dispatch_claimed",
        payload: expect.objectContaining({
          roleAssignmentId: roleBeforeCrash.id,
          roleAssignmentRevision: roleBeforeCrash.revision,
          roleAssignmentPhaseId: roleBeforeCrash.phaseId,
        }),
      },
    });

    await fixture.store.beginDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-role-takeover-uncertain",
      reconciliationFromCursor: "cursor-before-role-takeover-crash",
      now: "2026-07-19T12:05:01.000Z",
    });
    await fixture.store.completeDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-role-takeover-uncertain",
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "connector_send_exception",
      nextAttemptAt: null,
      now: "2026-07-19T12:05:02.000Z",
      audit: { runId: "role-takeover-crash-recovery", agentId: ORIGINAL_WORKER_ID },
    });
    const graphBeforeTakeover = await fixture.store.getTaskGraph(ROOM_ID);
    expect(graphBeforeTakeover?.nodes).toEqual([
      expect.objectContaining({ id: NODE_ID, state: "running", nodeVersion: 1 }),
    ]);

    const takeover = await fixture.leaseStore.acquireLease({
      leaseId: "lease-role-takeover-replacement",
      roomId: ROOM_ID,
      kind: "room_worker",
      resourceId: ROOM_ID,
      holderId: REPLACEMENT_WORKER_ID,
      hostId: REPLACEMENT_HOST_ID,
      expectedEpoch: fixture.originalWorkerLease.epoch,
      now: "2026-07-19T12:11:00.000Z",
      expiresAt: "2026-07-19T12:30:00.000Z",
    });
    expect(takeover).toMatchObject({ ok: true, action: "taken_over", lease: { epoch: 2 } });
    if (!takeover.ok) throw new Error("Replacement Room worker must take over the expired original lease");

    await expect(fixture.store.recoverNoProgressTaskDispatches({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      now: "2026-07-19T12:11:01.000Z",
      maxDeliveryUncertaintyAgeMs: 1_000,
    })).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(await fixture.store.getTaskGraph(ROOM_ID)).toEqual(graphBeforeTakeover);
    expect(await fixture.store.getActiveRoomRoleAssignment(ROOM_ID)).toEqual(roleBeforeCrash);

    await expect(fixture.store.recoverNoProgressTaskDispatches({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(takeover.lease),
      now: "2026-07-19T12:11:02.000Z",
      maxDeliveryUncertaintyAgeMs: 1_000,
    })).resolves.toEqual({ blockedNodeIds: [NODE_ID], skippedOutboxIds: [] });

    expect(await fixture.store.getTaskGraph(ROOM_ID)).toMatchObject({
      nodes: [expect.objectContaining({ id: NODE_ID, state: "blocked", nodeVersion: 2 })],
    });
    expect(await fixture.store.getActiveRoomRoleAssignment(ROOM_ID)).toEqual(roleBeforeCrash);
    const dispatchEvent = (await fixture.store.listEvents(ROOM_ID)).find(
      (event) => event.eventType === "room_task_dispatch_claimed",
    );
    expect(dispatchEvent).toMatchObject({
      payload: expect.objectContaining({
        roleAssignmentId: roleBeforeCrash.id,
        roleAssignmentRevision: roleBeforeCrash.revision,
        roleAssignmentPhaseId: roleBeforeCrash.phaseId,
      }),
    });
  });
});
