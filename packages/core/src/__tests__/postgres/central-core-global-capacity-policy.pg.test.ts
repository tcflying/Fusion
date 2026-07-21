import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CentralCore } from "../../central-core.js";
import type { GlobalCapacityLedgerPolicyV1 } from "../../global-capacity-ledger-postgres.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

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

let context: EmbeddedTestContext | null = null;
let layer: AsyncDataLayer | null = null;
let central: CentralCore | null = null;
let centralDir: string | null = null;

function requireLayer(): AsyncDataLayer {
  if (!layer) throw new Error("CentralCore global capacity policy PostgreSQL fixture was not started");
  return layer;
}

function requireCentral(): CentralCore {
  if (!central) throw new Error("CentralCore global capacity policy fixture was not started");
  return central;
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-central-core-global-capacity-policy-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 4 });
  await applySchemaBaseline(connections.migration, { pluginHooks: [] });
  return { dataDir, lifecycle, connections };
}

beforeAll(async () => {
  context = await startEmbeddedDatabase();
  layer = createAsyncDataLayer(context.connections!, {});
}, 60_000);

beforeEach(async () => {
  await central?.close();
  if (centralDir) rmSync(centralDir, { recursive: true, force: true });
  centralDir = mkdtempSync(join(tmpdir(), "fusion-central-core-policy-dir-"));
  central = new CentralCore(centralDir, { asyncLayer: requireLayer() });
  await central.init();
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE central.global_capacity_operations RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_claims RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_state RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.global_capacity_policy_authority RESTART IDENTITY CASCADE",
  ].join("; ")));
});

afterAll(async () => {
  await central?.close();
  central = null;
  if (centralDir) rmSync(centralDir, { recursive: true, force: true });
  centralDir = null;
  const shared = context;
  context = null;
  layer = null;
  if (!shared) return;
  if (shared.connections) {
    await shared.connections.close();
    shared.connections = null;
  }
  await shared.lifecycle.stop();
  rmSync(shared.dataDir, { recursive: true, force: true });
});

describe("CentralCore global capacity policy authority facade", () => {
  it("fails closed until the backend host explicitly installs a policy", async () => {
    await expect(requireCentral().readGlobalCapacityPolicyAuthorityV1()).rejects.toThrow("not installed");
  });

  it("explicitly installs and reads the central policy authority", async () => {
    const installed = await requireCentral().installGlobalCapacityPolicyAuthorityV1({
      expectedRevision: 0,
      policy: DEFAULT_POLICY,
    });
    const authority = await requireCentral().readGlobalCapacityPolicyAuthorityV1();

    expect(installed).toMatchObject({ revision: 1, policy: DEFAULT_POLICY });
    expect(authority).toMatchObject({ revision: 1, policy: DEFAULT_POLICY, policyHash: installed.policyHash });
  });

  it("refuses stale updates without overwriting the installed policy", async () => {
    await requireCentral().installGlobalCapacityPolicyAuthorityV1({ expectedRevision: 0, policy: DEFAULT_POLICY });
    await expect(requireCentral().updateGlobalCapacityPolicyAuthorityV1({
      expectedRevision: 1,
      policy: UPDATED_POLICY,
    })).resolves.toMatchObject({ revision: 2, policy: UPDATED_POLICY });
    await expect(requireCentral().updateGlobalCapacityPolicyAuthorityV1({
      expectedRevision: 1,
      policy: DEFAULT_POLICY,
    })).rejects.toThrow("revision is stale");
    await expect(requireCentral().readGlobalCapacityPolicyAuthorityV1())
      .resolves.toMatchObject({ revision: 2, policy: UPDATED_POLICY });
  });

  it("rejects SQLite or no-layer CentralCore instances instead of consulting settings", async () => {
    const sqliteDir = mkdtempSync(join(tmpdir(), "fusion-central-core-policy-sqlite-"));
    const sqliteCore = new CentralCore(sqliteDir);
    await sqliteCore.init();
    try {
      await expect(sqliteCore.readGlobalCapacityPolicyAuthorityV1())
        .rejects.toThrow("only available in backend mode");
      await expect(sqliteCore.installGlobalCapacityPolicyAuthorityV1({
        expectedRevision: 0,
        policy: DEFAULT_POLICY,
      })).rejects.toThrow("only available in backend mode");
      await expect(sqliteCore.updateGlobalCapacityPolicyAuthorityV1({
        expectedRevision: 1,
        policy: UPDATED_POLICY,
      })).rejects.toThrow("only available in backend mode");
    } finally {
      await sqliteCore.close();
      rmSync(sqliteDir, { recursive: true, force: true });
    }
  });
});
