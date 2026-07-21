import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  createGlobalCapacityLegacyAttemptStore,
  toGlobalCapacityLegacyAttemptReference,
  type GlobalCapacityLegacyAttemptV1,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptPrepareResultV1,
} from "../../global-capacity-legacy-attempt-postgres.js";
import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  createGlobalCapacityLedgerPostgresPorts,
  type GlobalCapacityLedgerPolicyV1,
} from "../../global-capacity-ledger-postgres.js";
import { createGlobalCapacityPolicyAuthorityStore } from "../../global-capacity-policy-authority.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { globalConcurrency } from "../../postgres/schema/central.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-legacy-attempt-a";
const AS_OF = "2026-07-20T00:00:00.000Z";
const AFTER_EXPIRY = "2026-07-20T00:06:00.000Z";
const RENEWED_EXPIRES_AT = "2026-07-20T00:09:00.000Z";
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
let idSequence = 0;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-global-capacity-legacy-attempt-"));
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
  if (!sharedLayer) throw new Error("Global capacity legacy attempt PostgreSQL fixture was not started");
  return sharedLayer;
}

function createStore(projectId = PROJECT_A) {
  return createGlobalCapacityLegacyAttemptStore({
    layer: createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    projectId,
    policy: DEFAULT_POLICY,
    now: () => trustedNow,
    idFactory: (input) => `${input.kind}-${input.projectId}-${input.resourceKind}-${input.resourceId}-${input.capacityFence}-${input.acquireGeneration}-${++idSequence}`,
  });
}

function createLedger(projectId = PROJECT_A) {
  return createGlobalCapacityLedgerPostgresPorts({
    layer: createAsyncDataLayer(sharedContext!.connections!, { projectId }),
    projectId,
    policy: DEFAULT_POLICY,
    now: () => trustedNow,
  });
}

async function acquireAttempt(attempt: {
  readonly projectId: string;
  readonly resourceKind: "legacy_task" | "legacy_triage";
  readonly resourceId: string;
  readonly claimId: string;
  readonly acquireOperationId: string;
  readonly workClass: "normal" | "verifier" | "recovery";
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly capacityFence: number;
  readonly preparedAt: string;
  readonly expiresAt: string;
}) {
  return createLedger(attempt.projectId).acquire({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    projectId: attempt.projectId,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    claimId: attempt.claimId,
    operationId: attempt.acquireOperationId,
    workClass: attempt.workClass,
    slots: attempt.slots,
    holderId: attempt.holderId,
    leaseId: attempt.leaseId,
    fence: attempt.capacityFence,
    asOf: attempt.preparedAt,
    expiresAt: attempt.expiresAt,
  });
}

async function renewAttempt(attempt: GlobalCapacityLegacyAttemptV1) {
  return createLedger(attempt.projectId).renew({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    projectId: attempt.projectId,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    claimId: attempt.claimId,
    operationId: attempt.renewOperationId,
    holderId: attempt.holderId,
    leaseId: attempt.leaseId,
    fence: attempt.capacityFence,
    asOf: trustedNow,
    expiresAt: RENEWED_EXPIRES_AT,
  });
}

async function releaseAttempt(attempt: GlobalCapacityLegacyAttemptV1) {
  return createLedger(attempt.projectId).release({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    projectId: attempt.projectId,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    claimId: attempt.claimId,
    operationId: attempt.releaseOperationId,
    holderId: attempt.holderId,
    leaseId: attempt.leaseId,
    fence: attempt.capacityFence,
    asOf: trustedNow,
  });
}

async function occupyOnlyCapacity(): Promise<void> {
  await requireLayer().db
    .update(globalConcurrency)
    .set({ globalMaxConcurrent: 1, currentlyActive: 0, queuedCount: 0, updatedAt: AS_OF })
    .where(eq(globalConcurrency.id, 1));
  await expect(createLedger().acquire({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    projectId: PROJECT_A,
    resourceKind: "room_worker",
    resourceId: "global-capacity-blocker",
    claimId: "global-capacity-blocker-claim",
    operationId: "global-capacity-blocker-acquire",
    workClass: "normal",
    slots: 1,
    holderId: "global-capacity-blocker-holder",
    leaseId: "global-capacity-blocker-lease",
    fence: 1,
    asOf: AS_OF,
    expiresAt: RENEWED_EXPIRES_AT,
  })).resolves.toMatchObject({ action: "acquired", claimId: "global-capacity-blocker-claim" });
}

