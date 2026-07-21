import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { AsyncRoomLeaseStore, type StoredRoomLeaseV1 } from "../../async-room-lease-store.js";
import {
  AsyncRoomStore,
  type RecordRoomCapabilityRegistryInputV1,
  type RoomCommandContext,
} from "../../async-room-store.js";
import { createRoomBindingCapabilitySnapshot, type RoomBindingCapabilitySnapshotV1 } from "../../room-capability-registry.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  roomBindings,
  roomCapabilityRegistryProjections,
  roomSeats,
} from "../../postgres/schema/room.js";
import { rebuildRoomCapabilityRegistryProjectionFromEvents } from "../../room-projection-replay.js";

const PROJECT_ID = "project-room-capability-registry";
const ROOM_ID = "room-capability-registry";
const BINDING_ID = "binding-capability-registry";
const SEAT_ID = "seat-capability-registry";
const WORKER_ID = "worker-capability-registry";
const HOST_ID = "windows-capability-registry";
const CREATED_AT = "2026-07-19T10:00:00.000Z";
const OBSERVED_AT = "2026-07-19T10:01:00.000Z";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface RegistryFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly projectId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly workerLease: StoredRoomLeaseV1;
}

let sharedContext: EmbeddedTestContext | null = null;
let sharedConnections: PostgresConnections | null = null;

