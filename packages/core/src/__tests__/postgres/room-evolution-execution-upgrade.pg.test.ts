import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  MIGRATION_BOOKKEEPING_TABLE,
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION,
  SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
} from "../../postgres/schema-applier.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

let context: EmbeddedTestContext | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-execution-upgrade-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  return {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 2 }),
  };
}

function requireConnections(): PostgresConnections {
  if (!context?.connections) throw new Error("Room evolution execution upgrade fixture was not started");
  return context.connections;
}

async function materializeThrough0027(): Promise<void> {
  const migration = requireConnections().migration;
  const targetIndex = SCHEMA_MIGRATIONS.findIndex(
    (candidate) => candidate.version === SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
  );
  if (targetIndex < 0) throw new Error("0027 Room evolution trust migration is not registered");
  await migration.execute(sql.raw(`
    CREATE TABLE public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
  for (const registered of SCHEMA_MIGRATIONS.slice(0, targetIndex + 1)) {
    await migration.execute(sql.raw(await readSchemaMigrationSql(registered.version)));
    await migration.execute(
      sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${registered.version})`,
    );
  }
}

beforeAll(async () => {
  context = await startEmbeddedDatabase();
}, 60_000);

afterAll(async () => {
  const current = context;
  context = null;
  if (!current) return;
  if (current.connections) {
    await current.connections.close();
    current.connections = null;
  }
  await current.lifecycle.stop();
  rmSync(current.dataDir, { recursive: true, force: true });
}, 60_000);

describe("Room evolution execution recovery upgrade", () => {
  it("applies only 0028 to a durable 0027 database and records the migration", async () => {
    await materializeThrough0027();

    const result = await applySchemaBaseline(requireConnections().migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION]);
    expect(await getAppliedMigrations(requireConnections().migration)).toContain(
      SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION,
    );
    const tables = (await requireConnections().migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project'
        AND table_name IN (
          'room_evolution_execution_runs',
          'room_evolution_effect_outbox',
          'room_evolution_execution_outcomes'
        )
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables).toEqual([
      { table_name: "room_evolution_effect_outbox" },
      { table_name: "room_evolution_execution_outcomes" },
      { table_name: "room_evolution_execution_runs" },
    ]);
  });
});
