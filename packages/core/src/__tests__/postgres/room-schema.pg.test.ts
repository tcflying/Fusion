import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  MIGRATION_BOOKKEEPING_TABLE,
  readBaselineMigrationSql,
  readSchemaMigrationSql,
  SQLITE_MIGRATION_RUNTIME_READ_VERSION,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
  SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
  SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION,
  SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
  SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
  SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
  SCHEMA_ROOM_MESSAGE_ROUTING_VERSION,
  SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
  SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION,
  SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION,
  SCHEMA_ROOM_VERSION,
} from "../../postgres/schema-applier.js";
import { ROOM_PROJECT_TABLE_NAMES } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

const MIGRATION_OWNED_ROOM_TABLE_NAMES = [
  "room_phase_gate_evidence",
  "room_protocol_messages",
  "room_role_assignments",
  "room_semantic_controller_inbox",
  "room_semantic_loop_breaks",
  "room_semantic_states",
  "room_task_progress_observations",
  "room_task_recovery_actions",
  "room_task_recovery_plans",
] as const;

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

async function materializeHistoricalBaseline(context: EmbeddedTestContext): Promise<void> {
  await context.connections!.migration.execute(
    sql.raw(await readBaselineMigrationSql()),
  );
}

function expectedRegisteredMigrationsAfter(version: string): string[] {
  const versionIndex = SCHEMA_MIGRATIONS.findIndex((migration) => migration.version === version);
  if (versionIndex < 0) {
    throw new Error(`Unknown registered schema migration version: ${version}`);
  }
  return SCHEMA_MIGRATIONS.slice(versionIndex + 1).map((migration) => migration.version);
}

