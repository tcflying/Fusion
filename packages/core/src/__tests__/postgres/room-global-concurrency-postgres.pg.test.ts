import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
  createRoomGlobalConcurrencyPostgresPorts,
  type RoomGlobalConcurrencyPostgresClaimStoreCommandV1,
  type RoomGlobalConcurrencyPostgresLegacySnapshotV1,
  type RoomGlobalConcurrencyPostgresPolicyV1,
  type RoomGlobalConcurrencyPostgresPortsV1,
  type RoomGlobalConcurrencyPostgresRenewInputV1,
  type RoomGlobalConcurrencyPostgresSnapshotV1,
} from "../../room-global-concurrency-postgres.js";
import { type GlobalCapacityLedgerPolicyV1 } from "../../global-capacity-ledger-postgres.js";
import { createGlobalCapacityPolicyAuthorityStore } from "../../global-capacity-policy-authority.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomGlobalConcurrencyClaims,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-global-concurrency-a";
const PROJECT_B = "project-global-concurrency-b";
const ROOM_A = "room-global-concurrency-a";
const ROOM_B = "room-global-concurrency-b";
const AS_OF = "2026-07-19T14:00:00.000Z";
const EXPIRES_AT = "2026-07-19T14:05:00.000Z";
const RENEWED_EXPIRES_AT = "2026-07-19T14:10:00.000Z";
const LATER = "2026-07-19T14:06:00.000Z";

const DEFAULT_POLICY = {
  totalSlots: 8,
  reservations: {
    verifierSlots: 2,
    recoverySlots: 1,
    legacyTaskTriageSlots: 0,
  },
  snapshotTtlMs: 60_000,
} as const satisfies RoomGlobalConcurrencyPostgresPolicyV1;

const CENTRAL_POLICY = {
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
let legacySnapshot: RoomGlobalConcurrencyPostgresLegacySnapshotV1 = {
  activeTaskSlots: 0,
  activeTriageSlots: 0,
  queuedTaskSlots: 0,
  queuedTriageSlots: 0,
};

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-global-concurrency-"));
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
  if (!sharedLayer) throw new Error("Room global-concurrency PostgreSQL fixture was not started");
  return sharedLayer;
}

function createPorts(
  projectId: string,
  policy: RoomGlobalConcurrencyPostgresPolicyV1 = DEFAULT_POLICY,
): RoomGlobalConcurrencyPostgresPortsV1 {
  return createRoomGlobalConcurrencyPostgresPorts({
    layer: createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    policy,
    legacySnapshotReader: {
      readSnapshot: async () => legacySnapshot,
    },
  });
}

async function createRoom(projectId: string, roomId: string): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: roomId,
    projectId,
    objective: `Use durable global concurrency for ${roomId}`,
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

async function installCentralCapacityPolicy(): Promise<void> {
  await createGlobalCapacityPolicyAuthorityStore({
    layer: requireLayer(),
    now: () => AS_OF,
  }).install({ expectedRevision: 0, policy: CENTRAL_POLICY });
}

async function readSnapshot(
  ports: RoomGlobalConcurrencyPostgresPortsV1,
  projectId: string,
  asOf = AS_OF,
): Promise<RoomGlobalConcurrencyPostgresSnapshotV1> {
  return ports.snapshotPort.readSnapshot({
    contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
    projectId,
    asOf,
  });
}

