import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import {
  AsyncRoomStore,
  rebuildRoomTaskGraphProjectionFromEvents,
  type RoomCommittedEventListener,
  type RoomCommandContext,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeDefinitionV1,
} from "../../async-room-store.js";
import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  roomBindings,
  roomMessageTargets,
  roomMessages,
  roomOutbox,
  roomSeats,
  roomTurns,
} from "../../postgres/schema/room.js";
import type { RoomAuthorityEnvelopeV1, RoomMessageIntent } from "../../room-contracts/controller.js";
import type {
  RoomCapabilitySnapshotInputV1,
  RoomRoleAssignmentConstraintsV1,
  RoomRoleAssignmentV1,
} from "../../room-contracts/assignment.js";
import { hashRoomValue } from "../../room-integrity.js";
import { applyRoomProjectionEvents } from "../../room-projection-replay.js";
import { getRoomProtocolDefinition } from "../../room-protocol-definitions.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface ClaimReadyRoomTaskDispatchInputV1 {
  readonly roomId: string;
  readonly nodeId: string;
  readonly expectedAggregateVersion: number;
  readonly expectedDagVersion: number;
  readonly expectedNodeVersion: number;
  readonly owner: {
    readonly seatId: string;
    readonly bindingId: string;
  };
  readonly roleAssignment?: {
    readonly assignmentId: string;
    readonly revision: number;
    readonly phaseId: string;
  };
  readonly roomWorkerFence: {
    readonly leaseId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly expectedEpoch: number;
  };
  readonly idempotencyKey: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly authority: RoomAuthorityEnvelopeV1;
  readonly message: {
    readonly intent: RoomMessageIntent;
    readonly content: string;
    readonly contentHash: string;
  };
}

interface ClaimReadyRoomTaskDispatchResultV1 {
  readonly nodeId: string;
  readonly ownerSeatId: string;
  readonly ownerBindingId: string;
  readonly runningNodeVersion: number;
  readonly message: { readonly id: string; readonly originType: string; readonly nodeId: string | null };
  readonly target: { readonly id: string; readonly seatId: string | null; readonly bindingId: string | null };
  readonly delivery: { readonly id: string; readonly bindingId: string; readonly state: string };
  readonly event: { readonly eventType: string; readonly aggregateVersion: number };
  readonly replayed: boolean;
}

interface ExpectedRoomTaskDispatchClaimStore {
  claimReadyTaskDispatch(
    input: ClaimReadyRoomTaskDispatchInputV1,
  ): Promise<ClaimReadyRoomTaskDispatchResultV1>;
}

interface RoomRoleAssignmentProjectionV1 {
  readonly id: string;
  readonly roomId: string;
  readonly revision: number;
  readonly phaseId: string;
  readonly state: "active" | "superseded";
  readonly capabilitySnapshot: Readonly<Record<string, unknown>>;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly assignment: RoomRoleAssignmentV1;
  readonly authoritativeProducerBindingIds: readonly string[];
  readonly aggregateVersion: number;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

interface ActivateRoomRoleAssignmentInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly capabilitySnapshot: RoomCapabilitySnapshotInputV1;
  readonly constraints: RoomRoleAssignmentConstraintsV1;
  readonly now: string;
}

interface TransitionRoomRoleAssignmentCommandInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly boundaryTurnId: string;
  readonly targetPhaseId: string;
  readonly phaseGateEvidenceId: string;
  readonly idempotencyKey: string;
  readonly capabilitySnapshot: RoomCapabilitySnapshotInputV1;
  readonly constraints: RoomRoleAssignmentConstraintsV1;
  readonly now: string;
}

interface RoomPhaseGateEvidenceRecordV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: string;
  readonly gateId: string;
  readonly phaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly source: { readonly recordId: string; readonly sourceHash: string; readonly recordedAt: string };
  readonly verdict: "passed" | "failed";
  readonly evaluatorBindingId: string | null;
  readonly producerBindingIds: readonly string[];
  readonly operatorApproval: null;
}

interface RecordRoomPhaseGateEvidenceInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly evidence: RoomPhaseGateEvidenceRecordV1;
  readonly now: string;
}

interface ExpectedRoomRoleAssignmentStore {
  activateRoomRoleAssignment(
    input: ActivateRoomRoleAssignmentInputV1,
    context: RoomCommandContext,
  ): Promise<RoomRoleAssignmentProjectionV1>;
  transitionRoomRoleAssignment(
    input: TransitionRoomRoleAssignmentCommandInputV1,
    context: RoomCommandContext,
  ): Promise<RoomRoleAssignmentProjectionV1>;
  recordRoomPhaseGateEvidence(
    input: RecordRoomPhaseGateEvidenceInputV1,
    context: RoomCommandContext,
  ): Promise<{ readonly id: string; readonly evidenceHash: string }>;
  getActiveRoomRoleAssignment(roomId: string): Promise<RoomRoleAssignmentProjectionV1 | null>;
}

