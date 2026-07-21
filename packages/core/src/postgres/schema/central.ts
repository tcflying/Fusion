/**
 * Drizzle schema for the central (global coordination) database.
 *
 * FNXC:PostgresSchema 2026-06-24-03:00:
 * Snapshotted from CENTRAL_SCHEMA_SQL in packages/core/src/central-db.ts
 * (CENTRAL_SCHEMA_VERSION=13). All migrations through v13 are collapsed into
 * the final shape: every ALTER TABLE ADD COLUMN from v2/v3/v4/v7 is folded
 * into the base table definition, and every CREATE TABLE migration is merged.
 *
 * Central DB stores the project registry, unified activity feed, global
 * concurrency limits, node mesh state, plugin install registry, durable mesh
 * shared-state snapshots, offline write queue, global secrets, and the
 * authoritative cross-node task claims table.
 */

import {
  pgSchema,
  text,
  integer,
  bigint,
  jsonb,
  primaryKey,
  foreignKey,
  unique,
  uniqueIndex,
  check,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CENTRAL_SCHEMA, bytea } from "./_shared.js";

/**
 * FNXC:PostgresSchema 2026-06-24-03:00:
 * Dedicated PostgreSQL schema for the central database. Isolation topology
 * (VAL-SCHEMA-008): project/central/archive are distinct schemas in one cluster.
 */
export const centralSchema = pgSchema(CENTRAL_SCHEMA);

// ── Projects (project registry) ──────────────────────────────────────
export const projects = centralSchema.table("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  status: text("status").notNull().default("active"),
  isolationMode: text("isolation_mode").notNull().default("in-process"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastActivityAt: text("last_activity_at"),
  nodeId: text("node_id"),
  settings: jsonb("settings"),
}, (t) => [
  index("idxProjectsPath").on(t.path),
  index("idxProjectsStatus").on(t.status),
]);

// ── Nodes (runtime hosts) ────────────────────────────────────────────
export const nodes = centralSchema.table("nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type").notNull(),
  url: text("url"),
  apiKey: text("api_key"),
  status: text("status").notNull().default("offline"),
  capabilities: jsonb("capabilities"),
  systemMetrics: jsonb("system_metrics"),
  knownPeers: jsonb("known_peers"),
  versionInfo: jsonb("version_info"),
  pluginVersions: jsonb("plugin_versions"),
  dockerConfig: jsonb("docker_config"),
  maxConcurrent: integer("max_concurrent").notNull().default(2),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("nodes_type_check", sql`${t.type} IN ('local', 'remote')`),
  index("idxNodesStatus").on(t.status),
  index("idxNodesType").on(t.type),
]);

// ── Per-project, per-node working directory mappings ─────────────────
export const projectNodePathMappings = centralSchema.table("project_node_path_mappings", {
  projectId: text("project_id").notNull(),
  nodeId: text("node_id").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.nodeId] }),
  foreignKey({ columns: [t.projectId], foreignColumns: [projects.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.nodeId], foreignColumns: [nodes.id] }).onDelete("cascade"),
  index("idxProjectNodePathMappingsProjectId").on(t.projectId),
  index("idxProjectNodePathMappingsNodeId").on(t.nodeId),
]);

