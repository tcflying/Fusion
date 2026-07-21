import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  GLOBAL_CAPACITY_LEDGER_STATE_ID,
  type GlobalCapacityLedgerPolicyV1,
} from "../../global-capacity-ledger-postgres.js";
import {
  GLOBAL_CAPACITY_POLICY_AUTHORITY_ID,
  createGlobalCapacityPolicyAuthorityStore,
  loadGlobalCapacityPolicyAuthority,
} from "../../global-capacity-policy-authority.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  globalCapacityPolicyAuthority,
  globalCapacityState,
  globalConcurrency,
} from "../../postgres/schema/central.js";
import { operationalRooms, roomGlobalConcurrencyClaims } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-authority-a";
const PROJECT_B = "project-authority-b";
const AS_OF = "2026-07-20T00:00:00.000Z";
const DEFAULT_POLICY = {
  reservations: {
    verifierSlots: 0,
    recoverySlots: 0,
    legacyTaskTriageSlots: 0,
  },
  snapshotTtlMs: 60_000,
  leaseTtlMs: 300_000,
} as const satisfies GlobalCapacityLedgerPolicyV1;
const UPDATED_POLICY = {
  ...DEFAULT_POLICY,
  reservations: {
    ...DEFAULT_POLICY.reservations,
    verifierSlots: 1,
  },
} as const satisfies GlobalCapacityLedgerPolicyV1;

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;
let trustedNow = AS_OF;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-global-capacity-policy-authority-"));
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
  if (!sharedLayer) throw new Error("Global capacity policy authority PostgreSQL fixture was not started");
  return sharedLayer;
}

function createStore() {
  return createGlobalCapacityPolicyAuthorityStore({
    layer: requireLayer(),
    now: () => trustedNow,
  });
}

async function installDefaultPolicy() {
  return createStore().install({ expectedRevision: 0, policy: DEFAULT_POLICY });
}

async function createLiveLegacyRoomClaim(id: string): Promise<void> {
  const roomId = `legacy-room-${id}`;
  await requireLayer().db.insert(operationalRooms).values({
    id: roomId,
    projectId: PROJECT_A,
    objective: "drain legacy Room capacity before central policy cutover",
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
    id,
    projectId: PROJECT_A,
    roomId,
    workClass: "normal",
    slots: 1,
    holderId: `legacy-worker-${id}`,
    leaseId: `legacy-lease-${id}`,
    fence: 1,
    acquiredAt: AS_OF,
    expiresAt: "2026-07-20T00:05:00.000Z",
    releasedAt: null,
  });
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  trustedNow = AS_OF;
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE project.room_global_concurrency_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE project.room_global_concurrency_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
  ].join("; ")));
  await requireLayer().db
    .update(globalConcurrency)
    .set({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, updatedAt: AS_OF })
    .where(eq(globalConcurrency.id, 1));
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