interface ClaimFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly roomId: string;
  readonly graph: RoomTaskGraphProjectionV1;
  readonly roleAssignment: RoomRoleAssignmentProjectionV1 | null;
  readonly workerLease: StoredRoomLeaseV1;
}

interface CreateClaimFixtureOptions {
  /**
   * FNXC:SessionRoomRoleAssignment 2026-07-18-23:45:
   * Dispatch claims must never inherit `assignedSeatIds` as an authorization
   * fallback. Keep the legacy-shaped fixture opt-out only for tests that prove
   * the durable store rejects that missing assignment proof.
   */
  readonly activateRoleAssignment?: boolean;
  readonly includeVerifier?: boolean;
}

const PROJECT_ID = "project-room-task-dispatch-claim";
const ROOM_ID = "room-task-dispatch-claim";
const NODE_ID = "node-dispatch-ready";
const SEAT_ID = "seat-dispatch-owner";
const BINDING_ID = "binding-dispatch-owner";
const VERIFIER_SEAT_ID = "seat-dispatch-verifier";
const VERIFIER_BINDING_ID = "binding-dispatch-verifier";
const HOST_ID = "windows-host-dispatch";
let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

/*
FNXC:SessionRoomDispatchClaim 2026-07-18-23:00:
Task 5.7 requires exactly one fenced transaction to claim a ready assigned node
and create its durable message delivery intent. A later worker crash may delay
provider send, but it must never leave a running node without its outbox record
or create an outbox record without the running node that owns it.
*/
function commandContext(label: string, occurredAt: string): RoomCommandContext {
  return {
    eventId: `event-task-dispatch-${label}`,
    actorType: "controller",
    actorId: "room-controller-dispatch-test",
    correlationId: `correlation-task-dispatch-${label}`,
    causationId: null,
    occurredAt,
  };
}

function taskNode(): RoomTaskNodeDefinitionV1 {
  return {
    id: NODE_ID,
    parentNodeId: null,
    objective: "Claim one ready node for its assigned worker seat",
    assignedSeatIds: [SEAT_ID],
    inputRefs: ["input:dispatch"],
    outputRefs: ["artifact:dispatch"],
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
    acceptanceGateIds: ["gate:dispatch"],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "exponential",
      baseDelayMs: 1_000,
      recoveryActions: ["replan"],
    },
    progressSignature: "progress:dispatch:ready",
  };
}

function requireClaimSeam(store: AsyncRoomStore): ExpectedRoomTaskDispatchClaimStore {
  const candidate = store as unknown as Partial<ExpectedRoomTaskDispatchClaimStore>;
  expect(
    candidate.claimReadyTaskDispatch,
    "Task 5.7 requires AsyncRoomStore.claimReadyTaskDispatch(input)",
  ).toBeTypeOf("function");
  return candidate as ExpectedRoomTaskDispatchClaimStore;
}

function requireRoleAssignmentSeam(store: AsyncRoomStore): ExpectedRoomRoleAssignmentStore {
  const candidate = store as unknown as Partial<ExpectedRoomRoleAssignmentStore>;
  expect(
    candidate.activateRoomRoleAssignment,
    "Task 5.5 requires AsyncRoomStore.activateRoomRoleAssignment(input, context)",
  ).toBeTypeOf("function");
  expect(
    candidate.getActiveRoomRoleAssignment,
    "Task 5.5 requires AsyncRoomStore.getActiveRoomRoleAssignment(roomId)",
  ).toBeTypeOf("function");
  expect(
    candidate.transitionRoomRoleAssignment,
    "Task 5.5 requires AsyncRoomStore.transitionRoomRoleAssignment(input, context)",
  ).toBeTypeOf("function");
  expect(
    candidate.recordRoomPhaseGateEvidence,
    "Task 5.5 requires immutable phase-gate evidence before a role transition",
  ).toBeTypeOf("function");
  return candidate as ExpectedRoomRoleAssignmentStore;
}

