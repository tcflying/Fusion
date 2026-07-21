import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import {
  AsyncRoomStore,
  type RoomCommandContext,
  type RoomSemanticStateProjectionV1,
  type RoomTaskNodeDefinitionV1,
} from "../../async-room-store.js";
import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomMessageTargets,
  roomMessages,
  roomOutbox,
  roomProtocolMessages,
  roomSeats,
  roomSemanticControllerInbox,
  roomSemanticLoopBreaks,
  roomSemanticStates,
  roomTurns,
} from "../../postgres/schema/room.js";
import type { RoomCapabilitySnapshotInputV1, RoomRoleAssignmentConstraintsV1 } from "../../room-contracts/assignment.js";
import type { RoomAuthorityEnvelopeV1 } from "../../room-contracts/controller.js";
import {
  ROOM_PROTOCOL_MESSAGE_VERSION,
  type RoomProtocolMessageV1,
} from "../../room-contracts/protocol-message.js";
import { hashRoomValue } from "../../room-integrity.js";
import { getRoomProtocolDefinition } from "../../room-protocol-definitions.js";
import {
  applyRoomProjectionEvents,
  extractRoomSemanticRouteEventSnapshot,
  rebuildRoomSemanticControllerInboxProjectionFromEvents,
} from "../../room-projection-replay.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface SemanticFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly workerLease: StoredRoomLeaseV1;
  readonly semanticState: RoomSemanticStateProjectionV1;
}

const PROJECT_ID = "project-room-semantic-routing";
const ROOM_ID = "room-semantic-routing";
const NODE_ID = "node-semantic-routing";
const ANALYST_SEAT_ID = "seat-semantic-analyst";
const ANALYST_BINDING_ID = "binding-semantic-analyst";
const SECOND_ANALYST_SEAT_ID = "seat-semantic-analyst-secondary";
const SECOND_ANALYST_BINDING_ID = "binding-semantic-analyst-secondary";
const VERIFIER_SEAT_ID = "seat-semantic-verifier";
const VERIFIER_BINDING_ID = "binding-semantic-verifier";
const BOUNDARY_TURN_ID = "turn-semantic-propose";
const ACTIVE_TURN_ID = "turn-semantic-challenge";
const HOST_ID = "windows-host-semantic-routing";
const SEMANTIC_HASH = hashRoomValue({ semantic: "stable" });
const EVIDENCE_HASH = hashRoomValue({ evidence: "stable" });
const DECISION_HASH = hashRoomValue({ decision: "stable" });

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

function controllerContext(label: string, occurredAt: string): RoomCommandContext {
  return {
    eventId: `event-semantic-${label}`,
    actorType: "controller",
    actorId: "room-controller-semantic-test",
    correlationId: `correlation-semantic-${label}`,
    causationId: null,
    occurredAt,
  };
}

function capabilitySnapshot(revision: number): RoomCapabilitySnapshotInputV1 {
  return {
    contractVersion: 1,
    snapshotId: `snapshot-semantic-routing-r${revision}`,
    revision,
    capturedAt: `2026-07-19T12:0${revision}:00.000Z`,
    bindings: [
      {
        bindingId: ANALYST_BINDING_ID,
        availability: "eligible",
        capabilityRevision: `semantic-analyst-r${revision}`,
        capabilities: [
          { name: "analysis", state: "verified" },
          { name: "source_read", state: "verified" },
        ],
      },
      {
        bindingId: VERIFIER_BINDING_ID,
        availability: "eligible",
        capabilityRevision: `semantic-verifier-r${revision}`,
        capabilities: [
          { name: "evidence_review", state: "verified" },
          { name: "source_read", state: "verified" },
        ],
      },
      {
        bindingId: SECOND_ANALYST_BINDING_ID,
        availability: "eligible",
        capabilityRevision: `semantic-secondary-analyst-r${revision}`,
        capabilities: [
          { name: "analysis", state: "verified" },
          { name: "source_read", state: "verified" },
        ],
      },
    ],
  };
}

function constraints(): RoomRoleAssignmentConstraintsV1 {
  return {
    locks: [],
    forbids: [],
  };
}