// ── Project health ───────────────────────────────────────────────────
export const projectHealth = centralSchema.table("project_health", {
  projectId: text("project_id").primaryKey(),
  status: text("status").notNull(),
  activeTaskCount: integer("active_task_count").default(0),
  inFlightAgentCount: integer("in_flight_agent_count").default(0),
  lastActivityAt: text("last_activity_at"),
  lastErrorAt: text("last_error_at"),
  lastErrorMessage: text("last_error_message"),
  totalTasksCompleted: integer("total_tasks_completed").default(0),
  totalTasksFailed: integer("total_tasks_failed").default(0),
  averageTaskDurationMs: integer("average_task_duration_ms"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [foreignKey({ columns: [t.projectId], foreignColumns: [projects.id] }).onDelete("cascade")]);

// ── Central activity log ─────────────────────────────────────────────
export const centralActivityLog = centralSchema.table("central_activity_log", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  type: text("type").notNull(),
  projectId: text("project_id").notNull(),
  projectName: text("project_name").notNull(),
  taskId: text("task_id"),
  taskTitle: text("task_title"),
  details: text("details").notNull(),
  metadata: jsonb("metadata"),
}, (t) => [
  foreignKey({ columns: [t.projectId], foreignColumns: [projects.id] }).onDelete("cascade"),
  index("idxActivityLogTimestamp").on(t.timestamp),
  index("idxActivityLogType").on(t.type),
  index("idxActivityLogProjectId").on(t.projectId),
]);

// ── Global concurrency state (single row) ────────────────────────────
export const globalConcurrency = centralSchema.table("global_concurrency", {
  id: integer("id").primaryKey(),
  globalMaxConcurrent: integer("global_max_concurrent").default(4),
  currentlyActive: integer("currently_active").default(0),
  queuedCount: integer("queued_count").default(0),
  updatedAt: text("updated_at"),
}, (t) => [check("global_concurrency_id_check", sql`${t.id} = 1`)]);

// ── Central settings (single row) ────────────────────────────────────
export const centralSettings = centralSchema.table("central_settings", {
  id: integer("id").primaryKey(),
  defaultProjectId: text("default_project_id"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [check("central_settings_id_check", sql`${t.id} = 1`)]);

// ── Peer nodes ───────────────────────────────────────────────────────
export const peerNodes = centralSchema.table("peer_nodes", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  peerNodeId: text("peer_node_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull().default("unknown"),
  lastSeen: text("last_seen").notNull(),
  connectedAt: text("connected_at").notNull(),
}, (t) => [
  unique("peer_nodes_node_id_peer_node_id_unique").on(t.nodeId, t.peerNodeId),
  foreignKey({ columns: [t.nodeId], foreignColumns: [nodes.id] }).onDelete("cascade"),
  index("idxPeerNodesNodeId").on(t.nodeId),
]);

// ── Settings sync state ──────────────────────────────────────────────
export const settingsSyncState = centralSchema.table("settings_sync_state", {
  nodeId: text("node_id").notNull(),
  remoteNodeId: text("remote_node_id").notNull(),
  lastSyncedAt: text("last_synced_at"),
  localChecksum: text("local_checksum"),
  remoteChecksum: text("remote_checksum"),
  syncCount: integer("sync_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.nodeId, t.remoteNodeId] }),
  foreignKey({ columns: [t.nodeId], foreignColumns: [nodes.id] }).onDelete("cascade"),
  index("idxSettingsSyncNode").on(t.nodeId),
]);

// ── Managed Docker nodes ─────────────────────────────────────────────
export const managedDockerNodes = centralSchema.table("managed_docker_nodes", {
  id: text("id").primaryKey(),
  nodeId: text("node_id"),
  name: text("name").notNull().unique(),
  imageName: text("image_name").notNull(),
  imageTag: text("image_tag").notNull(),
  containerId: text("container_id"),
  status: text("status").notNull().default("creating"),
  hostConfig: jsonb("host_config").notNull().default({}),
  envVars: jsonb("env_vars").notNull().default({}),
  volumeMounts: jsonb("volume_mounts").notNull().default([]),
  resourceSizing: jsonb("resource_sizing").notNull().default({}),
  extraClis: jsonb("extra_clis").notNull().default([]),
  persistentStorage: integer("persistent_storage").notNull().default(1),
  reachableUrl: text("reachable_url"),
  apiKey: text("api_key"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.nodeId], foreignColumns: [nodes.id] }).onDelete("set null"),
  index("idxManagedDockerNodesStatus").on(t.status),
  index("idxManagedDockerNodesNodeId").on(t.nodeId),
]);

// ── Global plugin install registry ───────────────────────────────────
export const pluginInstalls = centralSchema.table("plugin_installs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  author: text("author"),
  homepage: text("homepage"),
  path: text("path").notNull(),
  settings: jsonb("settings").default({}),
  settingsSchema: jsonb("settings_schema"),
  dependencies: jsonb("dependencies").default([]),
  aiScanOnLoad: integer("ai_scan_on_load").notNull().default(0),
  lastSecurityScan: text("last_security_scan"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const projectPluginStates = centralSchema.table("project_plugin_states", {
  projectPath: text("project_path").notNull(),
  pluginId: text("plugin_id").notNull(),
  enabled: integer("enabled").notNull().default(0),
  state: text("state").notNull().default("installed"),
  error: text("error"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectPath, t.pluginId] }),
  foreignKey({ columns: [t.pluginId], foreignColumns: [pluginInstalls.id] }).onDelete("cascade"),
  index("idxProjectPluginStatesProjectPath").on(t.projectPath),
  index("idxProjectPluginStatesPluginId").on(t.pluginId),
]);

// ── Mesh shared-state snapshots ──────────────────────────────────────
export const meshSharedSnapshots = centralSchema.table("mesh_shared_snapshots", {
  nodeId: text("node_id").notNull(),
  projectId: text("project_id"),
  scope: text("scope").notNull(),
  payload: jsonb("payload").notNull(),
  snapshotVersion: text("snapshot_version").notNull(),
  capturedAt: text("captured_at").notNull(),
  sourceNodeId: text("source_node_id"),
  sourceRunId: text("source_run_id"),
  staleAfter: text("stale_after"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.nodeId, t.projectId, t.scope] }),
  index("idxMeshSharedSnapshotsLookup").on(t.nodeId, t.projectId, t.scope),
]);