async function materializeHistoricalSchemaThrough(
  context: EmbeddedTestContext,
  targetVersion: string,
): Promise<void> {
  const targetIndex = SCHEMA_MIGRATIONS.findIndex((migration) => migration.version === targetVersion);
  if (targetIndex < 0) {
    throw new Error(`Unknown registered schema migration version: ${targetVersion}`);
  }
  await context.connections!.migration.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
  for (const migration of SCHEMA_MIGRATIONS.slice(0, targetIndex + 1)) {
    await context.connections!.migration.execute(
      sql.raw(await readSchemaMigrationSql(migration.version)),
    );
    await context.connections!.migration.execute(
      sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${migration.version})`,
    );
  }
}

async function restorePreMembershipProductionInvariantState(
  context: EmbeddedTestContext,
): Promise<void> {
  await context.connections!.migration.execute(sql.raw(`
    DELETE FROM public.${MIGRATION_BOOKKEEPING_TABLE}
    WHERE version = '${SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION}';

    DROP INDEX IF EXISTS project.idx_room_membership_changes_pending_native_session;
    DROP INDEX IF EXISTS project.idx_room_membership_changes_pending_happier_session;
    DROP INDEX IF EXISTS project.idx_room_bindings_active_native_session;
    DROP INDEX IF EXISTS project.idx_room_bindings_active_happier_session;

    ALTER TABLE project.room_membership_changes
      DROP COLUMN IF EXISTS reserved_connector_id,
      DROP COLUMN IF EXISTS reserved_provider_id,
      DROP COLUMN IF EXISTS reserved_native_session_id,
      DROP COLUMN IF EXISTS reserved_happier_session_id,
      DROP COLUMN IF EXISTS failed_at,
      DROP COLUMN IF EXISTS failure_code;
  `));
  await context.connections!.migration.execute(
    sql.raw(await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION)),
  );
}

async function restorePreNativeSenderTakeoverState(
  context: EmbeddedTestContext,
): Promise<void> {
  await context.connections!.migration.execute(sql.raw(`
    DELETE FROM public.${MIGRATION_BOOKKEEPING_TABLE}
    WHERE version = '${SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION}';

    ALTER TABLE project.room_binding_ingestion_state
      DROP COLUMN IF EXISTS takeover_id,
      DROP COLUMN IF EXISTS takeover_epoch,
      DROP COLUMN IF EXISTS takeover_state,
      DROP COLUMN IF EXISTS auto_sender_lease_epoch,
      DROP COLUMN IF EXISTS reconcile_from_cursor,
      DROP COLUMN IF EXISTS confirmed_cursor,
      DROP COLUMN IF EXISTS blocked_outbox_ids;
  `));
}

async function insertBindingIngestionFixture(
  context: EmbeddedTestContext,
  suffix: string,
): Promise<{ roomId: string; seatId: string; bindingId: string }> {
  const roomId = `room-schema-${suffix}`;
  const seatId = `seat-schema-${suffix}`;
  const bindingId = `binding-schema-${suffix}`;
  await context.connections!.migration.execute(sql`
    INSERT INTO project.operational_rooms (
      id, project_id, objective, protocol_id, protocol_version,
      lifecycle_state, created_at, updated_at
    ) VALUES (
      ${roomId}, 'project-schema-takeover', 'schema takeover fixture',
      'implementation', 1, 'running',
      '2026-07-18T06:59:00.000Z', '2026-07-18T06:59:00.000Z'
    )
  `);
  await context.connections!.migration.execute(sql`
    INSERT INTO project.room_seats (
      id, project_id, room_id, role, state, created_at, updated_at
    ) VALUES (
      ${seatId}, 'project-schema-takeover', ${roomId}, 'producer', 'active',
      '2026-07-18T06:59:00.000Z', '2026-07-18T06:59:00.000Z'
    )
  `);
  await context.connections!.migration.execute(sql`
    INSERT INTO project.room_bindings (
      id, project_id, room_id, seat_id, generation, connector_id,
      provider_id, native_session_id, host_id, state, attached_at
    ) VALUES (
      ${bindingId}, 'project-schema-takeover', ${roomId}, ${seatId}, 1,
      'happier', 'codex', ${`native-schema-${suffix}`}, 'windows-host-schema',
      'attached', '2026-07-18T06:59:00.000Z'
    )
  `);
  await context.connections!.migration.execute(sql`
    INSERT INTO project.room_binding_ingestion_state (
      binding_id, project_id, room_id, mode, updated_at
    ) VALUES (
      ${bindingId}, 'project-schema-takeover', ${roomId}, 'streaming',
      '2026-07-18T06:59:00.000Z'
    )
  `);
  return { roomId, seatId, bindingId };
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

    expect(result.appliedVersions).toEqual(SCHEMA_MIGRATIONS.map((migration) => migration.version));
    expect(result.baselineApplied).toBe(true);
    expect(await getAppliedMigrations(context.connections!.migration)).toEqual(
      SCHEMA_MIGRATIONS.map((migration) => migration.version),
    );

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
    expect(rows.map((row) => row.table_name)).toEqual([
      ...new Set([...ROOM_PROJECT_TABLE_NAMES, ...MIGRATION_OWNED_ROOM_TABLE_NAMES]),
    ].sort());

    const membershipForeignKeys = (await context.connections!.migration.execute(sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'project'
        AND table_name = 'room_membership_changes'
        AND constraint_type = 'FOREIGN KEY'
      ORDER BY constraint_name
    `)) as unknown as Array<{ constraint_name: string }>;
    expect(membershipForeignKeys).toEqual([
      { constraint_name: "room_membership_changes_room_project_fkey" },
    ]);

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

    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-2', 'project-1', 'objective 2', 'implementation', 1,
        'draft', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO project.room_seats (
        id, project_id, room_id, role, state, created_at, updated_at
      ) VALUES
        ('seat-owner-1', 'project-1', 'room-1', 'producer', 'ready', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),
        ('seat-owner-2', 'project-1', 'room-2', 'producer', 'ready', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES (
        'binding-owner-1', 'project-1', 'room-1', 'seat-owner-1', 1, 'happier',
        'codex', 'native-owner-1', 'happier-owner-1', 'host-1',
        'attached', '2026-07-17T00:00:00.000Z'
      );
    `));
    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES (
        'binding-native-duplicate', 'project-1', 'room-2', 'seat-owner-2', 1, 'happier',
        'codex', 'native-owner-1', 'happier-owner-2', 'host-2',
        'attached', '2026-07-17T00:00:00.000Z'
      )
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES (
        'binding-happier-duplicate', 'project-1', 'room-2', 'seat-owner-2', 1, 'happier',
        'codex', 'native-owner-2', 'happier-owner-1', 'host-2',
        'attached', '2026-07-17T00:00:00.000Z'
      )
    `))).rejects.toThrow();
    await context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_bindings
      SET state = 'detached', detached_at = '2026-07-17T00:01:00.000Z'
      WHERE id = 'binding-owner-1';
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES (
        'binding-owner-2', 'project-1', 'room-2', 'seat-owner-2', 1, 'happier',
        'codex', 'native-owner-1', 'happier-owner-1', 'host-2',
        'attached', '2026-07-17T00:02:00.000Z'
      );
    `));
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

  it("materializes durable native IDE sender takeover columns and enforces projection constraints", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    const fixture = await insertBindingIngestionFixture(context, "fresh-takeover");

    const columns = (await context.connections!.migration.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'room_binding_ingestion_state'
        AND column_name IN (
          'takeover_id',
          'takeover_epoch',
          'takeover_state',
          'auto_sender_lease_epoch',
          'reconcile_from_cursor',
          'confirmed_cursor',
          'blocked_outbox_ids'
        )
      ORDER BY ordinal_position
    `)) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;
    expect(columns).toEqual([
      { column_name: "takeover_id", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "takeover_epoch", data_type: "bigint", is_nullable: "YES", column_default: null },
      { column_name: "takeover_state", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "auto_sender_lease_epoch", data_type: "bigint", is_nullable: "YES", column_default: null },
      { column_name: "reconcile_from_cursor", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "confirmed_cursor", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "blocked_outbox_ids", data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" },
    ]);

    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_id = 'partial-takeover'
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_projection_check" },
    });

    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET
        native_writer_detected = true,
        mode = 'reconciling',
        takeover_id = 'native-writer:status-fresh-takeover',
        takeover_epoch = 1,
        takeover_state = 'reconciling',
        auto_sender_lease_epoch = 4,
        reconcile_from_cursor = 'cursor-before-takeover',
        confirmed_cursor = NULL,
        blocked_outbox_ids = '[]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `);

    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = false
      WHERE binding_id = ${fixture.bindingId}
    `);
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET
        takeover_state = 'ready_for_transfer',
        confirmed_cursor = 'cursor-ready-without-writer'
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_projection_check" },
    });
    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = true
      WHERE binding_id = ${fixture.bindingId}
    `);

    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_epoch = 0
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_epoch_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_epoch = 9007199254740992
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_epoch_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_state = 'unknown'
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_state_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET blocked_outbox_ids = '[""]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_blocked_outbox_ids_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET blocked_outbox_ids = '["outbox-duplicate","outbox-duplicate"]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_blocked_outbox_ids_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_state = 'blocked_delivery_uncertain'
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_payload_check" },
    });
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET takeover_state = 'ready_for_transfer'
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_payload_check" },
    });

    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET
        takeover_state = 'blocked_delivery_uncertain',
        blocked_outbox_ids = '["outbox-fresh-takeover"]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `);
    const takeover = (await context.connections!.migration.execute(sql`
      SELECT
        takeover_id,
        takeover_epoch,
        takeover_state,
        auto_sender_lease_epoch,
        reconcile_from_cursor,
        confirmed_cursor,
        blocked_outbox_ids
      FROM project.room_binding_ingestion_state
      WHERE binding_id = ${fixture.bindingId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(takeover).toEqual([{
      takeover_id: "native-writer:status-fresh-takeover",
      takeover_epoch: "1",
      takeover_state: "blocked_delivery_uncertain",
      auto_sender_lease_epoch: "4",
      reconcile_from_cursor: "cursor-before-takeover",
      confirmed_cursor: null,
      blocked_outbox_ids: ["outbox-fresh-takeover"],
    }]);

    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = false
      WHERE binding_id = ${fixture.bindingId}
    `);
    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET
        takeover_state = 'releasing',
        confirmed_cursor = NULL,
        blocked_outbox_ids = '[]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `);
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = true
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_projection_check" },
    });

    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET
        takeover_state = 'automatic_resumed',
        auto_sender_lease_epoch = 6,
        confirmed_cursor = 'cursor-after-human',
        blocked_outbox_ids = '[]'::jsonb
      WHERE binding_id = ${fixture.bindingId}
    `);
    await expect(context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = true
      WHERE binding_id = ${fixture.bindingId}
    `)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "room_binding_ingestion_takeover_projection_check" },
    });
  });

  it("upgrades existing ingestion rows to 0010 without fabricating takeover state", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await restorePreNativeSenderTakeoverState(context);
    const fixture = await insertBindingIngestionFixture(context, "upgrade-0010");
    await context.connections!.migration.execute(sql`
      UPDATE project.room_binding_ingestion_state
      SET native_writer_detected = true
      WHERE binding_id = ${fixture.bindingId}
    `);

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION]);
    const rows = (await context.connections!.migration.execute(sql`
      SELECT
        takeover_id,
        takeover_epoch,
        takeover_state,
        auto_sender_lease_epoch,
        reconcile_from_cursor,
        confirmed_cursor,
        blocked_outbox_ids
      FROM project.room_binding_ingestion_state
      WHERE binding_id = ${fixture.bindingId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      takeover_id: null,
      takeover_epoch: null,
      takeover_state: null,
      auto_sender_lease_epoch: null,
      reconcile_from_cursor: null,
      confirmed_cursor: null,
      blocked_outbox_ids: [],
    }]);
  });

  it("upgrades existing 0010 messages with durable routing targets and nullable provenance", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalSchemaThrough(
      context,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    );
    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-routing-upgrade', 'project-routing-upgrade', 'routing upgrade',
        'implementation', 1, 'running',
        '2026-07-18T03:00:00.000Z', '2026-07-18T03:00:00.000Z'
      );

      INSERT INTO project.room_seats (
        id, project_id, room_id, role, state, created_at, updated_at
      ) VALUES (
        'seat-routing-upgrade', 'project-routing-upgrade', 'room-routing-upgrade',
        'reviewer', 'active',
        '2026-07-18T03:00:00.000Z', '2026-07-18T03:00:00.000Z'
      );

      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, host_id, state, attached_at
      ) VALUES (
        'binding-routing-upgrade', 'project-routing-upgrade', 'room-routing-upgrade',
        'seat-routing-upgrade', 1, 'happier', 'codex',
        'native-routing-upgrade', 'windows-host-routing-upgrade', 'attached',
        '2026-07-18T03:00:00.000Z'
      );

      INSERT INTO project.room_messages (
        id, project_id, room_id, origin_type, origin_id, intent,
        target, authority, content, content_hash, created_at
      ) VALUES (
        'message-routing-upgrade', 'project-routing-upgrade', 'room-routing-upgrade',
        'operator', 'operator-routing-upgrade', 'instruction',
        '{"kind":"seats","seatIds":["seat-routing-upgrade"]}'::jsonb,
        '{}'::jsonb, 'legacy routed message', 'sha256:routing-upgrade',
        '2026-07-18T03:01:00.000Z'
      );
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION),
    );

    const messages = (await context.connections!.migration.execute(sql`
      SELECT target_seat_ids, idempotency_key, expected_aggregate_version
      FROM project.room_messages
      WHERE id = 'message-routing-upgrade'
    `)) as unknown as Array<{
      target_seat_ids: string[];
      idempotency_key: string | null;
      expected_aggregate_version: number | null;
    }>;
    expect(messages).toEqual([{
      target_seat_ids: ["seat-routing-upgrade"],
      idempotency_key: null,
      expected_aggregate_version: null,
    }]);

    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_message_targets (
        id, project_id, room_id, message_id, selector_kind, selector_ref,
        target_kind, seat_id, binding_id, ordinal, created_at
      ) VALUES (
        'target-routing-upgrade', 'project-routing-upgrade', 'room-routing-upgrade',
        'message-routing-upgrade', 'group', 'role:reviewer', 'seat',
        'seat-routing-upgrade', 'binding-routing-upgrade', 0,
        '2026-07-18T03:01:00.000Z'
      )
    `));
    const targets = (await context.connections!.migration.execute(sql`
      SELECT selector_kind, selector_ref, target_kind, seat_id, binding_id, ordinal
      FROM project.room_message_targets
      WHERE message_id = 'message-routing-upgrade'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(targets).toEqual([{
      selector_kind: "group",
      selector_ref: "role:reviewer",
      target_kind: "seat",
      seat_id: "seat-routing-upgrade",
      binding_id: "binding-routing-upgrade",
      ordinal: 0,
    }]);
  });

  it("upgrades existing 0011 task rows into scoped typed DAG projections", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalSchemaThrough(
      context,
      SCHEMA_ROOM_MESSAGE_ROUTING_VERSION,
    );
    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-dag-upgrade', 'project-dag-upgrade', 'legacy DAG upgrade',
        'implementation', 1, 'running',
        '2026-07-18T04:00:00.000Z', '2026-07-18T04:00:00.000Z'
      );

      INSERT INTO project.room_task_nodes (
        id, project_id, room_id, parent_node_id, objective, state,
        input_refs, output_refs, required_gate_ids, progress_signature, node_version
      ) VALUES
        (
          'node-dag-upgrade-a', 'project-dag-upgrade', 'room-dag-upgrade', NULL,
          'legacy producer', 'ready', '["input:a"]'::jsonb, '["output:a"]'::jsonb,
          '["gate:a"]'::jsonb, NULL, 0
        ),
        (
          'node-dag-upgrade-b', 'project-dag-upgrade', 'room-dag-upgrade', NULL,
          'legacy verifier', 'waiting_dependency', '["input:b"]'::jsonb, '["output:b"]'::jsonb,
          '["gate:b"]'::jsonb, 'progress:b', 0
        );

      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-dag-upgrade', 'project-dag-upgrade', 'room-dag-upgrade',
        'node-dag-upgrade-a', 'node-dag-upgrade-b', 'requires',
        '2026-07-18T04:01:00.000Z'
      );
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_MESSAGE_ROUTING_VERSION),
    );

    const rooms = (await context.connections!.migration.execute(sql`
      SELECT task_graph_version::integer AS task_graph_version
      FROM project.operational_rooms
      WHERE id = 'room-dag-upgrade'
    `)) as unknown as Array<{ task_graph_version: number }>;
    expect(rooms).toEqual([{ task_graph_version: 0 }]);

    const roomVersionConstraints = (await context.connections!.migration.execute(sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'project'
        AND table_name = 'operational_rooms'
        AND constraint_name IN (
          'operational_rooms_aggregate_version_check',
          'operational_rooms_task_graph_version_check'
        )
      ORDER BY constraint_name
    `)) as unknown as Array<{ constraint_name: string }>;
    expect(roomVersionConstraints.map((row) => row.constraint_name)).toEqual([
      "operational_rooms_aggregate_version_check",
      "operational_rooms_task_graph_version_check",
    ]);

    const nodes = (await context.connections!.migration.execute(sql`
      SELECT
        id,
        role_requirements,
        capability_requirements,
        resource_hints,
        authority_scope,
        retry_policy,
        progress_signature,
        acceptance_evidence_ids,
        reopened_by_evidence_id
      FROM project.room_task_nodes
      WHERE room_id = 'room-dag-upgrade'
      ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
    expect(nodes).toEqual([
      {
        id: "node-dag-upgrade-a",
        role_requirements: [],
        capability_requirements: [],
        resource_hints: {
          estimatedDurationMs: 0,
          concurrencyClass: "serial",
          preferredProviderIds: [],
        },
        authority_scope: { allowedActions: [], readPaths: [], writePaths: [] },
        retry_policy: {
          maxAttempts: 1,
          backoff: "fixed",
          baseDelayMs: 0,
          recoveryActions: [],
        },
        progress_signature: "legacy:0011:node-dag-upgrade-a:v0",
        acceptance_evidence_ids: [],
        reopened_by_evidence_id: null,
      },
      {
        id: "node-dag-upgrade-b",
        role_requirements: [],
        capability_requirements: [],
        resource_hints: {
          estimatedDurationMs: 0,
          concurrencyClass: "serial",
          preferredProviderIds: [],
        },
        authority_scope: { allowedActions: [], readPaths: [], writePaths: [] },
        retry_policy: {
          maxAttempts: 1,
          backoff: "fixed",
          baseDelayMs: 0,
          recoveryActions: [],
        },
        progress_signature: "progress:b",
        acceptance_evidence_ids: [],
        reopened_by_evidence_id: null,
      },
    ]);

    const edgeConstraints = (await context.connections!.migration.execute(sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'project'
        AND table_name = 'room_task_edges'
        AND constraint_name IN (
          'room_task_edges_from_room_project_fkey',
          'room_task_edges_to_room_project_fkey',
          'room_task_edges_kind_check',
          'room_task_edges_self_check'
        )
      ORDER BY constraint_name
    `)) as unknown as Array<{ constraint_name: string }>;
    expect(edgeConstraints.map((row) => row.constraint_name)).toEqual([
      "room_task_edges_from_room_project_fkey",
      "room_task_edges_kind_check",
      "room_task_edges_self_check",
      "room_task_edges_to_room_project_fkey",
    ]);

    const upgradedStore = new AsyncRoomStore(
      createAsyncDataLayer(context.connections!, { projectId: "project-dag-upgrade" }),
      { projectId: "project-dag-upgrade" },
    );
    await expect(upgradedStore.getTaskGraph("room-dag-upgrade")).resolves.toMatchObject({
      roomId: "room-dag-upgrade",
      dagVersion: 0,
      nodes: [
        expect.objectContaining({
          id: "node-dag-upgrade-a",
          progressSignature: "legacy:0011:node-dag-upgrade-a:v0",
        }),
        expect.objectContaining({ id: "node-dag-upgrade-b", progressSignature: "progress:b" }),
      ],
    });

    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET resource_hints = '{"estimatedDurationMs":1.5,"concurrencyClass":"serial","preferredProviderIds":[]}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET resource_hints = '{"estimatedDurationMs":1,"concurrencyClass":"serial","preferredProviderIds":[],"extra":true}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET authority_scope = '{"allowedActions":[],"readPaths":[],"writePaths":[],"extra":true}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET retry_policy = '{"maxAttempts":1.5,"backoff":"fixed","baseDelayMs":0,"recoveryActions":[]}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET retry_policy = '{"maxAttempts":1,"backoff":"fixed","baseDelayMs":0.5,"recoveryActions":[]}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET retry_policy = '{"maxAttempts":1,"backoff":"fixed","baseDelayMs":0,"recoveryActions":[],"extra":true}'::jsonb
      WHERE id = 'node-dag-upgrade-a'
    `))).rejects.toThrow();

    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-dag-foreign', 'project-dag-upgrade', 'foreign Room',
        'implementation', 1, 'running',
        '2026-07-18T04:02:00.000Z', '2026-07-18T04:02:00.000Z'
      );
      INSERT INTO project.room_task_nodes (
        id, project_id, room_id, objective, state, progress_signature
      ) VALUES (
        'node-dag-foreign', 'project-dag-upgrade', 'room-dag-foreign',
        'foreign node', 'ready', 'progress:foreign'
      );
    `));
    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-dag-cross-room', 'project-dag-upgrade', 'room-dag-upgrade',
        'node-dag-upgrade-a', 'node-dag-foreign', 'requires',
        '2026-07-18T04:03:00.000Z'
      )
    `))).rejects.toThrow();

    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.operational_rooms
      SET aggregate_version = -1
      WHERE id = 'room-dag-upgrade'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.operational_rooms
      SET aggregate_version = 9007199254740992
      WHERE id = 'room-dag-upgrade'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.operational_rooms
      SET aggregate_version = 9007199254740991
      WHERE id = 'room-dag-upgrade'
    `))).resolves.toBeDefined();
  });

  it("upgrades 0012 topology rows and enforces one active edge shape while retaining tombstones", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await context.connections!.migration.execute(sql.raw(`
      DELETE FROM public.${MIGRATION_BOOKKEEPING_TABLE}
      WHERE version = '${SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION}';

      DROP INDEX IF EXISTS project.room_task_edges_active_shape_unique;

      ALTER TABLE project.room_task_nodes
        DROP CONSTRAINT IF EXISTS room_task_nodes_origin_check,
        DROP CONSTRAINT IF EXISTS room_task_nodes_terminal_lineage_check,
        DROP COLUMN IF EXISTS origin,
        DROP COLUMN IF EXISTS terminal_lineage;

      ALTER TABLE project.room_task_edges
        DROP CONSTRAINT IF EXISTS room_task_edges_retirement_check,
        DROP CONSTRAINT IF EXISTS room_task_edges_derived_lineage_check,
        DROP COLUMN IF EXISTS retired_at,
        DROP COLUMN IF EXISTS retired_by_operation_id,
        DROP COLUMN IF EXISTS created_by_operation_id,
        DROP COLUMN IF EXISTS derived_from_edge_ids,
        ADD CONSTRAINT room_task_edges_shape_unique
          UNIQUE (room_id, from_node_id, to_node_id, kind);

      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-topology-upgrade', 'project-topology-upgrade', 'legacy topology',
        'implementation', 1, 'running',
        '2026-07-18T07:20:00.000Z', '2026-07-18T07:20:00.000Z'
      );

      INSERT INTO project.room_task_nodes (
        id, project_id, room_id, objective, state, progress_signature
      ) VALUES
        (
          'node-topology-upgrade-a', 'project-topology-upgrade',
          'room-topology-upgrade', 'legacy source', 'ready', 'progress:legacy:a'
        ),
        (
          'node-topology-upgrade-b', 'project-topology-upgrade',
          'room-topology-upgrade', 'legacy target', 'waiting_dependency', 'progress:legacy:b'
        );

      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-topology-upgrade-old', 'project-topology-upgrade', 'room-topology-upgrade',
        'node-topology-upgrade-a', 'node-topology-upgrade-b', 'requires',
        '2026-07-18T07:20:01.000Z'
      );
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION]);

    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_edges
      SET derived_from_edge_ids = '["edge-topology-upgrade-source"]'::jsonb
      WHERE id = 'edge-topology-upgrade-old'
    `))).rejects.toThrow();

    const nodes = (await context.connections!.migration.execute(sql`
      SELECT id, origin, terminal_lineage
      FROM project.room_task_nodes
      WHERE room_id = 'room-topology-upgrade'
      ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
    expect(nodes).toEqual([
      { id: "node-topology-upgrade-a", origin: { kind: "created" }, terminal_lineage: null },
      { id: "node-topology-upgrade-b", origin: { kind: "created" }, terminal_lineage: null },
    ]);
    const edges = (await context.connections!.migration.execute(sql`
      SELECT id, retired_at, retired_by_operation_id, created_by_operation_id, derived_from_edge_ids
      FROM project.room_task_edges
      WHERE room_id = 'room-topology-upgrade'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(edges).toEqual([{
      id: "edge-topology-upgrade-old",
      retired_at: null,
      retired_by_operation_id: null,
      created_by_operation_id: null,
      derived_from_edge_ids: [],
    }]);
    const indexes = (await context.connections!.migration.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename = 'room_task_edges'
        AND indexname = 'room_task_edges_active_shape_unique'
    `)) as unknown as Array<{ indexdef: string }>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("WHERE (retired_at IS NULL)");

    const expectRejectedTopologyShape = async (statement: string): Promise<void> => {
      await expect(context.connections!.migration.execute(sql.raw(statement))).rejects.toThrow();
    };
    const operationId = "room-task-topology:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reasonHash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await expectRejectedTopologyShape(`
      UPDATE project.room_task_nodes
      SET origin = '{"kind":"split_child","operationId":null,"sourceNodeIds":["node-topology-upgrade-a"]}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_nodes
      SET
        state = 'cancelled',
        terminal_lineage = '{"kind":"cancel","operationId":42,"at":"2026-07-18T07:22:00.000Z","reasonHash":"${reasonHash}"}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_nodes
      SET
        state = 'cancelled',
        terminal_lineage = '{"kind":"cancel","operationId":"${operationId}","at":null,"reasonHash":"${reasonHash}"}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_nodes
      SET
        state = 'cancelled',
        terminal_lineage = '{"kind":"cancel","operationId":"${operationId}","at":"2026-07-18T07:22:00Z","reasonHash":"${reasonHash}"}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_nodes
      SET
        state = 'cancelled',
        terminal_lineage = '{"kind":"cancel","operationId":"${operationId}","at":"2026-02-30T07:22:00.000Z","reasonHash":"${reasonHash}"}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `);
    await context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_nodes
      SET
        state = 'cancelled',
        terminal_lineage = '{"kind":"cancel","operationId":"${operationId}","at":"2026-07-18T07:22:00.000Z","reasonHash":"${reasonHash}"}'::jsonb
      WHERE id = 'node-topology-upgrade-a'
    `));
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET created_by_operation_id = '${operationId}'
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET
        created_by_operation_id = '   ',
        derived_from_edge_ids = '["edge-topology-upgrade-source"]'::jsonb
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET derived_from_edge_ids = 'null'::jsonb
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_edges
      SET
        created_by_operation_id = '${operationId}',
        derived_from_edge_ids = '["edge-topology-upgrade-source"]'::jsonb
      WHERE id = 'edge-topology-upgrade-old';

      UPDATE project.room_task_edges
      SET
        created_by_operation_id = NULL,
        derived_from_edge_ids = '[]'::jsonb
      WHERE id = 'edge-topology-upgrade-old';
    `));
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET retired_by_operation_id = '${operationId}'
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET retired_at = '2026-07-18T07:22:00.000Z'
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET
        retired_at = '2026-07-18T07:22:00Z',
        retired_by_operation_id = '${operationId}'
      WHERE id = 'edge-topology-upgrade-old'
    `);
    await expectRejectedTopologyShape(`
      UPDATE project.room_task_edges
      SET
        retired_at = '2026-02-30T07:22:00.000Z',
        retired_by_operation_id = '${operationId}'
      WHERE id = 'edge-topology-upgrade-old'
    `);

    await context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_task_edges
      SET
        retired_at = '2026-07-18T07:21:00.000Z',
        retired_by_operation_id = 'room-task-topology:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      WHERE id = 'edge-topology-upgrade-old';

      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-topology-upgrade-active', 'project-topology-upgrade', 'room-topology-upgrade',
        'node-topology-upgrade-a', 'node-topology-upgrade-b', 'requires',
        '2026-07-18T07:21:00.000Z'
      );
    `));
    await expectRejectedTopologyShape(`
      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-topology-upgrade-old', 'project-topology-upgrade', 'room-topology-upgrade',
        'node-topology-upgrade-a', 'node-topology-upgrade-b', 'requires',
        '2026-07-18T07:21:01.000Z'
      )
    `);

    await expectRejectedTopologyShape(`
      INSERT INTO project.room_task_edges (
        id, project_id, room_id, from_node_id, to_node_id, kind, created_at
      ) VALUES (
        'edge-topology-upgrade-duplicate', 'project-topology-upgrade', 'room-topology-upgrade',
        'node-topology-upgrade-a', 'node-topology-upgrade-b', 'requires',
        '2026-07-18T07:21:01.000Z'
      )
    `);

    const persistedTopology = (await context.connections!.migration.execute(sql`
      SELECT id, retired_at, retired_by_operation_id, created_by_operation_id
      FROM project.room_task_edges
      WHERE room_id = 'room-topology-upgrade'
      ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
    expect(persistedTopology).toEqual([
      {
        id: "edge-topology-upgrade-active",
        retired_at: null,
        retired_by_operation_id: null,
        created_by_operation_id: null,
      },
      {
        id: "edge-topology-upgrade-old",
        retired_at: "2026-07-18T07:21:00.000Z",
        retired_by_operation_id: operationId,
        created_by_operation_id: null,
      },
    ]);
  });

  it("upgrades a legacy accepted node with deterministic hash-only acceptance evidence", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalSchemaThrough(
      context,
      SCHEMA_ROOM_MESSAGE_ROUTING_VERSION,
    );
    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-dag-accepted-legacy', 'project-dag-accepted-legacy',
        'legacy accepted DAG', 'implementation', 1, 'running',
        '2026-07-18T04:10:00.000Z', '2026-07-18T04:10:00.000Z'
      );

      INSERT INTO project.room_task_nodes (
        id, project_id, room_id, objective, state, progress_signature,
        node_version, accepted_at
      ) VALUES (
        'node-dag-accepted-legacy', 'project-dag-accepted-legacy',
        'room-dag-accepted-legacy', 'legacy accepted node', 'accepted',
        'progress:legacy-accepted', 1, '2026-07-18T04:09:00.000Z'
      );
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_MESSAGE_ROUTING_VERSION),
    );
    expect(await getAppliedMigrations(context.connections!.migration)).toContain(
      SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION,
    );

    const nodes = (await context.connections!.migration.execute(sql`
      SELECT
        accepted_at,
        acceptance_evidence_ids,
        jsonb_build_array(format(
          'legacy:0011:acceptance:md5:%s',
          md5(jsonb_build_array(project_id, room_id, id, node_version, accepted_at)::text)
        )) AS expected_acceptance_evidence_ids
      FROM project.room_task_nodes
      WHERE id = 'node-dag-accepted-legacy'
    `)) as unknown as Array<{
      accepted_at: string;
      acceptance_evidence_ids: string[];
      expected_acceptance_evidence_ids: string[];
    }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      accepted_at: "2026-07-18T04:09:00.000Z",
      acceptance_evidence_ids: nodes[0]!.expected_acceptance_evidence_ids,
    });
    const marker = nodes[0]!.acceptance_evidence_ids[0]!;
    expect(marker).toMatch(/^legacy:0011:acceptance:md5:[0-9a-f]{32}$/);
    expect(marker).not.toContain("project-dag-accepted-legacy");
    expect(marker).not.toContain("room-dag-accepted-legacy");
    expect(marker).not.toContain("node-dag-accepted-legacy");
    expect(marker).not.toContain("legacy accepted node");
    expect(marker).not.toContain("2026-07-18T04:09:00.000Z");
  });

  it("fails 0012 before registration when a legacy accepted node lacks accepted_at", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalSchemaThrough(
      context,
      SCHEMA_ROOM_MESSAGE_ROUTING_VERSION,
    );
    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-dag-incomplete-accepted', 'project-dag-incomplete-accepted',
        'incomplete legacy accepted DAG', 'implementation', 1, 'running',
        '2026-07-18T04:20:00.000Z', '2026-07-18T04:20:00.000Z'
      );

      INSERT INTO project.room_task_nodes (
        id, project_id, room_id, objective, state, progress_signature,
        node_version, accepted_at
      ) VALUES (
        'node-dag-incomplete-accepted', 'project-dag-incomplete-accepted',
        'room-dag-incomplete-accepted', 'incomplete legacy accepted node', 'accepted',
        'progress:legacy-incomplete', 1, NULL
      );
    `));

    await expect(
      applySchemaBaseline(context.connections!.migration, { pluginHooks: [] }),
    ).rejects.toThrow(/legacy accepted Room task nodes lack accepted_at/);
    expect(await getAppliedMigrations(context.connections!.migration)).not.toContain(
      SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION,
    );
  }, 30_000);

  it("upgrades an existing 0000 database without replaying the baseline", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalBaseline(context);
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES ('${SQLITE_MIGRATION_RUNTIME_READ_VERSION}');
    `));

    const historicalBaselineTables = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'approval_requests'
    `)) as unknown as Array<{ table_name: string }>;
    expect(historicalBaselineTables).toEqual([{ table_name: "approval_requests" }]);

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });

    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SQLITE_MIGRATION_RUNTIME_READ_VERSION),
    );
    expect(result.appliedVersions).toContain(SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION);
    expect(result.baselineApplied).toBe(false);
    const rooms = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'operational_rooms'
    `)) as unknown as Array<{ table_name: string }>;
    expect(rooms).toEqual([{ table_name: "operational_rooms" }]);
    const evolutionTables = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'room_evolution_hypotheses'
    `)) as unknown as Array<{ table_name: string }>;
    expect(evolutionTables).toEqual([{ table_name: "room_evolution_hypotheses" }]);
  });

  it("upgrades an existing 0001 Room schema through connector ingestion", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalBaseline(context);
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES ('${SQLITE_MIGRATION_RUNTIME_READ_VERSION}'), ('${SCHEMA_ROOM_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_VERSION),
    );
    const indexes = (await context.connections!.migration.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND indexname IN (
          'idx_room_bindings_active_native_session',
          'idx_room_bindings_active_happier_session'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "idx_room_bindings_active_happier_session",
      "idx_room_bindings_active_native_session",
    ]);
    const outboxColumns = (await context.connections!.migration.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'room_outbox'
        AND column_name = 'local_message_id'
    `)) as unknown as Array<{ column_name: string; is_nullable: string }>;
    expect(outboxColumns).toEqual([{ column_name: "local_message_id", is_nullable: "NO" }]);
  });

  it("upgrades an existing 0002 schema through connector ingestion", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalBaseline(context);
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(ownershipSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES
        ('${SQLITE_MIGRATION_RUNTIME_READ_VERSION}'),
        ('${SCHEMA_ROOM_VERSION}'),
        ('${SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION),
    );
    const indexes = (await context.connections!.migration.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'project' AND indexname = 'idx_room_outbox_local_message'
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes).toEqual([{ indexname: "idx_room_outbox_local_message" }]);
  });

  it("upgrades an existing 0003 schema and deterministically backfills inbox identities", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalBaseline(context);
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    const outboxSql = await readSchemaMigrationSql(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION);
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(ownershipSql));
    await context.connections!.migration.execute(sql.raw(outboxSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES
        ('${SQLITE_MIGRATION_RUNTIME_READ_VERSION}'),
        ('${SCHEMA_ROOM_VERSION}'),
        ('${SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION}'),
        ('${SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION}');

      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-upgrade-0003', 'project-1', 'objective', 'implementation', 1,
        'draft', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO project.room_seats (
        id, project_id, room_id, role, state, created_at, updated_at
      ) VALUES (
        'seat-upgrade-0003', 'project-1', 'room-upgrade-0003', 'producer', 'active',
        '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id, provider_id,
        native_session_id, host_id, state, attached_at
      ) VALUES (
        'binding-upgrade-0003', 'project-1', 'room-upgrade-0003', 'seat-upgrade-0003', 1,
        'happier', 'codex', 'native-session-upgrade-0003', 'windows-host-1', 'attached',
        '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO project.room_inbox_receipts (
        id, project_id, room_id, binding_id, native_message_id,
        native_cursor, payload_hash, received_at
      ) VALUES
        (
          'inbox-upgrade-native', 'project-1', 'room-upgrade-0003', 'binding-upgrade-0003',
          'native-message-legacy', 'cursor-legacy-1', 'sha256:legacy-native',
          '2026-07-17T00:01:00.000Z'
        ),
        (
          'inbox-upgrade-fallback', 'project-1', 'room-upgrade-0003', 'binding-upgrade-0003',
          NULL, 'cursor-legacy-2', 'sha256:legacy-fallback',
          '2026-07-17T00:02:00.000Z'
        ),
        (
          'inbox-upgrade-native-overlap', 'project-1', 'room-upgrade-0003', 'binding-upgrade-0003',
          'native-message-legacy', 'cursor-legacy-3', 'sha256:legacy-native',
          '2026-07-17T00:03:00.000Z'
        );
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION),
    );
    const receipts = (await context.connections!.migration.execute(sql`
      SELECT id, dedupe_key, role, occurred_at, source, legacy_placeholder
      FROM project.room_inbox_receipts
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      dedupe_key: string;
      role: string;
      occurred_at: string;
      source: string;
      legacy_placeholder: boolean;
    }>;
    expect(receipts).toEqual([
      {
        id: "inbox-upgrade-fallback",
        dedupe_key: "legacy-fallback:inbox-upgrade-fallback",
        role: "unknown",
        occurred_at: "2026-07-17T00:02:00.000Z",
        source: "history",
        legacy_placeholder: true,
      },
      {
        id: "inbox-upgrade-native",
        dedupe_key: "native:native-message-legacy",
        role: "unknown",
        occurred_at: "2026-07-17T00:01:00.000Z",
        source: "history",
        legacy_placeholder: true,
      },
      {
        id: "inbox-upgrade-native-overlap",
        dedupe_key: "legacy-native-overlap:native-message-legacy:inbox-upgrade-native-overlap",
        role: "unknown",
        occurred_at: "2026-07-17T00:03:00.000Z",
        source: "history",
        legacy_placeholder: true,
      },
    ]);

    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    expect(await store.recordConnectorTranscriptBatch({
      roomId: "room-upgrade-0003",
      bindingId: "binding-upgrade-0003",
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-legacy-1",
      truncated: false,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T00:04:00.000Z",
      items: [{
        nativeMessageId: "native-message-legacy",
        logicalMessageId: "logical-message-legacy",
        nativeCursor: "cursor-legacy-1",
        payloadHash: "sha256:legacy-native",
        role: "assistant",
        occurredAt: "2026-07-17T00:00:30.000Z",
      }],
    })).toMatchObject({ insertedCount: 0, duplicateNativeMessageIdCount: 1 });
    expect(await store.recordConnectorTranscriptBatch({
      roomId: "room-upgrade-0003",
      bindingId: "binding-upgrade-0003",
      source: "history",
      fromCursor: "cursor-legacy-1",
      nextCursor: "cursor-legacy-2-rewritten",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T00:05:00.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: "logical-message-fallback",
        nativeCursor: "cursor-legacy-2-rewritten",
        payloadHash: "sha256:legacy-fallback",
        role: "tool",
        occurredAt: "2026-07-17T00:01:30.000Z",
      }],
    })).toMatchObject({
      insertedCount: 0,
      duplicatePayloadHashCount: 1,
      state: { transcriptCursor: "cursor-legacy-2-rewritten" },
    });
    const enriched = (await context.connections!.migration.execute(sql`
      SELECT id, dedupe_key, logical_message_id, role, occurred_at, source, legacy_placeholder
      FROM project.room_inbox_receipts
      WHERE id IN ('inbox-upgrade-native', 'inbox-upgrade-fallback')
      ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
    expect(enriched).toEqual([
      {
        id: "inbox-upgrade-fallback",
        dedupe_key: "fallback:sha256:legacy-fallback:tool:2026-07-17T00:01:30.000Z",
        logical_message_id: "logical-message-fallback",
        role: "tool",
        occurred_at: "2026-07-17T00:01:30.000Z",
        source: "history",
        legacy_placeholder: false,
      },
      {
        id: "inbox-upgrade-native",
        dedupe_key: "native:native-message-legacy",
        logical_message_id: "logical-message-legacy",
        role: "assistant",
        occurred_at: "2026-07-17T00:00:30.000Z",
        source: "history",
        legacy_placeholder: false,
      },
    ]);
    const stateTables = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'room_binding_ingestion_state'
    `)) as unknown as Array<{ table_name: string }>;
    expect(stateTables).toEqual([{ table_name: "room_binding_ingestion_state" }]);
  });

  it("upgrades an existing 0004 schema with durable delivery reconciliation evidence", async () => {
    const context = await startEmbeddedDatabase();
    await materializeHistoricalBaseline(context);
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    const outboxSql = await readSchemaMigrationSql(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION);
    const ingestionSql = await readSchemaMigrationSql(SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION);
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(ownershipSql));
    await context.connections!.migration.execute(sql.raw(outboxSql));
    await context.connections!.migration.execute(sql.raw(ingestionSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES
        ('${SQLITE_MIGRATION_RUNTIME_READ_VERSION}'),
        ('${SCHEMA_ROOM_VERSION}'),
        ('${SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION}'),
        ('${SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION}'),
        ('${SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual(
      expectedRegisteredMigrationsAfter(SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION),
    );
    const columns = (await context.connections!.migration.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'room_outbox'
        AND column_name IN ('reconciliation_from_cursor', 'reconciliation_evidence_ref')
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string; is_nullable: string }>;
    expect(columns).toEqual([
      { column_name: "reconciliation_evidence_ref", is_nullable: "YES" },
      { column_name: "reconciliation_from_cursor", is_nullable: "YES" },
    ]);
    const bindingColumns = (await context.connections!.migration.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'room_bindings'
        AND column_name = 'machine_id'
    `)) as unknown as Array<{ column_name: string; is_nullable: string }>;
    expect(bindingColumns).toEqual([{ column_name: "machine_id", is_nullable: "YES" }]);
  });

  it("idempotently backfills legacy Room run-audit rows from metadata during 0007", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await context.connections!.migration.execute(sql`
      INSERT INTO project.tasks (
        id, project_id, description, "column", created_at, updated_at
      ) VALUES (
        'legacy-task-audit-target', 'project-task-owner', 'legacy task', 'done',
        '2026-07-17T12:49:00.000Z', '2026-07-17T12:49:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.run_audit_events (
        id, timestamp, project_id, task_id, agent_id, run_id,
        domain, mutation_type, target, metadata
      ) VALUES
        (
          'legacy-room-audit', '2026-07-17T12:50:00.000Z', NULL, NULL,
          'legacy-worker', 'room-controller:legacy', 'database',
          'room:worker-started', 'legacy-room',
          ${JSON.stringify({ projectId: "project-legacy", roomId: "legacy-room" })}::jsonb
        ),
        (
          'legacy-task-audit', '2026-07-17T12:51:00.000Z', NULL, 'legacy-task-audit-target',
          'legacy-worker', 'task-run:legacy', 'database',
          'mergeQueue:enqueue', 'legacy-task-audit-target', '{}'::jsonb
        )
    `);

    await context.connections!.migration.execute(
      sql.raw(await readSchemaMigrationSql(SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION)),
    );

    const rows = (await context.connections!.migration.execute(sql`
      SELECT id, project_id
      FROM project.run_audit_events
      WHERE id IN ('legacy-room-audit', 'legacy-task-audit')
      ORDER BY id
    `)) as unknown as Array<{ id: string; project_id: string | null }>;
    expect(rows).toEqual([
      { id: "legacy-room-audit", project_id: "project-legacy" },
      { id: "legacy-task-audit", project_id: "project-task-owner" },
    ]);
  });

  it("upgrades 0008 pending membership rows into global Session identity reservations", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await restorePreMembershipProductionInvariantState(context);
    const binding = {
      id: "binding-upgrade-0009",
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: "native-upgrade-0009",
      happierSessionId: "happier-upgrade-0009",
      serverProfileId: "server-profile-1",
      machineId: "machine-upgrade-0009",
      hostId: "windows-host-1",
    };
    await context.connections!.migration.execute(sql`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, aggregate_version, membership_version,
        created_at, updated_at
      ) VALUES (
        'room-upgrade-0009', 'project-upgrade-0009', 'upgrade membership reservations',
        'implementation', 1, 'running', 3, 1,
        '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_membership_changes (
        id, project_id, room_id, seat_id, kind, payload, reason,
        requested_at, requested_by, effective_after_turn_id, applied_at, state
      ) VALUES (
        'change-upgrade-0009', 'project-upgrade-0009', 'room-upgrade-0009',
        'future-seat-upgrade-0009', 'add',
        ${JSON.stringify({ seat: { id: "future-seat-upgrade-0009" }, binding })}::jsonb,
        'preserve the pending Session identity reservation',
        '2026-07-17T12:01:00.000Z', 'operator-1', 'turn-upgrade-0009', NULL,
        'waiting_turn_boundary'
      )
    `);

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });

    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
    ]);
    const reservations = (await context.connections!.migration.execute(sql`
      SELECT
        reserved_connector_id,
        reserved_provider_id,
        reserved_native_session_id,
        reserved_happier_session_id,
        failed_at,
        failure_code
      FROM project.room_membership_changes
      WHERE id = 'change-upgrade-0009'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(reservations).toEqual([{
      reserved_connector_id: "happier",
      reserved_provider_id: "claude",
      reserved_native_session_id: "native-upgrade-0009",
      reserved_happier_session_id: "happier-upgrade-0009",
      failed_at: null,
      failure_code: null,
    }]);
    const activeIndexes = (await context.connections!.migration.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND indexname IN (
          'idx_room_bindings_active_native_session',
          'idx_room_bindings_active_happier_session'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(activeIndexes).toHaveLength(2);
    for (const index of activeIndexes) {
      expect(index.indexdef).not.toContain("project_id");
    }
  });

  it("fails the 0009 upgrade closed when two projects already own one active Session identity", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await restorePreMembershipProductionInvariantState(context);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, aggregate_version, membership_version,
        created_at, updated_at
      ) VALUES
        (
          'room-upgrade-0009-conflict-a', 'project-upgrade-0009-conflict-a',
          'first historical owner', 'implementation', 1, 'running', 3, 1,
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        ),
        (
          'room-upgrade-0009-conflict-b', 'project-upgrade-0009-conflict-b',
          'second historical owner', 'implementation', 1, 'running', 3, 1,
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_seats (
        id, project_id, room_id, role, role_version, permission_scope,
        state, active_binding_id, created_at, updated_at
      ) VALUES
        (
          'seat-upgrade-0009-conflict-a', 'project-upgrade-0009-conflict-a',
          'room-upgrade-0009-conflict-a', 'producer', 1, '[]'::jsonb,
          'active', 'binding-upgrade-0009-conflict-a',
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        ),
        (
          'seat-upgrade-0009-conflict-b', 'project-upgrade-0009-conflict-b',
          'room-upgrade-0009-conflict-b', 'producer', 1, '[]'::jsonb,
          'active', 'binding-upgrade-0009-conflict-b',
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES
        (
          'binding-upgrade-0009-conflict-a', 'project-upgrade-0009-conflict-a',
          'room-upgrade-0009-conflict-a', 'seat-upgrade-0009-conflict-a', 1,
          'happier', 'claude', 'native-upgrade-0009-conflict',
          'happier-upgrade-0009-conflict', 'windows-host-1', 'attached',
          '2026-07-17T12:00:00.000Z'
        ),
        (
          'binding-upgrade-0009-conflict-b', 'project-upgrade-0009-conflict-b',
          'room-upgrade-0009-conflict-b', 'seat-upgrade-0009-conflict-b', 1,
          'happier', 'claude', 'native-upgrade-0009-conflict',
          'happier-upgrade-0009-conflict', 'windows-host-1', 'attached',
          '2026-07-17T12:00:00.000Z'
        )
    `);

    await expect(applySchemaBaseline(
      context.connections!.migration,
      { pluginHooks: [] },
    )).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "idx_room_bindings_active_native_session",
      },
    });
    expect(await getAppliedMigrations(context.connections!.migration)).not.toContain(
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
    );
  });

  it("fails the 0009 upgrade closed for a malformed pending binding reservation", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await restorePreMembershipProductionInvariantState(context);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, aggregate_version, membership_version,
        created_at, updated_at
      ) VALUES (
        'room-upgrade-0009-malformed', 'project-upgrade-0009-malformed',
        'malformed historical reservation', 'implementation', 1,
        'running', 3, 1,
        '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_membership_changes (
        id, project_id, room_id, seat_id, kind, payload, reason,
        requested_at, requested_by, effective_after_turn_id, applied_at, state
      ) VALUES (
        'change-upgrade-0009-malformed', 'project-upgrade-0009-malformed',
        'room-upgrade-0009-malformed', 'future-seat-upgrade-0009-malformed',
        'add', '{"binding":{"connectorId":"happier"}}'::jsonb,
        'must not migrate without a native Session identity',
        '2026-07-17T12:01:00.000Z', 'unknown-writer', 'turn-upgrade-0009-malformed',
        NULL, 'waiting_turn_boundary'
      )
    `);

    await expect(applySchemaBaseline(
      context.connections!.migration,
      { pluginHooks: [] },
    )).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await getAppliedMigrations(context.connections!.migration)).not.toContain(
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
    );
  });

  it("fails the 0009 upgrade closed when active and pending rows share one Session identity", async () => {
    const context = await startEmbeddedDatabase();
    await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    await restorePreMembershipProductionInvariantState(context);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, aggregate_version, membership_version,
        created_at, updated_at
      ) VALUES
        (
          'room-upgrade-0009-active-owner', 'project-upgrade-0009-active-owner',
          'active historical owner', 'implementation', 1, 'running', 3, 1,
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        ),
        (
          'room-upgrade-0009-pending-owner', 'project-upgrade-0009-pending-owner',
          'pending historical owner', 'implementation', 1, 'running', 3, 0,
          '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
        )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_seats (
        id, project_id, room_id, role, role_version, permission_scope,
        state, active_binding_id, created_at, updated_at
      ) VALUES (
        'seat-upgrade-0009-active-owner', 'project-upgrade-0009-active-owner',
        'room-upgrade-0009-active-owner', 'producer', 1, '[]'::jsonb,
        'active', 'binding-upgrade-0009-active-owner',
        '2026-07-17T12:00:00.000Z', '2026-07-17T12:01:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_bindings (
        id, project_id, room_id, seat_id, generation, connector_id,
        provider_id, native_session_id, happier_session_id, host_id,
        state, attached_at
      ) VALUES (
        'binding-upgrade-0009-active-owner', 'project-upgrade-0009-active-owner',
        'room-upgrade-0009-active-owner', 'seat-upgrade-0009-active-owner', 1,
        'happier', 'claude', 'native-upgrade-0009-cross-table',
        'happier-upgrade-0009-cross-table', 'windows-host-1', 'attached',
        '2026-07-17T12:00:00.000Z'
      )
    `);
    await context.connections!.migration.execute(sql`
      INSERT INTO project.room_membership_changes (
        id, project_id, room_id, seat_id, kind, payload, reason,
        requested_at, requested_by, effective_after_turn_id, applied_at, state
      ) VALUES (
        'change-upgrade-0009-pending-owner', 'project-upgrade-0009-pending-owner',
        'room-upgrade-0009-pending-owner', 'future-seat-upgrade-0009-pending-owner',
        'add', ${JSON.stringify({
          binding: {
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: "native-upgrade-0009-cross-table",
            happierSessionId: "happier-upgrade-0009-cross-table",
          },
        })}::jsonb,
        'must not coexist with the active owner',
        '2026-07-17T12:01:00.000Z', 'operator-1', 'turn-upgrade-0009-pending-owner',
        NULL, 'waiting_turn_boundary'
      )
    `);

    await expect(applySchemaBaseline(
      context.connections!.migration,
      { pluginHooks: [] },
    )).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await getAppliedMigrations(context.connections!.migration)).not.toContain(
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
    );
  });

  it("materializes append-only controlled-evolution lineage with scoped evidence and rollback proof", async () => {
    const context = await startEmbeddedDatabase();
    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toContain(SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION);

    const evolutionTables = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project'
        AND table_name LIKE 'room_evolution_%'
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(evolutionTables.map((row) => row.table_name)).toEqual([
      "room_evolution_benchmark_cases",
      "room_evolution_benchmark_results",
      "room_evolution_canaries",
      "room_evolution_canary_observations",
      "room_evolution_candidate_versions",
      "room_evolution_experiments",
      "room_evolution_gate_results",
      "room_evolution_hypotheses",
      "room_evolution_promotion_decisions",
      "room_evolution_rollbacks",
    ]);

    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.operational_rooms (
        id, project_id, objective, protocol_id, protocol_version,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'room-evolution', 'project-evolution', 'controlled evolution fixture',
        'implementation', 1, 'running',
        '2026-07-19T13:21:00.000Z', '2026-07-19T13:21:00.000Z'
      );

      INSERT INTO project.room_evolution_hypotheses (
        id, project_id, room_id, scope_kind, scope_key, revision, state,
        source_signal_kinds, evidence, evidence_hash, declared_scope,
        risk_class, expected_mechanism, affected_domains, created_by_actor_id,
        created_at
      ) VALUES (
        'hypothesis-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 1, 'experimenting',
        '["verified_failure"]'::jsonb,
        '[{"outcomeId":"outcome-1","kind":"verified_failure"}]'::jsonb,
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '["task_decomposition"]'::jsonb, 'moderate',
        'Reduce repeated no-progress decomposition retries.',
        '["coding"]'::jsonb, 'operator-1', '2026-07-19T13:21:00.000Z'
      );

      INSERT INTO project.room_evolution_candidate_versions (
        id, project_id, room_id, scope_kind, scope_key, hypothesis_id,
        version_number, candidate_kind, base_revision, candidate_ref,
        isolation_kind, isolation_ref, immutable_input, input_hash,
        produced_by_actor_id, base_candidate_version_id,
        rollback_target_candidate_version_id, created_at
      ) VALUES
        (
          'candidate-base', 'project-evolution', 'room-evolution', 'room',
          'room:room-evolution', 'hypothesis-room', 1, 'task_decomposition',
          'strategy:baseline', 'strategy:candidate-base', 'versioned_policy_store',
          'policy://candidate-base', '{"prompt":"baseline"}'::jsonb,
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'producer-1', NULL, NULL, '2026-07-19T13:21:00.000Z'
        ),
        (
          'candidate-next', 'project-evolution', 'room-evolution', 'room',
          'room:room-evolution', 'hypothesis-room', 2, 'task_decomposition',
          'strategy:candidate-base', 'strategy:candidate-next', 'versioned_policy_store',
          'policy://candidate-next', '{"prompt":"more explicit"}'::jsonb,
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          'producer-1', 'candidate-base', 'candidate-base',
          '2026-07-19T13:21:01.000Z'
        );

      INSERT INTO project.room_evolution_experiments (
        id, project_id, room_id, scope_kind, scope_key, hypothesis_id,
        candidate_version_id, state, input_snapshot_hash, authorization_evidence,
        authorization_hash, capacity_pool, created_by_actor_id, created_at
      ) VALUES (
        'experiment-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'hypothesis-room', 'candidate-next', 'completed',
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        '{"policy":"approved"}'::jsonb,
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        'evolution_low_priority', 'operator-1', '2026-07-19T13:21:02.000Z'
      );

      INSERT INTO project.room_evolution_benchmark_cases (
        id, project_id, room_id, scope_kind, scope_key, domain, case_kind,
        contains_private_room_data, source_authorization_id, authorization_evidence,
        case_payload, expected_outcome, content_hash, created_at
      ) VALUES (
        'benchmark-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'coding', 'golden', false, NULL,
        '{}'::jsonb, '{"task":"decompose"}'::jsonb,
        '{"mustComplete":true}'::jsonb,
        'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        '2026-07-19T13:21:03.000Z'
      );

      INSERT INTO project.room_evolution_benchmark_results (
        id, project_id, room_id, scope_kind, scope_key, experiment_id,
        candidate_version_id, benchmark_case_id, evaluator_actor_id,
        evaluator_kind, outcome, metrics, evidence, evidence_hash, completed_at
      ) VALUES (
        'benchmark-result-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'experiment-room', 'candidate-next',
        'benchmark-room', 'reviewer-1', 'independent_reviewer', 'passed',
        '{"quality":0.9}'::jsonb,
        '[{"evidenceId":"evidence-benchmark"}]'::jsonb,
        'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        '2026-07-19T13:21:04.000Z'
      );

      INSERT INTO project.room_evolution_gate_results (
        id, project_id, room_id, scope_kind, scope_key, experiment_id,
        candidate_version_id, benchmark_result_id, gate_name, gate_class,
        outcome, evaluator_actor_id, evaluator_kind, candidate_producer_actor_id,
        metrics, evidence, evidence_hash, promotion_eligible, completed_at
      ) VALUES (
        'gate-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'experiment-room', 'candidate-next',
        'benchmark-result-room', 'evidence-integrity', 'hard', 'passed',
        'reviewer-1', 'independent_reviewer', 'producer-1',
        '{"integrity":1}'::jsonb,
        '[{"evidenceId":"evidence-gate"}]'::jsonb,
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        true, '2026-07-19T13:21:05.000Z'
      );

      INSERT INTO project.room_evolution_canaries (
        id, project_id, room_id, scope_kind, scope_key, experiment_id,
        candidate_version_id, allocation_version, allocation, success_criteria,
        failure_criteria, state, rollback_target_candidate_version_id,
        created_at
      ) VALUES (
        'canary-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'experiment-room', 'candidate-next', 1,
        '{"trafficPercent":5}'::jsonb, '{"maxCorrectionRate":0.05}'::jsonb,
        '{"maxCorrectionRate":0.1}'::jsonb, 'succeeded', 'candidate-base',
        '2026-07-19T13:21:06.000Z'
      );

      INSERT INTO project.room_evolution_canary_observations (
        id, project_id, room_id, scope_kind, scope_key, canary_id,
        metric_name, metric_value, threshold, breached, evidence, evidence_hash,
        observed_at
      ) VALUES (
        'canary-observation-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'canary-room', 'correction_rate',
        '{"value":0.02}'::jsonb, '{"max":0.05}'::jsonb, false,
        '[{"evidenceId":"evidence-canary"}]'::jsonb,
        'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        '2026-07-19T13:21:07.000Z'
      );

      INSERT INTO project.room_evolution_promotion_decisions (
        id, project_id, room_id, scope_kind, scope_key, experiment_id,
        candidate_version_id, canary_id, decision, risk_class, authority_tier,
        candidate_producer_actor_id, decision_actor_id, approval_request_id,
        authorization_evidence, evidence, evidence_hash,
        rollback_target_candidate_version_id, decided_at
      ) VALUES (
        'promotion-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'experiment-room', 'candidate-next', 'canary-room',
        'promoted', 'moderate', 'independent', 'producer-1', 'reviewer-1', NULL,
        '{"preAuthorized":true}'::jsonb,
        '[{"gateResultId":"gate-room"}]'::jsonb,
        'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        'candidate-base', '2026-07-19T13:21:08.000Z'
      );

      INSERT INTO project.room_evolution_rollbacks (
        id, project_id, room_id, scope_kind, scope_key, promotion_decision_id,
        canary_id, from_candidate_version_id, to_candidate_version_id,
        trigger_kind, reason, evidence, evidence_hash, executed_at
      ) VALUES (
        'rollback-room', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'promotion-room', 'canary-room', 'candidate-next',
        'candidate-base', 'automatic', 'simulated regression proof',
        '[{"observationId":"canary-observation-room"}]'::jsonb,
        'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        '2026-07-19T13:21:09.000Z'
      );
    `));

    const rollbackLineage = (await context.connections!.migration.execute(sql`
      SELECT from_candidate_version_id, to_candidate_version_id, trigger_kind
      FROM project.room_evolution_rollbacks
      WHERE id = 'rollback-room'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rollbackLineage).toEqual([{
      from_candidate_version_id: "candidate-next",
      to_candidate_version_id: "candidate-base",
      trigger_kind: "automatic",
    }]);

    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_hypotheses (
        id, project_id, room_id, scope_kind, scope_key, revision, state,
        source_signal_kinds, evidence, evidence_hash, declared_scope,
        risk_class, expected_mechanism, affected_domains, created_by_actor_id,
        created_at
      ) VALUES (
        'hypothesis-invalid-project-scope', 'project-evolution', 'room-evolution',
        'project', 'project:project-evolution', 1, 'proposed',
        '["verified_failure"]'::jsonb,
        '[{"outcomeId":"outcome-invalid"}]'::jsonb,
        'sha256:6666666666666666666666666666666666666666666666666666666666666666',
        '["task_decomposition"]'::jsonb, 'low', 'invalid project scope',
        '["coding"]'::jsonb, 'operator-1', '2026-07-19T13:21:10.000Z'
      )
    `))).rejects.toThrow();

    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_benchmark_cases (
        id, project_id, room_id, scope_kind, scope_key, domain, case_kind,
        contains_private_room_data, source_authorization_id, authorization_evidence,
        case_payload, expected_outcome, content_hash, created_at
      ) VALUES (
        'benchmark-private-without-authorization', 'project-evolution',
        'room-evolution', 'room', 'room:room-evolution', 'coding',
        'rolling_authorized', true, NULL, '{}'::jsonb,
        '{"task":"private"}'::jsonb, '{"mustComplete":true}'::jsonb,
        'sha256:7777777777777777777777777777777777777777777777777777777777777777',
        '2026-07-19T13:21:11.000Z'
      )
    `))).rejects.toThrow();

    await expect(context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_gate_results (
        id, project_id, room_id, scope_kind, scope_key, experiment_id,
        candidate_version_id, benchmark_result_id, gate_name, gate_class,
        outcome, evaluator_actor_id, evaluator_kind, candidate_producer_actor_id,
        metrics, evidence, evidence_hash, promotion_eligible, completed_at
      ) VALUES (
        'gate-self-accepted', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'experiment-room', 'candidate-next',
        'benchmark-result-room', 'self-report', 'hard', 'passed',
        'producer-1', 'producer_self_report', 'producer-1',
        '{}'::jsonb, '[{"evidenceId":"self-report"}]'::jsonb,
        'sha256:8888888888888888888888888888888888888888888888888888888888888888',
        true, '2026-07-19T13:21:12.000Z'
      )
    `))).rejects.toThrow();

    await context.connections!.migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_candidate_versions (
        id, project_id, room_id, scope_kind, scope_key, hypothesis_id,
        version_number, candidate_kind, base_revision, candidate_ref,
        isolation_kind, isolation_ref, immutable_input, input_hash,
        produced_by_actor_id, base_candidate_version_id,
        rollback_target_candidate_version_id, created_at
      ) VALUES (
        'candidate-immutable', 'project-evolution', 'room-evolution', 'room',
        'room:room-evolution', 'hypothesis-room', 3, 'task_decomposition',
        'strategy:candidate-next', 'strategy:candidate-immutable',
        'versioned_policy_store', 'policy://candidate-immutable',
        '{"prompt":"immutable"}'::jsonb,
        'sha256:9999999999999999999999999999999999999999999999999999999999999999',
        'producer-1', 'candidate-next', 'candidate-base',
        '2026-07-19T13:21:13.000Z'
      )
    `));
    await expect(context.connections!.migration.execute(sql.raw(`
      UPDATE project.room_evolution_candidate_versions
      SET candidate_ref = 'strategy:mutated'
      WHERE id = 'candidate-next'
    `))).rejects.toThrow();
    await expect(context.connections!.migration.execute(sql.raw(`
      DELETE FROM project.room_evolution_candidate_versions
      WHERE id = 'candidate-immutable'
    `))).rejects.toThrow();
  });
});
