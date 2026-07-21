import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  applySchemaBaseline,
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  createGlobalCapacityPolicyAuthorityStore,
  loadGlobalCapacityPolicyAuthority,
  type GlobalCapacityLedgerPolicyV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import { EmbeddedPostgresLifecycle } from "../../../core/src/postgres/embedded-lifecycle.js";
import { globalCapacityClaims, globalConcurrency } from "../../../core/src/postgres/schema/central.js";
import { roomGlobalConcurrencyClaims } from "../../../core/src/postgres/schema/room.js";
import { ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION } from "../room-global-concurrency-accounting.js";
import { createRoomGlobalConcurrencyRuntime } from "../room-global-concurrency-runtime.js";

const NOW = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-20T00:05:00.000Z";
const ROOM_PROJECT_ID = "project-room-central-capacity";
const LEGACY_PROJECT_ID = "project-legacy-central-capacity";
const ROOM_ID = "room-central-capacity";
const ROOM_CLAIM_ID = "room-central-capacity-claim";
const EMBEDDED_DATABASE_TIMEOUT_MS = 60_000;

const POLICY = {
  reservations: {
    verifierSlots: 0,
    recoverySlots: 0,
    legacyTaskTriageSlots: 0,
  },
  snapshotTtlMs: 60_000,
  leaseTtlMs: 300_000,
} as const satisfies GlobalCapacityLedgerPolicyV1;

const REFRESHED_POLICY = {
  ...POLICY,
  snapshotTtlMs: 90_000,
} as const satisfies GlobalCapacityLedgerPolicyV1;