function semanticTaskNode(): RoomTaskNodeDefinitionV1 {
  return {
    id: NODE_ID,
    parentNodeId: null,
    objective: "Route a challenge through the durable semantic protocol ledger",
    assignedSeatIds: [ANALYST_SEAT_ID, SECOND_ANALYST_SEAT_ID, VERIFIER_SEAT_ID],
    inputRefs: ["brief:semantic-routing"],
    outputRefs: ["decision:semantic-routing"],
    roleRequirements: ["analyst", "decision_verifier"],
    capabilityRequirements: ["source_read"],
    resourceHints: {
      estimatedDurationMs: 1_000,
      concurrencyClass: "parallel",
      preferredProviderIds: ["codex", "claude"],
    },
    authorityScope: {
      allowedActions: ["room:message:route"],
      readPaths: ["docs"],
      writePaths: [],
    },
    acceptanceGateIds: ["gate:semantic-routing"],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "exponential",
      baseDelayMs: 1_000,
      recoveryActions: ["replan"],
    },
    progressSignature: "progress:semantic-routing:challenge",
  };
}

function verifierAuthority(): RoomAuthorityEnvelopeV1 {
  return {
    actorType: "seat",
    actorId: VERIFIER_SEAT_ID,
    deviceId: null,
    role: "decision_verifier",
    allowedActions: ["room:message:route"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [NODE_ID],
    seatIds: [ANALYST_SEAT_ID, VERIFIER_SEAT_ID],
    evidenceRefs: ["evidence:semantic-routing"],
  };
}

function challengeMessage(messageId: string): RoomProtocolMessageV1 {
  // Fresh transport IDs must not disguise identical semantic output as progress.
  const content = "Challenge the unproven assumption.";
  return {
    contractVersion: ROOM_PROTOCOL_MESSAGE_VERSION,
    messageId,
    issuedAt: "2026-07-19T12:07:00.000Z",
    protocolId: "analysis-decision",
    protocolVersion: 1,
    phaseId: "challenge",
    channelId: "challenge",
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    turnId: ACTIVE_TURN_ID,
    nodeId: NODE_ID,
    origin: {
      seatId: VERIFIER_SEAT_ID,
      bindingId: VERIFIER_BINDING_ID,
      roleId: "decision_verifier",
    },
    target: { kind: "seats", seatIds: [ANALYST_SEAT_ID] },
    intent: "challenge",
    content,
    contentHash: hashRoomValue(content),
    semanticHash: SEMANTIC_HASH,
    evidenceStateHash: EVIDENCE_HASH,
    decisionStateHash: DECISION_HASH,
    authority: verifierAuthority(),
    references: {
      evidenceRefs: ["evidence:semantic-routing"],
      parentMessageIds: [],
      resolutionRefs: [],
    },
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-semantic-routing-"));
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
  if (!sharedLayer) throw new Error("Semantic-routing PostgreSQL fixture was not started");
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

async function createSemanticFixture(): Promise<SemanticFixture> {
  if (!sharedLayer) throw new Error("Semantic-routing PostgreSQL fixture was not started");
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, {
    currentTime: () => "2026-07-19T12:10:00.000Z",
  });
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const created = await store.createRoom({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist protocol-routed collaboration without loop storms",
    protocolId: "analysis-decision",
    protocolVersion: 1,
    now: "2026-07-19T12:00:00.000Z",
  }, controllerContext("created", "2026-07-19T12:00:00.000Z"));

  await layer.db.insert(roomSeats).values([
    {
      id: ANALYST_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "analyst",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: ANALYST_BINDING_ID,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
    },
    {
      id: SECOND_ANALYST_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "analyst",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: SECOND_ANALYST_BINDING_ID,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
    },
    {
      id: VERIFIER_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "decision_verifier",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: VERIFIER_BINDING_ID,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
    },
  ]);
  await layer.db.insert(roomBindings).values([
    {
      id: ANALYST_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: ANALYST_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "native-semantic-analyst",
      happierSessionId: "happier-semantic-analyst",
      serverProfileId: "server-semantic",
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: "2026-07-19T12:00:00.000Z",
    },
    {
      id: VERIFIER_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: VERIFIER_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: "native-semantic-verifier",
      happierSessionId: "happier-semantic-verifier",
      serverProfileId: "server-semantic",
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: "2026-07-19T12:00:00.000Z",
    },
    {
      id: SECOND_ANALYST_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: SECOND_ANALYST_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "opencode",
      nativeSessionId: "native-semantic-analyst-secondary",
      happierSessionId: "happier-semantic-analyst-secondary",
      serverProfileId: "server-semantic",
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: "2026-07-19T12:00:00.000Z",
    },
  ]);

  const ready = await store.transitionLifecycle(ROOM_ID, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: "2026-07-19T12:01:00.000Z",
  }, controllerContext("ready", "2026-07-19T12:01:00.000Z"));
  const running = await store.transitionLifecycle(ROOM_ID, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: "2026-07-19T12:02:00.000Z",
  }, controllerContext("running", "2026-07-19T12:02:00.000Z"));
  const graph = await store.mutateTaskGraph({
    roomId: ROOM_ID,
    expectedAggregateVersion: running.room.aggregateVersion,
    expectedDagVersion: 0,
    idempotencyKey: "seed-semantic-routing-node",
    mutations: [{ action: "add_node", node: semanticTaskNode() }],
    mutatedAt: "2026-07-19T12:03:00.000Z",
  }, controllerContext("seed-node", "2026-07-19T12:03:00.000Z"));
  await store.activateRoomRoleAssignment({
    roomId: ROOM_ID,
    expectedAggregateVersion: graph.aggregateVersion,
    idempotencyKey: "activate-semantic-propose-roles",
    capabilitySnapshot: capabilitySnapshot(1),
    constraints: constraints(),
    now: "2026-07-19T12:03:01.000Z",
  }, controllerContext("activate-propose-roles", "2026-07-19T12:03:01.000Z"));

  await layer.db.insert(roomTurns).values({
    id: BOUNDARY_TURN_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    sequence: 1,
    protocolPhaseId: "propose",
    membershipVersion: 0,
    state: "completed",
    startedAt: "2026-07-19T12:03:02.000Z",
    endedAt: "2026-07-19T12:03:03.000Z",
  });
  const beforeTransition = await store.getRoom(ROOM_ID);
  if (!beforeTransition) throw new Error("Room must exist before semantic phase transition");
  const activeAssignment = await store.getActiveRoomRoleAssignment(ROOM_ID);
  if (!activeAssignment) throw new Error("Semantic fixture must have an active role assignment");
  const protocol = getRoomProtocolDefinition("analysis-decision", 1);
  if (!protocol) throw new Error("Analysis-decision protocol must exist");
  const phaseGateEvidence = await store.recordRoomPhaseGateEvidence({
    roomId: ROOM_ID,
    expectedAggregateVersion: beforeTransition.room.aggregateVersion,
    idempotencyKey: "record-semantic-proposals-ready-evidence",
    evidence: {
      contractVersion: 1,
      id: "phase-gate-evidence-semantic-proposals-ready",
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      protocolHash: hashRoomValue(protocol),
      gateId: "proposals_ready",
      phaseId: "propose",
      turnId: BOUNDARY_TURN_ID,
      candidateId: "candidate-semantic-proposals-ready",
      candidateHash: hashRoomValue("candidate-semantic-proposals-ready"),
      source: {
        recordId: "source-semantic-proposals-ready",
        sourceHash: hashRoomValue("source-semantic-proposals-ready"),
        recordedAt: "2026-07-19T12:03:03.500Z",
      },
      verdict: "passed",
      evaluatorBindingId: VERIFIER_BINDING_ID,
      producerBindingIds: activeAssignment.authoritativeProducerBindingIds,
      operatorApproval: null,
    },
    now: "2026-07-19T12:03:03.500Z",
  }, controllerContext("record-proposals-ready", "2026-07-19T12:03:03.500Z"));
  const afterEvidence = await store.getRoom(ROOM_ID);
  if (!afterEvidence) throw new Error("Room must exist after semantic phase-gate evidence");
  await store.transitionRoomRoleAssignment({
    roomId: ROOM_ID,
    expectedAggregateVersion: afterEvidence.room.aggregateVersion,
    boundaryTurnId: BOUNDARY_TURN_ID,
    targetPhaseId: "challenge",
    phaseGateEvidenceId: phaseGateEvidence.id,
    idempotencyKey: "transition-semantic-challenge-roles",
    capabilitySnapshot: capabilitySnapshot(2),
    constraints: constraints(),
    now: "2026-07-19T12:03:04.000Z",
  }, controllerContext("transition-challenge-roles", "2026-07-19T12:03:04.000Z"));

  await layer.db.insert(roomTurns).values({
    id: ACTIVE_TURN_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    sequence: 2,
    protocolPhaseId: "challenge",
    membershipVersion: 0,
    state: "running",
    startedAt: "2026-07-19T12:04:00.000Z",
    endedAt: null,
  });
  await layer.db.update(operationalRooms)
    .set({ activeTurnId: ACTIVE_TURN_ID, updatedAt: "2026-07-19T12:04:00.000Z" })
    .where(eq(operationalRooms.id, ROOM_ID));

  const acquired = await leaseStore.acquireLease({
    leaseId: "lease-semantic-routing-worker",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: "room-controller-semantic-test",
    hostId: HOST_ID,
    expectedEpoch: null,
    now: "2026-07-19T12:04:30.000Z",
    expiresAt: "2026-07-19T12:30:00.000Z",
  });
  if (!acquired.ok) throw new Error("Semantic-routing fixture must acquire a Room worker lease");

  const beforeState = await store.getRoom(ROOM_ID);
  if (!beforeState) throw new Error("Room must exist before semantic state setup");
  const semanticState = await store.setRoomSemanticState({
    roomId: ROOM_ID,
    turnId: ACTIVE_TURN_ID,
    nodeId: NODE_ID,
    expectedAggregateVersion: beforeState.room.aggregateVersion,
    roomWorkerFence: workerFence(acquired.lease),
    idempotencyKey: "set-semantic-routing-state",
    semanticHash: SEMANTIC_HASH,
    evidenceStateHash: EVIDENCE_HASH,
    decisionStateHash: DECISION_HASH,
  }, controllerContext("set-state", "2026-07-19T12:05:00.000Z"));
  return { layer, store, leaseStore, workerLease: acquired.lease, semanticState };
}

