/**
 * PostgreSQL schema applier.
 *
 * FNXC:PostgresSchema 2026-06-24-03:40:
 * Applies ordered SQL migrations to a PostgreSQL connection and records each
 * version in a migration bookkeeping table. The baseline migration is the
 * translated final SQLite schema; later files upgrade both fresh and existing
 * PostgreSQL databases without mutating the historical baseline.
 *
 * After the baseline lands, plugin-owned tables are materialized via the
 * schema-init hook (VAL-SCHEMA-007). The applier calls each registered plugin
 * hook so plugins evolve their own tables independently of the core migration.
 *
 * Migration tracking uses a single-row bookkeeping table in the public schema
 * so the applier is idempotent: re-running against an already-migrated database
 * is a no-op. The version-gate discipline (the institutional learning that
 * fresh-DB tests cannot catch a skipped-on-upgrade migration) is carried
 * forward via the applier's explicit baseline marker.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { runPluginSchemaInitHooks, DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS, type PluginSchemaInitHook } from "./plugin-schema-hook.js";

/** Historical baseline version retained for API compatibility. */
export const SCHEMA_BASELINE_VERSION = "0000";

export const SCHEMA_ROOM_VERSION = "0001";

export const SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION = "0002";

export const SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION = "0003";
export const SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION = "0004";
export const SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION = "0005";
export const SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION = "0006";
export const SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION = "0007";
export const SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION = "0008";
export const SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION = "0009";
export const SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION = "0010";
export const SCHEMA_ROOM_MESSAGE_ROUTING_VERSION = "0011";
export const SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION = "0012";
export const SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION = "0013";
export const SCHEMA_ROOM_TASK_DISPATCH_DELIVERY_LINK_VERSION = "0014";
export const SCHEMA_ROOM_ROLE_ASSIGNMENT_VERSION = "0015";
export const SCHEMA_ROOM_SEMANTIC_ROUTING_VERSION = "0016";
/**
 * FNXC:SessionRoomProgressRecovery 2026-07-19-06:14:
 * Registers only the durable observation/recovery persistence foundation for
 * Task 5.8. Detection, scheduling, execution, and policy mutation remain
 * separate future commands and are not implied by applying this migration.
 */
export const SCHEMA_ROOM_TASK_PROGRESS_RECOVERY_VERSION = "0017";
export const SCHEMA_ROOM_PHASE_GATE_EVIDENCE_VERSION = "0018";
export const SCHEMA_ROOM_TASK_RECOVERY_PLAN_VERSION = "0019";
/**
 * FNXC:RoomCapabilityRegistry 2026-07-19-10:01:
 * Registers the durable current-registry projection independently from
 * capability routing or scheduling, which remain later OpenSpec 6.x work.
 */
export const SCHEMA_ROOM_CAPABILITY_REGISTRY_VERSION = "0020";
export const SCHEMA_ROOM_BLIND_REVIEW_REGISTRY_VERSION = "0021";
export const SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION = "0022";
/**
 * FNXC:RoomGlobalConcurrency 2026-07-19-16:39:
 * Register the durable global-concurrency tables in the ordered applier so
 * fresh databases and upgrades share the same fenced admission state.
 */
export const SCHEMA_ROOM_GLOBAL_CONCURRENCY_VERSION = "0023";
/**
 * FNXC:RoomProviderBackpressure 2026-07-19-17:25:
 * Apply the durable provider/account/model/connector/node lease and circuit
 * state before any Engine admission adapter may enforce provider pressure.
 */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_VERSION = "0024";
/**
 * FNXC:RoomRbacRegistry 2026-07-19-18:05:
 * Registers only project-scoped trusted-device digest sessions and role grants.
 * Dashboard bootstrap, pairing, and HTTP identity middleware remain separate.
 */
export const SCHEMA_ROOM_RBAC_REGISTRY_VERSION = "0025";
export const SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION = "0026";
/**
 * FNXC:RoomEvolutionLegacyProvenance 2026-07-19-21:40:
 * Apply the only safe bridge before trust-receipt constraints: legacy success
 * signals are quarantined and fail-closed instead of receiving invented proof.
 */