function acquireCommand(
  snapshot: RoomGlobalConcurrencyPostgresSnapshotV1,
  overrides: {
    readonly projectId?: string;
    readonly roomId?: string;
    readonly claimId?: string;
    readonly operationId?: string;
    readonly workClass?: "normal" | "verifier" | "recovery";
    readonly slots?: number;
    readonly holderId?: string;
    readonly leaseId?: string;
    readonly fence?: number;
    readonly asOf?: string;
    readonly expiresAt?: string;
  } = {},
): Extract<RoomGlobalConcurrencyPostgresClaimStoreCommandV1, { readonly kind: "acquire" }> {
  const request = {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
    projectId: overrides.projectId ?? PROJECT_A,
    roomId: overrides.roomId ?? ROOM_A,
    claimId: overrides.claimId ?? "claim-a",
    operationId: overrides.operationId ?? "acquire-a",
    workClass: overrides.workClass ?? "normal",
    slots: overrides.slots ?? 1,
    holderId: overrides.holderId ?? "worker-a",
    leaseId: overrides.leaseId ?? "lease-a",
    fence: overrides.fence ?? 2,
    asOf: overrides.asOf ?? AS_OF,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
  } as const;
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
    kind: "acquire",
    expectedSnapshotId: snapshot.snapshotId,
    claimId: request.claimId,
    fence: request.fence,
    request,
    budget: {
      totalSlots: 1,
      occupiedSlots: 0,
      legacyTaskTriageActiveSlots: 0,
      roomActiveSlots: 0,
      normalOccupiedSlots: 0,
      verifierOccupiedSlots: 0,
      recoveryOccupiedSlots: 0,
      protectedLegacyTaskTriageSlots: 0,
      normalLimitSlots: 1,
      verifierLimitSlots: 1,
      recoveryLimitSlots: 1,
      requestedWorkClass: request.workClass,
      requestedSlots: request.slots,
    },
  };
}

function releaseCommand(
  snapshot: RoomGlobalConcurrencyPostgresSnapshotV1,
  overrides: {
    readonly projectId?: string;
    readonly roomId?: string;
    readonly claimId?: string;
    readonly operationId?: string;
    readonly holderId?: string;
    readonly leaseId?: string;
    readonly fence?: number;
    readonly asOf?: string;
  } = {},
): Extract<RoomGlobalConcurrencyPostgresClaimStoreCommandV1, { readonly kind: "release" }> {
  const request = {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
    projectId: overrides.projectId ?? PROJECT_A,
    roomId: overrides.roomId ?? ROOM_A,
    claimId: overrides.claimId ?? "claim-a",
    operationId: overrides.operationId ?? "release-a",
    holderId: overrides.holderId ?? "worker-a",
    leaseId: overrides.leaseId ?? "lease-a",
    fence: overrides.fence ?? 2,
    asOf: overrides.asOf ?? AS_OF,
  } as const;
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
    kind: "release",
    expectedSnapshotId: snapshot.snapshotId,
    claimId: request.claimId,
    fence: request.fence,
    request,
    claim: snapshot.roomClaims.find((claim) => claim.claimId === request.claimId) ?? null,
  };
}

function renewInput(
  overrides: {
    readonly projectId?: string;
    readonly roomId?: string;
    readonly claimId?: string;
    readonly operationId?: string;
    readonly holderId?: string;
    readonly leaseId?: string;
    readonly fence?: number;
    readonly asOf?: string;
    readonly expiresAt?: string;
  } = {},
): RoomGlobalConcurrencyPostgresRenewInputV1 {
  const claimId = overrides.claimId ?? "claim-a";
  return {
    projectId: overrides.projectId ?? PROJECT_A,
    roomId: overrides.roomId ?? ROOM_A,
    claimId,
    operationId: overrides.operationId ?? "renew-a",
    holderId: overrides.holderId ?? "worker-a",
    leaseId: overrides.leaseId ?? "lease-a",
    fence: overrides.fence ?? 2,
    asOf: overrides.asOf ?? AS_OF,
    expiresAt: overrides.expiresAt ?? RENEWED_EXPIRES_AT,
  };
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  legacySnapshot = {
    activeTaskSlots: 0,
    activeTriageSlots: 0,
    queuedTaskSlots: 0,
    queuedTriageSlots: 0,
  };
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE project.room_global_concurrency_state RESTART IDENTITY",
    "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
  ].join("; ")));
  await createRoom(PROJECT_A, ROOM_A);
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