function dispatchAuthority(): RoomAuthorityEnvelopeV1 {
  return {
    actorType: "controller",
    actorId: "room-controller-dispatch-test",
    deviceId: null,
    role: "controller",
    allowedActions: ["room:task:dispatch"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [NODE_ID],
    seatIds: [SEAT_ID],
    evidenceRefs: ["policy:task-dispatch:v1"],
  };
}

function claimInput(fixture: ClaimFixture): ClaimReadyRoomTaskDispatchInputV1 {
  const content = "Start the assigned implementation node and report durable evidence.";
  const node = fixture.graph.nodes.find((candidate) => candidate.id === NODE_ID);
  if (!node) throw new Error("Dispatch test node is missing");
  return {
    roomId: fixture.roomId,
    nodeId: NODE_ID,
    expectedAggregateVersion: fixture.graph.aggregateVersion,
    expectedDagVersion: fixture.graph.dagVersion,
    expectedNodeVersion: node.nodeVersion,
    owner: { seatId: SEAT_ID, bindingId: BINDING_ID },
    ...(fixture.roleAssignment
      ? {
        roleAssignment: {
          assignmentId: fixture.roleAssignment.id,
          revision: fixture.roleAssignment.revision,
          phaseId: fixture.roleAssignment.phaseId,
        },
      }
      : {}),
    roomWorkerFence: {
      leaseId: fixture.workerLease.id,
      holderId: fixture.workerLease.holderId,
      hostId: fixture.workerLease.hostId,
      expectedEpoch: fixture.workerLease.epoch,
    },
    idempotencyKey: "room-worker-dispatch:node-dispatch-ready:attempt-1",
    commandId: "command-room-task-dispatch-1",
    correlationId: "correlation-room-task-dispatch-1",
    issuedAt: "2026-07-18T12:05:00.000Z",
    authority: dispatchAuthority(),
    message: {
      intent: "instruction",
      content,
      contentHash: hashRoomValue(content),
    },
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-task-dispatch-claim-"));
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
  if (!sharedLayer) throw new Error("Room dispatch claim PostgreSQL fixture was not started");
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

async function createClaimFixture(
  onCommittedEvent?: RoomCommittedEventListener,
  currentTime: () => string = () => "2026-07-18T12:05:00.000Z",
  options: CreateClaimFixtureOptions = {},
): Promise<ClaimFixture> {
  if (!sharedLayer) throw new Error("Room dispatch claim PostgreSQL fixture was not started");
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, { onCommittedEvent, currentTime });
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const created = await store.createRoom({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Atomically claim dispatch work",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-18T12:00:00.000Z",
  }, commandContext("created", "2026-07-18T12:00:00.000Z"));

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
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
  });
  await layer.db.insert(roomBindings).values({
    id: BINDING_ID,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    seatId: SEAT_ID,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "native-dispatch-owner",
    happierSessionId: "happier-dispatch-owner",
    serverProfileId: "server-dispatch",
    machineId: HOST_ID,
    hostId: HOST_ID,
    state: "attached",
    attachedAt: "2026-07-18T12:00:00.000Z",
  });
  if (options.includeVerifier) {
    await layer.db.insert(roomSeats).values({
      id: VERIFIER_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "implementation_verifier",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: VERIFIER_BINDING_ID,
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: VERIFIER_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: VERIFIER_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: "native-dispatch-verifier",
      happierSessionId: "happier-dispatch-verifier",
      serverProfileId: "server-dispatch",
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: "2026-07-18T12:00:00.000Z",
    });
  }

  const ready = await store.transitionLifecycle(ROOM_ID, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: "2026-07-18T12:01:00.000Z",
  }, commandContext("ready", "2026-07-18T12:01:00.000Z"));
  const running = await store.transitionLifecycle(ROOM_ID, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: "2026-07-18T12:02:00.000Z",
  }, commandContext("running", "2026-07-18T12:02:00.000Z"));
  const seededGraph = await store.mutateTaskGraph({
    roomId: ROOM_ID,
    expectedAggregateVersion: running.room.aggregateVersion,
    expectedDagVersion: 0,
    idempotencyKey: "seed-dispatch-ready-node",
    mutations: [{ action: "add_node", node: taskNode() }],
    mutatedAt: "2026-07-18T12:03:00.000Z",
  }, commandContext("seed-node", "2026-07-18T12:03:00.000Z"));

  const roleAssignment = options.activateRoleAssignment === false
    ? null
    : await requireRoleAssignmentSeam(store).activateRoomRoleAssignment({
      roomId: ROOM_ID,
      expectedAggregateVersion: seededGraph.aggregateVersion,
      idempotencyKey: "seed-dispatch-role-assignment",
      capabilitySnapshot: {
        contractVersion: 1,
        snapshotId: "snapshot-seed-dispatch-role-assignment",
        revision: 1,
        capturedAt: "2026-07-18T12:03:30.000Z",
        bindings: [
          {
            bindingId: BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-seed-dispatch-owner-v1",
            capabilities: [
              { name: "workspace_write", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
          ...(options.includeVerifier ? [{
            bindingId: VERIFIER_BINDING_ID,
            availability: "eligible" as const,
            capabilityRevision: "capability-seed-dispatch-verifier-v1",
            capabilities: [
              { name: "test", state: "verified" as const },
              { name: "source_read", state: "verified" as const },
            ],
          }] : []),
        ],
      },
      constraints: {
        locks: [{ roleId: "implementer", bindingId: BINDING_ID }],
        forbids: [],
      },
      now: "2026-07-18T12:03:30.000Z",
    }, commandContext("seed-dispatch-role-assignment", "2026-07-18T12:03:30.000Z"));
  const graph = roleAssignment
    ? await store.getTaskGraph(ROOM_ID)
    : seededGraph;
  if (!graph) throw new Error("Room dispatch claim task graph is missing after fixture setup");

  const acquired = await leaseStore.acquireLease({
    leaseId: "lease-room-worker-dispatch",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: "room-controller-dispatch-test",
    hostId: HOST_ID,
    expectedEpoch: null,
    now: "2026-07-18T12:04:00.000Z",
    expiresAt: "2026-07-18T12:09:00.000Z",
  });
  if (!acquired.ok) throw new Error("Room worker lease must be acquired for dispatch claim test");

  return {
    layer,
    store,
    leaseStore,
    roomId: ROOM_ID,
    graph,
    roleAssignment,
    workerLease: acquired.lease,
  };
}

describe("AsyncRoomStore atomic ready task dispatch claim (Task 5.7)", () => {
  it("uses the trusted backend clock so a historical issuedAt cannot bypass an expired worker lease", async () => {
    const fixture = await createClaimFixture(undefined, () => "2026-07-18T12:10:00.000Z");
    const api = requireClaimSeam(fixture.store);

    await expect(api.claimReadyTaskDispatch(claimInput(fixture))).rejects.toMatchObject({
      code: "stale_lease_fence",
    });

    expect(await fixture.store.getTaskGraph(fixture.roomId)).toEqual(fixture.graph);
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(0);
  });

  it("rejects a generic ready-to-running graph transition that would bypass durable dispatch intent", async () => {
    const fixture = await createClaimFixture();
    const node = fixture.graph.nodes.find((candidate) => candidate.id === NODE_ID);
    if (!node) throw new Error("Dispatch test node is missing");

    await expect(fixture.store.mutateTaskGraph({
      roomId: fixture.roomId,
      expectedAggregateVersion: fixture.graph.aggregateVersion,
      expectedDagVersion: fixture.graph.dagVersion,
      idempotencyKey: "generic-ready-running-must-reject",
      mutations: [{
        action: "transition_node",
        nodeId: NODE_ID,
        expectedNodeVersion: node.nodeVersion,
        to: "running",
        acceptanceEvidenceIds: [],
        progressSignature: "progress:generic-running-attempt",
      }],
      mutatedAt: "2026-07-18T12:05:00.000Z",
    }, commandContext("generic-running", "2026-07-18T12:05:00.000Z"))).rejects.toMatchObject({
      code: "task_dispatch_invalid_claim",
    });

    expect(await fixture.store.getTaskGraph(fixture.roomId)).toEqual(fixture.graph);
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(0);
  });

  it("fails closed when no active capability-aware role assignment exists", async () => {
    const fixture = await createClaimFixture(undefined, undefined, { activateRoleAssignment: false });
    const api = requireClaimSeam(fixture.store);

    await expect(api.claimReadyTaskDispatch(claimInput(fixture))).rejects.toMatchObject({
      code: "role_assignment_missing",
    });

    expect(await fixture.store.getTaskGraph(fixture.roomId)).toEqual(fixture.graph);
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomMessageTargets)).toHaveLength(0);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(0);
  });

  it("replays the same fenced dispatch key without duplicating the node claim or outbox intent", async () => {
    const fixture = await createClaimFixture();
    const api = requireClaimSeam(fixture.store);
    const input = claimInput(fixture);

    const first = await api.claimReadyTaskDispatch(input);
    const replay = await api.claimReadyTaskDispatch(input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      nodeId: first.nodeId,
      ownerSeatId: first.ownerSeatId,
      ownerBindingId: first.ownerBindingId,
      runningNodeVersion: first.runningNodeVersion,
      message: { id: first.message.id },
      target: { id: first.target.id },
      delivery: { id: first.delivery.id },
      event: { id: first.event.id },
    });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomMessageTargets)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect(
      (await fixture.store.listEvents(fixture.roomId)).filter(
        (event) => event.eventType === "room_task_dispatch_claimed",
      ),
    ).toHaveLength(1);
  });

  it("allows exactly one concurrent claim for the same ready node", async () => {
    const fixture = await createClaimFixture();
    const primary = requireClaimSeam(fixture.store);
    const contender = requireClaimSeam(new AsyncRoomStore(fixture.layer, {
      currentTime: () => "2026-07-18T12:05:00.000Z",
    }));
    const firstInput = claimInput(fixture);
    const secondInput: ClaimReadyRoomTaskDispatchInputV1 = {
      ...claimInput(fixture),
      idempotencyKey: "room-worker-dispatch:node-dispatch-ready:attempt-2",
      commandId: "command-room-task-dispatch-2",
      correlationId: "correlation-room-task-dispatch-2",
    };

    const settled = await Promise.allSettled([
      primary.claimReadyTaskDispatch(firstInput),
      contender.claimReadyTaskDispatch(secondInput),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ code: expect.stringMatching(/aggregate_version_conflict|dag_version_conflict/) }),
    });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomMessageTargets)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect(
      (await fixture.store.listEvents(fixture.roomId)).filter(
        (event) => event.eventType === "room_task_dispatch_claimed",
      ),
    ).toHaveLength(1);
  });

  it("commits a fenced ready-to-running claim with one durable message, target, outbox, and ledger event", async () => {
    const fixture = await createClaimFixture();
    const api = requireClaimSeam(fixture.store);
    const beforeClaim = await fixture.store.getRoom(fixture.roomId);
    if (!beforeClaim) throw new Error("Dispatch claim fixture Room is missing before claim");

    const result = await api.claimReadyTaskDispatch(claimInput(fixture));

    expect(result).toMatchObject({
      nodeId: NODE_ID,
      ownerSeatId: SEAT_ID,
      ownerBindingId: BINDING_ID,
      runningNodeVersion: 1,
      replayed: false,
      message: { originType: "controller", nodeId: NODE_ID },
      target: { seatId: SEAT_ID, bindingId: BINDING_ID },
      delivery: { bindingId: BINDING_ID, state: "pending" },
      event: { eventType: "room_task_dispatch_claimed", aggregateVersion: fixture.graph.aggregateVersion + 1 },
    });

    const graph = await fixture.store.getTaskGraph(fixture.roomId);
    expect(graph?.aggregateVersion).toBe(fixture.graph.aggregateVersion + 1);
    expect(graph?.dagVersion).toBe(fixture.graph.dagVersion + 1);
    expect(graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: NODE_ID,
        state: "running",
        nodeVersion: 1,
        assignedSeatIds: [SEAT_ID],
      }),
    ]));

    const [messages, targets, deliveries] = await Promise.all([
      fixture.layer.db.select().from(roomMessages).where(eq(roomMessages.id, result.message.id)),
      fixture.layer.db.select().from(roomMessageTargets).where(eq(roomMessageTargets.id, result.target.id)),
      fixture.layer.db.select().from(roomOutbox).where(eq(roomOutbox.id, result.delivery.id)),
    ]);
    expect(messages).toHaveLength(1);
    expect(targets).toHaveLength(1);
    expect(deliveries).toHaveLength(1);

    const claimEvent = (await fixture.store.listEvents(fixture.roomId)).at(-1);
    if (!claimEvent) throw new Error("Dispatch claim event is missing from immutable Room ledger");
    expect(claimEvent.eventType).toBe("room_task_dispatch_claimed");
    expect(applyRoomProjectionEvents(beforeClaim, [claimEvent])).toEqual(
      await fixture.store.getRoom(fixture.roomId),
    );
    expect(rebuildRoomTaskGraphProjectionFromEvents(
      await fixture.store.listEvents(fixture.roomId),
    )).toEqual(graph);
  });

  it("atomically blocks a claimed task node when its exact dispatch delivery is rejected", async () => {
    const fixture = await createClaimFixture();
    const api = requireClaimSeam(fixture.store);
    const claimed = await api.claimReadyTaskDispatch(claimInput(fixture));

    await fixture.store.beginDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-task-dispatch-rejected",
      reconciliationFromCursor: "cursor-before-task-dispatch-rejection",
      now: "2026-07-18T12:05:01.000Z",
    });
    const rejected = await fixture.store.completeDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-task-dispatch-rejected",
      outcome: "rejected",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "connector_rejected",
      nextAttemptAt: null,
      now: "2026-07-18T12:05:02.000Z",
      audit: { runId: "room-run-task-dispatch-rejected", agentId: "room-worker-dispatch-test" },
    });

    expect(rejected).toMatchObject({ state: "rejected" });
    const graph = await fixture.store.getTaskGraph(fixture.roomId);
    expect(graph).toMatchObject({
      aggregateVersion: fixture.graph.aggregateVersion + 2,
      dagVersion: fixture.graph.dagVersion + 2,
      nodes: [expect.objectContaining({
        id: NODE_ID,
        state: "blocked",
        nodeVersion: 2,
      })],
    });
    const events = await fixture.store.listEvents(fixture.roomId);
    expect(events.at(-1)).toMatchObject({
      eventType: "room_task_dispatch_delivery_rejected",
      payload: expect.objectContaining({
        nodeId: NODE_ID,
        outboxId: claimed.delivery.id,
      }),
    });
    expect(rebuildRoomTaskGraphProjectionFromEvents(events)).toEqual(graph);
  });

  it("records bounded delivery uncertainty as a node-only recovery block without affecting independent Room state", async () => {
    const fixture = await createClaimFixture();
    const api = requireClaimSeam(fixture.store);
    const claimed = await api.claimReadyTaskDispatch(claimInput(fixture));

    await fixture.store.beginDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-task-dispatch-uncertain",
      reconciliationFromCursor: "cursor-before-task-dispatch-uncertain",
      now: "2026-07-18T12:05:01.000Z",
    });
    await fixture.store.completeDeliveryAttempt({
      outboxId: claimed.delivery.id,
      attemptId: "attempt-task-dispatch-uncertain",
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "connector_send_exception",
      nextAttemptAt: null,
      now: "2026-07-18T12:05:02.000Z",
      audit: { runId: "room-run-task-dispatch-uncertain", agentId: "room-worker-dispatch-test" },
    });

    const beforeThreshold = await fixture.store.recoverNoProgressTaskDispatches({
      roomId: fixture.roomId,
      roomWorkerFence: {
        leaseId: fixture.workerLease.id,
        holderId: fixture.workerLease.holderId,
        hostId: fixture.workerLease.hostId,
        expectedEpoch: fixture.workerLease.epoch,
      },
      now: "2026-07-18T12:05:02.500Z",
      maxDeliveryUncertaintyAgeMs: 1_000,
    });
    expect(beforeThreshold).toEqual({ blockedNodeIds: [], skippedOutboxIds: [claimed.delivery.id] });
    expect(await fixture.store.getTaskGraph(fixture.roomId)).toMatchObject({
      nodes: [expect.objectContaining({ id: NODE_ID, state: "running", nodeVersion: 1 })],
    });

    const recovered = await fixture.store.recoverNoProgressTaskDispatches({
      roomId: fixture.roomId,
      roomWorkerFence: {
        leaseId: fixture.workerLease.id,
        holderId: fixture.workerLease.holderId,
        hostId: fixture.workerLease.hostId,
        expectedEpoch: fixture.workerLease.epoch,
      },
      now: "2026-07-18T12:05:04.000Z",
      maxDeliveryUncertaintyAgeMs: 1_000,
    });

    expect(recovered).toEqual({ blockedNodeIds: [NODE_ID], skippedOutboxIds: [] });
    const graph = await fixture.store.getTaskGraph(fixture.roomId);
    expect(graph).toMatchObject({
      aggregateVersion: fixture.graph.aggregateVersion + 2,
      dagVersion: fixture.graph.dagVersion + 2,
      nodes: [expect.objectContaining({ id: NODE_ID, state: "blocked", nodeVersion: 2 })],
    });
    const events = await fixture.store.listEvents(fixture.roomId);
    expect(events.at(-1)).toMatchObject({
      eventType: "room_task_dispatch_delivery_uncertain_blocked",
      payload: expect.objectContaining({
        nodeId: NODE_ID,
        outboxId: claimed.delivery.id,
        firstUncertainAt: "2026-07-18T12:05:02.000Z",
      }),
    });
    expect(rebuildRoomTaskGraphProjectionFromEvents(events)).toEqual(graph);

    const lateConfirmed = await fixture.store.reconcileDelivery({
      outboxId: claimed.delivery.id,
      expectedAttemptCount: 1,
      outcome: "confirmed",
      connectorAcknowledgementId: "connector-ack-after-timeout",
      nativeMessageId: "native-message-after-timeout",
      nativeCursor: "cursor-after-timeout",
      errorCode: null,
      evidenceRef: `room-history:sha256:${"a".repeat(64)}`,
      now: "2026-07-18T12:05:05.000Z",
      audit: { runId: "room-run-task-dispatch-late-confirmation", agentId: "room-recovery-worker-test" },
    });
    expect(lateConfirmed).toMatchObject({ state: "confirmed" });
    expect(await fixture.store.getTaskGraph(fixture.roomId)).toEqual(graph);
    expect(
      (await fixture.store.listEvents(fixture.roomId)).filter(
        (event) => event.eventType === "room_task_dispatch_delivery_uncertain_blocked",
      ),
    ).toHaveLength(1);
  });

  it("persists one canonical entry-phase assignment with capability evidence, user lock, and idempotent replay", async () => {
    const fixture = await createClaimFixture(undefined, undefined, { activateRoleAssignment: false });
    const api = requireRoleAssignmentSeam(fixture.store);
    await fixture.layer.db.insert(roomSeats).values({
      id: VERIFIER_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "implementation_verifier",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: VERIFIER_BINDING_ID,
      createdAt: "2026-07-18T12:03:00.000Z",
      updatedAt: "2026-07-18T12:03:00.000Z",
    });
    await fixture.layer.db.insert(roomBindings).values({
      id: VERIFIER_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: VERIFIER_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: "native-dispatch-verifier",
      happierSessionId: "happier-dispatch-verifier",
      serverProfileId: "server-dispatch",
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: "2026-07-18T12:03:00.000Z",
    });
    const input: ActivateRoomRoleAssignmentInputV1 = {
      roomId: fixture.roomId,
      expectedAggregateVersion: fixture.graph.aggregateVersion,
      idempotencyKey: "role-assignment-entry-phase-v1",
      capabilitySnapshot: {
        contractVersion: 1,
        snapshotId: "snapshot-role-assignment-v1",
        revision: 1,
        capturedAt: "2026-07-18T12:03:01.000Z",
        bindings: [
          {
            bindingId: BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-owner-v1",
            capabilities: [
              { name: "workspace_write", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
          {
            bindingId: VERIFIER_BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-verifier-v1",
            capabilities: [
              { name: "test", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
        ],
      },
      constraints: {
        locks: [{ roleId: "implementer", bindingId: BINDING_ID }],
        forbids: [],
      },
      now: "2026-07-18T12:03:02.000Z",
    };

    const first = await api.activateRoomRoleAssignment(
      input,
      commandContext("role-assignment-entry", input.now),
    );
    const replay = await api.activateRoomRoleAssignment(
      input,
      commandContext("role-assignment-entry-replay", input.now),
    );

    expect(first).toMatchObject({
      roomId: ROOM_ID,
      revision: 1,
      phaseId: "plan",
      state: "active",
      aggregateVersion: fixture.graph.aggregateVersion + 1,
      authoritativeProducerBindingIds: [BINDING_ID],
      assignment: {
        protocolId: "implementation",
        protocolVersion: 1,
        phaseId: "plan",
        producerBindingIds: [BINDING_ID],
        assignments: [{
          roleId: "implementer",
          bindingIds: [BINDING_ID],
          requiredCapabilities: ["source_read", "workspace_write"],
        }],
      },
    });
    expect(replay).toEqual(first);
    expect(await api.getActiveRoomRoleAssignment(ROOM_ID)).toEqual(first);
    expect(
      (await fixture.store.listEvents(ROOM_ID)).filter(
        (event) => event.eventType === "room_role_assignment_activated",
      ),
    ).toHaveLength(1);
  });

  it("requires and records the active capability-aware role assignment when claiming a task", async () => {
    const fixture = await createClaimFixture(undefined, undefined, { activateRoleAssignment: false });
    const roleApi = requireRoleAssignmentSeam(fixture.store);
    const activated = await roleApi.activateRoomRoleAssignment({
      roomId: fixture.roomId,
      expectedAggregateVersion: fixture.graph.aggregateVersion,
      idempotencyKey: "role-assignment-for-dispatch-v1",
      capabilitySnapshot: {
        contractVersion: 1,
        snapshotId: "snapshot-role-dispatch-v1",
        revision: 1,
        capturedAt: "2026-07-18T12:03:01.000Z",
        bindings: [{
          bindingId: BINDING_ID,
          availability: "eligible",
          capabilityRevision: "capability-owner-dispatch-v1",
          capabilities: [
            { name: "workspace_write", state: "verified" },
            { name: "source_read", state: "verified" },
          ],
        }],
      },
      constraints: { locks: [{ roleId: "implementer", bindingId: BINDING_ID }], forbids: [] },
      now: "2026-07-18T12:03:02.000Z",
    }, commandContext("role-assignment-for-dispatch", "2026-07-18T12:03:02.000Z"));
    const graph = await fixture.store.getTaskGraph(fixture.roomId);
    const node = graph?.nodes.find((candidate) => candidate.id === NODE_ID);
    if (!graph || !node) throw new Error("Fresh task graph is required after role activation");
    const input: ClaimReadyRoomTaskDispatchInputV1 = {
      ...claimInput(fixture),
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      expectedNodeVersion: node.nodeVersion,
      roleAssignment: {
        assignmentId: activated.id,
        revision: activated.revision,
        phaseId: activated.phaseId,
      },
    };
    const api = requireClaimSeam(fixture.store);

    const missingProof = { ...input };
    delete (missingProof as { roleAssignment?: unknown }).roleAssignment;
    await expect(api.claimReadyTaskDispatch(missingProof)).rejects.toMatchObject({
      code: "role_assignment_conflict",
    });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(0);

    const result = await api.claimReadyTaskDispatch(input);
    expect(result).toMatchObject({ ownerSeatId: SEAT_ID, ownerBindingId: BINDING_ID });
    const event = (await fixture.store.listEvents(fixture.roomId)).at(-1);
    expect(event).toMatchObject({
      eventType: "room_task_dispatch_claimed",
      payload: {
        projectionVersion: 3,
        roleAssignmentId: activated.id,
        roleAssignmentRevision: activated.revision,
        roleAssignmentPhaseId: "plan",
      },
    });
    expect(rebuildRoomTaskGraphProjectionFromEvents(
      await fixture.store.listEvents(fixture.roomId),
    )).toEqual(await fixture.store.getTaskGraph(fixture.roomId));
  });

  it("supersedes the entry assignment only at a completed turn boundary and preserves producer lineage", async () => {
    const fixture = await createClaimFixture(undefined, undefined, {
      activateRoleAssignment: false,
      includeVerifier: true,
    });
    const api = requireRoleAssignmentSeam(fixture.store);
    const entry = await api.activateRoomRoleAssignment({
      roomId: fixture.roomId,
      expectedAggregateVersion: fixture.graph.aggregateVersion,
      idempotencyKey: "role-assignment-entry-for-transition-v1",
      capabilitySnapshot: {
        contractVersion: 1,
        snapshotId: "snapshot-role-transition-entry-v1",
        revision: 1,
        capturedAt: "2026-07-18T12:03:01.000Z",
        bindings: [
          {
            bindingId: BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-owner-transition-r1",
            capabilities: [
              { name: "workspace_write", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
          {
            bindingId: VERIFIER_BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-verifier-transition-r1",
            capabilities: [
              { name: "test", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
        ],
      },
      constraints: { locks: [{ roleId: "implementer", bindingId: BINDING_ID }], forbids: [] },
      now: "2026-07-18T12:03:02.000Z",
    }, commandContext("role-assignment-entry-for-transition", "2026-07-18T12:03:02.000Z"));
    const boundaryTurnId = "turn-role-assignment-plan";
    await fixture.layer.db.insert(roomTurns).values({
      id: boundaryTurnId,
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      sequence: 1,
      protocolPhaseId: "plan",
      membershipVersion: 0,
      state: "completed",
      startedAt: "2026-07-18T12:03:03.000Z",
      endedAt: "2026-07-18T12:03:04.000Z",
    });
    const before = await fixture.store.getRoom(fixture.roomId);
    if (!before) throw new Error("Room must exist before role transition");
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Implementation protocol must exist");
    const evidence = await api.recordRoomPhaseGateEvidence({
      roomId: fixture.roomId,
      expectedAggregateVersion: before.room.aggregateVersion,
      idempotencyKey: "role-assignment-plan-ready-evidence-v1",
      evidence: {
        contractVersion: 1,
        id: "phase-gate-evidence-plan-ready-v1",
        protocolId: protocol.id,
        protocolVersion: protocol.version,
        protocolHash: hashRoomValue(protocol),
        gateId: "plan_ready",
        phaseId: "plan",
        turnId: boundaryTurnId,
        candidateId: "candidate-role-transition-plan-v1",
        candidateHash: hashRoomValue("candidate-role-transition-plan-v1"),
        source: {
          recordId: "gate-source-plan-ready-v1",
          sourceHash: hashRoomValue("gate-source-plan-ready-v1"),
          recordedAt: "2026-07-18T12:03:05.000Z",
        },
        verdict: "passed",
        evaluatorBindingId: VERIFIER_BINDING_ID,
        producerBindingIds: [BINDING_ID],
        operatorApproval: null,
      },
      now: "2026-07-18T12:03:05.000Z",
    }, commandContext("role-assignment-plan-ready-evidence", "2026-07-18T12:03:05.000Z"));
    const afterEvidence = await fixture.store.getRoom(fixture.roomId);
    if (!afterEvidence) throw new Error("Room must exist after phase-gate evidence recording");
    const input: TransitionRoomRoleAssignmentCommandInputV1 = {
      roomId: fixture.roomId,
      expectedAggregateVersion: afterEvidence.room.aggregateVersion,
      boundaryTurnId,
      targetPhaseId: "implement",
      phaseGateEvidenceId: evidence.id,
      idempotencyKey: "role-assignment-plan-to-implement-v1",
      capabilitySnapshot: {
        contractVersion: 1,
        snapshotId: "snapshot-role-transition-implement-v2",
        revision: 2,
        capturedAt: "2026-07-18T12:03:05.000Z",
        bindings: [
          {
            bindingId: BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-owner-transition-r2",
            capabilities: [
              { name: "workspace_write", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
          {
            bindingId: VERIFIER_BINDING_ID,
            availability: "eligible",
            capabilityRevision: "capability-verifier-transition-r2",
            capabilities: [
              { name: "test", state: "verified" },
              { name: "source_read", state: "verified" },
            ],
          },
        ],
      },
      constraints: { locks: [{ roleId: "implementer", bindingId: BINDING_ID }], forbids: [] },
      now: "2026-07-18T12:03:06.000Z",
    };

    const transitioned = await api.transitionRoomRoleAssignment(
      input,
      commandContext("role-assignment-plan-to-implement", input.now),
    );
    const replay = await api.transitionRoomRoleAssignment(
      input,
      commandContext("role-assignment-plan-to-implement-replay", input.now),
    );

    expect(transitioned).toMatchObject({
      revision: entry.revision + 1,
      phaseId: "implement",
      state: "active",
      authoritativeProducerBindingIds: [BINDING_ID],
      assignment: {
        phaseId: "implement",
        producerBindingIds: [BINDING_ID],
      },
    });
    expect(replay).toEqual(transitioned);
    expect(await api.getActiveRoomRoleAssignment(fixture.roomId)).toEqual(transitioned);
    const events = await fixture.store.listEvents(fixture.roomId);
    const phaseGateEvidenceEvent = events.at(-2);
    const transitionEvent = events.at(-1);
    expect(phaseGateEvidenceEvent).toMatchObject({
      eventType: "room_phase_gate_evidence_recorded",
      payload: { phaseGateEvidenceId: evidence.id },
    });
    expect(transitionEvent).toMatchObject({
      eventType: "room_role_assignment_transitioned",
      payload: {
        previousAssignmentId: entry.id,
        boundaryTurnId,
        phaseGateEvidenceId: evidence.id,
        assignmentId: transitioned.id,
      },
    });
    expect(applyRoomProjectionEvents(before, [phaseGateEvidenceEvent!, transitionEvent!])).toEqual(
      await fixture.store.getRoom(fixture.roomId),
    );
  });
});
