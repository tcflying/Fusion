import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  createGlobalCapacityLedgerPostgresPorts,
  type GlobalCapacityLedgerAcquireInputV1,
  type GlobalCapacityLedgerPolicyV1,
  type GlobalCapacityLedgerPostgresPortsV1,
} from "../../global-capacity-ledger-postgres.js";
import { createGlobalCapacityPolicyAuthorityStore } from "../../global-capacity-policy-authority.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { globalConcurrency } from "../../postgres/schema/central.js";
import { operationalRooms, roomGlobalConcurrencyClaims } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-capacity-a";
const PROJECT_B = "project-capacity-b";
const AS_OF = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-20T00:05:00.000Z";
const RENEWED_EXPIRES_AT = "2026-07-20T00:10:00.000Z";
const AFTER_EXPIRY = "2026-07-20T00:06:00.000Z";

const DEFAULT_POLICY = {
  reservations: {
    verifierSlots: 0,
    recoverySlots: 0,
    legacyTaskTriageSlots: 0,
  },
  snapshotTtlMs: 60_000,
  leaseTtlMs: 300_000,
} as const satisfies GlobalCapacityLedgerPolicyV1;

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;
let trustedNow = AS_OF;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-global-capacity-ledger-"));
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
  if (!sharedLayer) throw new Error("Global capacity ledger PostgreSQL fixture was not started");
  return sharedLayer;
}

function createPorts(
  projectId: string,
  policy: GlobalCapacityLedgerPolicyV1 = DEFAULT_POLICY,
): GlobalCapacityLedgerPostgresPortsV1 {
  return createGlobalCapacityLedgerPostgresPorts({
    layer: createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    projectId,
    policy,
    now: () => trustedNow,
  });
}

function createAuthorityStore() {
  return createGlobalCapacityPolicyAuthorityStore({
    layer: requireLayer(),
    now: () => trustedNow,
  });
}

async function installVerifiedPolicy(
  policy: GlobalCapacityLedgerPolicyV1 = DEFAULT_POLICY,
): Promise<void> {
  await createAuthorityStore().install({ expectedRevision: 0, policy });
}

async function replaceVerifiedPolicy(policy: GlobalCapacityLedgerPolicyV1): Promise<void> {
  await createAuthorityStore().update({ expectedRevision: 1, policy });
}

async function setGlobalLimit(globalMaxConcurrent: number): Promise<void> {
  await requireLayer().db
    .update(globalConcurrency)
    .set({ globalMaxConcurrent, currentlyActive: 0, queuedCount: 0, updatedAt: AS_OF })
    .where(sql`${globalConcurrency.id} = 1`);
}

function acquire(
  ports: GlobalCapacityLedgerPostgresPortsV1,
  overrides: Partial<Omit<GlobalCapacityLedgerAcquireInputV1, "contractVersion">> = {},
): Promise<Awaited<ReturnType<GlobalCapacityLedgerPostgresPortsV1["acquire"]>>> {
  return ports.acquire({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    projectId: PROJECT_A,
    resourceKind: "legacy_task",
    resourceId: "task-a",
    claimId: "claim-a",
    operationId: "acquire-a",
    workClass: "normal",
    slots: 1,
    holderId: "worker-a",
    leaseId: "lease-a",
    fence: 1,
    asOf: AS_OF,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  trustedNow = AS_OF;
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
  ].join("; ")));
  await setGlobalLimit(4);
  await installVerifiedPolicy();
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