/*
FNXC:RoomCentralCapacityIntegration 2026-07-20-07:22:
Room-controller capacity must use the loaded central policy authority rather
than the retired project.room_global_concurrency_claims path. This real
PostgreSQL boundary test keeps one Room worker and one cross-project legacy task
behind the same global limit so a future adapter regression cannot create a
separate Room-only budget.
*/
describe("Room runtime central capacity with PostgreSQL", () => {
  it("maps the Room claim into the shared central ledger and competes with a cross-project legacy task", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fusion-engine-room-central-capacity-"));
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir,
      database: "fusion",
      user: "postgres",
      password: "password",
    });
    let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;
    let started = false;

    try {
      const backend = await lifecycle.start();
      started = true;
      connections = await createConnectionSetFromUrl(backend, { poolMax: 4 });
      await applySchemaBaseline(connections.migration, { pluginHooks: [] });
      const layer = createAsyncDataLayer(connections, {});
      await layer.db
        .update(globalConcurrency)
        .set({ globalMaxConcurrent: 1, currentlyActive: 0, queuedCount: 0, updatedAt: NOW });

      const authorityStore = createGlobalCapacityPolicyAuthorityStore({ layer, now: () => NOW });
      await authorityStore.install({ expectedRevision: 0, policy: POLICY });
      const authority = await loadGlobalCapacityPolicyAuthority({ layer, now: () => NOW });
      const runtime = createRoomGlobalConcurrencyRuntime({
        projectId: ROOM_PROJECT_ID,
        globalCapacityAuthority: authority,
        verifiedPolicy: {
          controllerAdmission: {
            workClass: "normal",
            slots: 1,
            createClaimId: () => ROOM_CLAIM_ID,
          },
          verifiedAt: NOW,
          verificationId: "room-central-capacity-postgres-v1",
        },
      });
      const legacyPort = authority.createProjectPorts(LEGACY_PROJECT_ID);

      const roomResult = await runtime.capacityAdmission.globalAccounting.acquire({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: ROOM_PROJECT_ID,
        roomId: ROOM_ID,
        claimId: ROOM_CLAIM_ID,
        operationId: "room-central-capacity-acquire",
        workClass: "normal",
        slots: 1,
        holderId: "room-worker-central-capacity",
        leaseId: "room-lease-central-capacity",
        fence: 7,
        asOf: NOW,
        expiresAt: EXPIRES_AT,
      });
      const legacyResult = await legacyPort.acquire({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: LEGACY_PROJECT_ID,
        resourceKind: "legacy_task",
        resourceId: "legacy-task-central-capacity",
        claimId: "legacy-central-capacity-claim",
        operationId: "legacy-central-capacity-acquire",
        workClass: "normal",
        slots: 1,
        holderId: "legacy-worker-central-capacity",
        leaseId: "legacy-lease-central-capacity",
        fence: 3,
        asOf: NOW,
        expiresAt: EXPIRES_AT,
      });

      expect(roomResult).toMatchObject({
        action: "acquired",
        reason: "capacity_admitted",
        claimId: ROOM_CLAIM_ID,
        fence: 7,
      });
      expect(legacyResult).toMatchObject({ action: "held", reason: "global_capacity_exhausted" });
      expect([roomResult, legacyResult].filter((result) => result.action === "acquired")).toHaveLength(1);

      const centralClaims = await layer.db.select().from(globalCapacityClaims);
      expect(centralClaims).toEqual([
        expect.objectContaining({
          id: ROOM_CLAIM_ID,
          projectId: ROOM_PROJECT_ID,
          resourceKind: "room_worker",
          resourceId: ROOM_ID,
          workClass: "normal",
          slots: 1,
        }),
      ]);
      await expect(layer.db.select().from(roomGlobalConcurrencyClaims)).resolves.toEqual([]);

      const legacySnapshot = await legacyPort.readSnapshot({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: LEGACY_PROJECT_ID,
        asOf: NOW,
      });
      expect(legacySnapshot).toMatchObject({
        totalSlots: 1,
        ownClaims: [],
        foreignOccupancy: {
          totalSlots: 1,
          roomWorkerSlots: 1,
          normalSlots: 1,
        },
      });
    } finally {
      await connections?.close();
      if (started) await lifecycle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

  it("refreshes a no-claim policy epoch on the next Room acquire without restarting the controller runtime", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fusion-engine-room-central-capacity-refresh-"));
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir,
      database: "fusion",
      user: "postgres",
      password: "password",
    });
    let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;
    let started = false;

    try {
      const backend = await lifecycle.start();
      started = true;
      connections = await createConnectionSetFromUrl(backend, { poolMax: 4 });
      await applySchemaBaseline(connections.migration, { pluginHooks: [] });
      const layer = createAsyncDataLayer(connections, {});
      await layer.db
        .update(globalConcurrency)
        .set({ globalMaxConcurrent: 1, currentlyActive: 0, queuedCount: 0, updatedAt: NOW });

      const authorityStore = createGlobalCapacityPolicyAuthorityStore({ layer, now: () => NOW });
      await authorityStore.install({ expectedRevision: 0, policy: POLICY });
      const staleAuthority = await loadGlobalCapacityPolicyAuthority({ layer, now: () => NOW });
      let refreshCalls = 0;
      const runtime = createRoomGlobalConcurrencyRuntime({
        projectId: ROOM_PROJECT_ID,
        globalCapacityAuthority: staleAuthority,
        refreshGlobalCapacityAuthority: async () => {
          refreshCalls += 1;
          return loadGlobalCapacityPolicyAuthority({ layer, now: () => NOW });
        },
        verifiedPolicy: {
          controllerAdmission: {
            workClass: "normal",
            slots: 1,
            createClaimId: () => `${ROOM_CLAIM_ID}-refreshed`,
          },
          verifiedAt: NOW,
          verificationId: "room-central-capacity-policy-refresh-v1",
        },
      });

      await authorityStore.update({ expectedRevision: 1, policy: REFRESHED_POLICY });
      await expect(runtime.capacityAdmission.globalAccounting.acquire({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: ROOM_PROJECT_ID,
        roomId: ROOM_ID,
        claimId: `${ROOM_CLAIM_ID}-refreshed`,
        operationId: "room-central-capacity-refreshed-acquire",
        workClass: "normal",
        slots: 1,
        holderId: "room-worker-central-capacity-refresh",
        leaseId: "room-lease-central-capacity-refresh",
        fence: 8,
        asOf: NOW,
        expiresAt: EXPIRES_AT,
      })).resolves.toMatchObject({
        action: "acquired",
        reason: "capacity_admitted",
        claimId: `${ROOM_CLAIM_ID}-refreshed`,
      });
      expect(refreshCalls).toBe(1);
    } finally {
      await connections?.close();
      if (started) await lifecycle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, EMBEDDED_DATABASE_TIMEOUT_MS);
});
