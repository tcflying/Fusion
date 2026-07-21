import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import {
  AsyncRoomStore,
  type ClaimReadyRoomTaskDispatchInputV1,
  type CompleteRoomTaskRecoveryActionInputV1,
  type RoomCommandContext,
  type RoomRoleAssignmentProjectionV1,
  type RoomTaskNodeDefinitionV1,
  type RoomTaskProgressSignalHashesV1,
  type RoomTaskRecoveryActionResultV1,
  type RoomTaskRecoveryActionV1,
  type RecordRoomTaskProgressObservationInputV1,
  type RecordRoomTaskRecoveryPlanInputV1,
} from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomSeats,
  roomTurns,
} from "../../postgres/schema/room.js";
import type { RoomCapabilitySnapshotInputV1 } from "../../room-contracts/assignment.js";
import type { RoomAuthorityEnvelopeV1 } from "../../room-contracts/controller.js";
import { hashRoomValue } from "../../room-integrity.js";
import {
  rebuildRoomProjectionFromEvents,
  rebuildRoomTaskProgressRecoveryProjectionFromEvents,
} from "../../room-projection-replay.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface RecoveryFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly roomId: string;
  readonly turnId: string;
  readonly roleAssignment: RoomRoleAssignmentProjectionV1;
  readonly originalWorkerLease: StoredRoomLeaseV1;
  readonly targetNodeId: string;
  readonly independentNodeId: string | null;
}

interface RecoveryFixtureOptions {
  readonly includeIndependentNode?: boolean;
}

interface ProgressRoundInput {
  readonly roundId: string;
  readonly idempotencyKey: string;
  readonly signals: RoomTaskProgressSignalHashesV1;
  readonly observedAt: string;
}

const PROJECT_ID = "project-room-task-progress-recovery";
const ROOM_ID = "room-task-progress-recovery";
const TARGET_NODE_ID = "node-task-progress-target";
const INDEPENDENT_NODE_ID = "node-task-progress-independent";
const SEAT_ID = "seat-task-progress-implementer";
const BINDING_ID = "binding-task-progress-implementer";
const TURN_ID = "turn-task-progress-plan";
const PHASE_ID = "plan";
const WORKER_A_ID = "room-controller-progress-worker-a";
const WORKER_B_ID = "room-controller-progress-worker-b";
const HOST_A_ID = "windows-host-progress-worker-a";
const HOST_B_ID = "windows-host-progress-worker-b";

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

