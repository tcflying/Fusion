import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import {
  AsyncRoomStore,
  type RecordRoomTerminalizationContractInputV1,
  type RoomCommandContext,
  type TerminalizeRoomInputV1,
} from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomBindings, roomSeats } from "../../postgres/schema/room.js";
import { getRoomProtocolDefinition } from "../../room-protocol-definitions.js";
import {
  rebuildRoomProjectionFromEvents,
  rebuildRoomTerminalizationProjectionFromEvents,
} from "../../room-projection-replay.js";
import type {
  EvaluateRoomTerminalizationInputV1,
  RoomTerminalizationOutcomeV1,
} from "../../room-terminalization.js";

const PROJECT_ID = "project-room-terminalization";
const ROOM_ID = "room-terminalization";
const WORKER_ID = "worker-terminalization";
const HOST_ID = "windows-terminalization";
const IMPLEMENTER_SEAT_ID = "seat-terminalization-implementer";
const VERIFIER_SEAT_ID = "seat-terminalization-verifier";
const IMPLEMENTER_BINDING_ID = "binding-terminalization-implementer";
const VERIFIER_BINDING_ID = "binding-terminalization-verifier";
const CREATED_AT = "2026-07-19T10:00:00.000Z";
const READY_AT = "2026-07-19T10:00:01.000Z";
const RUNNING_AT = "2026-07-19T10:00:02.000Z";
const LEASED_AT = "2026-07-19T10:00:03.000Z";
const CONTRACT_AT = "2026-07-19T10:01:00.000Z";
const TERMINALIZED_AT = "2026-07-19T10:02:00.000Z";
const RETRY_AT = "2026-07-19T10:03:00.000Z";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface TerminalizationFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly projectId: string;
  readonly roomId: string;
  readonly workerLease: StoredRoomLeaseV1;
  readonly runningAggregateVersion: number;
}

interface TerminalizationEvidenceOptions {
  readonly gateStatus?: "passed" | "failed";
  readonly evidenceSetId: string;
}

let sharedContext: EmbeddedTestContext | null = null;
let sharedConnections: PostgresConnections | null = null;