export const SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION = "0026a";
export const SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION = "0027";
export const SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION = "0027a";
/**
 * FNXC:RoomEvolutionExecutionRecovery 2026-07-19-21:42:
 * Register the Core-only execution run/effect recovery tables before an Engine
 * can inject an effect handler. Applying this migration does not dispatch work.
 */
export const SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION = "0028";
/**
 * FNXC:RoomProviderCleanupLedger 2026-07-20-00:18:
 * Cleanup actions are Core-owned durable evidence for reservations that cannot
 * be released under a replacement worker fence; register before Engine wiring.
 */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTIONS_VERSION = "0029";
/** Exact pre-send attempt identity makes terminal cleanup recovery safe to retry. */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_OUTBOX_UNBLOCK_VERSION = "0030";
export const SCHEMA_PROJECT_PLUGIN_STATE_SETTINGS_VERSION = "0031";
/**
 * FNXC:RoomProviderCleanupOutboxFinalization 2026-07-20-02:34:
 * A terminal cleanup action records one durable finalization outcome. A stale
 * or acknowledged outbox generation is withheld rather than re-claimed forever.
 */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_OUTBOX_FINALIZATION_VERSION = "0032";
/**
 * FNXC:GlobalCapacityLedger 2026-07-20-03:12:
 * Register the central durable capacity ledger before Engine may bind Room and
 * legacy execution to the same cross-project capacity authority.
 */
export const SCHEMA_GLOBAL_CAPACITY_LEDGER_VERSION = "0033";
export const SCHEMA_GLOBAL_CAPACITY_POLICY_AUTHORITY_VERSION = "0034";
export const SCHEMA_GLOBAL_CAPACITY_LEGACY_ATTEMPTS_VERSION = "0035";
export const SCHEMA_ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_VERSION = "0036";
/** Pre-claim provider cleanup fences a pending outbox atomically with reservation evidence. */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_PRECLAIM_FENCE_VERSION = "0037";
/**
 * FNXC:RoomProviderPreClaimTargetShape 2026-07-20-22:48:
 * Register a forward-only target-shape guard because an already-applied 0037
 * must never be edited or presumed absent from an upgraded database.
 */
export const SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_PRECLAIM_TARGET_SHAPE_VERSION = "0038";
/**
 * FNXC:RoomProviderAdmissionTimeoutTombstone 2026-07-20-23:14:
 * Register the forward-only pre-permit timeout fence after all existing Room
 * cleanup migrations; applied databases must never require edits to 0029-0038.
 */
export const SCHEMA_ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONES_VERSION = "0039";
/** Existing timeout tombstones are opaque until their Core sender-fenced provenance is explicit. */
export const SCHEMA_ROOM_PROVIDER_ADMISSION_TIMEOUT_RECOVERY_PROTOCOL_VERSION = "0040";
/** A Core-issued receipt makes a standard sender-fenced timeout restart-verifiable. */
export const SCHEMA_ROOM_PROVIDER_ADMISSION_RECOVERY_RECEIPTS_VERSION = "0041";
/** Distinguish a Core no-reservation inference from a provider terminal callback. */
export const SCHEMA_ROOM_PROVIDER_ADMISSION_CORE_NO_RESERVATION_VERSION = "0042";