function prepareInput(
  holderId = "executor-owner-a",
  resourceId = "task-legacy-attempt-a",
): GlobalCapacityLegacyAttemptPrepareInputV1 {
  return {
    contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
    resourceKind: "legacy_task",
    resourceId,
    workClass: "normal",
    slots: 1,
    holderId,
  };
}

function requireReady(
  result: GlobalCapacityLegacyAttemptPrepareResultV1,
): Extract<GlobalCapacityLegacyAttemptPrepareResultV1, { outcome: "ready" }> {
  if (result.outcome !== "ready") throw new Error(`Expected ready attempt, received ${result.outcome}`);
  return result;
}

async function installPolicy(): Promise<void> {
  await createGlobalCapacityPolicyAuthorityStore({ layer: requireLayer(), now: () => trustedNow })
    .install({ expectedRevision: 0, policy: DEFAULT_POLICY });
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  trustedNow = AS_OF;
  idSequence = 0;
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE central.global_capacity_legacy_attempts RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
  ].join("; ")));
  await requireLayer().db
    .update(globalConcurrency)
    .set({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, updatedAt: AS_OF })
    .where(eq(globalConcurrency.id, 1));
  await installPolicy();
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

describe("global capacity legacy attempt store", () => {
  it("persists one exact unstarted execution bundle and does not let a second holder replace it", async () => {
    const store = createStore();
    const created = requireReady(await store.prepare(prepareInput()));
    const resumed = requireReady(await store.prepare(prepareInput()));
    const blocked = await store.prepare(prepareInput("executor-owner-b"));

    expect(created).toMatchObject({ outcome: "ready", reason: "created", replayed: false });
    expect(created.attempt).toMatchObject({ state: "prepared", capacityFence: 1, acquireGeneration: 1 });
    expect(Object.isFrozen(created.attempt)).toBe(true);
    expect(resumed).toMatchObject({ outcome: "ready", reason: "resumed", replayed: true, attempt: created.attempt });
    expect(blocked).toMatchObject({ outcome: "blocked", reason: "active_attempt_conflict", attempt: created.attempt });
    expect(toGlobalCapacityLegacyAttemptReference(created.attempt)).toMatchObject({
      attemptId: created.attempt.id,
      capacityFence: 1,
      resourceKind: "legacy_task",
    });
  });

  it("supersedes only an expired pre-start attempt and advances its durable fence", async () => {
    const store = createStore();
    const first = requireReady(await store.prepare(prepareInput()));
    const firstReference = toGlobalCapacityLegacyAttemptReference(first.attempt);

    trustedNow = AFTER_EXPIRY;
    const second = requireReady(await store.prepare(prepareInput("executor-owner-b")));
    const superseded = await store.read(firstReference);

    expect(second).toMatchObject({ outcome: "ready", reason: "created", replayed: false });
    expect(second.attempt.capacityFence).toBe(2);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(superseded).toMatchObject({ state: "superseded", supersededAt: AFTER_EXPIRY });
  });

  it("persists a fresh acquire operation after every held response and replays that transition safely", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);

    await expect(store.recordWithheld({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    })).rejects.toThrow("withheld response lacks its durable ledger receipt");
    await occupyOnlyCapacity();
    await expect(acquireAttempt(prepared)).resolves.toMatchObject({ action: "held" });

    const firstHeld = await store.recordWithheld({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    });
    const replayedHeld = await store.recordWithheld({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    });
    await expect(acquireAttempt(firstHeld)).resolves.toMatchObject({ action: "held" });
    const secondHeld = await store.recordWithheld({
      ...reference,
      observedAcquireOperationId: firstHeld.acquireOperationId,
    });

    expect(firstHeld).toMatchObject({
      state: "withheld",
      acquireGeneration: 2,
      lastWithheldOperationId: prepared.acquireOperationId,
    });
    expect(firstHeld.acquireOperationId).not.toBe(prepared.acquireOperationId);
    expect(replayedHeld).toEqual(firstHeld);
    expect(secondHeld).toMatchObject({ state: "withheld", acquireGeneration: 3 });
    expect(secondHeld.acquireOperationId).not.toBe(firstHeld.acquireOperationId);
  });

  it("binds admission to a live durable acquire receipt and grants external execution only once", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await expect(store.recordAdmission({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    })).rejects.toThrow("lacks its durable acquire receipt");
    await expect(acquireAttempt(prepared)).resolves.toMatchObject({ action: "acquired", claimId: prepared.claimId });
    const admitted = await store.recordAdmission({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected the first work-start receipt to grant execution");
    const started = start.attempt;

    trustedNow = AFTER_EXPIRY;
    const recovery = await store.prepare(prepareInput("executor-owner-b"));
    const duplicateStart = await store.recordWorkStarted(reference);
    await expect(store.recordWorkFinished({
      ...reference,
      executionReceiptId: "wrong-execution-receipt",
    })).rejects.toThrow("execution receipt is stale");
    await expect(store.recordWorkFinished({
      ...reference,
      capacityFence: reference.capacityFence + 1,
      executionReceiptId: start.executionReceiptId,
    }))
      .rejects.toThrow("durable project fence");

    expect(admitted).toMatchObject({ state: "admitted", admittedAt: AS_OF });
    expect(started).toMatchObject({ state: "work_started", workStartedAt: AS_OF });
    expect(Object.prototype.hasOwnProperty.call(started, "workStartReceiptId")).toBe(false);
    expect(start.executionReceiptId).toContain("work_start_receipt");
    expect(recovery).toMatchObject({
      outcome: "recovery_required",
      reason: "external_work_may_have_started",
      attempt: started,
    });
    expect(duplicateStart).toMatchObject({ outcome: "recovery_required", attempt: started });
  });

  it("inspects work_started as a fail-closed external-work boundary", async () => {
    const store = createStore();
    const inspectionInput = {
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: "legacy_task" as const,
      resourceId: "task-legacy-attempt-a",
    };
    await expect(store.inspectRecovery(inspectionInput)).resolves.toEqual({ state: "clear" });

    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await expect(store.inspectRecovery(inspectionInput)).resolves.toEqual({ state: "clear" });
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    await expect(store.inspectRecovery(inspectionInput)).resolves.toEqual({ state: "clear" });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");

    await expect(store.inspectRecovery(inspectionInput)).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "external_work_may_have_started",
      finding: "work_started",
      attempt: { id: prepared.id, state: "work_started" },
    });
  });

  it("distinguishes a durable renewed operation from a durable renewal loss", async () => {
    const store = createStore();
    const renewedPrepared = requireReady(await store.prepare(
      prepareInput("executor-owner-renewed", "task-legacy-attempt-renewed"),
    )).attempt;
    const renewedReference = toGlobalCapacityLegacyAttemptReference(renewedPrepared);
    await acquireAttempt(renewedPrepared);
    await store.recordAdmission({
      ...renewedReference,
      observedAcquireOperationId: renewedPrepared.acquireOperationId,
    });
    const renewedStart = await store.recordWorkStarted(renewedReference);
    if (renewedStart.outcome !== "execution_granted") throw new Error("Expected renewable work start");

    trustedNow = "2026-07-20T00:04:00.000Z";
    await expect(renewAttempt(renewedStart.attempt)).resolves.toMatchObject({
      action: "renewed",
      claimId: renewedPrepared.claimId,
    });
    trustedNow = AFTER_EXPIRY;
    await expect(store.inspectRecovery({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: renewedPrepared.resourceKind,
      resourceId: renewedPrepared.resourceId,
    })).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "external_work_may_have_started",
      finding: "work_started",
      attempt: { id: renewedPrepared.id, state: "work_started" },
    });

    const lostPrepared = requireReady(await store.prepare(
      prepareInput("executor-owner-renewal-lost", "task-legacy-attempt-renewal-lost"),
    )).attempt;
    const lostReference = toGlobalCapacityLegacyAttemptReference(lostPrepared);
    await acquireAttempt(lostPrepared);
    await store.recordAdmission({
      ...lostReference,
      observedAcquireOperationId: lostPrepared.acquireOperationId,
    });
    const lostStart = await store.recordWorkStarted(lostReference);
    if (lostStart.outcome !== "execution_granted") throw new Error("Expected renewal-loss work start");

    trustedNow = "2026-07-20T00:07:00.000Z";
    await expect(createLedger().renew({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: lostStart.attempt.projectId,
      resourceKind: lostStart.attempt.resourceKind,
      resourceId: lostStart.attempt.resourceId,
      claimId: lostStart.attempt.claimId,
      operationId: lostStart.attempt.renewOperationId,
      holderId: lostStart.attempt.holderId,
      leaseId: lostStart.attempt.leaseId,
      fence: lostStart.attempt.capacityFence + 1,
      asOf: trustedNow,
      expiresAt: RENEWED_EXPIRES_AT,
    })).resolves.toMatchObject({ action: "rejected", reason: "stale_fence" });
    await expect(store.inspectRecovery({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: lostPrepared.resourceKind,
      resourceId: lostPrepared.resourceId,
    })).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "external_work_may_have_started",
      finding: "renewal_lost",
      attempt: { id: lostPrepared.id, state: "work_started" },
    });
  });

  it("inspects work_finished as release_pending until the release receipt is recorded", async () => {
    const store = createStore();
    const inspectionInput = {
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: "legacy_task" as const,
      resourceId: "task-legacy-attempt-a",
    };
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");
    await store.recordWorkFinished({ ...reference, executionReceiptId: start.executionReceiptId });
    await expect(store.inspectRecovery(inspectionInput)).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "release_pending",
      finding: "release_pending",
      attempt: { id: prepared.id, state: "work_finished" },
    });
    await releaseAttempt(start.attempt);
    await store.recordReleased({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
      executionReceiptId: start.executionReceiptId,
    });
    await expect(store.inspectRecovery(inspectionInput)).resolves.toEqual({ state: "clear" });
  });

  it("marks an expired work_started attempt with no durable renewal outcome unresolved", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected unresolved work start");

    trustedNow = AFTER_EXPIRY;
    await expect(store.inspectRecovery({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: prepared.resourceKind,
      resourceId: prepared.resourceId,
    })).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "external_work_may_have_started",
      finding: "unresolved",
      attempt: { id: prepared.id, state: "work_started" },
    });
  });

  it("binds each long-running renewal to a live ledger receipt and advances the next operation id", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    const admitted = await store.recordAdmission({
      ...reference,
      observedAcquireOperationId: prepared.acquireOperationId,
    });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");

    trustedNow = "2026-07-20T00:04:00.000Z";
    await expect(renewAttempt(start.attempt)).resolves.toMatchObject({ action: "renewed", claimId: prepared.claimId });
    const renewed = await store.recordRenewed({
      ...reference,
      observedRenewOperationId: start.attempt.renewOperationId,
    });
    const replayed = await store.recordRenewed({
      ...reference,
      observedRenewOperationId: start.attempt.renewOperationId,
    });

    trustedNow = AFTER_EXPIRY;
    const snapshot = await createLedger().readSnapshot({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_A,
      asOf: AFTER_EXPIRY,
    });

    expect(admitted).toMatchObject({ state: "admitted" });
    expect(renewed).toMatchObject({
      state: "work_started",
      renewGeneration: 2,
      lastRenewalOperationId: start.attempt.renewOperationId,
      expiresAt: RENEWED_EXPIRES_AT,
    });
    expect(renewed.renewOperationId).not.toBe(start.attempt.renewOperationId);
    expect(replayed).toEqual(renewed);
    expect(snapshot.ownClaims).toHaveLength(1);
    expect(snapshot.ownClaims[0]).toMatchObject({ claimId: prepared.claimId, fence: prepared.capacityFence });
  });

  it("mints a fresh renewal id only after the prior non-renewal result is durable", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");

    const rejectedRenewal = await createLedger().renew({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: prepared.projectId,
      resourceKind: prepared.resourceKind,
      resourceId: prepared.resourceId,
      claimId: prepared.claimId,
      operationId: start.attempt.renewOperationId,
      holderId: prepared.holderId,
      leaseId: prepared.leaseId,
      fence: prepared.capacityFence + 1,
      asOf: AS_OF,
      expiresAt: RENEWED_EXPIRES_AT,
    });
    const advanced = await store.advanceRenewalAfterDurableFailure({
      ...reference,
      observedRenewOperationId: start.attempt.renewOperationId,
    });
    const replayed = await store.advanceRenewalAfterDurableFailure({
      ...reference,
      observedRenewOperationId: start.attempt.renewOperationId,
    });
    await expect(store.inspectRecovery({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      resourceKind: prepared.resourceKind,
      resourceId: prepared.resourceId,
    })).resolves.toMatchObject({
      state: "reconciliation_required",
      reason: "external_work_may_have_started",
      finding: "renewal_lost",
      attempt: { id: prepared.id, state: "work_started" },
    });

    expect(rejectedRenewal).toMatchObject({ action: "rejected", reason: "stale_fence" });
    expect(advanced).toMatchObject({
      state: "work_started",
      renewGeneration: 2,
      lastRenewalOperationId: start.attempt.renewOperationId,
    });
    expect(advanced.renewOperationId).not.toBe(start.attempt.renewOperationId);
    expect(replayed).toEqual(advanced);
  });

  it("records a release only after the exact ledger release receipt and then permits a successor fence", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");

    await expect(store.recordReleased({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
      executionReceiptId: start.executionReceiptId,
    })).rejects.toThrow("lacks its durable ledger receipt");

    await expect(releaseAttempt(start.attempt)).resolves.toMatchObject({
      action: "released",
      reason: "capacity_released",
      claimId: prepared.claimId,
    });
    const released = await store.recordReleased({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
      executionReceiptId: start.executionReceiptId,
    });
    const replayed = await store.recordReleased({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
      executionReceiptId: start.executionReceiptId,
    });
    const successor = requireReady(await store.prepare(prepareInput("executor-owner-b")));

    expect(released).toMatchObject({ state: "released", releasedAt: AS_OF });
    expect(replayed).toEqual(released);
    expect(successor.attempt).toMatchObject({ state: "prepared", capacityFence: prepared.capacityFence + 1 });
  });

  it("recovers only a durable work_finished release without exposing the private execution receipt", async () => {
    const store = createStore();
    const prepared = requireReady(await store.prepare(prepareInput())).attempt;
    const reference = toGlobalCapacityLegacyAttemptReference(prepared);
    await acquireAttempt(prepared);
    await store.recordAdmission({ ...reference, observedAcquireOperationId: prepared.acquireOperationId });
    const start = await store.recordWorkStarted(reference);
    if (start.outcome !== "execution_granted") throw new Error("Expected initial execution grant");
    await store.recordWorkFinished({ ...reference, executionReceiptId: start.executionReceiptId });

    await expect(store.recordRecoveredWorkFinishedRelease({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
    })).rejects.toThrow("lacks its durable ledger receipt");
    await releaseAttempt(start.attempt);
    const released = await store.recordRecoveredWorkFinishedRelease({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
    });
    const replayed = await store.recordRecoveredWorkFinishedRelease({
      ...reference,
      observedReleaseOperationId: start.attempt.releaseOperationId,
    });

    expect(released).toMatchObject({ state: "released", releasedAt: AS_OF });
    expect(replayed).toEqual(released);
    expect(Object.prototype.hasOwnProperty.call(released, "workStartReceiptId")).toBe(false);
  });

  it("fails closed when its policy copy is no longer backed by the central authority", async () => {
    await requireLayer().db.execute(sql.raw([
      "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
      "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    ].join("; ")));

    await expect(createStore().prepare(prepareInput()))
      .rejects.toThrow("requires an installed central policy authority");
  });
});