function workerFence(lease: StoredRoomLeaseV1) {
  return {
    leaseId: lease.id,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

describe.sequential("AsyncRoomStore semantic protocol routing (Task 5.6)", () => {
  it("atomically persists a typed route, target, outbox, and idempotent event replay", async () => {
    const fixture = await createSemanticFixture();
    const beforeRoute = await fixture.store.getRoom(ROOM_ID);
    if (!beforeRoute) throw new Error("Room must exist before semantic route");
    const input = {
      roomId: ROOM_ID,
      expectedAggregateVersion: beforeRoute.room.aggregateVersion,
      idempotencyKey: "route-semantic-challenge-1",
      message: challengeMessage("protocol-message-challenge-1"),
    };

    const first = await fixture.store.routeRoomProtocolMessage(input);
    const replay = await fixture.store.routeRoomProtocolMessage(input);

    expect(first.replayed).toBe(false);
    expect(first.protocolMessage).toMatchObject({
      protocolMessageId: "protocol-message-challenge-1",
      issuedAt: "2026-07-19T12:07:00.000Z",
      target: { kind: "seats", seatIds: [ANALYST_SEAT_ID] },
      routeOutcome: "route",
      recipientSeatIds: [ANALYST_SEAT_ID],
    });
    expect(first.deliveries).toHaveLength(1);
    expect(first.deliveries[0]).toMatchObject({ bindingId: ANALYST_BINDING_ID, state: "pending" });
    expect(first.controllerAction).toBeNull();
    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomProtocolMessages)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomMessageTargets)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomSemanticControllerInbox)).toHaveLength(0);
    const stored = (await fixture.layer.db.select().from(roomProtocolMessages))[0];
    expect(stored).toMatchObject({
      issuedAt: "2026-07-19T12:07:00.000Z",
      protocolTarget: { kind: "seats", seatIds: [ANALYST_SEAT_ID] },
      semanticStateId: fixture.semanticState.id,
    });
    expect(extractRoomSemanticRouteEventSnapshot(first.event)).toMatchObject({
      sourceMessage: { id: first.message.id, content: first.message.content },
      protocolMessage: {
        protocolMessageId: first.protocolMessage.protocolMessageId,
        envelope: { references: first.protocolMessage.envelope.references },
      },
      targets: [{ id: first.targets[0]?.id }],
      deliveries: [{ id: first.deliveries[0]?.id }],
      controllerAction: null,
      loopBreak: null,
    });
    expect(applyRoomProjectionEvents(beforeRoute, [first.event])).toEqual(await fixture.store.getRoom(ROOM_ID));
  });

  it("rejects a semantic-state revision from a taken-over worker fence before it writes", async () => {
    const fixture = await createSemanticFixture();
    const before = await fixture.store.getRoom(ROOM_ID);
    if (!before) throw new Error("Room must exist before stale semantic-state test");
    const replacement = await fixture.leaseStore.acquireLease({
      leaseId: "lease-semantic-state-replacement",
      roomId: ROOM_ID,
      kind: "room_worker",
      resourceId: ROOM_ID,
      holderId: "room-controller-semantic-state-replacement",
      hostId: HOST_ID,
      expectedEpoch: fixture.workerLease.epoch,
      now: "2026-07-19T12:31:00.000Z",
      expiresAt: "2026-07-19T12:50:00.000Z",
    });
    if (!replacement.ok) throw new Error("Replacement worker must take over expired Room lease");

    await expect(fixture.store.setRoomSemanticState({
      roomId: ROOM_ID,
      turnId: ACTIVE_TURN_ID,
      nodeId: NODE_ID,
      expectedAggregateVersion: before.room.aggregateVersion,
      roomWorkerFence: workerFence(fixture.workerLease),
      idempotencyKey: "set-semantic-routing-state-stale-fence",
      semanticHash: hashRoomValue({ semantic: "stale-write" }),
      evidenceStateHash: hashRoomValue({ evidence: "stale-write" }),
      decisionStateHash: hashRoomValue({ decision: "stale-write" }),
    }, controllerContext("set-state-stale-fence", "2026-07-19T12:31:01.000Z"))).rejects.toMatchObject({
      code: "stale_lease_fence",
    });
    expect(await fixture.layer.db.select().from(roomSemanticStates)).toHaveLength(1);
    expect(await fixture.store.getRoom(ROOM_ID)).toEqual(before);
  });

  it("rejects a peer message whose authority loses the active target scope before it writes anything", async () => {
    const fixture = await createSemanticFixture();
    const before = await fixture.store.getRoom(ROOM_ID);
    if (!before) throw new Error("Room must exist before invalid semantic route");
    const message = challengeMessage("protocol-message-invalid-authority");
    const invalid = {
      ...message,
      authority: { ...message.authority, seatIds: [VERIFIER_SEAT_ID] },
    };

    await expect(fixture.store.routeRoomProtocolMessage({
      roomId: ROOM_ID,
      expectedAggregateVersion: before.room.aggregateVersion,
      idempotencyKey: "route-semantic-invalid-authority",
      message: invalid,
    })).rejects.toMatchObject({ code: "semantic_message_invalid" });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomProtocolMessages)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(0);
  });

  it("rate-limits repeated semantic loops to one durable escalation and reclaims it only under the current worker fence", async () => {
    const fixture = await createSemanticFixture();
    const firstRoom = await fixture.store.getRoom(ROOM_ID);
    if (!firstRoom) throw new Error("Room must exist before first semantic route");
    await fixture.store.routeRoomProtocolMessage({
      roomId: ROOM_ID,
      expectedAggregateVersion: firstRoom.room.aggregateVersion,
      idempotencyKey: "route-semantic-loop-first",
      message: challengeMessage("protocol-message-loop-1"),
    });
    const secondRoom = await fixture.store.getRoom(ROOM_ID);
    if (!secondRoom) throw new Error("Room must exist before loop route");
    const loop = await fixture.store.routeRoomProtocolMessage({
      roomId: ROOM_ID,
      expectedAggregateVersion: secondRoom.room.aggregateVersion,
      idempotencyKey: "route-semantic-loop-second",
      message: challengeMessage("protocol-message-loop-2"),
    });

    expect(loop.protocolMessage).toMatchObject({
      routeOutcome: "loop_break",
      target: { kind: "seats", seatIds: [ANALYST_SEAT_ID] },
      recipientController: true,
    });
    expect(loop.deliveries).toEqual([]);
    expect(loop.controllerAction).toMatchObject({ actionKind: "semantic_loop_break", state: "pending" });
    const thirdRoom = await fixture.store.getRoom(ROOM_ID);
    if (!thirdRoom) throw new Error("Room must exist before repeated loop route");
    const repeated = await fixture.store.routeRoomProtocolMessage({
      roomId: ROOM_ID,
      expectedAggregateVersion: thirdRoom.room.aggregateVersion,
      idempotencyKey: "route-semantic-loop-third",
      message: challengeMessage("protocol-message-loop-3"),
    });

    expect(repeated.controllerAction?.id).toBe(loop.controllerAction?.id);
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(4);
    expect(await fixture.layer.db.select().from(roomProtocolMessages)).toHaveLength(3);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomSemanticLoopBreaks)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomSemanticControllerInbox)).toHaveLength(1);

    const claimed = await fixture.store.claimNextRoomSemanticControllerAction({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(fixture.workerLease),
      workerId: fixture.workerLease.holderId,
      now: "2026-07-19T12:11:00.000Z",
    });
    if (!claimed) throw new Error("Loop escalation must enqueue one controller action");
    expect(claimed).toMatchObject({ id: loop.controllerAction?.id, state: "claimed", attemptCount: 1 });

    const replacement = await fixture.leaseStore.acquireLease({
      leaseId: "lease-semantic-routing-replacement",
      roomId: ROOM_ID,
      kind: "room_worker",
      resourceId: ROOM_ID,
      holderId: "room-controller-semantic-replacement",
      hostId: HOST_ID,
      expectedEpoch: fixture.workerLease.epoch,
      now: "2026-07-19T12:31:00.000Z",
      expiresAt: "2026-07-19T12:50:00.000Z",
    });
    if (!replacement.ok) throw new Error("Replacement worker must take over expired Room lease");
    await expect(fixture.store.completeRoomSemanticControllerAction({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(fixture.workerLease),
      actionId: claimed.id,
      claimToken: claimed.claimToken!,
      outcome: "processed",
      errorCode: null,
      now: "2026-07-19T12:31:01.000Z",
    })).rejects.toMatchObject({ code: "stale_lease_fence" });

    const reclaimed = await fixture.store.claimNextRoomSemanticControllerAction({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(replacement.lease),
      workerId: replacement.lease.holderId,
      now: "2026-07-19T12:31:01.000Z",
    });
    if (!reclaimed) throw new Error("Replacement worker must reclaim expired controller action");
    expect(reclaimed).toMatchObject({ id: claimed.id, state: "claimed", attemptCount: 2 });
    await fixture.store.completeRoomSemanticControllerAction({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(replacement.lease),
      actionId: reclaimed.id,
      claimToken: reclaimed.claimToken!,
      outcome: "processed",
      errorCode: null,
      now: "2026-07-19T12:31:02.000Z",
    });
    await expect(fixture.store.claimNextRoomSemanticControllerAction({
      roomId: ROOM_ID,
      roomWorkerFence: workerFence(replacement.lease),
      workerId: replacement.lease.holderId,
      now: "2026-07-19T12:31:03.000Z",
    })).resolves.toBeNull();

    // The third route intentionally references the single prior loop-break
    // action rather than minting a second escalation. Its immutable reference,
    // both claims, and the final completion must rebuild from the event ledger
    // alone even after the old worker fence has been superseded.
    const events = await fixture.store.listEvents(ROOM_ID);
    expect(rebuildRoomSemanticControllerInboxProjectionFromEvents(events)).toEqual([
      expect.objectContaining({
        id: claimed.id,
        state: "processed",
        attemptCount: 2,
        claimToken: null,
        processedAt: "2026-07-19T12:31:02.000Z",
      }),
    ]);
  });
});
