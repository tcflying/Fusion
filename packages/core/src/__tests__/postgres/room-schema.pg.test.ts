import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  MIGRATION_BOOKKEEPING_TABLE,
  SCHEMA_BASELINE_VERSION,
  SCHEMA_ROOM_VERSION,
} from "../../postgres/schema-applier.js";
import { ROOM_PROJECT_TABLE_NAMES } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-schema-"));
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
    connections: await createConnectionSetFromUrl(backend, { poolMax: 2 }),
  } satisfies EmbeddedTestContext;
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    if (context.connections) {
      await context.connections.close();
      context.connections = null;
    }
    await context.lifecycle.stop();
    rmSync(context.dataDir, { recursive: true, force: true });
  }
});

describe("Session Room PostgreSQL migration", () => {
  it("applies baseline then Room migration to a fresh embedded database", async () => {
    const context = await startEmbeddedDatabase();
    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });

    expect(result.appliedVersions).toEqual([SCHEMA_BASELINE_VERSION, SCHEMA_ROOM_VERSION]);
    expect(result.baselineApplied).toBe(true);
    expect(await getAppliedMigrations(context.connections!.migration)).toEqual([
      SCHEMA_BASELINE_VERSION,
      SCHEMA_ROOM_VERSION,
    ]);

    const rows = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name LIKE 'room_%'
      UNION ALL
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'operational_rooms'
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(rows.map((row) => row.table_name)).toEqual([...ROOM_PROJECT_TABLE_NAMES].sort());

    await context.connections!.migration.execute(sql`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-1', 'project-1', 'objective', 'implementation', 1,
        'draft', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_events (
        id, project_id, room_id, aggregate_version, event_type,
        actor_type, actor_id, correlation_id, payload, occurred_at
      ) VALUES (
        'event-1', 'project-1', 'room-1', 1, 'room_created',
        'human', 'operator-1', 'correlation-1', '{}'::jsonb, '2026-07-17T00:00:00.000Z'
      )
    `);
    const cursors = (await context.connections!.migration.execute(sql`
      SELECT cursor FROM project.room_events WHERE id = 'event-1'
    `)) as unknown as Array<{ cursor: number }>;
    expect(Number(cursors[0]?.cursor)).toBeGreaterThan(0);

    await expect(
      context.connections!.migration.execute(sql`
        INSERT INTO project.room_events (
          id, project_id, room_id, aggregate_version, event_type,
          actor_type, actor_id, correlation_id, payload, occurred_at
        ) VALUES (
          'event-duplicate-version', 'project-1', 'room-1', 1, 'duplicate',
          'system', 'controller', 'correlation-2', '{}'::jsonb, '2026-07-17T00:01:00.000Z'
        )
      `),
    ).rejects.toThrow();
    await expect(
      context.connections!.migration.execute(sql`
        INSERT INTO project.room_seats (
          id, project_id, room_id, role, state, created_at, updated_at
        ) VALUES (
          'seat-cross-project', 'project-2', 'room-1', 'producer', 'ready',
          '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
        )
      `),
    ).rejects.toThrow();

    const second = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(second).toMatchObject({
      applied: false,
      baselineApplied: false,
      appliedVersions: [],
    });
  });

  it("upgrades an existing 0000 database without replaying the baseline", async () => {
    const context = await startEmbeddedDatabase();
    await context.connections!.migration.execute(sql.raw(`
      CREATE SCHEMA IF NOT EXISTS project;
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES ('${SCHEMA_BASELINE_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });

    expect(result.appliedVersions).toEqual([SCHEMA_ROOM_VERSION]);
    expect(result.baselineApplied).toBe(false);
    const rooms = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'operational_rooms'
    `)) as unknown as Array<{ table_name: string }>;
    expect(rooms).toEqual([{ table_name: "operational_rooms" }]);
  });
});
