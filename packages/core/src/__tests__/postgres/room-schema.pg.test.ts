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
  readSchemaMigrationSql,
  SCHEMA_BASELINE_VERSION,
  SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
  SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
  SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
  SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
  SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
  SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
  SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
  SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
  SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
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

    expect(result.appliedVersions).toEqual([
      SCHEMA_BASELINE_VERSION,
      SCHEMA_ROOM_VERSION,
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
    expect(result.baselineApplied).toBe(true);
    expect(await getAppliedMigrations(context.connections!.migration)).toEqual([
      SCHEMA_BASELINE_VERSION,
      SCHEMA_ROOM_VERSION,
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
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

    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_VERSION,
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
    expect(result.baselineApplied).toBe(false);
    const rooms = (await context.connections!.migration.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'operational_rooms'
    `)) as unknown as Array<{ table_name: string }>;
    expect(rooms).toEqual([{ table_name: "operational_rooms" }]);
  });

  it("upgrades an existing 0001 Room schema through connector ingestion", async () => {
    const context = await startEmbeddedDatabase();
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    await context.connections!.migration.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS project"));
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES ('${SCHEMA_BASELINE_VERSION}'), ('${SCHEMA_ROOM_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
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
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    await context.connections!.migration.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS project"));
    await context.connections!.migration.execute(sql.raw(roomSql));
    await context.connections!.migration.execute(sql.raw(ownershipSql));
    await context.connections!.migration.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.${MIGRATION_BOOKKEEPING_TABLE} (version)
      VALUES
        ('${SCHEMA_BASELINE_VERSION}'),
        ('${SCHEMA_ROOM_VERSION}'),
        ('${SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
    const indexes = (await context.connections!.migration.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'project' AND indexname = 'idx_room_outbox_local_message'
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes).toEqual([{ indexname: "idx_room_outbox_local_message" }]);
  });

  it("upgrades an existing 0003 schema and deterministically backfills inbox identities", async () => {
    const context = await startEmbeddedDatabase();
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    const outboxSql = await readSchemaMigrationSql(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION);
    await context.connections!.migration.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS project"));
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
        ('${SCHEMA_BASELINE_VERSION}'),
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
    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
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
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    const outboxSql = await readSchemaMigrationSql(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION);
    const ingestionSql = await readSchemaMigrationSql(SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION);
    await context.connections!.migration.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS project"));
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
        ('${SCHEMA_BASELINE_VERSION}'),
        ('${SCHEMA_ROOM_VERSION}'),
        ('${SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION}'),
        ('${SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION}'),
        ('${SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION}');
    `));

    const result = await applySchemaBaseline(context.connections!.migration, { pluginHooks: [] });
    expect(result.appliedVersions).toEqual([
      SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
      SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
      SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
      SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
    ]);
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
});