function commandContext(label: string, occurredAt = CREATED_AT): RoomCommandContext {
  return {
    eventId: `event-capability-registry-${label}`,
    actorType: "controller",
    actorId: WORKER_ID,
    correlationId: `correlation-capability-registry-${label}`,
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

function capabilitySnapshot(
  bindingId: string,
  asOf = OBSERVED_AT,
  revision = 1,
): RoomBindingCapabilitySnapshotV1 {
  const result = createRoomBindingCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: `snapshot-${bindingId}-${revision}`,
    revision,
    lineage: {
      bindingId,
      bindingGeneration: 1,
      providerId: "codex",
      accountId: "account-capability-registry",
      modelId: "gpt-capability-registry",
      connectorId: "happier",
      nativeSessionId: `native-${bindingId}`,
      hostId: HOST_ID,
    },
    freshness: {
      capturedAt: asOf,
      expiresAt: new Date(Date.parse(asOf) + 60_000).toISOString(),
      sourceRevision: `connector-capability-${revision}`,
    },
    tools: [
      { name: "source_read", state: "verified" },
      { name: "workspace_write", state: "verified" },
    ],
    context: {
      contextVersion: "context-capability-v1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
      observedAt: asOf,
    },
    health: { connectorState: "healthy", hostState: "healthy", observedAt: asOf },
    latency: { p50Ms: 100, p95Ms: 200, sampleCount: 10, observedAt: asOf },
    rateLimit: { state: "clear", retryAfterMs: null, observedAt: asOf },
    domainQuality: [{
      domain: "code",
      selfReportedScore: null,
      independentEvidence: [{
        sourceId: "gate:capability-registry",
        kind: "deterministic_gate",
        score: 0.9,
        observedAt: asOf,
      }],
    }],
    calibration: [{
      domain: "code",
      outcomeCount: 12,
      meanAbsoluteError: 0.1,
      observedAt: asOf,
    }],
  });
  if (!result.ok) throw new Error(`Invalid capability snapshot fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function recordInput(
  fixture: RegistryFixture,
  sample: RoomBindingCapabilitySnapshotV1,
  overrides: Partial<RecordRoomCapabilityRegistryInputV1> = {},
): RecordRoomCapabilityRegistryInputV1 {
  return {
    roomId: fixture.roomId,
    expectedAggregateVersion: 0,
    expectedRegistryRevision: 0,
    roomWorkerFence: workerFence(fixture.workerLease),
    idempotencyKey: "record-capability-registry-v1",
    samples: [sample],
    freshness: {
      maxSnapshotAgeMs: 60_000,
      maxSignalAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    },
    asOf: OBSERVED_AT,
    ...overrides,
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-capability-registry-"));
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

async function createFixture(
  projectId = PROJECT_ID,
  roomId = ROOM_ID,
  bindingId = BINDING_ID,
): Promise<RegistryFixture> {
  if (!sharedConnections) throw new Error("Capability-registry PostgreSQL fixture was not started");
  const layer = createAsyncDataLayer(sharedConnections, { projectId });
  const store = new AsyncRoomStore(layer);
  const leaseStore = new AsyncRoomLeaseStore(layer);
  await store.createRoom({
    id: roomId,
    projectId,
    objective: "Persist a capability registry without inventing reporter data",
    protocolId: "implementation",
    protocolVersion: 1,
    now: CREATED_AT,
  }, commandContext(`created-${roomId}`));
  await layer.db.insert(roomSeats).values({
    id: `${SEAT_ID}-${roomId}`,
    projectId,
    roomId,
    role: "implementer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: [],
    state: "active",
    activeBindingId: bindingId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await layer.db.insert(roomBindings).values({
    id: bindingId,
    projectId,
    roomId,
    seatId: `${SEAT_ID}-${roomId}`,
    generation: 1,
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: `native-${bindingId}`,
    happierSessionId: null,
    serverProfileId: null,
    machineId: HOST_ID,
    hostId: HOST_ID,
    state: "attached",
    attachedAt: CREATED_AT,
  });
  const acquired = await leaseStore.acquireLease({
    leaseId: `lease-capability-registry-${roomId}`,
    roomId,
    kind: "room_worker",
    resourceId: roomId,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    expectedEpoch: null,
    now: CREATED_AT,
    expiresAt: "2026-07-19T10:30:00.000Z",
  });
  if (!acquired.ok) throw new Error("Capability-registry fixture must acquire its worker fence");
  return {
    layer,
    store,
    leaseStore,
    projectId,
    roomId,
    bindingId,
    workerLease: acquired.lease,
  };
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedConnections = sharedContext.connections;
}, 60_000);

beforeEach(async () => {
  if (!sharedConnections) throw new Error("Capability-registry PostgreSQL fixture was not started");
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

describe.sequential("Room capability registry PostgreSQL projection", () => {
  it("commits one fenced canonical event, replays idempotently, and remains project-scoped", async () => {
    const fixture = await createFixture();
    const sample = capabilitySnapshot(fixture.bindingId);
    const input = recordInput(fixture, sample);

    const recorded = await fixture.store.recordRoomCapabilityRegistry(input);
    expect(recorded.replayed).toBe(false);
    expect(recorded.event.eventType).toBe("room_capability_registry_merged");
    expect(recorded.projection.registry).toMatchObject({ revision: 1, bindings: [sample] });

    const duplicate = await fixture.store.recordRoomCapabilityRegistry(input);
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.event.id).toBe(recorded.event.id);
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
      "room_capability_registry_merged",
    ]);

    const revised = await fixture.store.recordRoomCapabilityRegistry(recordInput(
      fixture,
      capabilitySnapshot(fixture.bindingId, "2026-07-19T10:02:00.000Z", 2),
      {
        expectedAggregateVersion: 1,
        expectedRegistryRevision: 1,
        idempotencyKey: "record-capability-registry-v2",
        asOf: "2026-07-19T10:02:00.000Z",
      },
    ));
    const historicalDuplicate = await fixture.store.recordRoomCapabilityRegistry(input);
    expect(historicalDuplicate).toMatchObject({
      replayed: true,
      event: { id: recorded.event.id },
      projection: { registry: { revision: 1 } },
    });

    const current = await fixture.store.getRoomCapabilityRegistry(fixture.roomId);
    expect(current).toMatchObject({
      sourceEventId: revised.event.id,
      workerFence: workerFence(fixture.workerLease),
      registry: { integrityHash: revised.projection.registry.integrityHash, revision: 2 },
    });
    expect(rebuildRoomCapabilityRegistryProjectionFromEvents(
      await fixture.store.listEvents(fixture.roomId),
    )).toMatchObject({ sourceEventId: revised.event.id });

    const foreign = await createFixture(
      "project-room-capability-registry-foreign",
      "room-capability-registry-foreign",
      "binding-capability-registry-foreign",
    );
    await foreign.store.recordRoomCapabilityRegistry(recordInput(
      foreign,
      capabilitySnapshot(foreign.bindingId),
    ));
    await expect(fixture.store.getRoomCapabilityRegistry(foreign.roomId)).resolves.toBeNull();
  });

  it("rejects forged or stale snapshots before they reach the current projection", async () => {
    const fixture = await createFixture();
    const valid = capabilitySnapshot(fixture.bindingId);
    const forged = { ...valid, integrityHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    await expect(fixture.store.recordRoomCapabilityRegistry(recordInput(
      fixture,
      forged as RoomBindingCapabilitySnapshotV1,
      { idempotencyKey: "record-capability-registry-forged" },
    ))).rejects.toMatchObject({ code: "capability_registry_invalid" });

    const staleAt = "2026-07-19T10:10:00.000Z";
    const stale = capabilitySnapshot(fixture.bindingId, CREATED_AT);
    await expect(fixture.store.recordRoomCapabilityRegistry(recordInput(
      fixture,
      stale,
      { idempotencyKey: "record-capability-registry-stale", asOf: staleAt },
    ))).rejects.toMatchObject({ code: "capability_registry_invalid" });
    await expect(fixture.store.getRoomCapabilityRegistry(fixture.roomId)).resolves.toBeNull();

    const fenced = await createFixture(
      "project-room-capability-registry-fence",
      "room-capability-registry-fence",
      "binding-capability-registry-fence",
    );
    const takeover = await fenced.leaseStore.acquireLease({
      leaseId: "lease-capability-registry-fence-takeover",
      roomId: fenced.roomId,
      kind: "room_worker",
      resourceId: fenced.roomId,
      holderId: "worker-capability-registry-takeover",
      hostId: "windows-capability-registry-takeover",
      expectedEpoch: fenced.workerLease.epoch,
      now: "2026-07-19T10:31:00.000Z",
      expiresAt: "2026-07-19T11:00:00.000Z",
    });
    expect(takeover.ok).toBe(true);
    await expect(fenced.store.recordRoomCapabilityRegistry(recordInput(
      fenced,
      capabilitySnapshot(fenced.bindingId, "2026-07-19T10:31:00.000Z"),
      { idempotencyKey: "record-capability-registry-stale-worker", asOf: "2026-07-19T10:31:00.000Z" },
    ))).rejects.toThrow(/lease|fence|epoch/i);
  });

  it("enforces registry revision CAS and detects mutable-projection drift on read", async () => {
    const fixture = await createFixture();
    const recorded = await fixture.store.recordRoomCapabilityRegistry(recordInput(
      fixture,
      capabilitySnapshot(fixture.bindingId),
    ));
    const revised = capabilitySnapshot(fixture.bindingId, "2026-07-19T10:02:00.000Z", 2);
    await expect(fixture.store.recordRoomCapabilityRegistry(recordInput(
      fixture,
      revised,
      {
        expectedAggregateVersion: 1,
        expectedRegistryRevision: 0,
        idempotencyKey: "record-capability-registry-stale-revision",
        asOf: "2026-07-19T10:02:00.000Z",
      },
    ))).rejects.toMatchObject({ code: "capability_registry_conflict" });

    await fixture.layer.db
      .update(roomCapabilityRegistryProjections)
      .set({ workerLeaseEpoch: recorded.projection.workerFence.expectedEpoch + 1 })
      .where(and(
        eq(roomCapabilityRegistryProjections.projectId, fixture.projectId),
        eq(roomCapabilityRegistryProjections.roomId, fixture.roomId),
      ));
    await expect(fixture.store.getRoomCapabilityRegistry(fixture.roomId))
      .rejects.toMatchObject({ code: "capability_registry_drift" });
  });
});