// ── Mesh offline write queue ─────────────────────────────────────────
export const meshWriteQueue = centralSchema.table("mesh_write_queue", {
  id: text("id").primaryKey(),
  originNodeId: text("origin_node_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  projectId: text("project_id"),
  scope: text("scope").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  operation: text("operation").notNull(),
  payload: jsonb("payload").notNull(),
  intentVersion: text("intent_version").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  appliedAt: text("applied_at"),
}, (t) => [
  check("mesh_write_queue_status_check", sql`${t.status} IN ('pending', 'replaying', 'applied', 'failed')`),
  index("idxMeshWriteQueueReplay").on(t.targetNodeId, t.status, t.createdAt, t.id),
]);

// ── Global secrets ───────────────────────────────────────────────────
export const secretsGlobal = centralSchema.table("secrets_global", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  valueCiphertext: bytea("value_ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  description: text("description"),
  accessPolicy: text("access_policy").notNull().default("auto"),
  envExportable: integer("env_exportable").notNull().default(0),
  envExportKey: text("env_export_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastReadAt: text("last_read_at"),
  lastReadBy: text("last_read_by"),
}, (t) => [
  unique("secrets_global_key_unique").on(t.key),
  check("secrets_global_access_policy_check", sql`${t.accessPolicy} IN ('auto', 'prompt', 'deny')`),
  check("secrets_global_env_exportable_check", sql`${t.envExportable} IN (0, 1)`),
]);

// ── Authoritative cross-node task claims ─────────────────────────────
export const taskClaims = centralSchema.table("task_claims", {
  projectId: text("project_id").notNull(),
  taskId: text("task_id").notNull(),
  ownerNodeId: text("owner_node_id").notNull(),
  ownerAgentId: text("owner_agent_id").notNull(),
  ownerRunId: text("owner_run_id"),
  leaseEpoch: integer("lease_epoch").notNull(),
  leaseRenewedAt: text("lease_renewed_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  index("idxTaskClaimsOwner").on(t.ownerNodeId),
]);

/*
 * FNXC:GlobalCapacityLedger 2026-07-20-03:12:
 * A global slot counter cannot prove which execution owns a slot or recover a
 * crash safely. Keep this ledger in the central schema (not the Room schema):
 * legacy task/triage and Room worker capacity must contend under one durable,
 * cross-project authority, while Room-specific lease tables retain their FK and
 * delete semantics. Every claim is therefore a typed capacity lease with an
 * explicit resource identity, holder/lease fence, expiry, and idempotent
 * operation record.
 */
export const globalCapacityState = centralSchema.table("global_capacity_state", {
  id: text("id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  policyHash: text("policy_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("global_capacity_state_id_check", sql`${t.id} = 'global-capacity-ledger-v1'`),
  check("global_capacity_state_revision_check", sql`${t.revision} BETWEEN 0 AND 9007199254740991`),
  check("global_capacity_state_policy_hash_check", sql`btrim(${t.policyHash}) <> ''`),
  check("global_capacity_state_updated_at_check", sql`btrim(${t.updatedAt}) <> ''`),
]);

export const globalCapacityPolicyAuthority = centralSchema.table("global_capacity_policy_authority", {
  id: text("id").primaryKey(),
  policyJson: jsonb("policy_json").notNull(),
  policyHash: text("policy_hash").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("global_capacity_policy_authority_id_check", sql`${t.id} = 'global-capacity-policy-authority-v1'`),
  check("global_capacity_policy_authority_policy_json_check", sql`jsonb_typeof(${t.policyJson}) = 'object'`),
  check("global_capacity_policy_authority_policy_hash_check", sql`${t.policyHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("global_capacity_policy_authority_revision_check", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  check("global_capacity_policy_authority_updated_at_check", sql`btrim(${t.updatedAt}) <> ''`),
]);

/**
 * Explicit operator-selected, project-and-host-scoped Room composition bundle.
 * Runtime provider/session facts never live in this authority record.
 */
export const roomHostCompositionOperatorPolicyAuthority = centralSchema.table("room_host_composition_operator_policy_authority", {
  projectId: text("project_id").notNull(),
  hostId: text("host_id").notNull(),
  bundleId: text("bundle_id").notNull(),
  issuer: text("issuer").notNull(),
  policyJson: jsonb("policy_json").notNull(),
  policyHash: text("policy_hash").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  issuedAt: text("issued_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  revokedReason: text("revoked_reason"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.hostId], name: "room_host_composition_operator_policy_authority_primary" }),
  foreignKey({ columns: [t.projectId], foreignColumns: [projects.id] }).onDelete("restrict"),
  index("idx_room_host_composition_operator_policy_authority_active")
    .on(t.projectId, t.hostId, t.expiresAt)
    .where(sql`${t.revokedAt} IS NULL`),
  check("room_host_composition_operator_policy_authority_policy_json_check", sql`jsonb_typeof(${t.policyJson}) = 'object'`),
  check("room_host_composition_operator_policy_authority_policy_hash_check", sql`${t.policyHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_host_composition_operator_policy_authority_revision_check", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  check("room_host_composition_operator_policy_authority_window_check", sql`${t.expiresAt} > ${t.issuedAt}`),
  check("room_host_composition_operator_policy_authority_revocation_check", sql`
    (${t.revokedAt} IS NULL AND ${t.revokedReason} IS NULL)
    OR (${t.revokedAt} IS NOT NULL AND ${t.revokedReason} IS NOT NULL)
  `),
  check("room_host_composition_operator_policy_authority_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.hostId}) <> ''
    AND btrim(${t.bundleId}) <> ''
    AND btrim(${t.issuer}) <> ''
    AND btrim(${t.policyHash}) <> ''
    AND btrim(${t.issuedAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND (${t.revokedAt} IS NULL OR btrim(${t.revokedAt}) <> '')
    AND (${t.revokedReason} IS NULL OR btrim(${t.revokedReason}) <> '')
  `),
]);

export const globalCapacityClaims = centralSchema.table("global_capacity_claims", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
  resourceKind: text("resource_kind").notNull(),
  resourceId: text("resource_id").notNull(),
  workClass: text("work_class").notNull(),
  slots: integer("slots").notNull(),
  holderId: text("holder_id").notNull(),
  leaseId: text("lease_id").notNull(),
  fence: bigint("fence", { mode: "number" }).notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  releasedAt: text("released_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id], name: "global_capacity_claims_primary" }),
  index("idx_global_capacity_claims_active")
    .on(t.projectId, t.resourceKind, t.workClass, t.expiresAt, t.id)
    .where(sql`${t.releasedAt} IS NULL`),
  uniqueIndex("idx_global_capacity_claims_active_resource")
    .on(t.projectId, t.resourceKind, t.resourceId)
    .where(sql`${t.releasedAt} IS NULL`),
  index("idx_global_capacity_claims_expiry")
    .on(t.expiresAt, t.id)
    .where(sql`${t.releasedAt} IS NULL`),
  check("global_capacity_claims_resource_kind_check", sql`${t.resourceKind} IN ('room_worker','legacy_task','legacy_triage')`),
  check("global_capacity_claims_work_class_check", sql`${t.workClass} IN ('normal','verifier','recovery')`),
  check("global_capacity_claims_slots_check", sql`${t.slots} BETWEEN 1 AND 2147483647`),
  check("global_capacity_claims_fence_check", sql`${t.fence} BETWEEN 1 AND 9007199254740991`),
  check("global_capacity_claims_window_check", sql`${t.expiresAt} > ${t.acquiredAt}`),
  check("global_capacity_claims_nonblank_check", sql`
    btrim(${t.id}) <> ''
    AND btrim(${t.projectId}) <> ''
    AND btrim(${t.resourceKind}) <> ''
    AND btrim(${t.resourceId}) <> ''
    AND btrim(${t.workClass}) <> ''
    AND btrim(${t.holderId}) <> ''
    AND btrim(${t.leaseId}) <> ''
    AND btrim(${t.acquiredAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND (${t.releasedAt} IS NULL OR btrim(${t.releasedAt}) <> '')
  `),
]);

export const globalCapacityOperations = centralSchema.table("global_capacity_operations", {
  projectId: text("project_id").notNull(),
  commandKind: text("command_kind").notNull(),
  operationId: text("operation_id").notNull(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  claimId: text("claim_id"),
  fence: bigint("fence", { mode: "number" }),
  occurredAt: text("occurred_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.commandKind, t.operationId], name: "global_capacity_operations_primary" }),
  index("idx_global_capacity_operations_claim").on(t.projectId, t.claimId, t.commandKind, t.occurredAt),
  check("global_capacity_operations_kind_check", sql`${t.commandKind} IN ('acquire','renew','release')`),
  check("global_capacity_operations_action_check", sql`${t.action} IN ('acquired','renewed','released','held','rejected')`),
  check("global_capacity_operations_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("global_capacity_operations_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.commandKind}) <> ''
    AND btrim(${t.operationId}) <> ''
    AND btrim(${t.requestHash}) <> ''
    AND btrim(${t.action}) <> ''
    AND btrim(${t.reason}) <> ''
    AND btrim(${t.occurredAt}) <> ''
    AND (${t.claimId} IS NULL OR btrim(${t.claimId}) <> '')
  `),
]);

/**
 * FNXC:GlobalCapacityLegacyAttempt 2026-07-20-04:31:
 * The generic capacity ledger deliberately knows only about slots. Legacy
 * executor and triage side effects need a separate, durable attempt boundary:
 * an acquired ledger replay must never be mistaken for permission to run the
 * same external work twice after a process crash.
 */
export const globalCapacityLegacyAttempts = centralSchema.table("global_capacity_legacy_attempts", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
  resourceKind: text("resource_kind").notNull(),
  resourceId: text("resource_id").notNull(),
  state: text("state").notNull(),
  workClass: text("work_class").notNull(),
  slots: integer("slots").notNull(),
  holderId: text("holder_id").notNull(),
  leaseId: text("lease_id").notNull(),
  capacityFence: bigint("capacity_fence", { mode: "number" }).notNull(),
  claimId: text("claim_id").notNull(),
  acquireOperationId: text("acquire_operation_id").notNull(),
  acquireGeneration: integer("acquire_generation").notNull(),
  lastWithheldOperationId: text("last_withheld_operation_id"),
  renewOperationId: text("renew_operation_id").notNull(),
  renewGeneration: integer("renew_generation").notNull(),
  lastRenewalOperationId: text("last_renewal_operation_id"),
  releaseOperationId: text("release_operation_id").notNull(),
  preparedAt: text("prepared_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  admittedAt: text("admitted_at"),
  workStartedAt: text("work_started_at"),
  workStartReceiptId: text("work_start_receipt_id"),
  workFinishedAt: text("work_finished_at"),
  releasedAt: text("released_at"),
  supersededAt: text("superseded_at"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id], name: "global_capacity_legacy_attempts_primary" }),
  uniqueIndex("idx_global_capacity_legacy_attempts_active_resource")
    .on(t.projectId, t.resourceKind, t.resourceId)
    .where(sql`${t.state} IN ('prepared','withheld','admitted','work_started','work_finished')`),
  index("idx_global_capacity_legacy_attempts_resource_history")
    .on(t.projectId, t.resourceKind, t.resourceId, t.capacityFence),
  index("idx_global_capacity_legacy_attempts_recovery")
    .on(t.state, t.updatedAt)
    .where(sql`${t.state} IN ('work_started','work_finished')`),
  check("global_capacity_legacy_attempts_resource_kind_check", sql`${t.resourceKind} IN ('legacy_task','legacy_triage')`),
  check("global_capacity_legacy_attempts_state_check", sql`${t.state} IN ('prepared','withheld','admitted','work_started','work_finished','released','superseded')`),
  check("global_capacity_legacy_attempts_work_class_check", sql`${t.workClass} IN ('normal','verifier','recovery')`),
  check("global_capacity_legacy_attempts_slots_check", sql`${t.slots} BETWEEN 1 AND 2147483647`),
  check("global_capacity_legacy_attempts_fence_check", sql`${t.capacityFence} BETWEEN 1 AND 9007199254740991`),
  check("global_capacity_legacy_attempts_generation_check", sql`${t.acquireGeneration} BETWEEN 1 AND 2147483647`),
  check("global_capacity_legacy_attempts_renew_generation_check", sql`${t.renewGeneration} BETWEEN 1 AND 2147483647`),
  check("global_capacity_legacy_attempts_window_check", sql`${t.expiresAt} > ${t.preparedAt}`),
  check("global_capacity_legacy_attempts_nonblank_check", sql`
    btrim(${t.id}) <> ''
    AND btrim(${t.projectId}) <> ''
    AND btrim(${t.resourceKind}) <> ''
    AND btrim(${t.resourceId}) <> ''
    AND btrim(${t.state}) <> ''
    AND btrim(${t.workClass}) <> ''
    AND btrim(${t.holderId}) <> ''
    AND btrim(${t.leaseId}) <> ''
    AND btrim(${t.claimId}) <> ''
    AND btrim(${t.acquireOperationId}) <> ''
    AND btrim(${t.renewOperationId}) <> ''
    AND btrim(${t.releaseOperationId}) <> ''
    AND btrim(${t.preparedAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
    AND (${t.lastWithheldOperationId} IS NULL OR btrim(${t.lastWithheldOperationId}) <> '')
    AND (${t.lastRenewalOperationId} IS NULL OR btrim(${t.lastRenewalOperationId}) <> '')
    AND (${t.admittedAt} IS NULL OR btrim(${t.admittedAt}) <> '')
    AND (${t.workStartedAt} IS NULL OR btrim(${t.workStartedAt}) <> '')
    AND (${t.workStartReceiptId} IS NULL OR btrim(${t.workStartReceiptId}) <> '')
    AND (${t.workFinishedAt} IS NULL OR btrim(${t.workFinishedAt}) <> '')
    AND (${t.releasedAt} IS NULL OR btrim(${t.releasedAt}) <> '')
    AND (${t.supersededAt} IS NULL OR btrim(${t.supersededAt}) <> '')
  `),
  check("global_capacity_legacy_attempts_state_timestamps_check", sql`
    (
      ${t.state} IN ('prepared','withheld')
      AND ${t.admittedAt} IS NULL
      AND ${t.workStartedAt} IS NULL
      AND ${t.workStartReceiptId} IS NULL
      AND ${t.workFinishedAt} IS NULL
      AND ${t.releasedAt} IS NULL
      AND ${t.supersededAt} IS NULL
    )
    OR (
      ${t.state} = 'admitted'
      AND ${t.admittedAt} IS NOT NULL
      AND ${t.workStartedAt} IS NULL
      AND ${t.workStartReceiptId} IS NULL
      AND ${t.workFinishedAt} IS NULL
      AND ${t.releasedAt} IS NULL
      AND ${t.supersededAt} IS NULL
    )
    OR (
      ${t.state} = 'work_started'
      AND ${t.admittedAt} IS NOT NULL
      AND ${t.workStartedAt} IS NOT NULL
      AND ${t.workStartReceiptId} IS NOT NULL
      AND ${t.workFinishedAt} IS NULL
      AND ${t.releasedAt} IS NULL
      AND ${t.supersededAt} IS NULL
    )
    OR (
      ${t.state} = 'work_finished'
      AND ${t.admittedAt} IS NOT NULL
      AND ${t.workStartedAt} IS NOT NULL
      AND ${t.workStartReceiptId} IS NOT NULL
      AND ${t.workFinishedAt} IS NOT NULL
      AND ${t.releasedAt} IS NULL
      AND ${t.supersededAt} IS NULL
    )
    OR (
      ${t.state} = 'released'
      AND ${t.releasedAt} IS NOT NULL
      AND ${t.supersededAt} IS NULL
      AND (
        (${t.workStartedAt} IS NULL AND ${t.workStartReceiptId} IS NULL)
        OR (${t.workStartedAt} IS NOT NULL AND ${t.workStartReceiptId} IS NOT NULL)
      )
    )
    OR (
      ${t.state} = 'superseded'
      AND ${t.workStartedAt} IS NULL
      AND ${t.workStartReceiptId} IS NULL
      AND ${t.workFinishedAt} IS NULL
      AND ${t.releasedAt} IS NULL
      AND ${t.supersededAt} IS NOT NULL
    )
  `),
]);

// ── Schema version meta ──────────────────────────────────────────────
export const centralMeta = centralSchema.table("__meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * FNXC:PostgresSchema 2026-06-24-03:05:
 * Registry of all central-schema table names.
 */
export const centralTableNames = [
  "projects", "nodes", "project_node_path_mappings", "project_health",
  "central_activity_log", "global_concurrency", "central_settings",
  "peer_nodes", "settings_sync_state", "managed_docker_nodes",
  "plugin_installs", "project_plugin_states", "mesh_shared_snapshots",
  "mesh_write_queue", "secrets_global", "task_claims", "global_capacity_state",
  "global_capacity_policy_authority",
  "global_capacity_claims", "global_capacity_operations", "global_capacity_legacy_attempts", "__meta",
] as const;
