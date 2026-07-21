import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomProviderBackpressureReservations,
  roomProviderBackpressureStates,
} from "../../postgres/schema/room.js";
import {
  ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
  createRoomProviderBackpressurePostgresPorts,
  type RoomProviderBackpressureControllerInputV1,
  type RoomProviderBackpressureControllerResultV1,
  type RoomProviderBackpressurePolicyV1,
  type RoomProviderBackpressurePostgresPortsV1,
  type RoomProviderBackpressurePostgresSnapshotV1,
  type RoomProviderBackpressureScopeV1,
  type RoomProviderBackpressureStateV1,
} from "../../room-provider-backpressure-postgres.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-provider-backpressure-a";
const PROJECT_B = "project-provider-backpressure-b";
const ROOM_A = "room-provider-backpressure-a";
const ROOM_A2 = "room-provider-backpressure-a2";
const ROOM_B = "room-provider-backpressure-b";
const AS_OF = "2026-07-19T14:00:00.000Z";
const AFTER_ADMIT = "2026-07-19T14:00:01.000Z";
const OPEN_UNTIL = "2026-07-19T14:00:05.000Z";
const HALF_OPEN_AT = "2026-07-19T14:00:05.000Z";
const SECOND_PROBE_AT = "2026-07-19T14:00:05.001Z";
const COMPLETED_AT = "2026-07-19T14:00:05.002Z";
const LATER = "2026-07-19T14:06:00.000Z";
const LEASE_EXPIRES_AT = "2026-07-19T14:05:00.000Z";
const LATER_LEASE_EXPIRES_AT = "2026-07-19T14:11:00.000Z";

const DEFAULT_SCOPE = Object.freeze({
  providerId: "happier",
  accountId: "account-a",
  modelId: "gpt-5.6",
  connectorId: "happier-direct-session",
  nodeId: "windows-a",
} satisfies RoomProviderBackpressureScopeV1);

const DEFAULT_POLICY = Object.freeze({
  concurrencyCap: 1,
  reservedVerifierSlots: 0,
  reservedRecoverySlots: 0,
  telemetryTtlMs: 60_000,
  failureThreshold: 2,
  maxRetryAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 1_000,
  circuitOpenMs: 5_000,
} satisfies RoomProviderBackpressurePolicyV1);

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-provider-backpressure-"));
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

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Room provider-backpressure PostgreSQL fixture was not started");
  return sharedLayer;
}

function createPorts(
  projectId: string,
  scope: RoomProviderBackpressureScopeV1 = DEFAULT_SCOPE,
  policy: RoomProviderBackpressurePolicyV1 = DEFAULT_POLICY,
  useDatabaseFenceClock = false,
): RoomProviderBackpressurePostgresPortsV1 {
  return createRoomProviderBackpressurePostgresPorts({
    layer: createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    snapshotSource: {
      read: async (input) => Object.freeze({
        scope: Object.freeze({ ...scope }),
        telemetry: Object.freeze({
          known: true,
          observedAt: input.asOf,
          admissionConfirmed: true,
          activeRequests: 0,
        }),
        policy: Object.freeze({ ...policy }),
      }),
    },
    ...(useDatabaseFenceClock ? {} : { fenceValidationClock: () => AS_OF }),
  });
}