describe("Room global concurrency PostgreSQL ports", () => {
  it("serializes central policy installation against a retired Room acquire so exactly one capacity epoch wins", async () => {
    const ports = createPorts(PROJECT_A);
    const initial = await readSnapshot(ports, PROJECT_A);

    const [policyInstallation, legacyAcquire] = await Promise.allSettled([
      installCentralCapacityPolicy(),
      ports.claimStore.apply(acquireCommand(initial, {
        claimId: "cutover-race-legacy-claim",
        operationId: "cutover-race-legacy-acquire",
      })),
    ]);

    const centralInstalled = policyInstallation.status === "fulfilled";
    const legacyAcquired = legacyAcquire.status === "fulfilled"
      && legacyAcquire.value.ok
      && legacyAcquire.value.action === "acquired";
    expect(Number(centralInstalled) + Number(legacyAcquired)).toBe(1);

    if (centralInstalled) {
      expect(legacyAcquire).toEqual({
        status: "fulfilled",
        value: { ok: false, reason: "store_rejected" },
      });
    } else {
      expect(policyInstallation.status).toBe("rejected");
      if (policyInstallation.status === "rejected") {
        expect(String(policyInstallation.reason)).toContain("unsafe while live capacity claims exist");
      }
      expect(legacyAcquire).toMatchObject({
        status: "fulfilled",
        value: { ok: true, action: "acquired", claimId: "cutover-race-legacy-claim" },
      });
    }
  }, 60_000);

  it("withholds retired Room acquires and renewals after central capacity cutover while allowing the legacy claim to drain", async () => {
    const ports = createPorts(PROJECT_A);
    await installCentralCapacityPolicy();

    const initial = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.apply(acquireCommand(initial))).resolves.toEqual({
      ok: false,
      reason: "store_rejected",
    });

    await requireLayer().db.insert(roomGlobalConcurrencyClaims).values({
      id: "cutover-legacy-claim",
      projectId: PROJECT_A,
      roomId: ROOM_A,
      workClass: "normal",
      slots: 1,
      holderId: "cutover-legacy-worker",
      leaseId: "cutover-legacy-lease",
      fence: 2,
      acquiredAt: AS_OF,
      expiresAt: EXPIRES_AT,
      releasedAt: null,
    });

    await expect(ports.claimStore.renew(renewInput({
      claimId: "cutover-legacy-claim",
      operationId: "cutover-legacy-renew",
      holderId: "cutover-legacy-worker",
      leaseId: "cutover-legacy-lease",
    }))).resolves.toEqual({ ok: false, reason: "store_rejected" });

    const drainSnapshot = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.apply(releaseCommand(drainSnapshot, {
      claimId: "cutover-legacy-claim",
      operationId: "cutover-legacy-release",
      holderId: "cutover-legacy-worker",
      leaseId: "cutover-legacy-lease",
    }))).resolves.toMatchObject({
      ok: true,
      action: "released",
      claimId: "cutover-legacy-claim",
    });

    const drained = await requireLayer().db
      .select({ releasedAt: roomGlobalConcurrencyClaims.releasedAt })
      .from(roomGlobalConcurrencyClaims)
      .where(eq(roomGlobalConcurrencyClaims.id, "cutover-legacy-claim"));
    expect(drained).toEqual([{ releasedAt: AS_OF }]);
  }, 60_000);

  it("durably acquires and releases once while replaying the same operation without a second mutation", async () => {
    const ports = createPorts(PROJECT_A);
    const initial = await readSnapshot(ports, PROJECT_A);
    const acquire = acquireCommand(initial, { slots: 2 });

    await expect(ports.claimStore.apply(acquire)).resolves.toEqual({
      ok: true,
      action: "acquired",
      replayed: false,
      claimId: "claim-a",
      fence: 2,
    });
    await expect(ports.claimStore.apply(acquire)).resolves.toEqual({
      ok: true,
      action: "acquired",
      replayed: true,
      claimId: "claim-a",
      fence: 2,
    });

    const claimRows = await requireLayer().db
      .select({ id: roomGlobalConcurrencyClaims.id, releasedAt: roomGlobalConcurrencyClaims.releasedAt })
      .from(roomGlobalConcurrencyClaims)
      .where(eq(roomGlobalConcurrencyClaims.id, "claim-a"));
    expect(claimRows).toEqual([{ id: "claim-a", releasedAt: null }]);

    const acquired = await readSnapshot(ports, PROJECT_A);
    const release = releaseCommand(acquired);
    await expect(ports.claimStore.apply(release)).resolves.toEqual({
      ok: true,
      action: "released",
      replayed: false,
      claimId: "claim-a",
      fence: 2,
    });
    await expect(ports.claimStore.apply(release)).resolves.toEqual({
      ok: true,
      action: "released",
      replayed: true,
      claimId: "claim-a",
      fence: 2,
    });

    const releasedRows = await requireLayer().db
      .select({ id: roomGlobalConcurrencyClaims.id, releasedAt: roomGlobalConcurrencyClaims.releasedAt })
      .from(roomGlobalConcurrencyClaims)
      .where(eq(roomGlobalConcurrencyClaims.id, "claim-a"));
    expect(releasedRows).toEqual([{ id: "claim-a", releasedAt: AS_OF }]);
  }, 60_000);

  it("rejects stale snapshots and stale fences without allowing a foreign project to release a claim", async () => {
    const portsA = createPorts(PROJECT_A);
    const portsB = createPorts(PROJECT_B);
    const initial = await readSnapshot(portsA, PROJECT_A);
    await expect(portsA.claimStore.apply(acquireCommand(initial))).resolves.toMatchObject({
      ok: true,
      action: "acquired",
    });

    await expect(portsA.claimStore.apply(acquireCommand(initial, {
      claimId: "claim-stale-snapshot",
      operationId: "acquire-stale-snapshot",
    }))).resolves.toEqual({ ok: false, reason: "snapshot_stale" });

    const current = await readSnapshot(portsA, PROJECT_A);
    await expect(portsA.claimStore.apply(releaseCommand(current, {
      operationId: "release-stale-fence",
      fence: 1,
    }))).resolves.toEqual({ ok: false, reason: "stale_fence" });

    const foreignSnapshot = await readSnapshot(portsB, PROJECT_B);
    expect(foreignSnapshot.roomClaims.some((claim) => claim.claimId === "claim-a")).toBe(false);
    await expect(portsB.claimStore.apply(releaseCommand(foreignSnapshot, {
      projectId: PROJECT_B,
      roomId: ROOM_B,
      operationId: "foreign-release",
    }))).resolves.toEqual({ ok: false, reason: "claim_not_found" });

    const retained = await requireLayer().db
      .select({ releasedAt: roomGlobalConcurrencyClaims.releasedAt })
      .from(roomGlobalConcurrencyClaims)
      .where(eq(roomGlobalConcurrencyClaims.id, "claim-a"));
    expect(retained).toEqual([{ releasedAt: null }]);
  }, 60_000);

  it("expires abandoned claims by TTL before admitting later work", async () => {
    const ports = createPorts(PROJECT_A, {
      totalSlots: 8,
      reservations: {
        verifierSlots: 0,
        recoverySlots: 0,
        legacyTaskTriageSlots: 0,
      },
      snapshotTtlMs: 60_000,
    });
    const initial = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.apply(acquireCommand(initial, {
      claimId: "claim-expired",
      operationId: "acquire-expired",
      slots: 8,
      expiresAt: "2026-07-19T14:01:00.000Z",
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });

    const afterExpiry = await readSnapshot(ports, PROJECT_A, LATER);
    expect(afterExpiry.roomClaims).toEqual([]);
    await expect(ports.claimStore.apply(acquireCommand(afterExpiry, {
      claimId: "claim-after-expiry",
      operationId: "acquire-after-expiry",
      slots: 8,
      asOf: LATER,
      expiresAt: "2026-07-19T14:11:00.000Z",
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });

    const expired = await requireLayer().db
      .select({ releasedAt: roomGlobalConcurrencyClaims.releasedAt })
      .from(roomGlobalConcurrencyClaims)
      .where(eq(roomGlobalConcurrencyClaims.id, "claim-expired"));
    expect(expired).toEqual([{ releasedAt: LATER }]);
  }, 60_000);

  it("fenced-renews a live claim once, exposes the state revision, and safely replays the same operation", async () => {
    const ports = createPorts(PROJECT_A);
    const initial = await readSnapshot(ports, PROJECT_A);
    expect(initial.stateRevision).toBe(0);
    await expect(ports.claimStore.apply(acquireCommand(initial, {
      expiresAt: "2026-07-19T14:01:00.000Z",
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });

    const acquired = await readSnapshot(ports, PROJECT_A);
    expect(acquired.stateRevision).toBe(1);
    const renew = renewInput();
    await expect(ports.claimStore.renew(renew)).resolves.toEqual({
      ok: true,
      action: "renewed",
      replayed: false,
      claimId: "claim-a",
      fence: 2,
      stateRevision: 2,
    });
    await expect(ports.claimStore.renew(renew)).resolves.toEqual({
      ok: true,
      action: "renewed",
      replayed: true,
      claimId: "claim-a",
      fence: 2,
      stateRevision: 2,
    });

    const renewed = await readSnapshot(ports, PROJECT_A);
    expect(renewed.stateRevision).toBe(2);
    expect(renewed.roomClaims).toEqual([expect.objectContaining({
      claimId: "claim-a",
      workClass: "normal",
      slots: 1,
      holderId: "worker-a",
      leaseId: "lease-a",
      fence: 2,
      expiresAt: RENEWED_EXPIRES_AT,
    })]);
  }, 60_000);

  it("rejects global renewal conflicts, regressions, stale fences, released claims, and expired claims", async () => {
    const ports = createPorts(PROJECT_A);
    const initial = await readSnapshot(ports, PROJECT_A);
    await ports.claimStore.apply(acquireCommand(initial, { expiresAt: "2026-07-19T14:01:00.000Z" }));
    const acquired = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.renew(renewInput())).resolves.toMatchObject({ ok: true, action: "renewed" });

    const renewed = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.renew(renewInput({
      expiresAt: "2026-07-19T14:11:00.000Z",
    }))).resolves.toEqual({ ok: false, reason: "idempotency_conflict" });
    await expect(ports.claimStore.renew(renewInput({
      operationId: "renew-backwards",
      expiresAt: EXPIRES_AT,
    }))).resolves.toEqual({ ok: false, reason: "renewal_regression" });
    await expect(ports.claimStore.renew(renewInput({
      operationId: "renew-stale-holder",
      holderId: "worker-other",
    }))).resolves.toEqual({ ok: false, reason: "stale_fence" });

    const release = releaseCommand(renewed, { operationId: "release-after-renew" });
    await expect(ports.claimStore.apply(release)).resolves.toMatchObject({ ok: true, action: "released" });
    await expect(ports.claimStore.renew(renewInput({
      operationId: "renew-released",
    }))).resolves.toEqual({ ok: false, reason: "claim_not_found" });

    const fresh = await readSnapshot(ports, PROJECT_A);
    await ports.claimStore.apply(acquireCommand(fresh, {
      claimId: "claim-expired-renewal",
      operationId: "acquire-expired-renewal",
      expiresAt: "2026-07-19T14:01:00.000Z",
    }));
    await readSnapshot(ports, PROJECT_A, LATER);
    await expect(ports.claimStore.renew(renewInput({
      claimId: "claim-expired-renewal",
      operationId: "renew-expired",
      asOf: LATER,
      expiresAt: "2026-07-19T14:11:00.000Z",
    }))).resolves.toEqual({ ok: false, reason: "claim_expired" });
  }, 60_000);

  it("protects legacy task and triage reserve while retaining verifier and recovery capacity", async () => {
    legacySnapshot = {
      activeTaskSlots: 2,
      activeTriageSlots: 1,
      queuedTaskSlots: 4,
      queuedTriageSlots: 3,
    };
    const ports = createPorts(PROJECT_A, {
      totalSlots: 10,
      reservations: {
        verifierSlots: 2,
        recoverySlots: 1,
        legacyTaskTriageSlots: 4,
      },
      snapshotTtlMs: 60_000,
    });
    const initial = await readSnapshot(ports, PROJECT_A);
    expect(initial.legacy).toEqual(legacySnapshot);
    await expect(ports.claimStore.apply(acquireCommand(initial, {
      claimId: "claim-normal",
      operationId: "acquire-normal",
      slots: 3,
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });

    const afterNormal = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.apply(acquireCommand(afterNormal, {
      claimId: "claim-normal-over-reserve",
      operationId: "acquire-normal-over-reserve",
      slots: 1,
    }))).resolves.toEqual({ ok: false, reason: "store_rejected" });
    await expect(ports.claimStore.apply(acquireCommand(afterNormal, {
      claimId: "claim-verifier",
      operationId: "acquire-verifier",
      workClass: "verifier",
      slots: 1,
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });

    const afterVerifier = await readSnapshot(ports, PROJECT_A);
    await expect(ports.claimStore.apply(acquireCommand(afterVerifier, {
      claimId: "claim-recovery",
      operationId: "acquire-recovery",
      workClass: "recovery",
      slots: 1,
    }))).resolves.toMatchObject({ ok: true, action: "acquired" });
  }, 60_000);
});
