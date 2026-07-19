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
) {
  return ports.commit({
    projectId,
    roomId,
    lease,
    expectedAggregateVersion: 0,
    requestId,
    decisionInput,
    decision,
  });
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
