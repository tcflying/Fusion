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
  SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
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

    expect(result.appliedVersions).toEqual([
      SCHEMA_BASELINE_VERSION,
      SCHEMA_ROOM_VERSION,
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
    ]);
    expect(result.baselineApplied).toBe(true);
    expect(await getAppliedMigrations(context.connections!.migration)).toEqual([
      SCHEMA_BASELINE_VERSION,
      SCHEMA_ROOM_VERSION,
      SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
      SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
      SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
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
    expect(result.appliedVersions).toEqual([SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION]);
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
});