async function createRoom(projectId: string, roomId: string): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: roomId,
    projectId,
    objective: `Keep provider capacity durable for ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: AS_OF,
    updatedAt: AS_OF,
  });
}

async function acquireWorkerLease(
  projectId: string,
  roomId: string,
  leaseId: string,
  now = AS_OF,
  expiresAt = LEASE_EXPIRES_AT,
  expectedEpoch: number | null = null,
): Promise<StoredRoomLeaseV1> {
  const store = new AsyncRoomLeaseStore(
    createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    { projectId },
  );
  const result = await store.acquireLease({
    leaseId,
    roomId,
    kind: "room_worker",
    resourceId: roomId,
    holderId: `worker:${leaseId}`,
    hostId: "windows-a",
    expectedEpoch,
    now,
    expiresAt,
  });
  if (!result.ok) throw new Error(`Could not acquire Room worker lease: ${result.reason}`);
  return result.lease;
}

async function renewWorkerLease(
  projectId: string,
  lease: StoredRoomLeaseV1,
  now: string,
  expiresAt: string,
): Promise<StoredRoomLeaseV1> {
  const store = new AsyncRoomLeaseStore(
    createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    { projectId },
  );
  const result = await store.renewLease({
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: lease.kind,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
    expiresAt,
  });
  if (!result.ok) throw new Error(`Could not renew Room worker lease: ${result.reason}`);
  return result.lease;
}

async function read(
  ports: RoomProviderBackpressurePostgresPortsV1,
  projectId: string,
  roomId: string,
  lease: StoredRoomLeaseV1,
  requestId: string,
  asOf = AS_OF,
): Promise<RoomProviderBackpressurePostgresSnapshotV1> {
  return ports.read({
    projectId,
    roomId,
    lease,
    expectedAggregateVersion: 0,
    requestId,
    workClass: "normal",
    allowHalfOpenProbe: false,
    asOf,
  });
}

function controllerInput(
  snapshot: RoomProviderBackpressurePostgresSnapshotV1,
  requestId: string,
  asOf: string,
  operation: RoomProviderBackpressureControllerInputV1["operation"],
  allowHalfOpenProbe = false,
): RoomProviderBackpressureControllerInputV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    asOf,
    scope: snapshot.scope,
    work: Object.freeze({ requestId, class: "normal" as const, allowHalfOpenProbe }),
    operation,
    telemetry: snapshot.telemetry,
    policy: snapshot.policy,
    ...(snapshot.state ? { state: snapshot.state } : {}),
  });
}

function scopeKey(scope: RoomProviderBackpressureScopeV1): string {
  return JSON.stringify([scope.providerId, scope.accountId, scope.modelId, scope.connectorId, scope.nodeId]);
}

function initialState(scope: RoomProviderBackpressureScopeV1, asOf: string): RoomProviderBackpressureStateV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: scopeKey(scope),
    circuitState: "closed",
    consecutiveFailures: 0,
    retryAttempt: 0,
    retryNotBefore: null,
    openUntil: null,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function result(
  input: RoomProviderBackpressureControllerInputV1,
  action: "admit" | "hold" | "recorded",
  reason: string,
  state: RoomProviderBackpressureStateV1,
  fields: {
    readonly retryAfterMs?: number | null;
    readonly exponentialBackoffMs?: number | null;
    readonly retryDelayMs?: number | null;
    readonly effectiveConcurrencyCap?: number | null;
  } = {},
): RoomProviderBackpressureControllerResultV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scope: input.scope,
    scopeKey: scopeKey(input.scope),
    decision: Object.freeze({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
      action,
      reason,
      retryAfterMs: fields.retryAfterMs ?? null,
      exponentialBackoffMs: fields.exponentialBackoffMs ?? null,
      retryDelayMs: fields.retryDelayMs ?? null,
      effectiveConcurrencyCap: fields.effectiveConcurrencyCap ?? null,
    }),
    state,
  });
}

function normalAdmission(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1 {
  return result(input, "admit", "capacity_confirmed", input.state ?? initialState(input.scope, input.asOf), {
    effectiveConcurrencyCap: input.policy.concurrencyCap,
  });
}

function halfOpenAdmission(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1 {
  const state = input.state;
  if (!state) throw new Error("Half-open admission requires a durable state");
  return result(input, "admit", "half_open_probe_admitted", Object.freeze({
    ...state,
    halfOpenProbeInFlight: true,
    lastUpdatedAt: input.asOf,
  }), { effectiveConcurrencyCap: input.policy.concurrencyCap });
}

function halfOpenHeld(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1 {
  if (!input.state) throw new Error("Half-open hold requires a durable state");
  return result(input, "hold", "half_open_probe_in_flight", input.state);
}

function rateLimitFailure(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1 {
  return result(input, "recorded", "circuit_opened", Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: scopeKey(input.scope),
    circuitState: "open",
    consecutiveFailures: 1,
    retryAttempt: 1,
    retryNotBefore: "2026-07-19T14:00:01.000Z",
    openUntil: OPEN_UNTIL,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: input.asOf,
  }), {
    retryAfterMs: 1_000,
    exponentialBackoffMs: 100,
    retryDelayMs: 1_000,
  });
}

async function commit(
  ports: RoomProviderBackpressurePostgresPortsV1,
  projectId: string,
  roomId: string,
  lease: StoredRoomLeaseV1,
  requestId: string,
  decisionInput: RoomProviderBackpressureControllerInputV1,
  decision: RoomProviderBackpressureControllerResultV1,
  options: { readonly idempotencyBindingHash?: string } = {},
) {
  return ports.commit({
    projectId,
    roomId,
    lease,
    expectedAggregateVersion: 0,
    requestId,
    decisionInput,
    decision,
    ...options,
  });
}

async function renewReservation(
  ports: RoomProviderBackpressurePostgresPortsV1,
  input: {
    readonly projectId: string;
    readonly roomId: string;
    readonly lease: StoredRoomLeaseV1;
    readonly expectedAggregateVersion: number;
    readonly reservationId: string;
    readonly claimId: string;
    readonly operationId: string;
    readonly asOf: string;
    readonly expiresAt: string;
  },
): Promise<unknown> {
  return (ports as unknown as {
    renew(value: typeof input): Promise<unknown>;
  }).renew(input);
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.room_provider_backpressure_states RESTART IDENTITY CASCADE"));
  await createRoom(PROJECT_A, ROOM_A);
  await createRoom(PROJECT_A, ROOM_A2);
  await createRoom(PROJECT_B, ROOM_B);
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
});

describe("Room provider backpressure PostgreSQL ports", () => {
  it("rejects delayed provider commit and renewal writes after the Room-worker lease has expired", async () => {
    const ports = createPorts(PROJECT_A, DEFAULT_SCOPE, DEFAULT_POLICY, true);
    const lease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-delayed-fence");
    const commitRequestId = "room-provider-capacity:claim-delayed-fence";
    const snapshot = await read(ports, PROJECT_A, ROOM_A, lease, commitRequestId, AS_OF);
    const input = controllerInput(snapshot, commitRequestId, AS_OF, { kind: "dispatch" });

    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      commitRequestId,
      input,
      normalAdmission(input),
    )).resolves.toEqual({ status: "held", reason: "stale_fence" });

    await requireLayer().db.insert(roomProviderBackpressureStates).values({
      projectId: PROJECT_A,
      scopeKey: scopeKey(DEFAULT_SCOPE),
      providerId: DEFAULT_SCOPE.providerId,
      accountId: DEFAULT_SCOPE.accountId,
      modelId: DEFAULT_SCOPE.modelId,
      connectorId: DEFAULT_SCOPE.connectorId,
      nodeId: DEFAULT_SCOPE.nodeId,
      circuitState: "closed",
      consecutiveFailures: 0,
      retryAttempt: 0,
      retryNotBefore: null,
      openUntil: null,
      revision: 0,
      lastUpdatedAt: AS_OF,
    });
    await requireLayer().db.insert(roomProviderBackpressureReservations).values({
      id: "reservation-delayed-fence",
      projectId: PROJECT_A,
      scopeKey: scopeKey(DEFAULT_SCOPE),
      roomId: ROOM_A,
      requestId: "room-provider-capacity:claim-delayed-renewal",
      claimId: "claim-delayed-fence",
      leaseId: lease.id,
      leaseEpoch: lease.epoch,
      expectedAggregateVersion: 0,
      workClass: "normal",
      isHalfOpenProbe: false,
      circuitOpenMs: DEFAULT_POLICY.circuitOpenMs,
      acquiredAt: AS_OF,
      expiresAt: LEASE_EXPIRES_AT,
      releasedAt: null,
      releaseOutcome: null,
    });

    await expect(renewReservation(ports, {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease,
      expectedAggregateVersion: 0,
      reservationId: "reservation-delayed-fence",
      claimId: "claim-delayed-fence",
      operationId: "renew-delayed-fence",
      asOf: AS_OF,
      expiresAt: LATER_LEASE_EXPIRES_AT,
    })).resolves.toEqual({ status: "held", reason: "stale_fence" });
  }, 60_000);

  it("replays an admitted provider reservation when only the recovery observation clock advances", async () => {
    const ports = createPorts(PROJECT_A);
    const lease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-replay-clock");
    const requestId = "room-provider-capacity:claim-replay-clock";
    const idempotencyBindingHash = `sha256:${"a".repeat(64)}`;
    const firstSnapshot = await read(ports, PROJECT_A, ROOM_A, lease, requestId, AS_OF);
    const firstInput = controllerInput(firstSnapshot, requestId, AS_OF, { kind: "dispatch" });
    const first = await commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      requestId,
      firstInput,
      normalAdmission(firstInput),
      { idempotencyBindingHash },
    );
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("Expected initial provider reservation");

    const replaySnapshot = await read(ports, PROJECT_A, ROOM_A, lease, requestId, AFTER_ADMIT);
    const replayInput = controllerInput(replaySnapshot, requestId, AFTER_ADMIT, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      requestId,
      replayInput,
      normalAdmission(replayInput),
      { idempotencyBindingHash },
    )).resolves.toEqual({ status: "reserved", reservationId: first.reservationId });
  }, 60_000);

  it("holds a fresh provider admission for one outbox while its earlier durable reservation is still live", async () => {
    const ports = createPorts(PROJECT_A);
    const lease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-delivery-owner");
    const firstRequest = "room-provider-capacity:outbox-owner-1:provider-admission:outbox-owner-1:first";
    const firstSnapshot = await read(ports, PROJECT_A, ROOM_A, lease, firstRequest, AS_OF);
    const firstInput = controllerInput(firstSnapshot, firstRequest, AS_OF, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      firstRequest,
      firstInput,
      normalAdmission(firstInput),
    )).resolves.toMatchObject({ status: "reserved" });

    const laterRequest = "room-provider-capacity:outbox-owner-1:provider-admission:outbox-owner-1:retry";
    const laterSnapshot = await read(ports, PROJECT_A, ROOM_A, lease, laterRequest, AFTER_ADMIT);
    const laterInput = controllerInput(laterSnapshot, laterRequest, AFTER_ADMIT, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      laterRequest,
      laterInput,
      normalAdmission(laterInput),
    )).resolves.toEqual({ status: "held", reason: "delivery_reservation_unresolved" });
  }, 60_000);

  it("does not replay a live provider reservation as a usable permit after its Room-worker lease hands off", async () => {
    const ports = createPorts(PROJECT_A);
    const firstLease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-replay-handoff-first");
    const requestId = "room-provider-capacity:outbox-handoff-1:provider-admission:outbox-handoff-1:first";
    const idempotencyBindingHash = `sha256:${"b".repeat(64)}`;
    const firstSnapshot = await read(ports, PROJECT_A, ROOM_A, firstLease, requestId, AS_OF);
    const firstInput = controllerInput(firstSnapshot, requestId, AS_OF, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      firstLease,
      requestId,
      firstInput,
      normalAdmission(firstInput),
      { idempotencyBindingHash },
    )).resolves.toMatchObject({ status: "reserved" });

    const leaseStore = new AsyncRoomLeaseStore(
      createAsyncDataLayer(sharedContext!.connections!, { projectId: PROJECT_A }),
      { projectId: PROJECT_A },
    );
    await expect(leaseStore.releaseLease({
      leaseId: firstLease.id,
      roomId: firstLease.roomId,
      kind: firstLease.kind,
      resourceId: firstLease.resourceId,
      holderId: firstLease.holderId,
      hostId: firstLease.hostId,
      expectedEpoch: firstLease.epoch,
      now: AFTER_ADMIT,
    })).resolves.toMatchObject({ ok: true });
    const replacementLease = await acquireWorkerLease(
      PROJECT_A,
      ROOM_A,
      "lease-replay-handoff-replacement",
      AFTER_ADMIT,
      LATER_LEASE_EXPIRES_AT,
      firstLease.epoch,
    );
    const replaySnapshot = await read(ports, PROJECT_A, ROOM_A, replacementLease, requestId, AFTER_ADMIT);
    const replayInput = controllerInput(replaySnapshot, requestId, AFTER_ADMIT, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      replacementLease,
      requestId,
      replayInput,
      normalAdmission(replayInput),
      { idempotencyBindingHash },
    )).resolves.toEqual({ status: "held", reason: "reservation_worker_handoff_required" });
  }, 60_000);

  it("serializes each provider scope, isolates accounts and projects, and rejects a forged release", async () => {
    const scopeB = Object.freeze({ ...DEFAULT_SCOPE, accountId: "account-b" });
    const portsA = createPorts(PROJECT_A);
    const portsAccountB = createPorts(PROJECT_A, scopeB);
    const portsProjectB = createPorts(PROJECT_B);
    const leaseA = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-a");
    const leaseA2 = await acquireWorkerLease(PROJECT_A, ROOM_A2, "lease-a2");
    const leaseB = await acquireWorkerLease(PROJECT_B, ROOM_B, "lease-b");

    const requestA = "room-provider-capacity:claim-a";
    const snapshotA = await read(portsA, PROJECT_A, ROOM_A, leaseA, requestA);
    const inputA = controllerInput(snapshotA, requestA, AS_OF, { kind: "dispatch" });
    const admittedA = await commit(portsA, PROJECT_A, ROOM_A, leaseA, requestA, inputA, normalAdmission(inputA));
    expect(admittedA.status).toBe("reserved");
    if (admittedA.status !== "reserved") throw new Error("Expected provider reservation");

    const requestA2 = "room-provider-capacity:claim-a2";
    const snapshotA2 = await read(portsA, PROJECT_A, ROOM_A2, leaseA2, requestA2);
    const inputA2 = controllerInput(snapshotA2, requestA2, AS_OF, { kind: "dispatch" });
    await expect(commit(portsA, PROJECT_A, ROOM_A2, leaseA2, requestA2, inputA2, normalAdmission(inputA2)))
      .resolves.toEqual({ status: "held", reason: "concurrency_cap_reached" });

    const requestAccountB = "room-provider-capacity:claim-account-b";
    const accountBSnapshot = await read(portsAccountB, PROJECT_A, ROOM_A2, leaseA2, requestAccountB);
    const accountBInput = controllerInput(accountBSnapshot, requestAccountB, AS_OF, { kind: "dispatch" });
    await expect(commit(
      portsAccountB,
      PROJECT_A,
      ROOM_A2,
      leaseA2,
      requestAccountB,
      accountBInput,
      normalAdmission(accountBInput),
    )).resolves.toMatchObject({ status: "reserved" });

    const requestProjectB = "room-provider-capacity:claim-project-b";
    const projectBSnapshot = await read(portsProjectB, PROJECT_B, ROOM_B, leaseB, requestProjectB);
    const projectBInput = controllerInput(projectBSnapshot, requestProjectB, AS_OF, { kind: "dispatch" });
    await expect(commit(
      portsProjectB,
      PROJECT_B,
      ROOM_B,
      leaseB,
      requestProjectB,
      projectBInput,
      normalAdmission(projectBInput),
    )).resolves.toMatchObject({ status: "reserved" });

    await expect(portsA.release({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease: leaseA,
      expectedAggregateVersion: 0,
      requestId: requestA,
      reservationId: admittedA.reservationId,
      claimId: "other-claim",
      outcome: "worker_completed",
      releasedAt: AFTER_ADMIT,
    })).rejects.toThrow("release fence was rejected");

    const retained = await requireLayer().db
      .select({ releasedAt: roomProviderBackpressureReservations.releasedAt })
      .from(roomProviderBackpressureReservations)
      .where(eq(roomProviderBackpressureReservations.id, admittedA.reservationId));
    expect(retained).toEqual([{ releasedAt: null }]);

    await portsA.release({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease: leaseA,
      expectedAggregateVersion: 0,
      requestId: requestA,
      reservationId: admittedA.reservationId,
      claimId: "claim-a",
      outcome: "worker_completed",
      releasedAt: AFTER_ADMIT,
    });
    const released = await requireLayer().db
      .select({ releasedAt: roomProviderBackpressureReservations.releasedAt })
      .from(roomProviderBackpressureReservations)
      .where(eq(roomProviderBackpressureReservations.id, admittedA.reservationId));
    expect(released).toEqual([{ releasedAt: AFTER_ADMIT }]);
  }, 60_000);

  it("expires abandoned reservations at the fenced worker-lease TTL before later admission", async () => {
    const ports = createPorts(PROJECT_A);
    const firstLease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-expiring");
    const firstRequest = "room-provider-capacity:claim-expiring";
    const firstSnapshot = await read(ports, PROJECT_A, ROOM_A, firstLease, firstRequest);
    const firstInput = controllerInput(firstSnapshot, firstRequest, AS_OF, { kind: "dispatch" });
    const first = await commit(ports, PROJECT_A, ROOM_A, firstLease, firstRequest, firstInput, normalAdmission(firstInput));
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("Expected first provider reservation");

    const replacementLease = await acquireWorkerLease(
      PROJECT_A,
      ROOM_A,
      "lease-after-expiry",
      LATER,
      LATER_LEASE_EXPIRES_AT,
      firstLease.epoch,
    );
    const laterRequest = "room-provider-capacity:claim-after-expiry";
    const laterSnapshot = await read(ports, PROJECT_A, ROOM_A, replacementLease, laterRequest, LATER);
    const laterInput = controllerInput(laterSnapshot, laterRequest, LATER, { kind: "dispatch" });
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      replacementLease,
      laterRequest,
      laterInput,
      normalAdmission(laterInput),
    )).resolves.toMatchObject({ status: "reserved" });

    const expired = await requireLayer().db
      .select({
        releasedAt: roomProviderBackpressureReservations.releasedAt,
        releaseOutcome: roomProviderBackpressureReservations.releaseOutcome,
      })
      .from(roomProviderBackpressureReservations)
      .where(eq(roomProviderBackpressureReservations.id, first.reservationId));
    expect(expired).toEqual([{ releasedAt: LATER, releaseOutcome: "expired" }]);
  }, 60_000);

  it("fenced-renews a live provider reservation to the current worker-lease endpoint and safely replays once", async () => {
    const ports = createPorts(PROJECT_A);
    const initialLease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-renew");
    const requestId = "room-provider-capacity:claim-renew";
    const snapshot = await read(ports, PROJECT_A, ROOM_A, initialLease, requestId);
    const input = controllerInput(snapshot, requestId, AS_OF, { kind: "dispatch" });
    const committed = await commit(ports, PROJECT_A, ROOM_A, initialLease, requestId, input, normalAdmission(input));
    expect(committed.status).toBe("reserved");
    if (committed.status !== "reserved") throw new Error("Expected provider reservation");

    const currentLease = await renewWorkerLease(PROJECT_A, initialLease, AFTER_ADMIT, LATER_LEASE_EXPIRES_AT);
    const renewInput = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease: currentLease,
      expectedAggregateVersion: 0,
      reservationId: committed.reservationId,
      claimId: "claim-renew",
      operationId: "renew-provider-reservation",
      asOf: AFTER_ADMIT,
      expiresAt: LATER_LEASE_EXPIRES_AT,
    } as const;
    await expect(renewReservation(ports, renewInput)).resolves.toEqual({
      status: "renewed",
      reservationId: committed.reservationId,
      expiresAt: LATER_LEASE_EXPIRES_AT,
      replayed: false,
    });
    await expect(renewReservation(ports, renewInput)).resolves.toEqual({
      status: "renewed",
      reservationId: committed.reservationId,
      expiresAt: LATER_LEASE_EXPIRES_AT,
      replayed: true,
    });

    const reservation = await requireLayer().db
      .select({
        expiresAt: roomProviderBackpressureReservations.expiresAt,
        requestId: roomProviderBackpressureReservations.requestId,
        claimId: roomProviderBackpressureReservations.claimId,
        workClass: roomProviderBackpressureReservations.workClass,
        leaseId: roomProviderBackpressureReservations.leaseId,
        leaseEpoch: roomProviderBackpressureReservations.leaseEpoch,
      })
      .from(roomProviderBackpressureReservations)
      .where(eq(roomProviderBackpressureReservations.id, committed.reservationId));
    expect(reservation).toEqual([{
      expiresAt: LATER_LEASE_EXPIRES_AT,
      requestId,
      claimId: "claim-renew",
      workClass: "normal",
      leaseId: currentLease.id,
      leaseEpoch: currentLease.epoch,
    }]);
  }, 60_000);

  it("rejects provider renewal conflicts, regressions, stale worker or room authority, released reservations, and expired reservations", async () => {
    const ports = createPorts(PROJECT_A);
    const initialLease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-renew-fences");
    const requestId = "room-provider-capacity:claim-renew-fences";
    const snapshot = await read(ports, PROJECT_A, ROOM_A, initialLease, requestId);
    const input = controllerInput(snapshot, requestId, AS_OF, { kind: "dispatch" });
    const committed = await commit(ports, PROJECT_A, ROOM_A, initialLease, requestId, input, normalAdmission(input));
    if (committed.status !== "reserved") throw new Error("Expected provider reservation");
    const currentLease = await renewWorkerLease(PROJECT_A, initialLease, AFTER_ADMIT, LATER_LEASE_EXPIRES_AT);
    const renewInput = {
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease: currentLease,
      expectedAggregateVersion: 0,
      reservationId: committed.reservationId,
      claimId: "claim-renew-fences",
      operationId: "renew-provider-fences",
      asOf: AFTER_ADMIT,
      expiresAt: LATER_LEASE_EXPIRES_AT,
    } as const;
    await expect(renewReservation(ports, renewInput)).resolves.toMatchObject({ status: "renewed" });
    await expect(renewReservation(ports, { ...renewInput, expiresAt: "2026-07-19T14:12:00.000Z" }))
      .resolves.toEqual({ status: "held", reason: "idempotency_conflict" });
    await expect(renewReservation(ports, {
      ...renewInput,
      operationId: "renew-provider-backwards",
      expiresAt: "2026-07-19T14:10:00.000Z",
    })).resolves.toEqual({ status: "held", reason: "renewal_regression" });
    await expect(renewReservation(ports, {
      ...renewInput,
      operationId: "renew-provider-stale-lease",
      lease: { ...currentLease, holderId: "worker:forged" },
    })).resolves.toEqual({ status: "held", reason: "stale_fence" });

    await requireLayer().db
      .update(operationalRooms)
      .set({ aggregateVersion: 1 })
      .where(eq(operationalRooms.id, ROOM_A));
    await expect(renewReservation(ports, {
      ...renewInput,
      operationId: "renew-provider-stale-version",
    })).resolves.toEqual({ status: "held", reason: "stale_room_version" });

    await ports.release({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease: currentLease,
      expectedAggregateVersion: 0,
      requestId,
      reservationId: committed.reservationId,
      claimId: "claim-renew-fences",
      outcome: "worker_completed",
      releasedAt: AFTER_ADMIT,
    });
    await expect(renewReservation(ports, {
      ...renewInput,
      expectedAggregateVersion: 1,
      operationId: "renew-provider-released",
    })).resolves.toEqual({ status: "held", reason: "reservation_not_found" });

    const expiringLease = await acquireWorkerLease(PROJECT_A, ROOM_A2, "lease-renew-expired");
    const expiringRequest = "room-provider-capacity:claim-renew-expired";
    const expiringSnapshot = await read(ports, PROJECT_A, ROOM_A2, expiringLease, expiringRequest);
    const expiringDecision = controllerInput(expiringSnapshot, expiringRequest, AS_OF, { kind: "dispatch" });
    const expiring = await commit(
      ports,
      PROJECT_A,
      ROOM_A2,
      expiringLease,
      expiringRequest,
      expiringDecision,
      normalAdmission(expiringDecision),
    );
    if (expiring.status !== "reserved") throw new Error("Expected expiring provider reservation");
    const replacementLease = await acquireWorkerLease(
      PROJECT_A,
      ROOM_A2,
      "lease-renew-expired-replacement",
      LATER,
      LATER_LEASE_EXPIRES_AT,
      expiringLease.epoch,
    );
    await read(ports, PROJECT_A, ROOM_A2, replacementLease, "room-provider-capacity:trigger-expiry", LATER);
    await expect(renewReservation(ports, {
      projectId: PROJECT_A,
      roomId: ROOM_A2,
      lease: replacementLease,
      expectedAggregateVersion: 0,
      reservationId: expiring.reservationId,
      claimId: "claim-renew-expired",
      operationId: "renew-provider-expired",
      asOf: LATER,
      expiresAt: LATER_LEASE_EXPIRES_AT,
    })).resolves.toEqual({ status: "held", reason: "reservation_expired" });
  }, 60_000);

  it("persists an open circuit, permits exactly one half-open probe, and closes only after its fenced success", async () => {
    const ports = createPorts(PROJECT_A);
    const lease = await acquireWorkerLease(PROJECT_A, ROOM_A, "lease-half-open");
    const failureRequest = "room-provider-capacity:claim-rate-limit";
    const initial = await read(ports, PROJECT_A, ROOM_A, lease, failureRequest);
    const failureInput = controllerInput(
      initial,
      failureRequest,
      AS_OF,
      { kind: "failure", failureKind: "rate_limited", retryAfterMs: 1_000 },
    );
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      failureRequest,
      failureInput,
      rateLimitFailure(failureInput),
    )).resolves.toEqual({ status: "held", reason: "circuit_opened" });

    const firstProbeRequest = "room-provider-capacity:claim-half-open-1";
    const halfOpen = await read(ports, PROJECT_A, ROOM_A, lease, firstProbeRequest, HALF_OPEN_AT);
    expect(halfOpen.state).toMatchObject({ circuitState: "half_open", halfOpenProbeInFlight: false });
    const firstProbeInput = controllerInput(halfOpen, firstProbeRequest, HALF_OPEN_AT, { kind: "dispatch" }, true);
    const firstProbe = await commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      firstProbeRequest,
      firstProbeInput,
      halfOpenAdmission(firstProbeInput),
    );
    expect(firstProbe.status).toBe("reserved");
    if (firstProbe.status !== "reserved") throw new Error("Expected first half-open probe reservation");

    const secondProbeRequest = "room-provider-capacity:claim-half-open-2";
    const probeInFlight = await read(ports, PROJECT_A, ROOM_A, lease, secondProbeRequest, SECOND_PROBE_AT);
    expect(probeInFlight.state).toMatchObject({ circuitState: "half_open", halfOpenProbeInFlight: true });
    const secondProbeInput = controllerInput(probeInFlight, secondProbeRequest, SECOND_PROBE_AT, { kind: "dispatch" }, true);
    await expect(commit(
      ports,
      PROJECT_A,
      ROOM_A,
      lease,
      secondProbeRequest,
      secondProbeInput,
      halfOpenHeld(secondProbeInput),
    )).resolves.toEqual({ status: "held", reason: "half_open_probe_in_flight" });

    await ports.release({
      projectId: PROJECT_A,
      roomId: ROOM_A,
      lease,
      expectedAggregateVersion: 0,
      requestId: firstProbeRequest,
      reservationId: firstProbe.reservationId,
      claimId: "claim-half-open-1",
      outcome: "worker_completed",
      releasedAt: COMPLETED_AT,
    });
    const recovered = await read(ports, PROJECT_A, ROOM_A, lease, "room-provider-capacity:claim-recovered", "2026-07-19T14:00:05.003Z");
    expect(recovered.state).toMatchObject({
      circuitState: "closed",
      consecutiveFailures: 0,
      retryAttempt: 0,
      halfOpenProbeInFlight: false,
    });
  }, 60_000);
});