export const SCHEMA_MIGRATIONS = [
  { version: SCHEMA_BASELINE_VERSION, filename: "0000_initial.sql" },
  { version: SCHEMA_ROOM_VERSION, filename: "0001_session_rooms.sql" },
  { version: SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION, filename: "0002_room_binding_ownership.sql" },
  { version: SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION, filename: "0003_room_outbox_identity.sql" },
  { version: SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION, filename: "0004_room_connector_ingestion.sql" },
  { version: SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION, filename: "0005_room_delivery_reconciliation.sql" },
  { version: SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION, filename: "0006_room_membership_future_seats.sql" },
  { version: SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION, filename: "0007_room_run_audit_project_scope.sql" },
  { version: SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION, filename: "0008_room_run_audit_outbox.sql" },
  { version: SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION, filename: "0009_room_membership_production_invariants.sql" },
  { version: SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION, filename: "0010_room_native_sender_takeover.sql" },
  { version: SCHEMA_ROOM_MESSAGE_ROUTING_VERSION, filename: "0011_room_message_routing.sql" },
  { version: SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION, filename: "0012_room_task_graph_commands.sql" },
  { version: SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION, filename: "0013_room_task_topology_lineage.sql" },
  { version: SCHEMA_ROOM_TASK_DISPATCH_DELIVERY_LINK_VERSION, filename: "0014_room_task_dispatch_delivery_link.sql" },
  { version: SCHEMA_ROOM_ROLE_ASSIGNMENT_VERSION, filename: "0015_room_role_assignment.sql" },
  { version: SCHEMA_ROOM_SEMANTIC_ROUTING_VERSION, filename: "0016_room_semantic_routing.sql" },
  { version: SCHEMA_ROOM_TASK_PROGRESS_RECOVERY_VERSION, filename: "0017_room_task_progress_recovery.sql" },
  { version: SCHEMA_ROOM_PHASE_GATE_EVIDENCE_VERSION, filename: "0018_room_phase_gate_evidence.sql" },
  { version: SCHEMA_ROOM_TASK_RECOVERY_PLAN_VERSION, filename: "0019_room_task_recovery_plans.sql" },
  { version: SCHEMA_ROOM_CAPABILITY_REGISTRY_VERSION, filename: "0020_room_capability_registry.sql" },
  { version: SCHEMA_ROOM_BLIND_REVIEW_REGISTRY_VERSION, filename: "0021_room_blind_review_registry.sql" },
  { version: SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION, filename: "0022_room_evolution_controller.sql" },
  { version: SCHEMA_ROOM_GLOBAL_CONCURRENCY_VERSION, filename: "0023_room_global_concurrency.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_VERSION, filename: "0024_room_provider_backpressure.sql" },
  { version: SCHEMA_ROOM_RBAC_REGISTRY_VERSION, filename: "0025_room_rbac_registry.sql" },
  { version: SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION, filename: "0026_room_event_replay_paging.sql" },
  { version: SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION, filename: "0026a_room_evolution_legacy_provenance_bridge.sql" },
  { version: SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION, filename: "0027_room_evolution_trust_receipts.sql" },
  { version: SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION, filename: "0027a_room_evolution_legacy_provenance_guard.sql" },
  { version: SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION, filename: "0028_room_evolution_execution_recovery.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_ACTIONS_VERSION, filename: "0029_room_provider_backpressure_cleanup_actions.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_OUTBOX_UNBLOCK_VERSION, filename: "0030_room_provider_cleanup_outbox_unblock.sql" },
  { version: SCHEMA_PROJECT_PLUGIN_STATE_SETTINGS_VERSION, filename: "0031_project_plugin_state_settings.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_OUTBOX_FINALIZATION_VERSION, filename: "0032_room_provider_cleanup_outbox_finalization.sql" },
  { version: SCHEMA_GLOBAL_CAPACITY_LEDGER_VERSION, filename: "0033_global_capacity_ledger.sql" },
  { version: SCHEMA_GLOBAL_CAPACITY_POLICY_AUTHORITY_VERSION, filename: "0034_global_capacity_policy_authority.sql" },
  { version: SCHEMA_GLOBAL_CAPACITY_LEGACY_ATTEMPTS_VERSION, filename: "0035_global_capacity_legacy_attempts.sql" },
  { version: SCHEMA_ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_VERSION, filename: "0036_room_host_composition_operator_policy_authority.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_PRECLAIM_FENCE_VERSION, filename: "0037_room_provider_cleanup_preclaim_fence.sql" },
  { version: SCHEMA_ROOM_PROVIDER_BACKPRESSURE_CLEANUP_PRECLAIM_TARGET_SHAPE_VERSION, filename: "0038_room_provider_cleanup_preclaim_target_shape.sql" },
  { version: SCHEMA_ROOM_PROVIDER_ADMISSION_TIMEOUT_TOMBSTONES_VERSION, filename: "0039_room_provider_admission_timeout_tombstones.sql" },
  { version: SCHEMA_ROOM_PROVIDER_ADMISSION_TIMEOUT_RECOVERY_PROTOCOL_VERSION, filename: "0040_room_provider_admission_timeout_recovery_protocol.sql" },
  { version: SCHEMA_ROOM_PROVIDER_ADMISSION_RECOVERY_RECEIPTS_VERSION, filename: "0041_room_provider_admission_recovery_receipts.sql" },
  { version: SCHEMA_ROOM_PROVIDER_ADMISSION_CORE_NO_RESERVATION_VERSION, filename: "0042_room_provider_admission_core_no_reservation.sql" },
] as const;

/** Bookkeeping table for the fresh Drizzle migration history. */
export const MIGRATION_BOOKKEEPING_TABLE = "fusion_schema_migrations";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIRECTORY = join(__dirname, "migrations");
const MIGRATION_LOCK_NAME = "fusion_schema_migrations_v1";

/**
 * Ensure the migration bookkeeping table exists. Lives in the public schema so
 * it survives across the three application schemas and is queryable without
 * search_path qualification.
 */
async function ensureBookkeepingTable(db: PostgresJsDatabase<Record<string, never>>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
}

export type SchemaMigrationVersion = (typeof SCHEMA_MIGRATIONS)[number]["version"];

/** Read one registered migration from disk. */
export async function readSchemaMigrationSql(version: SchemaMigrationVersion): Promise<string> {
  const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.version === version);
  if (!migration) {
    throw new Error(`Unknown Fusion schema migration version: ${version}`);
  }
  return readFile(join(MIGRATIONS_DIRECTORY, migration.filename), "utf8");
}

/** Read the historical baseline SQL. Exported for compatibility and tests. */
export async function readBaselineMigrationSql(): Promise<string> {
  return readSchemaMigrationSql(SCHEMA_BASELINE_VERSION);
}

/** Return the set of already-applied migration versions, or empty if none. */
export async function getAppliedMigrations(
  db: PostgresJsDatabase<Record<string, never>>,
): Promise<string[]> {
  await ensureBookkeepingTable(db);
  const rows = (await db.execute(
    sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} ORDER BY version`,
  )) as unknown as Array<{ version: string }>;
  return rows.map((row) => row.version);
}

/**
 * Apply the fresh baseline migration to the given connection.
 *
 * Idempotent: if the baseline version is already recorded, this is a no-op.
 * After the baseline lands, all registered plugin schema-init hooks run so
 * plugin-owned tables (e.g. roadmap) materialize (VAL-SCHEMA-007).
 *
 * The baseline SQL is applied as a single batch via postgres.js's file/unsafe
 * execution path. It uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT
 * EXISTS throughout, so a partial prior apply is safe to resume.
 */
export async function applySchemaBaseline(
  db: PostgresJsDatabase<Record<string, never>>,
  options: { pluginHooks?: readonly PluginSchemaInitHook[] } = {},
): Promise<{
  applied: boolean;
  baselineApplied: boolean;
  appliedVersions: readonly string[];
  pluginHooksRun: number;
}> {
  await ensureBookkeepingTable(db);
  const appliedVersions = await db.transaction(async (tx) => {
    // Serialize startup migrators across engines/processes sharing one database.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_NAME}))`);
    const rows = (await tx.execute(
      sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} ORDER BY version`,
    )) as unknown as Array<{ version: string }>;
    const alreadyApplied = new Set(rows.map((row) => row.version));
    const newlyApplied: string[] = [];

    for (const migration of SCHEMA_MIGRATIONS) {
      if (alreadyApplied.has(migration.version)) continue;
      const migrationSql = await readSchemaMigrationSql(migration.version);
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${migration.version})`,
      );
      newlyApplied.push(migration.version);
    }
    return newlyApplied;
  });

  // Run plugin schema-init hooks regardless of whether the baseline was just
  // applied or already present — plugin tables must exist on every connection
  // the applier touches. The hooks are themselves idempotent (CREATE TABLE IF
  // NOT EXISTS), so re-running is safe.
  const pluginHooks = options.pluginHooks ?? DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS;
  await runPluginSchemaInitHooks(db, pluginHooks);

  return {
    applied: appliedVersions.length > 0,
    baselineApplied: appliedVersions.includes(SCHEMA_BASELINE_VERSION),
    appliedVersions,
    pluginHooksRun: pluginHooks.length,
  };
}