function controllerContext(label: string, occurredAt: string): RoomCommandContext {
  return {
    eventId: `event-terminalization-${label}`,
    actorType: "controller",
    actorId: WORKER_ID,
    correlationId: `correlation-terminalization-${label}`,
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

function implementationTerminalizationProtocol(): EvaluateRoomTerminalizationInputV1["protocol"] {
  const protocol = getRoomProtocolDefinition("implementation", 1);
  if (!protocol) throw new Error("implementation@1 protocol must be available to terminalization persistence tests");
  return {
    id: protocol.id,
    version: protocol.version,
    gates: protocol.gates,
    exitConditions: protocol.exitConditions,
  };
}

function terminalizationEvidence(
  requestedOutcome: RoomTerminalizationOutcomeV1,
  options: TerminalizationEvidenceOptions,
): EvaluateRoomTerminalizationInputV1 {
  const isCompleted = requestedOutcome === "completed";
  const gateId = isCompleted ? "hard_gates_passed" : "implementation_blocked";
  const gateStatus = options.gateStatus ?? "passed";
  return {
    requestedOutcome,
    protocol: implementationTerminalizationProtocol(),
    evidence: {
      source: "room_gate_ledger",
      evidenceSetId: options.evidenceSetId,
      protocolId: "implementation",
      protocolVersion: 1,
      producerBindingIds: [IMPLEMENTER_BINDING_ID],
      gateResults: [{
        gateId,
        status: gateStatus,
        evidenceRef: `ledger:${options.evidenceSetId}:${gateId}`,
        evaluatorBindingIds: isCompleted ? [VERIFIER_BINDING_ID] : [],
      }],
      ...(isCompleted ? {
        artifactEvidence: [{
          gateId: "hard_gates_passed",
          artifactId: "implementation",
          artifactRef: `artifact:${options.evidenceSetId}:implementation`,
        }],
        deliveryEvidence: [{
          gateId: "hard_gates_passed",
          deliveryId: "implementation",
          status: "confirmed" as const,
          evidenceRef: `delivery:${options.evidenceSetId}:implementation`,
        }],
      } : {}),
      unresolvedRisks: [],
    },
  };
}

function recordContractInput(
  fixture: TerminalizationFixture,
  requestedOutcome: RoomTerminalizationOutcomeV1,
  label: string,
  asOf: string,
  options: Omit<TerminalizationEvidenceOptions, "evidenceSetId"> = {},
): RecordRoomTerminalizationContractInputV1 {
  const evidenceSetId = `gate-set-terminalization-${label}`;
  const terminalization = terminalizationEvidence(requestedOutcome, {
    evidenceSetId,
    ...options,
  });
  return {
    roomId: fixture.roomId,
    expectedAggregateVersion: fixture.runningAggregateVersion,
    roomWorkerFence: workerFence(fixture.workerLease),
    idempotencyKey: `record-terminalization-${label}`,
    completionContractRef: `completion-contract:${label}`,
    gateEvidenceSetId: evidenceSetId,
    independentVerificationRefs: requestedOutcome === "completed"
      ? [`verification:${evidenceSetId}:${VERIFIER_BINDING_ID}`]
      : [],
    unresolvedRiskEvidence: [],
    cancellationReason: null,
    terminalization,
    asOf,
  };
}

function terminalizeInput(
  fixture: TerminalizationFixture,
  recorded: Awaited<ReturnType<AsyncRoomStore["recordRoomTerminalizationContract"]>>,
  label: string,
  asOf: string,
): TerminalizeRoomInputV1 {
  return {
    roomId: fixture.roomId,
    expectedAggregateVersion: recorded.projection.contract.aggregateVersion,
    roomWorkerFence: workerFence(fixture.workerLease),
    idempotencyKey: `terminalize-room-${label}`,
    terminalContractId: recorded.projection.contract.id,
    terminalContractHash: recorded.projection.contract.contractHash,
    asOf,
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-terminalization-"));
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

async function createFixture(): Promise<TerminalizationFixture> {
  if (!sharedConnections) throw new Error("Terminalization PostgreSQL fixture was not started");
  const layer = createAsyncDataLayer(sharedConnections, { projectId: PROJECT_ID });
  const store = new AsyncRoomStore(layer);
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const created = await store.createRoom({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist controller-fenced terminalization with real protocol evidence",
    protocolId: "implementation",
    protocolVersion: 1,
    now: CREATED_AT,
  }, controllerContext("created", CREATED_AT));

  await layer.db.insert(roomSeats).values([
    {
      id: IMPLEMENTER_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "implementer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: [],
      state: "active",
      activeBindingId: IMPLEMENTER_BINDING_ID,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    {
      id: VERIFIER_SEAT_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "implementation_verifier",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: [],
      state: "active",
      activeBindingId: VERIFIER_BINDING_ID,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ]);
  await layer.db.insert(roomBindings).values([
    {
      id: IMPLEMENTER_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: IMPLEMENTER_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "native-terminalization-implementer",
      happierSessionId: null,
      serverProfileId: null,
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: CREATED_AT,
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
    {
      id: VERIFIER_BINDING_ID,
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: VERIFIER_SEAT_ID,
      generation: 1,
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: "native-terminalization-verifier",
      happierSessionId: null,
      serverProfileId: null,
      machineId: HOST_ID,
      hostId: HOST_ID,
      state: "attached",
      attachedAt: CREATED_AT,
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
  ]);

  const ready = await store.transitionLifecycle(ROOM_ID, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: READY_AT,
  }, controllerContext("ready", READY_AT));
  const running = await store.transitionLifecycle(ROOM_ID, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: RUNNING_AT,
  }, controllerContext("running", RUNNING_AT));
  const acquired = await leaseStore.acquireLease({
    leaseId: "lease-terminalization-worker",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    expectedEpoch: null,
    now: LEASED_AT,
    expiresAt: "2026-07-19T10:30:00.000Z",
  });
  if (!acquired.ok) throw new Error("Terminalization fixture must acquire its worker fence");
  return {
    layer,
    store,
    leaseStore,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    workerLease: acquired.lease,
    runningAggregateVersion: running.room.aggregateVersion,
  };
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedConnections = sharedContext.connections;
}, 60_000);

beforeEach(async () => {
  if (!sharedConnections) throw new Error("Terminalization PostgreSQL fixture was not started");
  await sharedConnections.runtime.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedConnections = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
}, 60_000);

describe.sequential("Room terminalization PostgreSQL persistence", () => {
  it("persists a completed contract, terminal event, projection replay, and worker-lease revocation", async () => {
    const fixture = await createFixture();
    const recorded = await fixture.store.recordRoomTerminalizationContract(recordContractInput(
      fixture,
      "completed",
      "completed",
      CONTRACT_AT,
    ), controllerContext("record-completed", CONTRACT_AT));
    expect(recorded).toMatchObject({
      replayed: false,
      event: { eventType: "room_terminalization_contract_recorded", aggregateVersion: 3 },
      projection: {
        state: "recorded",
        terminalization: null,
        contract: { requestedOutcome: "completed", decision: { canTerminalize: true } },
      },
    });

    const terminalized = await fixture.store.terminalizeRoom(
      terminalizeInput(fixture, recorded, "completed", TERMINALIZED_AT),
      controllerContext("terminalize-completed", TERMINALIZED_AT),
    );
    expect(terminalized).toMatchObject({
      replayed: false,
      aggregate: {
        room: { state: "completed", aggregateVersion: 4 },
        terminalization: {
          contractId: recorded.projection.contract.id,
          contractHash: recorded.projection.contract.contractHash,
          outcome: "completed",
        },
      },
      event: { eventType: "room_terminalized", aggregateVersion: 4 },
      projection: { state: "terminalized" },
    });

    const events = await fixture.store.listEvents(fixture.roomId);
    expect(events.map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
      "room_terminalization_contract_recorded",
      "room_terminalized",
    ]);
    expect(rebuildRoomProjectionFromEvents(events)).toMatchObject({
      room: { state: "completed", aggregateVersion: 4 },
      terminalization: { eventId: terminalized.event.id },
    });
    expect(rebuildRoomTerminalizationProjectionFromEvents(events)).toMatchObject({
      state: "terminalized",
      contract: { id: recorded.projection.contract.id },
      terminalization: { eventId: terminalized.event.id },
    });
    await expect(fixture.store.getRoomTerminalizationContract(fixture.roomId)).resolves.toMatchObject({
      state: "terminalized",
      terminalization: { eventId: terminalized.event.id },
    });
    await expect(fixture.leaseStore.getActiveLease("room_worker", fixture.roomId)).resolves.toBeNull();
    await expect(fixture.leaseStore.listLeaseHistory("room_worker", fixture.roomId)).resolves.toEqual([
      expect.objectContaining({ id: fixture.workerLease.id, releasedAt: TERMINALIZED_AT }),
    ]);
  });

  it("rejects ordinary lifecycle completion before it can bypass the controller terminalization contract", async () => {
    const fixture = await createFixture();
    await expect(fixture.store.transitionLifecycle(fixture.roomId, {
      to: "completed",
      expectedAggregateVersion: fixture.runningAggregateVersion,
      now: CONTRACT_AT,
    }, controllerContext("bypass-completed", CONTRACT_AT))).rejects.toMatchObject({
      code: "terminalization_required",
    });
    await expect(fixture.store.getRoom(fixture.roomId)).resolves.toMatchObject({
      room: { state: "running", aggregateVersion: fixture.runningAggregateVersion },
    });
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
    ]);
    await expect(fixture.leaseStore.getActiveLease("room_worker", fixture.roomId)).resolves.toMatchObject({
      id: fixture.workerLease.id,
    });
  });

  it("replays the same committed terminal result after acknowledgement loss even though the worker lease is revoked", async () => {
    const fixture = await createFixture();
    const recorded = await fixture.store.recordRoomTerminalizationContract(recordContractInput(
      fixture,
      "completed",
      "ack-loss",
      CONTRACT_AT,
    ), controllerContext("record-ack-loss", CONTRACT_AT));
    const firstInput = terminalizeInput(fixture, recorded, "ack-loss", TERMINALIZED_AT);
    const first = await fixture.store.terminalizeRoom(
      firstInput,
      controllerContext("terminalize-ack-loss", TERMINALIZED_AT),
    );
    await expect(fixture.leaseStore.getActiveLease("room_worker", fixture.roomId)).resolves.toBeNull();

    const replay = await fixture.store.terminalizeRoom({
      ...firstInput,
      asOf: RETRY_AT,
    }, controllerContext("replay-ack-loss", RETRY_AT));
    expect(replay).toMatchObject({
      replayed: true,
      event: { id: first.event.id, eventType: "room_terminalized" },
      aggregate: { room: { state: "completed", aggregateVersion: first.aggregate.room.aggregateVersion } },
      projection: { state: "terminalized" },
    });
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
      "room_terminalization_contract_recorded",
      "room_terminalized",
    ]);
  });

  it("keeps a red hard-gate contract recorded while rejecting hash-forged and stale-fence terminal writes", async () => {
    const fixture = await createFixture();
    const recorded = await fixture.store.recordRoomTerminalizationContract(recordContractInput(
      fixture,
      "completed",
      "red-hard-gate",
      CONTRACT_AT,
      { gateStatus: "failed" },
    ), controllerContext("record-red-hard-gate", CONTRACT_AT));
    expect(recorded.projection.contract.decision).toMatchObject({ canTerminalize: false });
    expect(recorded.projection.contract.decision.unmetReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "required_gate_not_passed" }),
    ]));
    const baselineVersion = recorded.projection.contract.aggregateVersion;
    const correctInput = terminalizeInput(fixture, recorded, "red-hard-gate", TERMINALIZED_AT);

    await expect(fixture.store.terminalizeRoom(
      correctInput,
      controllerContext("terminalize-red-hard-gate", TERMINALIZED_AT),
    )).rejects.toMatchObject({ code: "terminalization_gate_blocked" });
    await expect(fixture.store.terminalizeRoom({
      ...correctInput,
      idempotencyKey: "terminalize-room-red-hard-gate-forged-hash",
      terminalContractHash: "sha256:forged-terminal-contract",
      asOf: RETRY_AT,
    }, controllerContext("terminalize-forged-hash", RETRY_AT))).rejects.toMatchObject({
      code: "terminalization_contract_conflict",
    });
    await expect(fixture.store.terminalizeRoom({
      ...correctInput,
      idempotencyKey: "terminalize-room-red-hard-gate-stale-fence",
      roomWorkerFence: {
        ...correctInput.roomWorkerFence,
        expectedEpoch: fixture.workerLease.epoch + 1,
      },
      asOf: "2026-07-19T10:04:00.000Z",
    }, controllerContext("terminalize-stale-fence", "2026-07-19T10:04:00.000Z"))).rejects.toMatchObject({
      code: "stale_lease_fence",
    });

    await expect(fixture.store.getRoom(fixture.roomId)).resolves.toMatchObject({
      room: { state: "running", aggregateVersion: baselineVersion },
    });
    await expect(fixture.store.getRoomTerminalizationContract(fixture.roomId)).resolves.toMatchObject({
      state: "recorded",
      terminalization: null,
      contract: { id: recorded.projection.contract.id },
    });
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
      "room_terminalization_contract_recorded",
    ]);
    await expect(fixture.leaseStore.getActiveLease("room_worker", fixture.roomId)).resolves.toMatchObject({
      id: fixture.workerLease.id,
    });
  });

  it("marks terminal blocked as immutable so it cannot resume through the ordinary lifecycle path", async () => {
    const fixture = await createFixture();
    const recorded = await fixture.store.recordRoomTerminalizationContract(recordContractInput(
      fixture,
      "blocked",
      "blocked",
      CONTRACT_AT,
    ), controllerContext("record-blocked", CONTRACT_AT));
    expect(recorded.projection.contract.decision).toMatchObject({ canTerminalize: true, outcome: "blocked" });
    const terminalized = await fixture.store.terminalizeRoom(
      terminalizeInput(fixture, recorded, "blocked", TERMINALIZED_AT),
      controllerContext("terminalize-blocked", TERMINALIZED_AT),
    );
    expect(terminalized.aggregate).toMatchObject({
      room: { state: "blocked", aggregateVersion: 4 },
      terminalization: { outcome: "blocked" },
    });

    await expect(fixture.store.transitionLifecycle(fixture.roomId, {
      to: "running",
      expectedAggregateVersion: terminalized.aggregate.room.aggregateVersion,
      now: RETRY_AT,
    }, controllerContext("resume-terminal-blocked", RETRY_AT))).rejects.toMatchObject({
      code: "terminal_state_immutable",
    });
    await expect(fixture.store.getRoom(fixture.roomId)).resolves.toMatchObject({
      room: { state: "blocked", aggregateVersion: terminalized.aggregate.room.aggregateVersion },
      terminalization: { contractId: recorded.projection.contract.id, outcome: "blocked" },
    });
  });
});