describe("global capacity ledger PostgreSQL ports", () => {
  it("does not let a project port seed missing central capacity policy state", async () => {
    await requireLayer().db.execute(sql.raw([
      "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
      "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
      "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
      "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
    ].join("; ")));

    const ports = createPorts(PROJECT_A);
    await expect(ports.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: AS_OF,
    })).rejects.toThrow("central policy authority installs a verified policy");
    await expect(acquire(ports)).resolves.toMatchObject({
      action: "rejected",
      reason: "capacity_policy_unavailable",
    });
  });

  it("serializes legacy and Room claims across projects without exposing foreign resource identities", async () => {
    await setGlobalLimit(2);
    const a = createPorts(PROJECT_A);
    const b = createPorts(PROJECT_B);

    await expect(acquire(a)).resolves.toMatchObject({
      action: "acquired",
      reason: "capacity_admitted",
      replayed: false,
      claimId: "claim-a",
      fence: 1,
    });
    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b",
      claimId: "room-claim-b",
      operationId: "room-acquire-b",
      holderId: "room-worker-b",
      leaseId: "room-lease-b",
      fence: 3,
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });

    await expect(acquire(a, {
      resourceKind: "legacy_triage",
      resourceId: "triage-a",
      claimId: "claim-triage-a",
      operationId: "acquire-triage-a",
      holderId: "triage-worker-a",
      leaseId: "triage-lease-a",
      fence: 2,
    })).resolves.toMatchObject({
      action: "held",
      reason: "global_capacity_exhausted",
      claimId: null,
      fence: null,
    });

    const snapshot = await a.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: AS_OF,
    });
    expect(snapshot.totalSlots).toBe(2);
    expect(snapshot.ownClaims).toEqual([
      expect.objectContaining({ claimId: "claim-a", resourceKind: "legacy_task", resourceId: "task-a" }),
    ]);
    expect(snapshot.foreignOccupancy).toEqual({
      totalSlots: 1,
      legacyTaskSlots: 0,
      legacyTriageSlots: 0,
      roomWorkerSlots: 1,
      normalSlots: 1,
      verifierSlots: 0,
      recoverySlots: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain("room-b");
    expect(JSON.stringify(snapshot)).not.toContain("room-worker-b");
  });

  it("halts every central admission while a live pre-central Room claim still exists", async () => {
    await requireLayer().db.insert(operationalRooms).values({
      id: "legacy-room-cutover-a",
      projectId: PROJECT_A,
      objective: "complete the durable capacity cutover",
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
    await requireLayer().db.insert(roomGlobalConcurrencyClaims).values({
      id: "legacy-room-cutover-claim-a",
      projectId: PROJECT_A,
      roomId: "legacy-room-cutover-a",
      workClass: "normal",
      slots: 1,
      holderId: "legacy-room-worker-a",
      leaseId: "legacy-room-lease-a",
      fence: 1,
      acquiredAt: AS_OF,
      expiresAt: EXPIRES_AT,
      releasedAt: null,
    });
    const a = createPorts(PROJECT_A);
    const b = createPorts(PROJECT_B);

    await expect(acquire(a)).resolves.toMatchObject({
      action: "held",
      reason: "legacy_room_migration_pending",
    });
    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b",
      claimId: "room-b-cutover-claim",
      operationId: "room-b-cutover-acquire",
      holderId: "room-worker-b",
      leaseId: "room-lease-b",
      fence: 1,
    })).resolves.toMatchObject({
      action: "held",
      reason: "legacy_room_migration_pending",
    });

    await requireLayer().db
      .update(roomGlobalConcurrencyClaims)
      .set({ releasedAt: AS_OF })
      .where(eq(roomGlobalConcurrencyClaims.id, "legacy-room-cutover-claim-a"));

    await expect(acquire(a, {
      resourceId: "task-after-room-cutover",
      claimId: "task-after-room-cutover-claim",
      operationId: "task-after-room-cutover-acquire",
      leaseId: "task-after-room-cutover-lease",
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
  });

  it("makes acquire replay-safe, fences renew/release, and reclaims expired capacity", async () => {
    await setGlobalLimit(1);
    const ports = createPorts(PROJECT_A);

    const first = await acquire(ports);
    const replay = await acquire(ports);
    expect(first).toMatchObject({ action: "acquired", replayed: false });
    expect(replay).toMatchObject({ action: "acquired", replayed: true, claimId: "claim-a", fence: 1 });
    await expect(acquire(ports, { expiresAt: "2099-01-01T00:00:00.000Z" })).resolves.toMatchObject({
      action: "acquired",
      replayed: true,
    });

    trustedNow = "2026-07-20T00:01:00.000Z";
    await expect(ports.renew({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task",
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "renew-stale",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 2,
      asOf: AS_OF,
      expiresAt: RENEWED_EXPIRES_AT,
    })).resolves.toMatchObject({ action: "rejected", reason: "stale_fence" });

    await expect(ports.renew({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task",
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "renew-a",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 1,
      asOf: AS_OF,
      expiresAt: RENEWED_EXPIRES_AT,
    })).resolves.toMatchObject({ action: "renewed", reason: "capacity_renewed", claimId: "claim-a" });

    trustedNow = "2026-07-20T00:05:00.000Z";
    await expect(acquire(ports, {
      resourceId: "task-after-expiry",
      claimId: "claim-after-expiry",
      operationId: "acquire-after-expiry",
      leaseId: "lease-after-expiry",
      asOf: "2026-07-20T00:05:00.000Z",
      expiresAt: "2026-07-20T00:11:00.000Z",
    })).resolves.toMatchObject({ action: "held", reason: "global_capacity_exhausted" });

    trustedNow = "2026-07-20T00:07:00.000Z";
    await expect(acquire(ports, {
      resourceId: "task-after-renewed-expiry",
      claimId: "claim-after-renewed-expiry",
      operationId: "acquire-after-renewed-expiry",
      leaseId: "lease-after-renewed-expiry",
      asOf: "2026-07-20T00:07:00.000Z",
      expiresAt: "2026-07-20T00:12:00.000Z",
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
  });

  it("derives lease expiry from verified policy and replays acknowledged operations after host expiry", async () => {
    await setGlobalLimit(1);
    const ports = createPorts(PROJECT_A);

    await expect(acquire(ports, { expiresAt: "2099-01-01T00:00:00.000Z" })).resolves.toMatchObject({
      action: "acquired",
      replayed: false,
    });

    trustedNow = "2026-07-20T00:01:00.000Z";
    const renew = {
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task" as const,
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "renew-a",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 1,
      asOf: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await expect(ports.renew(renew)).resolves.toMatchObject({ action: "renewed", replayed: false });

    const beforeExpiry = await ports.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: "2099-01-01T00:00:00.000Z",
    });
    expect(beforeExpiry.ownClaims).toEqual([
      expect.objectContaining({ claimId: "claim-a", expiresAt: "2026-07-20T00:06:00.000Z" }),
    ]);

    trustedNow = "2026-07-20T00:07:00.000Z";
    await expect(acquire(ports, { expiresAt: "2000-01-01T00:00:00.000Z" })).resolves.toMatchObject({
      action: "acquired",
      replayed: true,
    });
    await expect(ports.renew({
      ...renew,
      asOf: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    })).resolves.toMatchObject({ action: "renewed", replayed: true });
  });

  it("releases only the matching durable identity and replays a completed release without double-freeing", async () => {
    await setGlobalLimit(1);
    const a = createPorts(PROJECT_A);
    const b = createPorts(PROJECT_B);
    await acquire(a);

    await expect(b.release({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_B,
      resourceKind: "legacy_task",
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "foreign-release",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 1,
      asOf: AS_OF,
    })).resolves.toMatchObject({ action: "rejected", reason: "claim_not_found" });
    await expect(a.release({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task",
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "stale-release",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 2,
      asOf: AS_OF,
    })).resolves.toMatchObject({ action: "rejected", reason: "stale_fence" });

    const release = {
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task" as const,
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "release-a",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 1,
      asOf: AS_OF,
    };
    await expect(a.release(release)).resolves.toMatchObject({
      action: "released",
      reason: "capacity_released",
      replayed: false,
    });
    await expect(a.release(release)).resolves.toMatchObject({
      action: "released",
      reason: "capacity_released",
      replayed: true,
    });
    await expect(acquire(a, {
      claimId: "claim-after-release",
      operationId: "acquire-after-release",
      leaseId: "lease-after-release",
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
  });

  it("protects legacy task and triage reserve from Room normal work while allowing legacy work to consume it", async () => {
    await setGlobalLimit(4);
    const policy = {
      reservations: {
        verifierSlots: 1,
        recoverySlots: 1,
        legacyTaskTriageSlots: 1,
      },
      snapshotTtlMs: 60_000,
      leaseTtlMs: 300_000,
    } as const satisfies GlobalCapacityLedgerPolicyV1;
    await replaceVerifiedPolicy(policy);
    const a = createPorts(PROJECT_A, policy);
    const b = createPorts(PROJECT_B, policy);

    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b",
      claimId: "room-normal-a",
      operationId: "room-normal-a-op",
      holderId: "room-worker-b",
      leaseId: "room-lease-b",
      fence: 1,
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });

    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b-2",
      claimId: "room-normal-b",
      operationId: "room-normal-b-op",
      holderId: "room-worker-b-2",
      leaseId: "room-lease-b-2",
      fence: 2,
    })).resolves.toMatchObject({
      action: "held",
      reason: "legacy_task_triage_reserve_protected",
    });

    await expect(acquire(a)).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
  });

  it("binds one verified reservation policy globally and never lets a mismatched project bypass it", async () => {
    await setGlobalLimit(2);
    const protectedPolicy = {
      reservations: {
        verifierSlots: 0,
        recoverySlots: 0,
        legacyTaskTriageSlots: 1,
      },
      snapshotTtlMs: 60_000,
      leaseTtlMs: 300_000,
    } as const satisfies GlobalCapacityLedgerPolicyV1;
    await replaceVerifiedPolicy(protectedPolicy);
    const a = createPorts(PROJECT_A, protectedPolicy);
    const bWithMismatchedPolicy = createPorts(PROJECT_B, DEFAULT_POLICY);
    const aWithMismatchedPolicy = createPorts(PROJECT_A, DEFAULT_POLICY);

    await expect(acquire(a)).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
    await expect(acquire(bWithMismatchedPolicy, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b",
      claimId: "room-b-claim",
      operationId: "room-b-acquire",
      holderId: "room-worker-b",
      leaseId: "room-lease-b",
      fence: 1,
    })).resolves.toMatchObject({ action: "rejected", reason: "policy_mismatch" });

    await expect(aWithMismatchedPolicy.release({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task",
      resourceId: "task-a",
      claimId: "claim-a",
      operationId: "release-after-policy-change",
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 1,
      asOf: "2026-07-20T00:01:00.000Z",
    })).resolves.toMatchObject({ action: "released", reason: "capacity_released" });
  });

  it("uses its host-owned clock so a future project timestamp cannot expire foreign capacity", async () => {
    await setGlobalLimit(1);
    const a = createPorts(PROJECT_A);
    const b = createPorts(PROJECT_B);
    await expect(acquire(a)).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });

    const futureSnapshot = await b.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_B,
      asOf: "2099-01-01T00:00:00.000Z",
    });
    expect(futureSnapshot.observedAt).toBe(AS_OF);
    expect(futureSnapshot.foreignOccupancy.totalSlots).toBe(1);

    const aSnapshot = await a.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: "2099-01-01T00:00:00.000Z",
    });
    expect(aSnapshot.ownClaims).toEqual([expect.objectContaining({ claimId: "claim-a" })]);

    trustedNow = AFTER_EXPIRY;
    await expect(a.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: AS_OF,
    })).resolves.toMatchObject({ ownClaims: [] });
  });

  it("namespaces claim IDs by project while rejecting duplicate active resource identities", async () => {
    await setGlobalLimit(3);
    const a = createPorts(PROJECT_A);
    const b = createPorts(PROJECT_B);
    await expect(acquire(a)).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });

    await expect(acquire(a, {
      claimId: "claim-a-second",
      operationId: "acquire-a-second",
      leaseId: "lease-a-second",
    })).resolves.toMatchObject({ action: "rejected", reason: "claim_conflict" });

    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-b",
      claimId: "claim-a",
      operationId: "acquire-b-same-claim-id",
      holderId: "room-worker-b",
      leaseId: "room-lease-b",
      fence: 1,
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted", claimId: "claim-a" });
  });

  it("protects unfilled recovery capacity from a multi-slot verifier request", async () => {
    await setGlobalLimit(4);
    const policy = {
      reservations: {
        verifierSlots: 0,
        recoverySlots: 1,
        legacyTaskTriageSlots: 0,
      },
      snapshotTtlMs: 60_000,
      leaseTtlMs: 300_000,
    } as const satisfies GlobalCapacityLedgerPolicyV1;
    await replaceVerifiedPolicy(policy);
    const a = createPorts(PROJECT_A, policy);
    const b = createPorts(PROJECT_B, policy);

    await expect(acquire(a, { slots: 2 })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-verifier-b",
      claimId: "verifier-claim-b",
      operationId: "verifier-acquire-b",
      workClass: "verifier",
      slots: 2,
      holderId: "verifier-worker-b",
      leaseId: "verifier-lease-b",
      fence: 1,
    })).resolves.toMatchObject({ action: "held", reason: "reserved_capacity_protected" });

    await expect(acquire(b, {
      projectId: PROJECT_B,
      resourceKind: "room_worker",
      resourceId: "room-recovery-b",
      claimId: "recovery-claim-b",
      operationId: "recovery-acquire-b",
      workClass: "recovery",
      holderId: "recovery-worker-b",
      leaseId: "recovery-lease-b",
      fence: 2,
    })).resolves.toMatchObject({ action: "acquired", reason: "capacity_admitted" });
  });
});