/*
FNXC:SessionRoomProgressRecovery 2026-07-19:
Task 5.8 must preserve a genuine running Room turn, active capability-aware
role assignment, fence, and ready-to-running dispatch before it observes
progress. These tests intentionally do not treat a raw task row as execution
proof: every recovery action is derived from the durable Room control plane.
*/
function commandContext(label: string, occurredAt: string): RoomCommandContext {
  return {
    eventId: `event-task-progress-${label}`,
    actorType: "controller",
    actorId: WORKER_A_ID,
    correlationId: `correlation-task-progress-${label}`,
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

function progressSignals(label: string): RoomTaskProgressSignalHashesV1 {
  return {
    semanticHash: hashRoomValue({ label, signal: "semantic" }),
    evidenceHash: hashRoomValue({ label, signal: "evidence" }),
    artifactHash: hashRoomValue({ label, signal: "artifact" }),
    testHash: hashRoomValue({ label, signal: "test" }),
    resolvedDissentHash: hashRoomValue({ label, signal: "resolved-dissent" }),
  };
}

function recoveryReceipt(
  kind: RoomTaskRecoveryActionResultV1["kind"] = "operator_approval_requested",
): RoomTaskRecoveryActionResultV1 {
  const receiptRef = `recovery-receipt:${kind}`;
  return {
    contractVersion: "room-task-recovery-action-result/v1",
    kind,
    receiptRef,
    resultHash: hashRoomValue({
      contractVersion: "room-task-recovery-action-result/v1",
      kind,
      receiptRef,
    }),
  };
}

function taskNode(id: string, objective: string): RoomTaskNodeDefinitionV1 {
  return {
    id,
    parentNodeId: null,
    objective,
    assignedSeatIds: [SEAT_ID],
    inputRefs: [`input:${id}`],
    outputRefs: [`artifact:${id}`],
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
    acceptanceGateIds: ["gate:implementation"],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "exponential",
      baseDelayMs: 1_000,
      recoveryActions: ["replan"],
    },
    progressSignature: `progress:${id}:v1`,
  };
}

function dispatchAuthority(): RoomAuthorityEnvelopeV1 {
  return {
    actorType: "controller",
    actorId: WORKER_A_ID,
    deviceId: null,
    role: "controller",
    allowedActions: ["room:task:dispatch"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [TARGET_NODE_ID],
    seatIds: [SEAT_ID],
    evidenceRefs: ["policy:task-progress-recovery:v1"],
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-task-progress-recovery-"));
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
  if (!sharedLayer) throw new Error("Task-progress recovery PostgreSQL fixture was not started");
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

async function createRecoveryFixture(
  options: RecoveryFixtureOptions = {},
): Promise<RecoveryFixture> {
  if (!sharedLayer) throw new Error("Task-progress recovery PostgreSQL fixture was not started");
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, {
    currentTime: () => "2026-07-19T12:05:00.000Z",
  });
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const created = await store.createRoom({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Prove no-progress recovery remains fenced and replayable",
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
    nativeSessionId: "native-task-progress-implementer",
    happierSessionId: "happier-task-progress-implementer",
    serverProfileId: "server-task-progress",
    machineId: HOST_A_ID,
    hostId: HOST_A_ID,
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
  const graph = await store.mutateTaskGraph({
    roomId: ROOM_ID,
    expectedAggregateVersion: running.room.aggregateVersion,
    expectedDagVersion: 0,
    idempotencyKey: "seed-task-progress-recovery-graph",
    mutations: [
      {
        action: "add_node",
        node: taskNode(TARGET_NODE_ID, "Recover one stalled implementation node"),
      },
      ...(options.includeIndependentNode
        ? [{
            action: "add_node" as const,
            node: taskNode(INDEPENDENT_NODE_ID, "Keep an independent branch runnable"),
          }]
        : []),
    ],
    mutatedAt: "2026-07-19T12:03:00.000Z",
  }, commandContext("seed-graph", "2026-07-19T12:03:00.000Z"));

  const roleAssignment = await store.activateRoomRoleAssignment({
    roomId: ROOM_ID,
    expectedAggregateVersion: graph.aggregateVersion,
    idempotencyKey: "activate-task-progress-plan-assignment",
    capabilitySnapshot: {
      contractVersion: 1,
      snapshotId: "snapshot-task-progress-plan-v1",
      revision: 1,
      capturedAt: "2026-07-19T12:03:30.000Z",
      bindings: [{
        bindingId: BINDING_ID,
        availability: "eligible",
        capabilityRevision: "capability-task-progress-implementer-v1",
        capabilities: [
          { name: "workspace_write", state: "verified" },
          { name: "source_read", state: "verified" },
        ],
      }],
    } satisfies RoomCapabilitySnapshotInputV1,
    constraints: {
      locks: [{ roleId: "implementer", bindingId: BINDING_ID }],
      forbids: [],
    },
    now: "2026-07-19T12:03:30.000Z",
  }, commandContext("activate-plan-assignment", "2026-07-19T12:03:30.000Z"));

  await layer.db.insert(roomTurns).values({
    id: TURN_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    sequence: 1,
    protocolPhaseId: PHASE_ID,
    membershipVersion: 0,
    state: "running",
    startedAt: "2026-07-19T12:04:00.000Z",
    endedAt: null,
  });
  await layer.db
    .update(operationalRooms)
    .set({ activeTurnId: TURN_ID, updatedAt: "2026-07-19T12:04:00.000Z" })
    .where(and(
      eq(operationalRooms.projectId, PROJECT_ID),
      eq(operationalRooms.id, ROOM_ID),
    ));

  const acquired = await leaseStore.acquireLease({
    leaseId: "lease-task-progress-worker-a",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_A_ID,
    hostId: HOST_A_ID,
    expectedEpoch: null,
    now: "2026-07-19T12:04:30.000Z",
    expiresAt: "2026-07-19T12:30:00.000Z",
  });
  if (!acquired.ok) throw new Error("Task-progress fixture must acquire its initial Room worker lease");

  const preDispatchRoom = await store.getRoom(ROOM_ID);
  const preDispatchGraph = await store.getTaskGraph(ROOM_ID);
  const target = preDispatchGraph?.nodes.find((node) => node.id === TARGET_NODE_ID);
  if (!preDispatchRoom || !preDispatchGraph || !target) {
    throw new Error("Task-progress fixture must retain its Room and target node before dispatch");
  }
  const content = "Run the target task and retain its durable recovery lineage.";
  const dispatchInput: ClaimReadyRoomTaskDispatchInputV1 = {
    roomId: ROOM_ID,
    nodeId: TARGET_NODE_ID,
    expectedAggregateVersion: preDispatchRoom.room.aggregateVersion,
    expectedDagVersion: preDispatchGraph.dagVersion,
    expectedNodeVersion: target.nodeVersion,
    owner: { seatId: SEAT_ID, bindingId: BINDING_ID },
    roleAssignment: {
      assignmentId: roleAssignment.id,
      revision: roleAssignment.revision,
      phaseId: roleAssignment.phaseId,
    },
    roomWorkerFence: workerFence(acquired.lease),
    idempotencyKey: "dispatch-task-progress-target",
    commandId: "command-dispatch-task-progress-target",
    correlationId: "correlation-dispatch-task-progress-target",
    issuedAt: "2026-07-19T12:05:00.000Z",
    authority: dispatchAuthority(),
    message: {
      intent: "instruction",
      content,
      contentHash: hashRoomValue(content),
    },
  };
  const dispatch = await store.claimReadyTaskDispatch(dispatchInput);
  expect(dispatch).toMatchObject({
    nodeId: TARGET_NODE_ID,
    ownerSeatId: SEAT_ID,
    ownerBindingId: BINDING_ID,
    replayed: false,
  });

  return {
    layer,
    store,
    leaseStore,
    roomId: ROOM_ID,
    turnId: TURN_ID,
    roleAssignment,
    originalWorkerLease: acquired.lease,
    targetNodeId: TARGET_NODE_ID,
    independentNodeId: options.includeIndependentNode ? INDEPENDENT_NODE_ID : null,
  };
}

async function buildProgressRoundInput(
  fixture: RecoveryFixture,
  input: ProgressRoundInput,
): Promise<RecordRoomTaskProgressObservationInputV1> {
  const [room, graph] = await Promise.all([
    fixture.store.getRoom(fixture.roomId),
    fixture.store.getTaskGraph(fixture.roomId),
  ]);
  const node = graph?.nodes.find((candidate) => candidate.id === fixture.targetNodeId);
  if (!room || !graph || !node) {
    throw new Error("Task-progress fixture must retain a current Room graph target");
  }
  expect(room.activeTurnId).toBe(fixture.turnId);
  expect(node.state).toBe("running");
  return {
    roomId: fixture.roomId,
    roomWorkerFence: workerFence(fixture.originalWorkerLease),
    expectedAggregateVersion: room.room.aggregateVersion,
    expectedDagVersion: graph.dagVersion,
    nodeId: fixture.targetNodeId,
    expectedNodeVersion: node.nodeVersion,
    turnId: fixture.turnId,
    phaseId: PHASE_ID,
    roundId: input.roundId,
    idempotencyKey: input.idempotencyKey,
    signals: input.signals,
    origin: {
      contractVersion: "room-task-progress-observation-origin/v1",
      sourceKind: "recovery_worker",
      sourceRef: `controller:${WORKER_A_ID}:round:${input.roundId}`,
    },
    observedAt: input.observedAt,
  };
}

async function recordProgressRound(
  fixture: RecoveryFixture,
  input: ProgressRoundInput,
) {
  return fixture.store.recordRoomTaskProgressObservation(
    await buildProgressRoundInput(fixture, input),
  );
}

async function enqueueNoProgressRecoveryAction(
  fixture: RecoveryFixture,
  signals: RoomTaskProgressSignalHashesV1,
  prefix: string,
): Promise<RoomTaskRecoveryActionV1> {
  const first = await recordProgressRound(fixture, {
    roundId: `${prefix}-round-1`,
    idempotencyKey: `${prefix}:round-1`,
    signals,
    observedAt: "2026-07-19T12:07:00.000Z",
  });
  expect(first.decision).toEqual({ kind: "below_threshold", consecutiveUnchangedRounds: 1 });

  const second = await recordProgressRound(fixture, {
    roundId: `${prefix}-round-2`,
    idempotencyKey: `${prefix}:round-2`,
    signals,
    observedAt: "2026-07-19T12:08:00.000Z",
  });
  expect(second.decision).toMatchObject({
    kind: "action_enqueued",
    consecutiveUnchangedRounds: 2,
    action: {
      nodeId: fixture.targetNodeId,
      state: "pending",
      actionId: "replace_stalled_implementer",
      actionSnapshot: {
        turnId: fixture.turnId,
        phaseId: PHASE_ID,
        executionMode: "operator_approval",
      },
    },
  });
  if (second.decision.kind !== "action_enqueued") {
    throw new Error("Two unchanged progress rounds must enqueue the declared recovery action");
  }
  return second.decision.action;
}

async function claimRecoveryAction(
  fixture: RecoveryFixture,
  lease: StoredRoomLeaseV1,
  now: string,
  claimTtlMs = 1_000,
): Promise<RoomTaskRecoveryActionV1> {
  const action = await fixture.store.claimNextRoomTaskRecoveryAction({
    roomId: fixture.roomId,
    roomWorkerFence: workerFence(lease),
    workerId: lease.holderId,
    now,
    claimTtlMs,
  });
  if (!action) throw new Error("Expected a due Room task recovery action");
  return action;
}

function claimToken(action: RoomTaskRecoveryActionV1): string {
  if (!action.claimToken) throw new Error(`Recovery action ${action.id} must be claimed`);
  return action.claimToken;
}

describe.sequential("Task 5.8 fenced task-progress recovery", () => {
  it("enqueues only after two unchanged vectors and resets when one signal hash changes", async () => {
    const fixture = await createRecoveryFixture();
    const original = progressSignals("original-vector");
    const changed = {
      ...original,
      testHash: hashRoomValue({ signal: "test", label: "changed-vector" }),
    } satisfies RoomTaskProgressSignalHashesV1;

    const first = await recordProgressRound(fixture, {
      roundId: "vector-round-1",
      idempotencyKey: "vector:round-1",
      signals: original,
      observedAt: "2026-07-19T12:07:00.000Z",
    });
    expect(first).toMatchObject({
      replayed: false,
      event: { eventType: "room_task_progress_observed" },
      decision: { kind: "below_threshold", consecutiveUnchangedRounds: 1 },
    });

    const reset = await recordProgressRound(fixture, {
      roundId: "vector-round-2",
      idempotencyKey: "vector:round-2",
      signals: changed,
      observedAt: "2026-07-19T12:08:00.000Z",
    });
    expect(reset).toMatchObject({
      event: { eventType: "room_task_progress_observed" },
      decision: { kind: "below_threshold", consecutiveUnchangedRounds: 1 },
    });

    const queued = await recordProgressRound(fixture, {
      roundId: "vector-round-3",
      idempotencyKey: "vector:round-3",
      signals: changed,
      observedAt: "2026-07-19T12:09:00.000Z",
    });
    expect(queued).toMatchObject({
      event: { eventType: "room_task_recovery_action_enqueued" },
      decision: {
        kind: "action_enqueued",
        consecutiveUnchangedRounds: 2,
        action: { actionId: "replace_stalled_implementer", state: "pending" },
      },
    });
    expect((await fixture.store.getTaskProgressRecoveryProjection(fixture.roomId))).toMatchObject({
      observations: [{ roundId: "vector-round-1" }, { roundId: "vector-round-2" }, { roundId: "vector-round-3" }],
      actions: [expect.objectContaining({ actionId: "replace_stalled_implementer", state: "pending" })],
    });
  });

  it("replays an exact observation idempotently and rejects changed-key reuse plus a duplicate round", async () => {
    const fixture = await createRecoveryFixture();
    const originalInput = await buildProgressRoundInput(fixture, {
      roundId: "idempotency-round-1",
      idempotencyKey: "idempotency:round-1",
      signals: progressSignals("idempotency-vector"),
      observedAt: "2026-07-19T12:07:00.000Z",
    });

    const first = await fixture.store.recordRoomTaskProgressObservation(originalInput);
    const replay = await fixture.store.recordRoomTaskProgressObservation(originalInput);
    expect(replay).toMatchObject({
      replayed: true,
      observation: { id: first.observation.id, roundId: "idempotency-round-1" },
      event: { id: first.event.id, eventType: "room_task_progress_observed" },
    });

    await expect(fixture.store.recordRoomTaskProgressObservation({
      ...originalInput,
      signals: progressSignals("idempotency-different-vector"),
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    await expect(recordProgressRound(fixture, {
      roundId: "idempotency-round-1",
      idempotencyKey: "idempotency:duplicate-round",
      signals: originalInput.signals,
      observedAt: "2026-07-19T12:08:00.000Z",
    })).rejects.toMatchObject({ code: "task_progress_observation_conflict" });
  });

  it("lets a replacement worker reclaim an expired action and rejects the stale worker completion", async () => {
    const fixture = await createRecoveryFixture();
    const action = await enqueueNoProgressRecoveryAction(
      fixture,
      progressSignals("takeover-vector"),
      "takeover",
    );
    const originalClaim = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    expect(originalClaim).toMatchObject({ id: action.id, state: "claimed", attemptCount: 1 });

    const takeover = await fixture.leaseStore.acquireLease({
      leaseId: "lease-task-progress-worker-b",
      roomId: fixture.roomId,
      kind: "room_worker",
      resourceId: fixture.roomId,
      holderId: WORKER_B_ID,
      hostId: HOST_B_ID,
      expectedEpoch: fixture.originalWorkerLease.epoch,
      now: "2026-07-19T12:31:00.000Z",
      expiresAt: "2026-07-19T12:45:00.000Z",
    });
    expect(takeover).toMatchObject({ ok: true, action: "taken_over", lease: { epoch: 2 } });
    if (!takeover.ok) throw new Error("Replacement worker must take over the expired Room lease");

    const replacementClaim = await claimRecoveryAction(
      fixture,
      takeover.lease,
      "2026-07-19T12:31:01.000Z",
    );
    expect(replacementClaim).toMatchObject({
      id: action.id,
      state: "claimed",
      attemptCount: 2,
      claimedByWorkerId: WORKER_B_ID,
    });

    await expect(fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(originalClaim),
      idempotencyKey: "takeover:stale-completion",
      outcome: "processed",
      resultPayload: recoveryReceipt(),
      errorCode: null,
      now: "2026-07-19T12:31:02.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });

    expect((await fixture.store.getTaskProgressRecoveryProjection(fixture.roomId)).actions).toEqual([
      expect.objectContaining({
        id: action.id,
        state: "claimed",
        attemptCount: 2,
        claimedByWorkerId: WORKER_B_ID,
        claimToken: claimToken(replacementClaim),
      }),
    ]);
  });

  it("honors retry eligibility and marks processed only with a verifiable durable receipt", async () => {
    const fixture = await createRecoveryFixture();
    const action = await enqueueNoProgressRecoveryAction(
      fixture,
      progressSignals("retry-vector"),
      "retry",
    );
    const initialClaim = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    const retried = await fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(initialClaim),
      idempotencyKey: "retry:release-initial-claim",
      outcome: "retry",
      resultPayload: null,
      errorCode: "room_task_recovery_action_consumer_unconfigured",
      retryAt: "2026-07-19T12:10:00.000Z",
      now: "2026-07-19T12:09:01.000Z",
    });
    expect(retried).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextEligibleAt: "2026-07-19T12:10:00.000Z",
      lastErrorCode: "room_task_recovery_action_consumer_unconfigured",
    });

    await expect(fixture.store.claimNextRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      workerId: WORKER_A_ID,
      now: "2026-07-19T12:09:59.000Z",
      claimTtlMs: 1_000,
    })).resolves.toBeNull();

    const retryClaim = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:10:00.000Z",
    );
    expect(retryClaim).toMatchObject({ id: action.id, state: "claimed", attemptCount: 2 });
    const invalidReceipt = {
      ...recoveryReceipt(),
      resultHash: "0".repeat(64),
    } satisfies RoomTaskRecoveryActionResultV1;
    await expect(fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(retryClaim),
      idempotencyKey: "retry:invalid-receipt",
      outcome: "processed",
      resultPayload: invalidReceipt,
      errorCode: null,
      now: "2026-07-19T12:10:01.000Z",
    })).rejects.toMatchObject({ code: "task_recovery_action_invalid" });

    const processed = await fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(retryClaim),
      idempotencyKey: "retry:processed-completion",
      outcome: "processed",
      resultPayload: recoveryReceipt(),
      errorCode: null,
      now: "2026-07-19T12:10:02.000Z",
    });
    expect(processed).toMatchObject({
      state: "processed",
      attemptCount: 2,
      claimToken: null,
      resultPayload: recoveryReceipt(),
      processedAt: "2026-07-19T12:10:02.000Z",
    });
  });

  it("replays an exact completion without a second immutable event and rejects changed outcome or receipt", async () => {
    const fixture = await createRecoveryFixture();
    const action = await enqueueNoProgressRecoveryAction(
      fixture,
      progressSignals("completion-idempotency-vector"),
      "completion-idempotency",
    );
    const claimed = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    const completionInput = {
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: "completion-idempotency:processed",
      outcome: "processed",
      resultPayload: recoveryReceipt(),
      errorCode: null,
      now: "2026-07-19T12:09:01.000Z",
    } satisfies CompleteRoomTaskRecoveryActionInputV1;
    const completionEventsBefore = (await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_action_completed",
    );

    const completed = await fixture.store.completeRoomTaskRecoveryAction(completionInput);
    const completionEventsAfterFirst = (await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_action_completed",
    );
    const replayed = await fixture.store.completeRoomTaskRecoveryAction(completionInput);
    const completionEventsAfterReplay = (await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_action_completed",
    );
    expect(replayed).toEqual(completed);
    expect(completionEventsAfterFirst).toHaveLength(completionEventsBefore.length + 1);
    expect(completionEventsAfterReplay).toEqual(completionEventsAfterFirst);

    const changedReceiptRef = "recovery-receipt:operator_approval_requested:changed";
    const changedReceipt: RoomTaskRecoveryActionResultV1 = {
      contractVersion: "room-task-recovery-action-result/v1",
      kind: "operator_approval_requested",
      receiptRef: changedReceiptRef,
      resultHash: hashRoomValue({
        contractVersion: "room-task-recovery-action-result/v1",
        kind: "operator_approval_requested",
        receiptRef: changedReceiptRef,
      }),
    };
    await expect(fixture.store.completeRoomTaskRecoveryAction({
      ...completionInput,
      resultPayload: changedReceipt,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(fixture.store.completeRoomTaskRecoveryAction({
      ...completionInput,
      outcome: "retry",
      resultPayload: null,
      errorCode: "room_task_recovery_action_consumer_unconfigured",
      retryAt: "2026-07-19T12:10:00.000Z",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await fixture.store.getTaskProgressRecoveryProjection(fixture.roomId)).actions).toEqual([
      completed,
    ]);
    expect((await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_action_completed",
    )).toEqual(completionEventsAfterFirst);
  });

  it("records one immutable controller handoff before acknowledging the claimed action", async () => {
    const fixture = await createRecoveryFixture();
    const action = await enqueueNoProgressRecoveryAction(
      fixture,
      progressSignals("durable-plan-vector"),
      "durable-plan",
    );
    const claimed = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    const planInput = {
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      recoveryActionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: `room-task-recovery-plan:${action.id}`,
      now: "2026-07-19T12:09:01.000Z",
    } satisfies RecordRoomTaskRecoveryPlanInputV1;
    const planEventsBefore = (await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_plan_recorded",
    );

    const plan = await fixture.store.recordRoomTaskRecoveryPlan(planInput);
    const replayedPlan = await fixture.store.recordRoomTaskRecoveryPlan(planInput);
    const planEventsAfterReplay = (await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "room_task_recovery_plan_recorded",
    );
    expect(plan).toMatchObject({
      id: `room-task-recovery-plan:${action.id}`,
      roomId: fixture.roomId,
      recoveryActionId: action.id,
      executionMode: "operator_approval",
      actionSnapshotHash: hashRoomValue(claimed.actionSnapshot),
      resultReceipt: {
        kind: "operator_approval_requested",
        receiptRef: `room-task-recovery-plan:${action.id}`,
      },
    });
    expect(replayedPlan).toEqual(plan);
    expect(planEventsAfterReplay).toHaveLength(planEventsBefore.length + 1);
    expect(await fixture.store.getRoomTaskRecoveryPlans(fixture.roomId)).toEqual([plan]);

    const forgedReceiptRef = `${plan.resultReceipt.receiptRef}:forged`;
    const forgedReceipt: RoomTaskRecoveryActionResultV1 = {
      contractVersion: "room-task-recovery-action-result/v1",
      kind: plan.resultReceipt.kind,
      receiptRef: forgedReceiptRef,
      resultHash: hashRoomValue({
        contractVersion: "room-task-recovery-action-result/v1",
        kind: plan.resultReceipt.kind,
        receiptRef: forgedReceiptRef,
      }),
    };
    await expect(fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: "durable-plan:forged-completion",
      outcome: "processed",
      resultPayload: forgedReceipt,
      errorCode: null,
      now: "2026-07-19T12:09:02.000Z",
    })).rejects.toMatchObject({ code: "task_recovery_action_invalid" });

    const completed = await fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: "durable-plan:completion",
      outcome: "processed",
      resultPayload: plan.resultReceipt,
      errorCode: null,
      now: "2026-07-19T12:09:03.000Z",
    });
    expect(completed).toMatchObject({ state: "processed", resultPayload: plan.resultReceipt });

    const events = await fixture.store.listEvents(fixture.roomId);
    const replay = rebuildRoomTaskProgressRecoveryProjectionFromEvents(events);
    expect(replay.plans).toEqual([plan]);
    expect(replay.actions).toEqual([completed]);
    expect(rebuildRoomProjectionFromEvents(events).room.aggregateVersion).toBe(
      (await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion,
    );
  });

  it("blocks only the exhausted target node and leaves an independent ready branch runnable", async () => {
    const fixture = await createRecoveryFixture({ includeIndependentNode: true });
    const signals = progressSignals("exhaustion-vector");
    const action = await enqueueNoProgressRecoveryAction(fixture, signals, "exhaustion");
    const claimed = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    await fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: "exhaustion:processed-completion",
      outcome: "processed",
      resultPayload: recoveryReceipt(),
      errorCode: null,
      now: "2026-07-19T12:09:01.000Z",
    });

    const exhausted = await recordProgressRound(fixture, {
      roundId: "exhaustion-round-3",
      idempotencyKey: "exhaustion:round-3",
      signals,
      observedAt: "2026-07-19T12:10:00.000Z",
    });
    expect(exhausted).toMatchObject({
      event: { eventType: "room_task_recovery_ladder_exhausted" },
      decision: {
        kind: "exhausted",
        consecutiveUnchangedRounds: 3,
        exhaustedGateIds: ["implementation_blocked"],
      },
    });

    const graph = await fixture.store.getTaskGraph(fixture.roomId);
    expect(graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.targetNodeId, state: "blocked", nodeVersion: 2 }),
      expect.objectContaining({ id: fixture.independentNodeId, state: "ready", nodeVersion: 0 }),
    ]));
  });

  it("replays the immutable recovery ledger through the main Room projection validator", async () => {
    const fixture = await createRecoveryFixture();
    const signals = progressSignals("ledger-vector");
    const action = await enqueueNoProgressRecoveryAction(fixture, signals, "ledger");
    const claimed = await claimRecoveryAction(
      fixture,
      fixture.originalWorkerLease,
      "2026-07-19T12:09:00.000Z",
    );
    await fixture.store.completeRoomTaskRecoveryAction({
      roomId: fixture.roomId,
      roomWorkerFence: workerFence(fixture.originalWorkerLease),
      actionId: action.id,
      claimToken: claimToken(claimed),
      idempotencyKey: "ledger:processed-completion",
      outcome: "processed",
      resultPayload: recoveryReceipt(),
      errorCode: null,
      now: "2026-07-19T12:09:01.000Z",
    });
    await recordProgressRound(fixture, {
      roundId: "ledger-round-3",
      idempotencyKey: "ledger:round-3",
      signals,
      observedAt: "2026-07-19T12:10:00.000Z",
    });

    const [events, liveRoom] = await Promise.all([
      fixture.store.listEvents(fixture.roomId),
      fixture.store.getRoom(fixture.roomId),
    ]);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "room_task_progress_observed",
      "room_task_recovery_action_enqueued",
      "room_task_recovery_action_claimed",
      "room_task_recovery_action_completed",
      "room_task_recovery_ladder_exhausted",
    ]));
    const replayed = rebuildRoomProjectionFromEvents(events);
    expect(replayed.room).toMatchObject({
      id: fixture.roomId,
      state: "running",
      aggregateVersion: liveRoom?.room.aggregateVersion,
    });

    const exhaustionEvent = events.find(
      (event) => event.eventType === "room_task_recovery_ladder_exhausted",
    );
    expect(exhaustionEvent).toMatchObject({
      payload: expect.objectContaining({
        projectionVersion: 1,
        snapshot: expect.objectContaining({
          contractVersion: "room-task-progress-observation-snapshot/v1",
          decision: expect.objectContaining({ kind: "exhausted" }),
        }),
        taskGraphProjectionHash: expect.any(String),
      }),
    });
  });
});