describe("global capacity policy authority", () => {
  it("fails closed while the central host has not deliberately installed a policy", async () => {
    await expect(createStore().read()).rejects.toThrow("not installed");
    await expect(loadGlobalCapacityPolicyAuthority({ layer: requireLayer(), now: () => trustedNow }))
      .rejects.toThrow("not installed");
  });

  it("installs one immutable central policy and creates usable ports for multiple projects", async () => {
    const installed = await installDefaultPolicy();
    const authority = await loadGlobalCapacityPolicyAuthority({ layer: requireLayer(), now: () => trustedNow });
    const a = authority.createProjectPorts(PROJECT_A);
    const b = authority.createProjectPorts(PROJECT_B);

    expect(installed).toMatchObject({ revision: 1, policyHash: authority.policyHash, policy: DEFAULT_POLICY });
    expect(authority.policy).toEqual(DEFAULT_POLICY);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.policy)).toBe(true);
    expect(Object.isFrozen(authority.policy.reservations)).toBe(true);
    await expect(a.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: AS_OF,
    })).resolves.toMatchObject({ reservations: DEFAULT_POLICY.reservations });
    await expect(b.readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_B,
      asOf: AS_OF,
    })).resolves.toMatchObject({ reservations: DEFAULT_POLICY.reservations });
  });

  it("fails closed for malformed and hash-drift central policy records", async () => {
    await requireLayer().db.insert(globalCapacityPolicyAuthority).values({
      id: GLOBAL_CAPACITY_POLICY_AUTHORITY_ID,
      policyJson: { reservations: {} },
      policyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
      updatedAt: AS_OF,
    });
    await requireLayer().db.insert(globalCapacityState).values({
      id: GLOBAL_CAPACITY_LEDGER_STATE_ID,
      revision: 0,
      policyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      updatedAt: AS_OF,
    });
    await expect(createStore().read()).rejects.toThrow("policy is invalid");

    await requireLayer().db.execute(sql.raw([
      "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
      "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    ].join("; ")));
    await requireLayer().db.insert(globalCapacityPolicyAuthority).values({
      id: GLOBAL_CAPACITY_POLICY_AUTHORITY_ID,
      policyJson: DEFAULT_POLICY,
      policyHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      revision: 1,
      updatedAt: AS_OF,
    });
    await requireLayer().db.insert(globalCapacityState).values({
      id: GLOBAL_CAPACITY_LEDGER_STATE_ID,
      revision: 0,
      policyHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      updatedAt: AS_OF,
    });
    await expect(createStore().read()).rejects.toThrow("hash does not match");
  });

  it("rejects a stale optimistic update without overwriting the installed policy", async () => {
    await installDefaultPolicy();
    const store = createStore();
    await expect(store.update({ expectedRevision: 1, policy: UPDATED_POLICY })).resolves.toMatchObject({ revision: 2, policy: UPDATED_POLICY });
    await expect(store.update({ expectedRevision: 1, policy: DEFAULT_POLICY })).rejects.toThrow("revision is stale");
    await expect(store.read()).resolves.toMatchObject({ revision: 2, policy: UPDATED_POLICY });
  });

  it("keeps the installed lease TTL immutable so live Room controllers never acquire under divergent expiry", async () => {
    await installDefaultPolicy();
    const store = createStore();
    await expect(store.update({
      expectedRevision: 1,
      policy: { ...UPDATED_POLICY, leaseTtlMs: DEFAULT_POLICY.leaseTtlMs + 60_000 },
    })).rejects.toThrow("cannot change the installed lease TTL");
    await expect(store.read()).resolves.toMatchObject({ revision: 1, policy: DEFAULT_POLICY });
  });

  it("withholds policy replacement while a live claim still depends on the prior policy", async () => {
    await installDefaultPolicy();
    const authority = await loadGlobalCapacityPolicyAuthority({ layer: requireLayer(), now: () => trustedNow });
    const ports = authority.createProjectPorts(PROJECT_A);
    await expect(ports.acquire({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      resourceKind: "legacy_task",
      resourceId: "task-live",
      claimId: "claim-live",
      operationId: "claim-live-op",
      workClass: "normal",
      slots: 1,
      holderId: "host-live",
      leaseId: "lease-live",
      fence: 1,
      asOf: AS_OF,
      expiresAt: "2026-07-20T00:05:00.000Z",
    })).resolves.toMatchObject({ action: "acquired" });
    await expect(createStore().update({ expectedRevision: 1, policy: UPDATED_POLICY }))
      .rejects.toThrow("unsafe while live capacity claims exist");
    await expect(createStore().read()).resolves.toMatchObject({ revision: 1, policy: DEFAULT_POLICY });
  });

  it("rejects initial installation and policy replacement until legacy Room capacity has drained", async () => {
    await createLiveLegacyRoomClaim("legacy-room-install-claim");
    await expect(installDefaultPolicy()).rejects.toThrow("unsafe while live capacity claims exist");

    await requireLayer().db
      .update(roomGlobalConcurrencyClaims)
      .set({ releasedAt: AS_OF })
      .where(eq(roomGlobalConcurrencyClaims.id, "legacy-room-install-claim"));
    await installDefaultPolicy();

    await createLiveLegacyRoomClaim("legacy-room-update-claim");
    await expect(createStore().update({ expectedRevision: 1, policy: UPDATED_POLICY }))
      .rejects.toThrow("unsafe while live capacity claims exist");
  });
});
