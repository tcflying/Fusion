/**
 * Canonical PostgreSQL schema for operational Session Rooms.
 *
 * These tables live in the existing `project` schema and are reached through
 * Fusion's AsyncDataLayer. They intentionally do not reuse chat_rooms: chat is
 * a conversational projection, while an operational Room owns versions,
 * leases, delivery state, task topology, evidence, and recovery history.
 */

import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { PROJECT_SCHEMA } from "./_shared.js";
import { approvalRequests } from "./approval-requests.js";

const roomSchema = pgSchema(PROJECT_SCHEMA);

const scopedRoomColumns = () => ({
  projectId: text("project_id").notNull(),
  roomId: text("room_id").notNull(),
});

const evolutionScopeColumns = () => ({
  projectId: text("project_id").notNull(),
  roomId: text("room_id"),
  scopeKind: text("scope_kind").notNull(),
  scopeKey: text("scope_key").notNull(),
});

export const operationalRooms = roomSchema.table("operational_rooms", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  objective: text("objective").notNull(),
  protocolId: text("protocol_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  protocolPhaseId: text("protocol_phase_id"),
  lifecycleState: text("lifecycle_state").notNull(),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull().default(0),
  taskGraphVersion: bigint("task_graph_version", { mode: "number" }).notNull().default(0),
  membershipVersion: bigint("membership_version", { mode: "number" }).notNull().default(0),
  activeTurnId: text("active_turn_id"),
  completionContract: jsonb("completion_contract").notNull().default({}),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  unique("operational_rooms_id_project_unique").on(t.id, t.projectId),
  index("idx_operational_rooms_project_state").on(t.projectId, t.lifecycleState, t.updatedAt),
  check("operational_rooms_lifecycle_check", sql`${t.lifecycleState} IN ('draft','ready','running','paused','completed','completed_with_risks','partial','blocked','cancelled','failed','archived')`),
  check("operational_rooms_aggregate_version_check", sql`${t.aggregateVersion} BETWEEN 0 AND 9007199254740991`),
  check("operational_rooms_task_graph_version_check", sql`${t.taskGraphVersion} BETWEEN 0 AND 9007199254740991`),
]);

export const roomSeats = roomSchema.table("room_seats", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  role: text("role").notNull(),
  roleVersion: integer("role_version").notNull().default(1),
  roleHistory: jsonb("role_history").notNull().default([]),
  permissionScope: jsonb("permission_scope").notNull().default([]),
  state: text("state").notNull(),
  activeBindingId: text("active_binding_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_seats_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_seats_room_id_unique").on(t.roomId, t.id),
  unique("room_seats_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  index("idx_room_seats_project_room_state").on(t.projectId, t.roomId, t.state),
  check("room_seats_state_check", sql`${t.state} IN ('pending','ready','active','paused','waiting','lost','removed')`),
]);

export const roomBindings = roomSchema.table("room_bindings", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  seatId: text("seat_id").notNull(),
  generation: integer("generation").notNull(),
  connectorId: text("connector_id").notNull(),
  providerId: text("provider_id").notNull(),
  nativeSessionId: text("native_session_id").notNull(),
  happierSessionId: text("happier_session_id"),
  serverProfileId: text("server_profile_id"),
  machineId: text("machine_id"),
  hostId: text("host_id").notNull(),
  state: text("state").notNull(),
  attachedAt: text("attached_at").notNull(),
  detachedAt: text("detached_at"),
  replacedByBindingId: text("replaced_by_binding_id"),
  replacementReason: text("replacement_reason"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_bindings_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.seatId],
    foreignColumns: [roomSeats.id],
    name: "room_bindings_seat_fkey",
  }).onDelete("cascade"),
  unique("room_bindings_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  unique("room_bindings_id_seat_room_project_unique").on(t.id, t.seatId, t.roomId, t.projectId),
  unique("room_bindings_seat_generation_unique").on(t.seatId, t.generation),
  index("idx_room_bindings_native_session").on(t.providerId, t.nativeSessionId),
  index("idx_room_bindings_room_state").on(t.projectId, t.roomId, t.state),
  uniqueIndex("idx_room_bindings_active_native_session")
    .on(t.providerId, t.nativeSessionId)
    .where(sql`${t.state} IN ('pending','attached','paused','authentication_blocked','host_unavailable','delivery_uncertain')`),
  uniqueIndex("idx_room_bindings_active_happier_session")
    .on(t.connectorId, t.happierSessionId)
    .where(sql`${t.happierSessionId} IS NOT NULL AND ${t.state} IN ('pending','attached','paused','authentication_blocked','host_unavailable','delivery_uncertain')`),
  check("room_bindings_generation_check", sql`${t.generation} > 0`),
  check("room_bindings_state_check", sql`${t.state} IN ('pending','attached','paused','authentication_blocked','host_unavailable','delivery_uncertain','detached','replaced','failed')`),
]);

export const roomBindingIngestionState = roomSchema.table("room_binding_ingestion_state", {
  bindingId: text("binding_id").notNull(),
  ...scopedRoomColumns(),
  mode: text("mode").notNull(),
  transcriptCursor: text("transcript_cursor"),
  statusCursor: text("status_cursor"),
  lastNativeMessageId: text("last_native_message_id"),
  lastPayloadHash: text("last_payload_hash"),
  connectorStatus: text("connector_status"),
  nativeWriterDetected: boolean("native_writer_detected").notNull().default(false),
  /*
  FNXC:SessionRoomSenderTakeover 2026-07-18-07:05:
  Native IDE writer detection must persist one complete, epoch-fenced sender takeover projection with its reconciliation cursors and uncertain outbox blockers. Historical ingestion rows remain a valid no-takeover projection instead of receiving fabricated lease or cursor state during upgrade.
  */
  takeoverId: text("takeover_id"),
  takeoverEpoch: bigint("takeover_epoch", { mode: "number" }),
  takeoverState: text("takeover_state"),
  autoSenderLeaseEpoch: bigint("auto_sender_lease_epoch", { mode: "number" }),
  reconcileFromCursor: text("reconcile_from_cursor"),
  confirmedCursor: text("confirmed_cursor"),
  blockedOutboxIds: jsonb("blocked_outbox_ids").notNull().default([]),
  gapExpectedCursor: text("gap_expected_cursor"),
  gapObservedCursor: text("gap_observed_cursor"),
  gapDetectedAt: text("gap_detected_at"),
  lastTranscriptAt: text("last_transcript_at"),
  lastStatusAt: text("last_status_at"),
  lastModeAt: text("last_mode_at"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.bindingId] }),
  foreignKey({
    columns: [t.bindingId, t.roomId, t.projectId],
    foreignColumns: [roomBindings.id, roomBindings.roomId, roomBindings.projectId],
    name: "room_binding_ingestion_state_binding_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_binding_ingestion_room_mode").on(t.projectId, t.roomId, t.mode),
  check("room_binding_ingestion_mode_check", sql`${t.mode} IN ('starting','streaming','polling','reconciling','degraded','stopped')`),
  check("room_binding_ingestion_status_check", sql`${t.connectorStatus} IS NULL OR ${t.connectorStatus} IN ('idle','running','waiting_input','paused','lost','unknown')`),
  check("room_binding_ingestion_takeover_state_check", sql`${t.takeoverState} IS NULL OR ${t.takeoverState} IN ('reconciling','ready_for_transfer','human_active','releasing','automatic_resumed','blocked_delivery_uncertain')`),
  check("room_binding_ingestion_takeover_epoch_check", sql`(${t.takeoverEpoch} IS NULL OR ${t.takeoverEpoch} BETWEEN 1 AND 9007199254740991) AND (${t.autoSenderLeaseEpoch} IS NULL OR ${t.autoSenderLeaseEpoch} BETWEEN 1 AND 9007199254740991)`),
  check("room_binding_ingestion_blocked_outbox_ids_check", sql`jsonb_typeof(${t.blockedOutboxIds}) = 'array' AND NOT jsonb_path_exists(${t.blockedOutboxIds}, '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")') AND project.room_jsonb_text_array_is_unique(${t.blockedOutboxIds})`),
  check("room_binding_ingestion_takeover_projection_check", sql`(
    ${t.takeoverId} IS NULL
    AND ${t.takeoverEpoch} IS NULL
    AND ${t.takeoverState} IS NULL
    AND ${t.autoSenderLeaseEpoch} IS NULL
    AND ${t.reconcileFromCursor} IS NULL
    AND ${t.confirmedCursor} IS NULL
    AND ${t.blockedOutboxIds} = '[]'::jsonb
  ) OR (
    ${t.takeoverId} IS NOT NULL
    AND btrim(${t.takeoverId}) <> ''
    AND ${t.takeoverEpoch} IS NOT NULL
    AND ${t.takeoverState} IS NOT NULL
    AND ${t.autoSenderLeaseEpoch} IS NOT NULL
    AND (
      ${t.takeoverState} NOT IN ('reconciling','ready_for_transfer','human_active','releasing','automatic_resumed','blocked_delivery_uncertain')
      OR ${t.takeoverState} IN ('reconciling','blocked_delivery_uncertain')
      OR (${t.takeoverState} IN ('releasing','automatic_resumed') AND NOT ${t.nativeWriterDetected})
      OR (${t.takeoverState} IN ('ready_for_transfer','human_active') AND ${t.nativeWriterDetected})
    )
    AND (${t.reconcileFromCursor} IS NULL OR btrim(${t.reconcileFromCursor}) <> '')
    AND (${t.confirmedCursor} IS NULL OR btrim(${t.confirmedCursor}) <> '')
  )`),
  check("room_binding_ingestion_takeover_payload_check", sql`CASE ${t.takeoverState}
    WHEN 'reconciling' THEN ${t.blockedOutboxIds} = '[]'::jsonb
    WHEN 'ready_for_transfer' THEN ${t.confirmedCursor} IS NOT NULL AND ${t.blockedOutboxIds} = '[]'::jsonb
    WHEN 'human_active' THEN ${t.confirmedCursor} IS NOT NULL AND ${t.blockedOutboxIds} = '[]'::jsonb
    WHEN 'releasing' THEN ${t.blockedOutboxIds} = '[]'::jsonb
    WHEN 'automatic_resumed' THEN ${t.confirmedCursor} IS NOT NULL AND ${t.blockedOutboxIds} = '[]'::jsonb
    WHEN 'blocked_delivery_uncertain' THEN ${t.blockedOutboxIds} <> '[]'::jsonb
    ELSE true
  END`),
]);

export const roomTurns = roomSchema.table("room_turns", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  protocolPhaseId: text("protocol_phase_id").notNull(),
  membershipVersion: bigint("membership_version", { mode: "number" }).notNull(),
  state: text("state").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_turns_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_turns_room_sequence_unique").on(t.roomId, t.sequence),
  unique("room_turns_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  index("idx_room_turns_room_state").on(t.projectId, t.roomId, t.state),
  check("room_turns_state_check", sql`${t.state} IN ('pending','running','waiting','checkpointed','completed','cancelled','uncertain')`),
]);

export const roomMembershipChanges = roomSchema.table("room_membership_changes", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  seatId: text("seat_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  reason: text("reason").notNull(),
  requestedAt: text("requested_at").notNull(),
  requestedBy: text("requested_by").notNull(),
  effectiveAfterTurnId: text("effective_after_turn_id"),
  reservedConnectorId: text("reserved_connector_id"),
  reservedProviderId: text("reserved_provider_id"),
  reservedNativeSessionId: text("reserved_native_session_id"),
  reservedHappierSessionId: text("reserved_happier_session_id"),
  appliedAt: text("applied_at"),
  failedAt: text("failed_at"),
  failureCode: text("failure_code"),
  state: text("state").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_membership_changes_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_membership_changes_pending").on(t.projectId, t.roomId, t.state, t.requestedAt),
  uniqueIndex("idx_room_membership_changes_pending_native_session")
    .on(t.reservedProviderId, t.reservedNativeSessionId)
    .where(sql`${t.state} = 'waiting_turn_boundary' AND ${t.reservedProviderId} IS NOT NULL AND ${t.reservedNativeSessionId} IS NOT NULL`),
  uniqueIndex("idx_room_membership_changes_pending_happier_session")
    .on(t.reservedConnectorId, t.reservedHappierSessionId)
    .where(sql`${t.state} = 'waiting_turn_boundary' AND ${t.reservedConnectorId} IS NOT NULL AND ${t.reservedHappierSessionId} IS NOT NULL`),
  check("room_membership_changes_state_check", sql`${t.state} IN ('requested','waiting_turn_boundary','applied','cancelled','failed')`),
]);

export const roomEvents = roomSchema.table("room_events", {
  id: text("id").primaryKey(),
  cursor: bigint("cursor", { mode: "number" }).generatedAlwaysAsIdentity(),
  ...scopedRoomColumns(),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  payload: jsonb("payload").notNull(),
  occurredAt: text("occurred_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_events_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_events_room_aggregate_version_unique").on(t.roomId, t.aggregateVersion),
  unique("room_events_id_project_unique").on(t.projectId, t.id),
  unique("room_events_cursor_unique").on(t.cursor),
  index("idx_room_events_project_room_time").on(t.projectId, t.roomId, t.occurredAt, t.id),
  index("idx_room_events_project_cursor").on(t.projectId, t.cursor),
  index("idx_room_events_project_room_cursor").on(t.projectId, t.roomId, t.cursor),
  index("idx_room_events_correlation").on(t.correlationId),
]);

/*
FNXC:RoomCapabilityRegistry 2026-07-19-10:01:
The current capability registry is a project-and-Room-scoped projection of
immutable Room events. It retains the accepted registry hash and worker fence
so stale workers and forged snapshots cannot silently replace a durable view.
*/
export const roomCapabilityRegistryProjections = roomSchema.table("room_capability_registry_projections", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  registryId: text("registry_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
  registry: jsonb("registry").notNull(),
  registryIntegrityHash: text("registry_integrity_hash").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  workerLeaseId: text("worker_lease_id").notNull(),
  workerHolderId: text("worker_holder_id").notNull(),
  workerHostId: text("worker_host_id").notNull(),
  workerLeaseEpoch: bigint("worker_lease_epoch", { mode: "number" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_capability_registry_projections_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.projectId, t.sourceEventId],
    foreignColumns: [roomEvents.projectId, roomEvents.id],
    name: "room_capability_registry_projections_source_event_fkey",
  }).onDelete("restrict"),
  unique("room_capability_registry_projections_room_project_unique").on(t.projectId, t.roomId),
  unique("room_capability_registry_projections_source_event_unique").on(t.sourceEventId),
  index("idx_room_capability_registry_projections_project_room").on(t.projectId, t.roomId),
  check("room_capability_registry_projections_revision_check", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  check("room_capability_registry_projections_aggregate_version_check", sql`${t.aggregateVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_capability_registry_projections_worker_epoch_check", sql`${t.workerLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_capability_registry_projections_registry_shape_check", sql`jsonb_typeof(${t.registry}) = 'object'`),
  check("room_capability_registry_projections_hash_matches_registry_check", sql`${t.registryIntegrityHash} = (${t.registry} ->> 'integrityHash')`),
  check("room_capability_registry_projections_nonblank_check", sql`
    btrim(${t.registryId}) <> ''
    AND btrim(${t.registryIntegrityHash}) <> ''
    AND btrim(${t.sourceEventId}) <> ''
    AND btrim(${t.workerLeaseId}) <> ''
    AND btrim(${t.workerHolderId}) <> ''
    AND btrim(${t.workerHostId}) <> ''
    AND btrim(${t.createdAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
  `),
]);

export const roomBlindReviewRegistries = roomSchema.table("room_blind_review_registries", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  reviewRoundId: text("review_round_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  mappingIntegrityHash: text("mapping_integrity_hash").notNull(),
  sealedMapping: jsonb("sealed_mapping").notNull(),
  reviewPack: jsonb("review_pack").notNull(),
  sealedAt: text("sealed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_blind_review_registries_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_blind_review_registries_scope_review_unique").on(t.projectId, t.roomId, t.reviewRoundId),
  unique("room_blind_review_registries_scope_idempotency_unique").on(t.projectId, t.roomId, t.idempotencyKey),
  index("idx_room_blind_review_registries_project_room").on(t.projectId, t.roomId, t.sealedAt),
  check("room_blind_review_registries_mapping_shape_check", sql`jsonb_typeof(${t.sealedMapping}) = 'object'`),
  check("room_blind_review_registries_pack_shape_check", sql`jsonb_typeof(${t.reviewPack}) = 'object'`),
  check("room_blind_review_registries_sealed_hash_commit_check", sql`COALESCE(
    ${t.mappingIntegrityHash} = (${t.sealedMapping} ->> 'integrityHash')
    AND ${t.commandHash} = (${t.sealedMapping} ->> 'commandHash')
    AND ${t.reviewRoundId} = (${t.sealedMapping} ->> 'reviewRoundId')
    AND ${t.reviewRoundId} = (${t.reviewPack} ->> 'reviewRoundId')
    AND (${t.reviewPack} ->> 'purpose') = 'blind_review_only',
    FALSE
  )`),
  check("room_blind_review_registries_expiry_check", sql`${t.expiresAt} > ${t.sealedAt}`),
  check("room_blind_review_registries_hashes_check", sql`
    ${t.commandHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.mappingIntegrityHash} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check("room_blind_review_registries_nonblank_check", sql`
    btrim(${t.reviewRoundId}) <> ''
    AND btrim(${t.idempotencyKey}) <> ''
    AND btrim(${t.sealedAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
  `),
]);

/*
FNXC:RoomEvolutionController 2026-07-19-13:21:
Controlled evolution is one append-only, project-schema ledger rather than a
parallel control product. Each hypothesis, isolated candidate, evaluation,
canary, decision, and rollback retains its scoped evidence and version lineage
so no producer can turn a self-report into an in-place production mutation.
*/
export const roomEvolutionHypotheses = roomSchema.table("room_evolution_hypotheses", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  sourceSignalKinds: jsonb("source_signal_kinds").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  declaredScope: jsonb("declared_scope").notNull(),
  riskClass: text("risk_class").notNull(),
  expectedMechanism: text("expected_mechanism").notNull(),
  affectedDomains: jsonb("affected_domains").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_hypotheses_room_project_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_hypotheses_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_hypotheses_scope_revision_unique").on(t.projectId, t.scopeKey, t.revision),
  index("idx_room_evolution_hypotheses_scope_state").on(t.projectId, t.scopeKey, t.state, t.createdAt),
  check("room_evolution_hypotheses_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_hypotheses_revision_check", sql`${t.revision} BETWEEN 1 AND 2147483647`),
  check("room_evolution_hypotheses_state_check", sql`${t.state} IN ('proposed','experimenting','promoted','rejected','rolled_back','inconclusive')`),
  check("room_evolution_hypotheses_signal_shape_check", sql`jsonb_typeof(${t.sourceSignalKinds}) = 'array'`),
  check("room_evolution_hypotheses_evidence_shape_check", sql`jsonb_typeof(${t.evidence}) = 'array'`),
  check("room_evolution_hypotheses_declared_scope_check", sql`jsonb_typeof(${t.declaredScope}) = 'array'`),
  check("room_evolution_hypotheses_domains_shape_check", sql`jsonb_typeof(${t.affectedDomains}) = 'array'`),
  check("room_evolution_hypotheses_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_hypotheses_risk_check", sql`${t.riskClass} IN ('low','moderate','high','critical')`),
  check("room_evolution_hypotheses_nonblank_check", sql`
    btrim(${t.expectedMechanism}) <> ''
    AND btrim(${t.createdByActorId}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

/*
FNXC:RoomEvolutionLegacyProvenance 2026-07-19-21:40:
0022 records that advertised promotion or canary success without the 0027 trust
receipts remain auditable but are quarantined and cannot be elevated into new
acceptance proof. The audit snapshot itself is append-only at the database.
*/
export const roomEvolutionLegacyProvenanceQuarantines = roomSchema.table("room_evolution_legacy_provenance_quarantines", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  recordKind: text("record_kind").notNull(),
  recordId: text("record_id").notNull(),
  quarantineReason: text("quarantine_reason").notNull(),
  sourceMigrationVersion: text("source_migration_version").notNull(),
  legacySnapshot: jsonb("legacy_snapshot").notNull(),
  quarantinedAt: text("quarantined_at").notNull(),
}, (t) => [
  unique("room_evolution_legacy_provenance_quarantines_record_unique")
    .on(t.projectId, t.scopeKey, t.recordKind, t.recordId),
  index("idx_room_evolution_legacy_provenance_quarantines_scope")
    .on(t.projectId, t.scopeKey, t.recordKind, t.quarantinedAt),
  check("room_evolution_legacy_provenance_quarantines_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_legacy_provenance_quarantines_kind_check", sql`${t.recordKind} IN ('gate_result','canary','promotion_decision')`),
  check("room_evolution_legacy_provenance_quarantines_source_check", sql`${t.sourceMigrationVersion} = '0022'`),
  check("room_evolution_legacy_provenance_quarantines_snapshot_check", sql`jsonb_typeof(${t.legacySnapshot}) = 'object'`),
  check("room_evolution_legacy_provenance_quarantines_nonblank_check", sql`
    btrim(${t.recordId}) <> ''
    AND btrim(${t.quarantineReason}) <> ''
    AND btrim(${t.quarantinedAt}) <> ''
  `),
]);

/* FNXC:RoomEvolutionTrustReceipts 2026-07-19: identity/role/binding evidence is
append-only and points at the actual Room binding generation, not an actor string. */
export const roomEvolutionTrustedBindings = roomSchema.table("room_evolution_trusted_bindings", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  actorId: text("actor_id").notNull(),
  purpose: text("purpose").notNull(),
  subjectRoomId: text("subject_room_id").notNull(),
  roomBindingId: text("room_binding_id").notNull(),
  roomBindingGeneration: integer("room_binding_generation").notNull(),
  roleId: text("role_id").notNull(),
  roleVersion: integer("role_version").notNull(),
  bindingVersion: integer("binding_version").notNull(),
  issuedByPrincipalId: text("issued_by_principal_id").notNull(),
  issuerGrantId: text("issuer_grant_id").notNull(),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  integrityHash: text("integrity_hash").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_trusted_bindings_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.subjectRoomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_trusted_bindings_subject_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.roomBindingId, t.subjectRoomId, t.projectId],
    foreignColumns: [roomBindings.id, roomBindings.roomId, roomBindings.projectId],
    name: "room_evolution_trusted_bindings_binding_room_project_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_trusted_bindings_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_trusted_bindings_version_scope_unique")
    .on(t.id, t.projectId, t.scopeKey, t.bindingVersion),
  unique("room_evolution_trusted_bindings_identity_version_unique")
    .on(t.projectId, t.scopeKey, t.roomBindingId, t.roomBindingGeneration, t.purpose, t.bindingVersion),
  index("idx_room_evolution_trusted_bindings_scope").on(t.projectId, t.scopeKey, t.purpose, t.expiresAt),
  check("room_evolution_trusted_bindings_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND ${t.roomId} = ${t.subjectRoomId}
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_trusted_bindings_purpose_check", sql`${t.purpose} IN ('candidate_producer','independent_evaluator')`),
  check("room_evolution_trusted_bindings_version_check", sql`
    ${t.roomBindingGeneration} BETWEEN 1 AND 2147483647
    AND ${t.roleVersion} BETWEEN 1 AND 2147483647
    AND ${t.bindingVersion} BETWEEN 1 AND 2147483647
  `),
  check("room_evolution_trusted_bindings_hash_check", sql`${t.integrityHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_trusted_bindings_window_check", sql`${t.expiresAt}::timestamptz > ${t.issuedAt}::timestamptz`),
]);

export const roomEvolutionTrustedBindingRevocations = roomSchema.table("room_evolution_trusted_binding_revocations", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  trustedBindingId: text("trusted_binding_id").notNull(),
  revokedByPrincipalId: text("revoked_by_principal_id").notNull(),
  revokerGrantId: text("revoker_grant_id").notNull(),
  reason: text("reason").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  revokedAt: text("revoked_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_trusted_binding_revocations_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.trustedBindingId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionTrustedBindings.id, roomEvolutionTrustedBindings.projectId, roomEvolutionTrustedBindings.scopeKey],
    name: "room_evolution_trusted_binding_revocations_binding_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_trusted_binding_revocations_binding_scope_unique")
    .on(t.projectId, t.scopeKey, t.trustedBindingId),
  check("room_evolution_trusted_binding_revocations_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (${t.scopeKind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.scopeKey} = ('room:' || ${t.roomId}))
    )
  )`),
  check("room_evolution_trusted_binding_revocations_payload_check", sql`jsonb_typeof(${t.evidence}) = 'array'`),
  check("room_evolution_trusted_binding_revocations_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
]);

export const roomEvolutionCandidateVersions = roomSchema.table("room_evolution_candidate_versions", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  hypothesisId: text("hypothesis_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  candidateKind: text("candidate_kind").notNull(),
  baseRevision: text("base_revision").notNull(),
  candidateRef: text("candidate_ref").notNull(),
  isolationKind: text("isolation_kind").notNull(),
  isolationRef: text("isolation_ref").notNull(),
  immutableInput: jsonb("immutable_input").notNull(),
  inputHash: text("input_hash").notNull(),
  candidateHash: text("candidate_hash"),
  producedByActorId: text("produced_by_actor_id").notNull(),
  producerBindingId: text("producer_binding_id"),
  producerBindingVersion: integer("producer_binding_version"),
  baseCandidateVersionId: text("base_candidate_version_id"),
  rollbackTargetCandidateVersionId: text("rollback_target_candidate_version_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_candidates_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.hypothesisId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionHypotheses.id, roomEvolutionHypotheses.projectId, roomEvolutionHypotheses.scopeKey],
    name: "room_evolution_candidates_hypothesis_scope_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.baseCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [t.id, t.projectId, t.scopeKey],
    name: "room_evolution_candidates_base_scope_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.rollbackTargetCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [t.id, t.projectId, t.scopeKey],
    name: "room_evolution_candidates_rollback_scope_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.producerBindingId, t.projectId, t.scopeKey, t.producerBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_candidates_producer_binding_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_candidates_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_candidates_hypothesis_version_unique").on(t.projectId, t.scopeKey, t.hypothesisId, t.versionNumber),
  index("idx_room_evolution_candidates_scope_created").on(t.projectId, t.scopeKey, t.createdAt),
  check("room_evolution_candidates_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_candidates_version_check", sql`${t.versionNumber} BETWEEN 1 AND 2147483647`),
  check("room_evolution_candidates_verified_shape_check", sql`
    (${t.candidateHash} IS NULL AND ${t.producerBindingId} IS NULL AND ${t.producerBindingVersion} IS NULL)
    OR (
      ${t.candidateHash} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.producerBindingId} IS NOT NULL
      AND ${t.producerBindingVersion} BETWEEN 1 AND 2147483647
    )
  `),
  check("room_evolution_candidates_kind_check", sql`${t.candidateKind} IN ('prompt','skill','context','task_decomposition','protocol','role_assignment','model_routing','retry_concurrency','connector_adapter','evaluation_rule','source_code')`),
  check("room_evolution_candidates_isolation_check", sql`${t.isolationKind} IN ('branch','worktree','versioned_policy_store')`),
  check("room_evolution_candidates_source_isolation_check", sql`${t.candidateKind} <> 'source_code' OR ${t.isolationKind} IN ('branch','worktree')`),
  check("room_evolution_candidates_input_shape_check", sql`jsonb_typeof(${t.immutableInput}) = 'object'`),
  check("room_evolution_candidates_hash_check", sql`${t.inputHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_candidates_lineage_check", sql`
    ${t.id} <> COALESCE(${t.baseCandidateVersionId}, '')
    AND ${t.id} <> COALESCE(${t.rollbackTargetCandidateVersionId}, '')
    AND (${t.versionNumber} = 1 OR ${t.baseCandidateVersionId} IS NOT NULL)
  `),
  check("room_evolution_candidates_nonblank_check", sql`
    btrim(${t.baseRevision}) <> ''
    AND btrim(${t.candidateRef}) <> ''
    AND btrim(${t.baseRevision}) <> btrim(${t.candidateRef})
    AND btrim(${t.isolationRef}) <> ''
    AND btrim(${t.producedByActorId}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

export const roomEvolutionExperiments = roomSchema.table("room_evolution_experiments", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  hypothesisId: text("hypothesis_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  state: text("state").notNull(),
  inputSnapshotHash: text("input_snapshot_hash").notNull(),
  authorizationEvidence: jsonb("authorization_evidence").notNull(),
  authorizationHash: text("authorization_hash").notNull(),
  capacityPool: text("capacity_pool").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_experiments_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.hypothesisId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionHypotheses.id, roomEvolutionHypotheses.projectId, roomEvolutionHypotheses.scopeKey],
    name: "room_evolution_experiments_hypothesis_scope_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_experiments_candidate_scope_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_experiments_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  index("idx_room_evolution_experiments_scope_state").on(t.projectId, t.scopeKey, t.state, t.createdAt),
  check("room_evolution_experiments_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_experiments_state_check", sql`${t.state} IN ('planned','running','completed','failed','cancelled','inconclusive')`),
  check("room_evolution_experiments_pool_check", sql`${t.capacityPool} IN ('evolution_low_priority','evolution_paused')`),
  check("room_evolution_experiments_authorization_shape_check", sql`jsonb_typeof(${t.authorizationEvidence}) = 'object'`),
  check("room_evolution_experiments_hashes_check", sql`
    ${t.inputSnapshotHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.authorizationHash} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check("room_evolution_experiments_nonblank_check", sql`
    btrim(${t.createdByActorId}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

export const roomEvolutionBenchmarkCases = roomSchema.table("room_evolution_benchmark_cases", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  domain: text("domain").notNull(),
  caseKind: text("case_kind").notNull(),
  containsPrivateRoomData: boolean("contains_private_room_data").notNull(),
  sourceAuthorizationId: text("source_authorization_id"),
  authorizationEvidence: jsonb("authorization_evidence").notNull(),
  casePayload: jsonb("case_payload").notNull(),
  expectedOutcome: jsonb("expected_outcome").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_benchmarks_room_project_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_benchmarks_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  index("idx_room_evolution_benchmarks_scope_domain").on(t.projectId, t.scopeKey, t.domain, t.caseKind, t.createdAt),
  check("room_evolution_benchmarks_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_benchmarks_case_kind_check", sql`${t.caseKind} IN ('golden','rolling_authorized','adversarial','historical_replay')`),
  check("room_evolution_benchmarks_private_data_check", sql`
    NOT ${t.containsPrivateRoomData}
    OR (
      ${t.sourceAuthorizationId} IS NOT NULL
      AND btrim(${t.sourceAuthorizationId}) <> ''
      AND jsonb_typeof(${t.authorizationEvidence}) = 'object'
      AND ${t.authorizationEvidence} <> '{}'::jsonb
    )
  `),
  check("room_evolution_benchmarks_payload_shape_check", sql`
    jsonb_typeof(${t.authorizationEvidence}) = 'object'
    AND jsonb_typeof(${t.casePayload}) = 'object'
    AND jsonb_typeof(${t.expectedOutcome}) = 'object'
  `),
  check("room_evolution_benchmarks_hash_check", sql`${t.contentHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_benchmarks_nonblank_check", sql`
    btrim(${t.domain}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

export const roomEvolutionBenchmarkResults = roomSchema.table("room_evolution_benchmark_results", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  benchmarkCaseId: text("benchmark_case_id").notNull(),
  evaluatorActorId: text("evaluator_actor_id").notNull(),
  evaluatorKind: text("evaluator_kind").notNull(),
  outcome: text("outcome").notNull(),
  metrics: jsonb("metrics").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  completedAt: text("completed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_benchmark_results_room_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_benchmark_results_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_benchmark_results_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.benchmarkCaseId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionBenchmarkCases.id, roomEvolutionBenchmarkCases.projectId, roomEvolutionBenchmarkCases.scopeKey],
    name: "room_evolution_benchmark_results_case_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_benchmark_results_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_benchmark_results_run_unique").on(t.projectId, t.scopeKey, t.experimentId, t.candidateVersionId, t.benchmarkCaseId, t.evaluatorActorId),
  index("idx_room_evolution_benchmark_results_scope").on(t.projectId, t.scopeKey, t.experimentId, t.completedAt),
  check("room_evolution_benchmark_results_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_benchmark_results_evaluator_check", sql`${t.evaluatorKind} IN ('deterministic','independent_reviewer','producer_self_report')`),
  check("room_evolution_benchmark_results_outcome_check", sql`${t.outcome} IN ('passed','failed','error','inconclusive')`),
  check("room_evolution_benchmark_results_payload_shape_check", sql`
    jsonb_typeof(${t.metrics}) = 'object'
    AND jsonb_typeof(${t.evidence}) = 'array'
  `),
  check("room_evolution_benchmark_results_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_benchmark_results_nonblank_check", sql`
    btrim(${t.evaluatorActorId}) <> ''
    AND btrim(${t.completedAt}) <> ''
  `),
]);

export const roomEvolutionGateResults = roomSchema.table("room_evolution_gate_results", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  benchmarkResultId: text("benchmark_result_id"),
  gateName: text("gate_name").notNull(),
  gateClass: text("gate_class").notNull(),
  outcome: text("outcome").notNull(),
  evaluatorActorId: text("evaluator_actor_id").notNull(),
  evaluatorKind: text("evaluator_kind").notNull(),
  candidateProducerActorId: text("candidate_producer_actor_id").notNull(),
  candidateHash: text("candidate_hash"),
  candidateBindingId: text("candidate_binding_id"),
  candidateBindingVersion: integer("candidate_binding_version"),
  evaluatorBindingId: text("evaluator_binding_id"),
  evaluatorBindingVersion: integer("evaluator_binding_version"),
  evaluationArtifactHash: text("evaluation_artifact_hash"),
  metrics: jsonb("metrics").notNull(),
  metricsHash: text("metrics_hash"),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  promotionEligible: boolean("promotion_eligible").notNull(),
  completedAt: text("completed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_gate_results_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_gate_results_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_gate_results_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.benchmarkResultId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionBenchmarkResults.id, roomEvolutionBenchmarkResults.projectId, roomEvolutionBenchmarkResults.scopeKey],
    name: "room_evolution_gate_results_benchmark_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateBindingId, t.projectId, t.scopeKey, t.candidateBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_gate_results_candidate_binding_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.evaluatorBindingId, t.projectId, t.scopeKey, t.evaluatorBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_gate_results_evaluator_binding_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_gate_results_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_gate_results_identity_unique").on(t.projectId, t.scopeKey, t.experimentId, t.candidateVersionId, t.gateName, t.evaluatorActorId),
  index("idx_room_evolution_gate_results_scope").on(t.projectId, t.scopeKey, t.experimentId, t.gateClass, t.completedAt),
  check("room_evolution_gate_results_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_gate_results_class_check", sql`${t.gateClass} IN ('hard','optimization')`),
  check("room_evolution_gate_results_outcome_check", sql`${t.outcome} IN ('passed','failed','error','not_run')`),
  check("room_evolution_gate_results_evaluator_check", sql`${t.evaluatorKind} IN ('deterministic','independent_reviewer','producer_self_report')`),
  check("room_evolution_gate_results_verified_shape_check", sql`
    ${t.promotionEligible} = false
    OR (
      ${t.candidateHash} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.candidateBindingId} IS NOT NULL
      AND ${t.candidateBindingVersion} BETWEEN 1 AND 2147483647
      AND ${t.evaluatorBindingId} IS NOT NULL
      AND ${t.evaluatorBindingVersion} BETWEEN 1 AND 2147483647
      AND ${t.evaluationArtifactHash} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.metricsHash} ~ '^sha256:[a-f0-9]{64}$'
    )
  `),
  check("room_evolution_gate_results_payload_shape_check", sql`
    jsonb_typeof(${t.metrics}) = 'object'
    AND jsonb_typeof(${t.evidence}) = 'array'
  `),
  check("room_evolution_gate_results_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_gate_results_independence_check", sql`
    NOT ${t.promotionEligible}
    OR (
      ${t.outcome} = 'passed'
      AND ${t.evaluatorKind} IN ('deterministic','independent_reviewer')
      AND ${t.evaluatorActorId} <> ${t.candidateProducerActorId}
    )
  `),
  check("room_evolution_gate_results_nonblank_check", sql`
    btrim(${t.gateName}) <> ''
    AND btrim(${t.evaluatorActorId}) <> ''
    AND btrim(${t.candidateProducerActorId}) <> ''
    AND btrim(${t.completedAt}) <> ''
  `),
]);

export const roomEvolutionCanaries = roomSchema.table("room_evolution_canaries", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  allocationVersion: integer("allocation_version").notNull(),
  allocation: jsonb("allocation").notNull(),
  successCriteria: jsonb("success_criteria").notNull(),
  failureCriteria: jsonb("failure_criteria").notNull(),
  state: text("state").notNull(),
  rollbackTargetCandidateVersionId: text("rollback_target_candidate_version_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_canaries_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_canaries_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_canaries_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.rollbackTargetCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_canaries_rollback_target_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_canaries_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_canaries_allocation_unique").on(t.projectId, t.scopeKey, t.candidateVersionId, t.allocationVersion),
  index("idx_room_evolution_canaries_scope_state").on(t.projectId, t.scopeKey, t.state, t.createdAt),
  check("room_evolution_canaries_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_canaries_allocation_version_check", sql`${t.allocationVersion} BETWEEN 1 AND 2147483647`),
  check("room_evolution_canaries_state_check", sql`${t.state} IN ('planned','running','paused','succeeded','failed','rolled_back','cancelled')`),
  check("room_evolution_canaries_payload_shape_check", sql`
    jsonb_typeof(${t.allocation}) = 'object'
    AND jsonb_typeof(${t.successCriteria}) = 'object'
    AND jsonb_typeof(${t.failureCriteria}) = 'object'
  `),
  check("room_evolution_canaries_lineage_check", sql`${t.candidateVersionId} <> ${t.rollbackTargetCandidateVersionId}`),
  check("room_evolution_canaries_nonblank_check", sql`btrim(${t.createdAt}) <> ''`),
]);

export const roomEvolutionCanaryObservations = roomSchema.table("room_evolution_canary_observations", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  canaryId: text("canary_id").notNull(),
  metricName: text("metric_name").notNull(),
  metricValue: jsonb("metric_value").notNull(),
  threshold: jsonb("threshold").notNull(),
  breached: boolean("breached").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  observedAt: text("observed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_canary_observations_room_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.canaryId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCanaries.id, roomEvolutionCanaries.projectId, roomEvolutionCanaries.scopeKey],
    name: "room_evolution_canary_observations_canary_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_canary_observations_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  index("idx_room_evolution_canary_observations_scope").on(t.projectId, t.scopeKey, t.canaryId, t.observedAt),
  check("room_evolution_canary_observations_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_canary_observations_payload_check", sql`
    jsonb_typeof(${t.metricValue}) = 'object'
    AND jsonb_typeof(${t.threshold}) = 'object'
    AND jsonb_typeof(${t.evidence}) = 'array'
  `),
  check("room_evolution_canary_observations_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_canary_observations_nonblank_check", sql`
    btrim(${t.metricName}) <> ''
    AND btrim(${t.observedAt}) <> ''
  `),
]);

export const roomEvolutionCanarySuccessOutcomes = roomSchema.table("room_evolution_canary_success_outcomes", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  canaryId: text("canary_id").notNull(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  candidateHash: text("candidate_hash").notNull(),
  candidateBindingId: text("candidate_binding_id").notNull(),
  candidateBindingVersion: integer("candidate_binding_version").notNull(),
  evaluatorBindingId: text("evaluator_binding_id").notNull(),
  evaluatorBindingVersion: integer("evaluator_binding_version").notNull(),
  gateResultIds: jsonb("gate_result_ids").notNull(),
  allocationHash: text("allocation_hash").notNull(),
  artifactHash: text("artifact_hash").notNull(),
  metrics: jsonb("metrics").notNull(),
  metricsHash: text("metrics_hash").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  completedAt: text("completed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_canary_success_outcomes_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.canaryId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCanaries.id, roomEvolutionCanaries.projectId, roomEvolutionCanaries.scopeKey],
    name: "room_evolution_canary_success_outcomes_canary_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_canary_success_outcomes_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_canary_success_outcomes_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateBindingId, t.projectId, t.scopeKey, t.candidateBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_canary_success_outcomes_candidate_binding_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.evaluatorBindingId, t.projectId, t.scopeKey, t.evaluatorBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_canary_success_outcomes_evaluator_binding_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_canary_success_outcomes_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_canary_success_outcomes_canary_unique").on(t.projectId, t.scopeKey, t.canaryId),
  index("idx_room_evolution_canary_success_outcomes_scope").on(t.projectId, t.scopeKey, t.completedAt),
  check("room_evolution_canary_success_outcomes_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (${t.scopeKind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.scopeKey} = ('room:' || ${t.roomId}))
    )
  )`),
  check("room_evolution_canary_success_outcomes_payload_check", sql`
    jsonb_typeof(${t.gateResultIds}) = 'array'
    AND jsonb_array_length(${t.gateResultIds}) > 0
    AND jsonb_typeof(${t.metrics}) = 'object'
    AND jsonb_typeof(${t.evidence}) = 'array'
  `),
  check("room_evolution_canary_success_outcomes_hash_check", sql`
    ${t.candidateHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.allocationHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.artifactHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.metricsHash} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'
  `),
]);

export const roomEvolutionPromotionDecisions = roomSchema.table("room_evolution_promotion_decisions", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  canaryId: text("canary_id"),
  canarySuccessOutcomeId: text("canary_success_outcome_id"),
  candidateHash: text("candidate_hash"),
  decisionBindingId: text("decision_binding_id"),
  decisionBindingVersion: integer("decision_binding_version"),
  decision: text("decision").notNull(),
  riskClass: text("risk_class").notNull(),
  authorityTier: text("authority_tier").notNull(),
  candidateProducerActorId: text("candidate_producer_actor_id").notNull(),
  decisionActorId: text("decision_actor_id").notNull(),
  approvalRequestId: text("approval_request_id"),
  authorizationEvidence: jsonb("authorization_evidence").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  rollbackTargetCandidateVersionId: text("rollback_target_candidate_version_id"),
  decidedAt: text("decided_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_promotions_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_promotions_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_promotions_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.canaryId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCanaries.id, roomEvolutionCanaries.projectId, roomEvolutionCanaries.scopeKey],
    name: "room_evolution_promotions_canary_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.canarySuccessOutcomeId, t.projectId, t.scopeKey],
    foreignColumns: [
      roomEvolutionCanarySuccessOutcomes.id,
      roomEvolutionCanarySuccessOutcomes.projectId,
      roomEvolutionCanarySuccessOutcomes.scopeKey,
    ],
    name: "room_evolution_promotions_success_outcome_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.decisionBindingId, t.projectId, t.scopeKey, t.decisionBindingVersion],
    foreignColumns: [
      roomEvolutionTrustedBindings.id,
      roomEvolutionTrustedBindings.projectId,
      roomEvolutionTrustedBindings.scopeKey,
      roomEvolutionTrustedBindings.bindingVersion,
    ],
    name: "room_evolution_promotions_decision_binding_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.rollbackTargetCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_promotions_rollback_target_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.projectId, t.approvalRequestId],
    foreignColumns: [approvalRequests.projectId, approvalRequests.id],
    name: "room_evolution_promotions_approval_request_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_promotions_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_promotions_candidate_decision_unique").on(t.projectId, t.scopeKey, t.experimentId, t.candidateVersionId, t.decidedAt),
  index("idx_room_evolution_promotions_scope_decision").on(t.projectId, t.scopeKey, t.decision, t.decidedAt),
  check("room_evolution_promotions_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_promotions_verified_shape_check", sql`
    ${t.decision} <> 'promoted'
    OR (
      ${t.canarySuccessOutcomeId} IS NOT NULL
      AND ${t.candidateHash} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.decisionBindingId} IS NOT NULL
      AND ${t.decisionBindingVersion} BETWEEN 1 AND 2147483647
      AND ${t.canaryId} IS NOT NULL
      AND ${t.rollbackTargetCandidateVersionId} IS NOT NULL
    )
  `),
  check("room_evolution_promotions_decision_check", sql`${t.decision} IN ('promoted','rejected','inconclusive','rollback_required')`),
  check("room_evolution_promotions_risk_check", sql`${t.riskClass} IN ('low','moderate','high','critical')`),
  check("room_evolution_promotions_authority_check", sql`${t.authorityTier} IN ('automatic_pre_authorized','independent','human')`),
  check("room_evolution_promotions_payload_shape_check", sql`
    jsonb_typeof(${t.authorizationEvidence}) = 'object'
    AND jsonb_typeof(${t.evidence}) = 'array'
  `),
  check("room_evolution_promotions_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_promotions_no_self_accept_check", sql`
    ${t.decision} <> 'promoted'
    OR ${t.decisionActorId} <> ${t.candidateProducerActorId}
  `),
  check("room_evolution_promotions_canary_check", sql`
    ${t.decision} <> 'promoted'
    OR (${t.canaryId} IS NOT NULL AND ${t.rollbackTargetCandidateVersionId} IS NOT NULL)
  `),
  check("room_evolution_promotions_high_risk_check", sql`
    ${t.riskClass} NOT IN ('high','critical')
    OR (${t.authorityTier} = 'human' AND ${t.approvalRequestId} IS NOT NULL)
  `),
  check("room_evolution_promotions_nonblank_check", sql`
    btrim(${t.candidateProducerActorId}) <> ''
    AND btrim(${t.decisionActorId}) <> ''
    AND btrim(${t.decidedAt}) <> ''
  `),
]);

export const roomEvolutionRollbacks = roomSchema.table("room_evolution_rollbacks", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  promotionDecisionId: text("promotion_decision_id").notNull(),
  canaryId: text("canary_id").notNull(),
  fromCandidateVersionId: text("from_candidate_version_id").notNull(),
  toCandidateVersionId: text("to_candidate_version_id").notNull(),
  triggerKind: text("trigger_kind").notNull(),
  reason: text("reason").notNull(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  executedAt: text("executed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_rollbacks_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.promotionDecisionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionPromotionDecisions.id, roomEvolutionPromotionDecisions.projectId, roomEvolutionPromotionDecisions.scopeKey],
    name: "room_evolution_rollbacks_promotion_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.canaryId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCanaries.id, roomEvolutionCanaries.projectId, roomEvolutionCanaries.scopeKey],
    name: "room_evolution_rollbacks_canary_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.fromCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_rollbacks_from_candidate_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.toCandidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_rollbacks_to_candidate_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_rollbacks_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  index("idx_room_evolution_rollbacks_scope_time").on(t.projectId, t.scopeKey, t.executedAt),
  check("room_evolution_rollbacks_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (
        ${t.scopeKind} = 'room'
        AND ${t.roomId} IS NOT NULL
        AND btrim(${t.roomId}) <> ''
        AND ${t.scopeKey} = ('room:' || ${t.roomId})
      )
    )
  )`),
  check("room_evolution_rollbacks_trigger_check", sql`${t.triggerKind} IN ('automatic','operator')`),
  check("room_evolution_rollbacks_payload_shape_check", sql`jsonb_typeof(${t.evidence}) = 'array'`),
  check("room_evolution_rollbacks_hash_check", sql`${t.evidenceHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_rollbacks_lineage_check", sql`${t.fromCandidateVersionId} <> ${t.toCandidateVersionId}`),
  check("room_evolution_rollbacks_nonblank_check", sql`
    btrim(${t.reason}) <> ''
    AND btrim(${t.executedAt}) <> ''
  `),
]);

/*
FNXC:RoomEvolutionExecutionRecovery 2026-07-19-21:36:
These tables are a durable execution-intent and effect-outbox boundary only.
They bind request/effect payload hashes, claims, recovery attempts, and outcomes
without asserting that an Engine, provider, source candidate, or policy change ran.
*/
export const roomEvolutionExecutionRuns = roomSchema.table("room_evolution_execution_runs", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  experimentId: text("experiment_id").notNull(),
  candidateVersionId: text("candidate_version_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  request: jsonb("request").notNull(),
  requestHash: text("request_hash").notNull(),
  state: text("state").notNull(),
  effectCount: integer("effect_count").notNull(),
  completedEffectCount: integer("completed_effect_count").notNull().default(0),
  failedEffectCount: integer("failed_effect_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evolution_execution_runs_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.experimentId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExperiments.id, roomEvolutionExperiments.projectId, roomEvolutionExperiments.scopeKey],
    name: "room_evolution_execution_runs_experiment_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.candidateVersionId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionCandidateVersions.id, roomEvolutionCandidateVersions.projectId, roomEvolutionCandidateVersions.scopeKey],
    name: "room_evolution_execution_runs_candidate_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_execution_runs_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_execution_runs_idempotency_unique").on(t.projectId, t.scopeKey, t.idempotencyKey),
  index("idx_room_evolution_execution_runs_scope_state").on(t.projectId, t.scopeKey, t.state, t.updatedAt),
  check("room_evolution_execution_runs_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (${t.scopeKind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.scopeKey} = ('room:' || ${t.roomId}))
    )
  )`),
  check("room_evolution_execution_runs_payload_check", sql`jsonb_typeof(${t.request}) = 'object'`),
  check("room_evolution_execution_runs_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_execution_runs_state_check", sql`${t.state} IN ('pending','running','succeeded','failed')`),
  check("room_evolution_execution_runs_counts_check", sql`
    ${t.effectCount} BETWEEN 1 AND 2147483647
    AND ${t.completedEffectCount} BETWEEN 0 AND ${t.effectCount}
    AND ${t.failedEffectCount} BETWEEN 0 AND ${t.effectCount}
    AND ${t.completedEffectCount} + ${t.failedEffectCount} <= ${t.effectCount}
  `),
  check("room_evolution_execution_runs_terminal_check", sql`
    (${t.state} IN ('pending','running') AND ${t.completedAt} IS NULL)
    OR (${t.state} IN ('succeeded','failed') AND ${t.completedAt} IS NOT NULL)
  `),
  check("room_evolution_execution_runs_nonblank_check", sql`
    btrim(${t.experimentId}) <> ''
    AND btrim(${t.candidateVersionId}) <> ''
    AND btrim(${t.idempotencyKey}) <> ''
    AND btrim(${t.createdAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
  `),
]);

export const roomEvolutionEffectOutbox = roomSchema.table("room_evolution_effect_outbox", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  runId: text("run_id").notNull(),
  effectKey: text("effect_key").notNull(),
  effectKind: text("effect_kind").notNull(),
  payload: jsonb("payload").notNull(),
  payloadHash: text("payload_hash").notNull(),
  state: text("state").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  nextEligibleAt: text("next_eligible_at"),
  claimToken: text("claim_token"),
  claimExpiresAt: text("claim_expires_at"),
  claimedByWorkerId: text("claimed_by_worker_id"),
  claimedAt: text("claimed_at"),
  lastErrorCode: text("last_error_code"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.runId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExecutionRuns.id, roomEvolutionExecutionRuns.projectId, roomEvolutionExecutionRuns.scopeKey],
    name: "room_evolution_effect_outbox_run_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_effect_outbox_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_effect_outbox_run_key_unique").on(t.projectId, t.scopeKey, t.runId, t.effectKey),
  index("idx_room_evolution_effect_outbox_claimable").on(t.projectId, t.scopeKey, t.state, t.nextEligibleAt, t.claimExpiresAt),
  check("room_evolution_effect_outbox_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (${t.scopeKind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.scopeKey} = ('room:' || ${t.roomId}))
    )
  )`),
  check("room_evolution_effect_outbox_payload_check", sql`jsonb_typeof(${t.payload}) = 'object'`),
  check("room_evolution_effect_outbox_hash_check", sql`${t.payloadHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_effect_outbox_state_check", sql`${t.state} IN ('pending','claimed','retry_scheduled','succeeded','failed')`),
  check("room_evolution_effect_outbox_attempts_check", sql`
    ${t.attemptCount} BETWEEN 0 AND ${t.maxAttempts}
    AND ${t.maxAttempts} BETWEEN 1 AND 2147483647
  `),
  check("room_evolution_effect_outbox_state_shape_check", sql`
    (${t.state} = 'pending'
      AND ${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.claimedByWorkerId} IS NULL AND ${t.claimedAt} IS NULL
      AND ${t.nextEligibleAt} IS NOT NULL AND ${t.completedAt} IS NULL
      AND ${t.lastErrorCode} IS NULL)
    OR (${t.state} = 'claimed'
      AND ${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL
      AND ${t.claimedByWorkerId} IS NOT NULL AND ${t.claimedAt} IS NOT NULL
      AND ${t.nextEligibleAt} IS NULL AND ${t.completedAt} IS NULL)
    OR (${t.state} = 'retry_scheduled'
      AND ${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.claimedByWorkerId} IS NULL AND ${t.claimedAt} IS NULL
      AND ${t.nextEligibleAt} IS NOT NULL AND ${t.completedAt} IS NULL
      AND ${t.lastErrorCode} IS NOT NULL)
    OR (${t.state} IN ('succeeded','failed')
      AND ${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.claimedByWorkerId} IS NULL AND ${t.claimedAt} IS NULL
      AND ${t.nextEligibleAt} IS NULL AND ${t.completedAt} IS NOT NULL)
  `),
  check("room_evolution_effect_outbox_nonblank_check", sql`
    btrim(${t.runId}) <> ''
    AND btrim(${t.effectKey}) <> ''
    AND btrim(${t.effectKind}) <> ''
    AND btrim(${t.createdAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
  `),
]);

export const roomEvolutionExecutionOutcomes = roomSchema.table("room_evolution_execution_outcomes", {
  id: text("id").primaryKey(),
  ...evolutionScopeColumns(),
  runId: text("run_id").notNull(),
  effectId: text("effect_id").notNull(),
  claimToken: text("claim_token").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  payloadHash: text("payload_hash").notNull(),
  errorCode: text("error_code"),
  recordedAt: text("recorded_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.runId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionExecutionRuns.id, roomEvolutionExecutionRuns.projectId, roomEvolutionExecutionRuns.scopeKey],
    name: "room_evolution_execution_outcomes_run_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.effectId, t.projectId, t.scopeKey],
    foreignColumns: [roomEvolutionEffectOutbox.id, roomEvolutionEffectOutbox.projectId, roomEvolutionEffectOutbox.scopeKey],
    name: "room_evolution_execution_outcomes_effect_fkey",
  }).onDelete("restrict"),
  unique("room_evolution_execution_outcomes_id_scope_unique").on(t.id, t.projectId, t.scopeKey),
  unique("room_evolution_execution_outcomes_effect_claim_unique").on(t.projectId, t.scopeKey, t.effectId, t.claimToken),
  index("idx_room_evolution_execution_outcomes_run_time").on(t.projectId, t.scopeKey, t.runId, t.recordedAt),
  check("room_evolution_execution_outcomes_scope_check", sql`(
    btrim(${t.projectId}) <> ''
    AND (
      (${t.scopeKind} = 'project' AND ${t.roomId} IS NULL AND ${t.scopeKey} = ('project:' || ${t.projectId}))
      OR (${t.scopeKind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.scopeKey} = ('room:' || ${t.roomId}))
    )
  )`),
  check("room_evolution_execution_outcomes_payload_check", sql`jsonb_typeof(${t.payload}) = 'object'`),
  check("room_evolution_execution_outcomes_hash_check", sql`${t.payloadHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_evolution_execution_outcomes_kind_check", sql`${t.kind} IN ('claim_expired','retry_scheduled','succeeded','failed')`),
  check("room_evolution_execution_outcomes_error_shape_check", sql`
    (${t.kind} = 'succeeded' AND ${t.errorCode} IS NULL)
    OR (${t.kind} <> 'succeeded' AND ${t.errorCode} IS NOT NULL)
  `),
  check("room_evolution_execution_outcomes_attempt_check", sql`${t.attemptCount} BETWEEN 1 AND 2147483647`),
  check("room_evolution_execution_outcomes_nonblank_check", sql`
    btrim(${t.runId}) <> ''
    AND btrim(${t.effectId}) <> ''
    AND btrim(${t.claimToken}) <> ''
    AND btrim(${t.recordedAt}) <> ''
  `),
]);

export const roomTaskNodes = roomSchema.table("room_task_nodes", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  parentNodeId: text("parent_node_id"),
  objective: text("objective").notNull(),
  state: text("state").notNull(),
  assignedSeatIds: jsonb("assigned_seat_ids").notNull().default([]),
  inputRefs: jsonb("input_refs").notNull().default([]),
  outputRefs: jsonb("output_refs").notNull().default([]),
  roleRequirements: jsonb("role_requirements").notNull().default([]),
  capabilityRequirements: jsonb("capability_requirements").notNull().default([]),
  resourceHints: jsonb("resource_hints").notNull().default({
    estimatedDurationMs: 0,
    concurrencyClass: "serial",
    preferredProviderIds: [],
  }),
  authorityScope: jsonb("authority_scope").notNull().default({
    allowedActions: [],
    readPaths: [],
    writePaths: [],
  }),
  requiredGateIds: jsonb("required_gate_ids").notNull().default([]),
  retryPolicy: jsonb("retry_policy").notNull().default({
    maxAttempts: 1,
    backoff: "fixed",
    baseDelayMs: 0,
    recoveryActions: [],
  }),
  progressSignature: text("progress_signature").notNull(),
  nodeVersion: bigint("node_version", { mode: "number" }).notNull().default(0),
  acceptedAt: text("accepted_at"),
  acceptanceEvidenceIds: jsonb("acceptance_evidence_ids").notNull().default([]),
  invalidatedByEvidenceId: text("invalidated_by_evidence_id"),
  reopenedByEvidenceId: text("reopened_by_evidence_id"),
  origin: jsonb("origin").notNull().default({ kind: "created" }),
  terminalLineage: jsonb("terminal_lineage"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_task_nodes_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.parentNodeId, t.roomId, t.projectId],
    foreignColumns: [t.id, t.roomId, t.projectId],
    name: "room_task_nodes_parent_room_project_fkey",
  }),
  unique("room_task_nodes_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  index("idx_room_task_nodes_room_state").on(t.projectId, t.roomId, t.state),
  index("idx_room_task_nodes_parent").on(t.projectId, t.roomId, t.parentNodeId),
  check("room_task_nodes_state_check", sql`${t.state} IN ('pending','ready','running','waiting_dependency','waiting_approval','rate_limited','retrying','accepted','blocked','failed','cancelled')`),
  check("room_task_nodes_node_version_check", sql`${t.nodeVersion} BETWEEN 0 AND 9007199254740991`),
  check("room_task_nodes_progress_signature_check", sql`btrim(${t.progressSignature}) <> ''`),
  /*
  FNXC:SessionRoomTaskDag 2026-07-18-14:25:
  The declarative schema must preserve migration 0012's exact hostile-JSON
  rejection rules so fresh schema generation cannot accept shapes that the
  incremental migration rejects.
  */
  check("room_task_nodes_role_requirements_check", sql`
    CASE WHEN jsonb_typeof(${t.roleRequirements}) = 'array'
      THEN NOT jsonb_path_exists(${t.roleRequirements}, '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.roleRequirements})
      ELSE false
    END
  `),
  check("room_task_nodes_capability_requirements_check", sql`
    CASE WHEN jsonb_typeof(${t.capabilityRequirements}) = 'array'
      THEN NOT jsonb_path_exists(${t.capabilityRequirements}, '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.capabilityRequirements})
      ELSE false
    END
  `),
  check("room_task_nodes_resource_hints_check", sql`
    jsonb_typeof(${t.resourceHints}) = 'object'
    AND ${t.resourceHints} ?& ARRAY['estimatedDurationMs','concurrencyClass','preferredProviderIds']
    AND ${t.resourceHints} - 'estimatedDurationMs' - 'concurrencyClass' - 'preferredProviderIds' = '{}'::jsonb
    AND jsonb_typeof(${t.resourceHints}->'estimatedDurationMs') = 'number'
    AND (${t.resourceHints}->>'estimatedDurationMs')::numeric BETWEEN 0 AND 9007199254740991
    AND trunc((${t.resourceHints}->>'estimatedDurationMs')::numeric) = (${t.resourceHints}->>'estimatedDurationMs')::numeric
    AND ${t.resourceHints}->>'concurrencyClass' IN ('serial','parallel')
    AND CASE WHEN jsonb_typeof(${t.resourceHints}->'preferredProviderIds') = 'array'
      THEN NOT jsonb_path_exists(${t.resourceHints}->'preferredProviderIds', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.resourceHints}->'preferredProviderIds')
      ELSE false
    END
  `),
  check("room_task_nodes_authority_scope_check", sql`
    jsonb_typeof(${t.authorityScope}) = 'object'
    AND ${t.authorityScope} ?& ARRAY['allowedActions','readPaths','writePaths']
    AND ${t.authorityScope} - 'allowedActions' - 'readPaths' - 'writePaths' = '{}'::jsonb
    AND CASE WHEN jsonb_typeof(${t.authorityScope}->'allowedActions') = 'array'
      THEN NOT jsonb_path_exists(${t.authorityScope}->'allowedActions', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.authorityScope}->'allowedActions')
      ELSE false
    END
    AND CASE WHEN jsonb_typeof(${t.authorityScope}->'readPaths') = 'array'
      THEN NOT jsonb_path_exists(${t.authorityScope}->'readPaths', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.authorityScope}->'readPaths')
      ELSE false
    END
    AND CASE WHEN jsonb_typeof(${t.authorityScope}->'writePaths') = 'array'
      THEN NOT jsonb_path_exists(${t.authorityScope}->'writePaths', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.authorityScope}->'writePaths')
      ELSE false
    END
  `),
  check("room_task_nodes_retry_policy_check", sql`
    jsonb_typeof(${t.retryPolicy}) = 'object'
    AND ${t.retryPolicy} ?& ARRAY['maxAttempts','backoff','baseDelayMs','recoveryActions']
    AND ${t.retryPolicy} - 'maxAttempts' - 'backoff' - 'baseDelayMs' - 'recoveryActions' = '{}'::jsonb
    AND jsonb_typeof(${t.retryPolicy}->'maxAttempts') = 'number'
    AND (${t.retryPolicy}->>'maxAttempts')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((${t.retryPolicy}->>'maxAttempts')::numeric) = (${t.retryPolicy}->>'maxAttempts')::numeric
    AND ${t.retryPolicy}->>'backoff' IN ('fixed','exponential')
    AND jsonb_typeof(${t.retryPolicy}->'baseDelayMs') = 'number'
    AND (${t.retryPolicy}->>'baseDelayMs')::numeric BETWEEN 0 AND 9007199254740991
    AND trunc((${t.retryPolicy}->>'baseDelayMs')::numeric) = (${t.retryPolicy}->>'baseDelayMs')::numeric
    AND CASE WHEN jsonb_typeof(${t.retryPolicy}->'recoveryActions') = 'array'
      THEN NOT jsonb_path_exists(${t.retryPolicy}->'recoveryActions', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.retryPolicy}->'recoveryActions')
      ELSE false
    END
  `),
  check("room_task_nodes_acceptance_evidence_ids_check", sql`
    CASE WHEN jsonb_typeof(${t.acceptanceEvidenceIds}) = 'array'
      THEN NOT jsonb_path_exists(${t.acceptanceEvidenceIds}, '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
        AND project.room_jsonb_text_array_is_unique(${t.acceptanceEvidenceIds})
      ELSE false
    END
  `),
  check("room_task_nodes_acceptance_projection_check", sql`
    CASE WHEN ${t.state} = 'accepted'
      THEN ${t.acceptedAt} IS NOT NULL
        AND btrim(${t.acceptedAt}) <> ''
        AND CASE WHEN jsonb_typeof(${t.acceptanceEvidenceIds}) = 'array'
          THEN jsonb_array_length(${t.acceptanceEvidenceIds}) > 0
          ELSE false
        END
      ELSE ${t.acceptedAt} IS NULL
        AND ${t.acceptanceEvidenceIds} = '[]'::jsonb
        AND ${t.invalidatedByEvidenceId} IS NULL
    END
  `),
  /*
  FNXC:SessionRoomTaskTopology 2026-07-18-15:20:
  Origin and terminal lineage are typed, hash-safe tombstone facts. They retain
  hierarchical history without copying causal reason text into projections.

  FNXC:SessionRoomTaskTopology 2026-07-18-15:58:
  Single-row topology facts must reject SQL UNKNOWN, require real JSON strings,
  and retain only canonical, calendar-valid UTC ISO timestamps.

  FNXC:SessionRoomTaskTopology 2026-07-18-16:12:
  Ordinary edges have no creation operation and no derived lineage. Derived
  edges require both a nonblank creation operation and nonempty source lineage.
  */
  check("room_task_nodes_origin_check", sql`
    (
      jsonb_typeof(${t.origin}) = 'object'
      AND (
        ${t.origin} = '{"kind":"created"}'::jsonb
        OR (
          ${t.origin} ?& ARRAY['kind','operationId','sourceNodeIds']
          AND ${t.origin} - 'kind' - 'operationId' - 'sourceNodeIds' = '{}'::jsonb
          AND jsonb_typeof(${t.origin}->'kind') = 'string'
          AND ${t.origin}->>'kind' IN ('split_child','merge_result')
          AND jsonb_typeof(${t.origin}->'operationId') = 'string'
          AND btrim(${t.origin}->>'operationId') <> ''
          AND CASE WHEN jsonb_typeof(${t.origin}->'sourceNodeIds') = 'array'
            THEN jsonb_array_length(${t.origin}->'sourceNodeIds') > 0
              AND NOT jsonb_path_exists(${t.origin}->'sourceNodeIds', '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
              AND project.room_jsonb_text_array_is_unique(${t.origin}->'sourceNodeIds')
              AND (
                (${t.origin}->>'kind' = 'split_child' AND jsonb_array_length(${t.origin}->'sourceNodeIds') = 1)
                OR (${t.origin}->>'kind' = 'merge_result' AND jsonb_array_length(${t.origin}->'sourceNodeIds') >= 2)
              )
            ELSE false
          END
        )
      )
    ) IS TRUE
  `),
  check("room_task_nodes_terminal_lineage_check", sql`
    (
      ${t.terminalLineage} IS NULL
      OR (
        jsonb_typeof(${t.terminalLineage}) = 'object'
        AND ${t.terminalLineage} ?& ARRAY['kind','operationId','at','reasonHash']
        AND ${t.terminalLineage} - 'kind' - 'operationId' - 'at' - 'reasonHash' = '{}'::jsonb
        AND jsonb_typeof(${t.terminalLineage}->'kind') = 'string'
        AND ${t.terminalLineage}->>'kind' IN ('split','merge','cancel')
        AND jsonb_typeof(${t.terminalLineage}->'operationId') = 'string'
        AND btrim(${t.terminalLineage}->>'operationId') <> ''
        AND CASE
          WHEN jsonb_typeof(${t.terminalLineage}->'at') = 'string'
            AND ${t.terminalLineage}->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$'
          THEN to_char((${t.terminalLineage}->>'at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${t.terminalLineage}->>'at'
          ELSE false
        END
        AND jsonb_typeof(${t.terminalLineage}->'reasonHash') = 'string'
        AND ${t.terminalLineage}->>'reasonHash' ~ '^sha256:[0-9a-f]{64}$'
        AND ${t.state} = 'cancelled'
      )
    ) IS TRUE
  `),
]);

/*
FNXC:SessionRoomRoleAssignment 2026-07-19-02:24:
Capability-aware role selection is a durable Room control-plane decision, not
a transient coordinator preference. Keep each canonical snapshot, user lock or
forbid, and producer lineage versioned so a restart or later dispatch claim
can prove exactly why one concrete Session binding was eligible.
*/
export const roomRoleAssignments = roomSchema.table("room_role_assignments", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
  state: text("state").notNull(),
  protocolId: text("protocol_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  phaseId: text("phase_id").notNull(),
  capabilitySnapshot: jsonb("capability_snapshot").notNull(),
  constraints: jsonb("constraints").notNull(),
  assignment: jsonb("assignment").notNull(),
  authoritativeProducerBindingIds: jsonb("authoritative_producer_binding_ids").notNull().default([]),
  createdAt: text("created_at").notNull(),
  supersededAt: text("superseded_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_role_assignments_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_role_assignments_room_revision_unique").on(t.roomId, t.revision),
  uniqueIndex("room_role_assignments_active_room_unique")
    .on(t.projectId, t.roomId)
    .where(sql`${t.state} = 'active'`),
  index("idx_room_role_assignments_project_room_state")
    .on(t.projectId, t.roomId, t.state, t.revision),
  check("room_role_assignments_state_check", sql`${t.state} IN ('active','superseded')`),
  check("room_role_assignments_revision_check", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  check("room_role_assignments_aggregate_version_check", sql`${t.aggregateVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_role_assignments_protocol_version_check", sql`${t.protocolVersion} BETWEEN 1 AND 2147483647`),
  check("room_role_assignments_phase_id_check", sql`btrim(${t.phaseId}) <> ''`),
  check("room_role_assignments_snapshot_shape_check", sql`jsonb_typeof(${t.capabilitySnapshot}) = 'object'`),
  check("room_role_assignments_constraints_shape_check", sql`jsonb_typeof(${t.constraints}) = 'object'`),
  check("room_role_assignments_assignment_shape_check", sql`jsonb_typeof(${t.assignment}) = 'object'`),
  check("room_role_assignments_producer_shape_check", sql`jsonb_typeof(${t.authoritativeProducerBindingIds}) = 'array'`),
  check("room_role_assignments_state_time_check", sql`(
    ${t.state} = 'active' AND ${t.supersededAt} IS NULL
  ) OR (
    ${t.state} = 'superseded' AND ${t.supersededAt} IS NOT NULL
  )`),
]);

/*
FNXC:RoomPhaseGateEvidence 2026-07-18-08:41:
Phase advancement must consume immutable, independently checkable proof rather
than a command-provided list of passed gate ids. Keep the full canonical
evidence record and the producer-lineage snapshot together so an event replay
can re-evaluate exactly the proof that authorized a phase transition.
*/
export const roomPhaseGateEvidence = roomSchema.table("room_phase_gate_evidence", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  evidence: jsonb("evidence").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  producerLineage: jsonb("producer_lineage").notNull(),
  evidenceNotBefore: text("evidence_not_before").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_phase_gate_evidence_room_project_fkey",
  }).onDelete("cascade"),
  uniqueIndex("room_phase_gate_evidence_source_unique")
    .on(t.projectId, t.roomId, sql`(${t.evidence}->'source'->>'recordId')`),
  index("idx_room_phase_gate_evidence_room_created")
    .on(t.projectId, t.roomId, t.createdAt, t.id),
  check("room_phase_gate_evidence_evidence_shape_check", sql`jsonb_typeof(${t.evidence}) = 'object'`),
  check("room_phase_gate_evidence_lineage_shape_check", sql`jsonb_typeof(${t.producerLineage}) = 'object'`),
  check("room_phase_gate_evidence_nonblank_check", sql`
    btrim(${t.id}) <> ''
    AND btrim(${t.evidenceHash}) <> ''
    AND btrim(${t.evidenceNotBefore}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

/*
FNXC:SessionRoomSemanticRouting 2026-07-19-03:18:
The controller-owned semantic/evidence/decision state is versioned separately
from peer messages. A peer can only echo the current state; it cannot create
or advance authority merely by supplying matching-looking hashes.
*/
export const roomSemanticStates = roomSchema.table("room_semantic_states", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  turnId: text("turn_id").notNull(),
  nodeId: text("node_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  state: text("state").notNull(),
  protocolId: text("protocol_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  phaseId: text("phase_id").notNull(),
  semanticHash: text("semantic_hash").notNull(),
  evidenceStateHash: text("evidence_state_hash").notNull(),
  decisionStateHash: text("decision_state_hash").notNull(),
  stateFingerprint: text("state_fingerprint").notNull(),
  createdAt: text("created_at").notNull(),
  supersededAt: text("superseded_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_semantic_states_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.nodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_semantic_states_node_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({ columns: [t.turnId, t.roomId, t.projectId], foreignColumns: [roomTurns.id, roomTurns.roomId, roomTurns.projectId], name: "room_semantic_states_turn_fkey" }).onDelete("cascade"),
  unique("room_semantic_states_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  unique("room_semantic_states_turn_node_revision_unique").on(t.turnId, t.nodeId, t.revision),
  uniqueIndex("room_semantic_states_active_turn_node_unique")
    .on(t.projectId, t.roomId, t.turnId, t.nodeId)
    .where(sql`${t.state} = 'active'`),
  index("idx_room_semantic_states_project_room_turn_node")
    .on(t.projectId, t.roomId, t.turnId, t.nodeId, t.state, t.revision),
  check("room_semantic_states_state_check", sql`${t.state} IN ('active','superseded')`),
  check("room_semantic_states_revision_check", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  check("room_semantic_states_protocol_version_check", sql`${t.protocolVersion} BETWEEN 1 AND 2147483647`),
  check("room_semantic_states_nonblank_check", sql`
    btrim(${t.protocolId}) <> ''
    AND btrim(${t.phaseId}) <> ''
    AND btrim(${t.semanticHash}) <> ''
    AND btrim(${t.evidenceStateHash}) <> ''
    AND btrim(${t.decisionStateHash}) <> ''
    AND btrim(${t.stateFingerprint}) <> ''
  `),
  check("room_semantic_states_state_time_check", sql`(
    ${t.state} = 'active' AND ${t.supersededAt} IS NULL
  ) OR (
    ${t.state} = 'superseded' AND ${t.supersededAt} IS NOT NULL
  )`),
]);

export const roomTaskEdges = roomSchema.table("room_task_edges", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  fromNodeId: text("from_node_id").notNull(),
  toNodeId: text("to_node_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: text("created_at").notNull(),
  retiredAt: text("retired_at"),
  retiredByOperationId: text("retired_by_operation_id"),
  createdByOperationId: text("created_by_operation_id"),
  derivedFromEdgeIds: jsonb("derived_from_edge_ids").notNull().default([]),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_task_edges_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.fromNodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_task_edges_from_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.toNodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_task_edges_to_room_project_fkey",
  }).onDelete("cascade"),
  uniqueIndex("room_task_edges_active_shape_unique")
    .on(t.projectId, t.roomId, t.fromNodeId, t.toNodeId, t.kind)
    .where(sql`${t.retiredAt} IS NULL`),
  index("idx_room_task_edges_to").on(t.projectId, t.roomId, t.toNodeId),
  check("room_task_edges_kind_check", sql`${t.kind} IN ('requires','informs','invalidates')`),
  check("room_task_edges_self_check", sql`${t.fromNodeId} <> ${t.toNodeId}`),
  check("room_task_edges_retirement_check", sql`
    (
      (${t.retiredAt} IS NULL AND ${t.retiredByOperationId} IS NULL)
      OR (
        ${t.retiredAt} IS NOT NULL
        AND CASE
          WHEN ${t.retiredAt} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$'
          THEN to_char(${t.retiredAt}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${t.retiredAt}
          ELSE false
        END
        AND ${t.retiredByOperationId} IS NOT NULL
        AND btrim(${t.retiredByOperationId}) <> ''
      )
    ) IS TRUE
  `),
  check("room_task_edges_derived_lineage_check", sql`
    (
      CASE WHEN jsonb_typeof(${t.derivedFromEdgeIds}) = 'array'
        THEN NOT jsonb_path_exists(${t.derivedFromEdgeIds}, '$[*] ? (@.type() != "string" || @ like_regex "^\\\\s*$")')
          AND project.room_jsonb_text_array_is_unique(${t.derivedFromEdgeIds})
          AND (
            (${t.createdByOperationId} IS NULL AND ${t.derivedFromEdgeIds} = '[]'::jsonb)
            OR (
              ${t.createdByOperationId} IS NOT NULL
              AND btrim(${t.createdByOperationId}) <> ''
              AND jsonb_array_length(${t.derivedFromEdgeIds}) > 0
            )
          )
        ELSE false
      END
    ) IS TRUE
  `),
]);

export const roomMessages = roomSchema.table("room_messages", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  turnId: text("turn_id"),
  nodeId: text("node_id"),
  originType: text("origin_type").notNull(),
  originId: text("origin_id").notNull(),
  intent: text("intent").notNull(),
  target: jsonb("target").notNull(),
  targetSeatIds: jsonb("target_seat_ids").notNull().default([]),
  authority: jsonb("authority").notNull(),
  idempotencyKey: text("idempotency_key"),
  expectedAggregateVersion: bigint("expected_aggregate_version", { mode: "number" }),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  evidenceRefs: jsonb("evidence_refs").notNull().default([]),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_messages_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_messages_id_room_project_unique").on(t.id, t.roomId, t.projectId),
  index("idx_room_messages_room_time").on(t.projectId, t.roomId, t.createdAt, t.id),
  index("idx_room_messages_turn").on(t.turnId),
  check("room_messages_target_seat_ids_check", sql`jsonb_typeof(${t.targetSeatIds}) = 'array'`),
  check("room_messages_expected_aggregate_version_check", sql`${t.expectedAggregateVersion} IS NULL OR ${t.expectedAggregateVersion} BETWEEN 0 AND 9007199254740991`),
]);

/*
FNXC:SessionRoomSemanticRouting 2026-07-19-03:18:
room_messages remains the transport-neutral body and delivery ledger. This
companion keeps the complete typed protocol envelope plus resolved response
obligations so replay and a restarted controller do not infer semantics from
untyped chat content.
*/
export const roomProtocolMessages = roomSchema.table("room_protocol_messages", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  protocolMessageId: text("protocol_message_id").notNull(),
  turnId: text("turn_id").notNull(),
  nodeId: text("node_id").notNull(),
  protocolId: text("protocol_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  phaseId: text("phase_id").notNull(),
  channelId: text("channel_id").notNull(),
  issuedAt: text("issued_at").notNull(),
  originSeatId: text("origin_seat_id").notNull(),
  originBindingId: text("origin_binding_id").notNull(),
  originRoleId: text("origin_role_id").notNull(),
  semanticHash: text("semantic_hash").notNull(),
  evidenceStateHash: text("evidence_state_hash").notNull(),
  decisionStateHash: text("decision_state_hash").notNull(),
  semanticStateId: text("semantic_state_id").notNull(),
  semanticStateRevision: bigint("semantic_state_revision", { mode: "number" }).notNull(),
  semanticStateFingerprint: text("semantic_state_fingerprint").notNull(),
  semanticLoopFingerprint: text("semantic_loop_fingerprint").notNull(),
  protocolTarget: jsonb("protocol_target").notNull(),
  referenceBundle: jsonb("reference_bundle").notNull(),
  routeOutcome: text("route_outcome").notNull(),
  recipientController: boolean("recipient_controller").notNull(),
  recipientSeatIds: jsonb("recipient_seat_ids").notNull().default([]),
  requiredControllerResponse: boolean("required_controller_response").notNull(),
  requiredResponderSeatIds: jsonb("required_responder_seat_ids").notNull().default([]),
  audit: jsonb("audit").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.id, t.roomId, t.projectId],
    foreignColumns: [roomMessages.id, roomMessages.roomId, roomMessages.projectId],
    name: "room_protocol_messages_message_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.semanticStateId, t.roomId, t.projectId],
    foreignColumns: [roomSemanticStates.id, roomSemanticStates.roomId, roomSemanticStates.projectId],
    name: "room_protocol_messages_semantic_state_room_project_fkey",
  }).onDelete("restrict"),
  unique("room_protocol_messages_room_protocol_message_unique")
    .on(t.projectId, t.roomId, t.protocolMessageId),
  index("idx_room_protocol_messages_turn_node_time")
    .on(t.projectId, t.roomId, t.turnId, t.nodeId, t.createdAt, t.id),
  check("room_protocol_messages_protocol_version_check", sql`${t.protocolVersion} BETWEEN 1 AND 2147483647`),
  check("room_protocol_messages_semantic_state_revision_check", sql`${t.semanticStateRevision} BETWEEN 1 AND 9007199254740991`),
  check("room_protocol_messages_semantic_loop_fingerprint_check", sql`btrim(${t.semanticLoopFingerprint}) <> ''`),
  check("room_protocol_messages_route_outcome_check", sql`${t.routeOutcome} IN ('route','loop_break')`),
  check("room_protocol_messages_json_shape_check", sql`
    jsonb_typeof(${t.protocolTarget}) = 'object'
    AND jsonb_typeof(${t.referenceBundle}) = 'object'
    AND jsonb_typeof(${t.recipientSeatIds}) = 'array'
    AND jsonb_typeof(${t.requiredResponderSeatIds}) = 'array'
    AND jsonb_typeof(${t.audit}) = 'object'
  `),
]);

/*
FNXC:SessionRoomSemanticRouting 2026-07-19-03:18:
One unchanged semantic state may escalate to the controller once. The unique
fingerprint prevents a failed participant from converting a blocked loop into
an unbounded stream of duplicated help requests after retries or restarts.
*/
export const roomSemanticLoopBreaks = roomSchema.table("room_semantic_loop_breaks", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  turnId: text("turn_id").notNull(),
  nodeId: text("node_id").notNull(),
  semanticStateFingerprint: text("semantic_state_fingerprint").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  escalationMessageId: text("escalation_message_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_semantic_loop_breaks_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceMessageId, t.roomId, t.projectId], foreignColumns: [roomMessages.id, roomMessages.roomId, roomMessages.projectId], name: "room_semantic_loop_breaks_source_message_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.escalationMessageId, t.roomId, t.projectId], foreignColumns: [roomMessages.id, roomMessages.roomId, roomMessages.projectId], name: "room_semantic_loop_breaks_escalation_message_fkey" }).onDelete("cascade"),
  unique("room_semantic_loop_breaks_state_unique")
    .on(t.projectId, t.roomId, t.turnId, t.nodeId, t.semanticStateFingerprint),
  index("idx_room_semantic_loop_breaks_room_node").on(t.projectId, t.roomId, t.turnId, t.nodeId, t.createdAt),
  check("room_semantic_loop_breaks_nonblank_check", sql`
    btrim(${t.semanticStateFingerprint}) <> ''
    AND btrim(${t.sourceMessageId}) <> ''
    AND btrim(${t.escalationMessageId}) <> ''
  `),
]);

/*
FNXC:SessionRoomSemanticRouting 2026-07-19-03:26:
Controller-directed semantic work is a durable, fenced inbox rather than an
in-process callback. Recovery can reclaim an expired action after a controller
crash without duplicating the originating protocol message or provider send.
*/
export const roomSemanticControllerInbox = roomSchema.table("room_semantic_controller_inbox", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  messageId: text("message_id").notNull(),
  protocolMessageId: text("protocol_message_id"),
  actionKind: text("action_kind").notNull(),
  reasonCode: text("reason_code"),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimToken: text("claim_token"),
  claimExpiresAt: text("claim_expires_at"),
  claimedBy: text("claimed_by"),
  processedAt: text("processed_at"),
  lastErrorCode: text("last_error_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_semantic_controller_inbox_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({ columns: [t.messageId, t.roomId, t.projectId], foreignColumns: [roomMessages.id, roomMessages.roomId, roomMessages.projectId], name: "room_semantic_controller_inbox_message_fkey" }).onDelete("cascade"),
  unique("room_semantic_controller_inbox_message_action_unique")
    .on(t.projectId, t.roomId, t.messageId, t.actionKind),
  index("idx_room_semantic_controller_inbox_claim")
    .on(t.projectId, t.roomId, t.state, t.claimExpiresAt, t.createdAt),
  check("room_semantic_controller_inbox_action_kind_check", sql`${t.actionKind} IN ('semantic_message','semantic_loop_break')`),
  check("room_semantic_controller_inbox_state_check", sql`${t.state} IN ('pending','claimed','processed')`),
  check("room_semantic_controller_inbox_attempt_check", sql`${t.attemptCount} BETWEEN 0 AND 9007199254740991`),
  check("room_semantic_controller_inbox_payload_shape_check", sql`jsonb_typeof(${t.payload}) = 'object'`),
  check("room_semantic_controller_inbox_claim_shape_check", sql`(
    ${t.state} = 'pending'
    AND ${t.claimToken} IS NULL
    AND ${t.claimExpiresAt} IS NULL
    AND ${t.claimedBy} IS NULL
    AND ${t.processedAt} IS NULL
  ) OR (
    ${t.state} = 'claimed'
    AND ${t.claimToken} IS NOT NULL
    AND ${t.claimExpiresAt} IS NOT NULL
    AND ${t.claimedBy} IS NOT NULL
    AND ${t.processedAt} IS NULL
  ) OR (
    ${t.state} = 'processed'
    AND ${t.claimToken} IS NULL
    AND ${t.claimExpiresAt} IS NULL
    AND ${t.claimedBy} IS NULL
    AND ${t.processedAt} IS NOT NULL
  )`),
]);

/*
FNXC:SessionRoomProgressRecovery 2026-07-19-06:14:
Task 5.8 needs one immutable, per-round observation record that freezes the
semantic, evidence, artifact, test, and resolved-dissent inputs used for a
later no-progress decision. This persistence layer deliberately does not
detect no-progress or advance a recovery ladder by itself.
*/
export const roomTaskProgressObservations = roomSchema.table("room_task_progress_observations", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  nodeVersion: bigint("node_version", { mode: "number" }).notNull(),
  turnId: text("turn_id").notNull(),
  phaseId: text("phase_id").notNull(),
  roundId: text("round_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  progressSignature: text("progress_signature").notNull(),
  semanticHash: text("semantic_hash").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  artifactHash: text("artifact_hash").notNull(),
  testHash: text("test_hash").notNull(),
  resolvedDissentHash: text("resolved_dissent_hash").notNull(),
  origin: jsonb("origin").notNull(),
  observedAt: text("observed_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_task_progress_observations_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.nodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_task_progress_observations_node_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.turnId, t.roomId, t.projectId],
    foreignColumns: [roomTurns.id, roomTurns.roomId, roomTurns.projectId],
    name: "room_task_progress_observations_turn_fkey",
  }).onDelete("cascade"),
  unique("room_task_progress_observations_id_lineage_unique")
    .on(t.id, t.nodeId, t.nodeVersion, t.roomId, t.projectId),
  unique("room_task_progress_observations_round_unique")
    .on(t.projectId, t.roomId, t.nodeId, t.nodeVersion, t.turnId, t.phaseId, t.roundId),
  unique("room_task_progress_observations_idempotency_unique")
    .on(t.projectId, t.roomId, t.idempotencyKey),
  index("idx_room_task_progress_observations_node_time")
    .on(t.projectId, t.roomId, t.nodeId, t.nodeVersion, t.turnId, t.phaseId, t.observedAt, t.id),
  check("room_task_progress_observations_node_version_check", sql`${t.nodeVersion} BETWEEN 0 AND 9007199254740991`),
  check("room_task_progress_observations_origin_shape_check", sql`jsonb_typeof(${t.origin}) = 'object'`),
  check("room_task_progress_observations_nonblank_check", sql`
    btrim(${t.nodeId}) <> ''
    AND btrim(${t.turnId}) <> ''
    AND btrim(${t.phaseId}) <> ''
    AND btrim(${t.roundId}) <> ''
    AND btrim(${t.idempotencyKey}) <> ''
    AND btrim(${t.progressSignature}) <> ''
    AND btrim(${t.semanticHash}) <> ''
    AND btrim(${t.evidenceHash}) <> ''
    AND btrim(${t.artifactHash}) <> ''
    AND btrim(${t.testHash}) <> ''
    AND btrim(${t.resolvedDissentHash}) <> ''
    AND btrim(${t.observedAt}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

/*
FNXC:SessionRoomProgressRecovery 2026-07-19-06:14:
Every chosen recovery step retains its exact triggering observation and frozen
action/policy snapshots. A future worker may only claim the queue through a
fence-aware command; this table intentionally supplies no executor, detector,
or policy promotion behavior on its own.
*/
export const roomTaskRecoveryActions = roomSchema.table("room_task_recovery_actions", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  nodeVersion: bigint("node_version", { mode: "number" }).notNull(),
  observationId: text("observation_id").notNull(),
  actionId: text("action_id").notNull(),
  actionSnapshot: jsonb("action_snapshot").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  state: text("state").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimToken: text("claim_token"),
  claimExpiresAt: text("claim_expires_at"),
  claimedByWorkerId: text("claimed_by_worker_id"),
  claimedAt: text("claimed_at"),
  nextEligibleAt: text("next_eligible_at").notNull(),
  resultPayload: jsonb("result_payload"),
  lastErrorCode: text("last_error_code"),
  operatorApprovalId: text("operator_approval_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  processedAt: text("processed_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_task_recovery_actions_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.nodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_task_recovery_actions_node_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.observationId, t.nodeId, t.nodeVersion, t.roomId, t.projectId],
    foreignColumns: [
      roomTaskProgressObservations.id,
      roomTaskProgressObservations.nodeId,
      roomTaskProgressObservations.nodeVersion,
      roomTaskProgressObservations.roomId,
      roomTaskProgressObservations.projectId,
    ],
    name: "room_task_recovery_actions_observation_lineage_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.projectId, t.operatorApprovalId],
    foreignColumns: [approvalRequests.projectId, approvalRequests.id],
    name: "room_task_recovery_actions_operator_approval_fkey",
  }).onDelete("restrict"),
  unique("room_task_recovery_actions_observation_action_unique")
    .on(t.projectId, t.roomId, t.observationId, t.actionId),
  unique("room_task_recovery_actions_identity_room_project_unique")
    .on(t.id, t.roomId, t.projectId),
  index("idx_room_task_recovery_actions_claim")
    .on(t.projectId, t.roomId, t.state, t.nextEligibleAt, t.claimExpiresAt, t.createdAt),
  index("idx_room_task_recovery_actions_node")
    .on(t.projectId, t.roomId, t.nodeId, t.nodeVersion, t.createdAt, t.id),
  index("idx_room_task_recovery_actions_operator_approval")
    .on(t.operatorApprovalId),
  check("room_task_recovery_actions_node_version_check", sql`${t.nodeVersion} BETWEEN 0 AND 9007199254740991`),
  check("room_task_recovery_actions_state_check", sql`${t.state} IN ('pending','claimed','processed')`),
  check("room_task_recovery_actions_attempt_check", sql`${t.attemptCount} BETWEEN 0 AND 9007199254740991`),
  check("room_task_recovery_actions_action_snapshot_shape_check", sql`jsonb_typeof(${t.actionSnapshot}) = 'object'`),
  check("room_task_recovery_actions_policy_snapshot_shape_check", sql`jsonb_typeof(${t.policySnapshot}) = 'object'`),
  check("room_task_recovery_actions_result_shape_check", sql`${t.resultPayload} IS NULL OR jsonb_typeof(${t.resultPayload}) = 'object'`),
  check("room_task_recovery_actions_nonblank_check", sql`
    btrim(${t.nodeId}) <> ''
    AND btrim(${t.observationId}) <> ''
    AND btrim(${t.actionId}) <> ''
    AND btrim(${t.nextEligibleAt}) <> ''
    AND btrim(${t.createdAt}) <> ''
    AND btrim(${t.updatedAt}) <> ''
    AND (${t.lastErrorCode} IS NULL OR btrim(${t.lastErrorCode}) <> '')
    AND (${t.operatorApprovalId} IS NULL OR btrim(${t.operatorApprovalId}) <> '')
  `),
  check("room_task_recovery_actions_claim_shape_check", sql`(
    ${t.state} = 'pending'
    AND ${t.claimToken} IS NULL
    AND ${t.claimExpiresAt} IS NULL
    AND ${t.claimedByWorkerId} IS NULL
    AND ${t.claimedAt} IS NULL
    AND ${t.processedAt} IS NULL
    AND ${t.resultPayload} IS NULL
  ) OR (
    ${t.state} = 'claimed'
    AND ${t.claimToken} IS NOT NULL
    AND btrim(${t.claimToken}) <> ''
    AND ${t.claimExpiresAt} IS NOT NULL
    AND btrim(${t.claimExpiresAt}) <> ''
    AND ${t.claimedByWorkerId} IS NOT NULL
    AND btrim(${t.claimedByWorkerId}) <> ''
    AND ${t.claimedAt} IS NOT NULL
    AND btrim(${t.claimedAt}) <> ''
    AND ${t.processedAt} IS NULL
    AND ${t.resultPayload} IS NULL
  ) OR (
    ${t.state} = 'processed'
    AND ${t.claimToken} IS NULL
    AND ${t.claimExpiresAt} IS NULL
    AND ${t.claimedByWorkerId} IS NULL
    AND ${t.claimedAt} IS NULL
    AND ${t.processedAt} IS NOT NULL
    AND btrim(${t.processedAt}) <> ''
    AND ${t.resultPayload} IS NOT NULL
  )`),
]);

/*
FNXC:SessionRoomRecoveryPlan 2026-07-19:
A no-progress action is not considered executed merely because a worker saw it.
This immutable, project-scoped handoff is the durable controller-plan or
operator-escalation receipt. Its source action remains separately fenced and
is retained verbatim, so a later controller can inspect the exact bounded
recovery directive without re-reading mutable provider state.
*/
export const roomTaskRecoveryPlans = roomSchema.table("room_task_recovery_plans", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  recoveryActionId: text("recovery_action_id").notNull(),
  executionMode: text("execution_mode").notNull(),
  actionSnapshot: jsonb("action_snapshot").notNull(),
  actionSnapshotHash: text("action_snapshot_hash").notNull(),
  resultReceipt: jsonb("result_receipt").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_task_recovery_plans_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.recoveryActionId, t.roomId, t.projectId],
    foreignColumns: [
      roomTaskRecoveryActions.id,
      roomTaskRecoveryActions.roomId,
      roomTaskRecoveryActions.projectId,
    ],
    name: "room_task_recovery_plans_action_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_task_recovery_plans_action_room_project_unique")
    .on(t.recoveryActionId, t.roomId, t.projectId),
  index("idx_room_task_recovery_plans_room_created")
    .on(t.projectId, t.roomId, t.createdAt, t.id),
  check("room_task_recovery_plans_execution_mode_check", sql`${t.executionMode} IN ('controller_plan','operator_approval')`),
  check("room_task_recovery_plans_action_snapshot_shape_check", sql`jsonb_typeof(${t.actionSnapshot}) = 'object'`),
  check("room_task_recovery_plans_result_receipt_shape_check", sql`jsonb_typeof(${t.resultReceipt}) = 'object'`),
  check("room_task_recovery_plans_nonblank_check", sql`
    btrim(${t.recoveryActionId}) <> ''
    AND btrim(${t.actionSnapshotHash}) <> ''
    AND btrim(${t.createdAt}) <> ''
  `),
]);

/*
FNXC:SessionRoomMessageRouting 2026-07-18-11:26:
Routed operator messages must freeze their resolved controller/seat targets and active binding lineage at command commit. The selector remains on room_messages for backward-compatible reads, while these ordered target rows prevent later membership changes from rewriting delivery history.
*/
export const roomMessageTargets = roomSchema.table("room_message_targets", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  messageId: text("message_id").notNull(),
  selectorKind: text("selector_kind").notNull(),
  selectorRef: text("selector_ref"),
  targetKind: text("target_kind").notNull(),
  seatId: text("seat_id"),
  bindingId: text("binding_id"),
  ordinal: integer("ordinal").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.messageId, t.roomId, t.projectId],
    foreignColumns: [roomMessages.id, roomMessages.roomId, roomMessages.projectId],
    name: "room_message_targets_message_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.seatId, t.roomId, t.projectId],
    foreignColumns: [roomSeats.id, roomSeats.roomId, roomSeats.projectId],
    name: "room_message_targets_seat_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.bindingId, t.seatId, t.roomId, t.projectId],
    foreignColumns: [roomBindings.id, roomBindings.seatId, roomBindings.roomId, roomBindings.projectId],
    name: "room_message_targets_binding_seat_room_project_fkey",
  }).onDelete("restrict"),
  unique("room_message_targets_message_ordinal_unique").on(t.messageId, t.ordinal),
  unique("room_message_targets_message_seat_unique").on(t.messageId, t.seatId),
  index("idx_room_message_targets_room_message").on(t.projectId, t.roomId, t.messageId, t.ordinal),
  check("room_message_targets_selector_kind_check", sql`${t.selectorKind} IN ('controller','all','group','seats')`),
  check("room_message_targets_target_kind_check", sql`${t.targetKind} IN ('controller','seat')`),
  check("room_message_targets_ordinal_check", sql`${t.ordinal} >= 0`),
  check("room_message_targets_selector_ref_check", sql`(${t.selectorKind} = 'group' AND ${t.selectorRef} IS NOT NULL AND btrim(${t.selectorRef}) <> '') OR (${t.selectorKind} <> 'group' AND ${t.selectorRef} IS NULL)`),
  check("room_message_targets_shape_check", sql`(${t.selectorKind} = 'controller' AND ${t.targetKind} = 'controller' AND ${t.seatId} IS NULL AND ${t.bindingId} IS NULL AND ${t.ordinal} = 0) OR (${t.selectorKind} IN ('all','group','seats') AND ${t.targetKind} = 'seat' AND ${t.seatId} IS NOT NULL AND ${t.bindingId} IS NOT NULL)`),
]);

export const roomOutbox = roomSchema.table("room_outbox", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  messageId: text("message_id").notNull(),
  bindingId: text("binding_id").notNull(),
  logicalMessageId: text("logical_message_id").notNull(),
  localMessageId: text("local_message_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  deliveryState: text("delivery_state").notNull(),
  nativeAcknowledgement: jsonb("native_acknowledgement"),
  nativeCursor: text("native_cursor"),
  reconciliationFromCursor: text("reconciliation_from_cursor"),
  reconciliationEvidenceRef: text("reconciliation_evidence_ref"),
  /** Present only for the atomic ready-to-running task-dispatch outbox. */
  dispatchTaskNodeId: text("dispatch_task_node_id"),
  dispatchClaimNodeVersion: bigint("dispatch_claim_node_version", { mode: "number" }),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  nextAttemptAt: text("next_attempt_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_outbox_room_project_fkey",
  }).onDelete("cascade"),
  foreignKey({ columns: [t.messageId], foreignColumns: [roomMessages.id], name: "room_outbox_message_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.bindingId], foreignColumns: [roomBindings.id], name: "room_outbox_binding_fkey" }).onDelete("cascade"),
  foreignKey({
    columns: [t.dispatchTaskNodeId, t.roomId, t.projectId],
    foreignColumns: [roomTaskNodes.id, roomTaskNodes.roomId, roomTaskNodes.projectId],
    name: "room_outbox_dispatch_task_node_room_project_fkey",
  }).onDelete("restrict"),
  uniqueIndex("idx_room_outbox_logical_message").on(t.bindingId, t.logicalMessageId),
  uniqueIndex("idx_room_outbox_local_message").on(t.bindingId, t.localMessageId),
  unique("room_outbox_id_project_unique").on(t.projectId, t.id),
  index("idx_room_outbox_dispatch").on(t.projectId, t.deliveryState, t.nextAttemptAt),
  index("idx_room_outbox_dispatch_task").on(t.projectId, t.roomId, t.dispatchTaskNodeId),
  check("room_outbox_delivery_state_check", sql`${t.deliveryState} IN ('pending','dispatching','confirmed','delivery_uncertain','rejected','cancelled')`),
  check("room_outbox_dispatch_task_claim_check", sql`(
    (${t.dispatchTaskNodeId} IS NULL AND ${t.dispatchClaimNodeVersion} IS NULL)
    OR (
      ${t.dispatchTaskNodeId} IS NOT NULL
      AND ${t.dispatchClaimNodeVersion} BETWEEN 1 AND 9007199254740991
    )
  )`),
]);

export const roomOutboxAttempts = roomSchema.table("room_outbox_attempts", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  outboxId: text("outbox_id").notNull(),
  attempt: integer("attempt").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  outcome: text("outcome").notNull(),
  errorCode: text("error_code"),
  evidenceRef: text("evidence_ref"),
}, (t) => [
  foreignKey({ columns: [t.outboxId], foreignColumns: [roomOutbox.id], name: "room_outbox_attempts_outbox_fkey" }).onDelete("cascade"),
  unique("room_outbox_attempts_number_unique").on(t.outboxId, t.attempt),
  index("idx_room_outbox_attempts_room").on(t.projectId, t.roomId, t.startedAt),
]);

export const roomInboxReceipts = roomSchema.table("room_inbox_receipts", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  bindingId: text("binding_id").notNull(),
  nativeMessageId: text("native_message_id"),
  logicalMessageId: text("logical_message_id"),
  nativeCursor: text("native_cursor").notNull(),
  payloadHash: text("payload_hash").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  role: text("role").notNull(),
  occurredAt: text("occurred_at").notNull(),
  source: text("source").notNull(),
  legacyPlaceholder: boolean("legacy_placeholder").notNull().default(false),
  receivedAt: text("received_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.bindingId], foreignColumns: [roomBindings.id], name: "room_inbox_receipts_binding_fkey" }).onDelete("cascade"),
  foreignKey({
    columns: [t.bindingId, t.roomId, t.projectId],
    foreignColumns: [roomBindings.id, roomBindings.roomId, roomBindings.projectId],
    name: "room_inbox_receipts_binding_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_inbox_receipts_binding_cursor_unique").on(t.bindingId, t.nativeCursor),
  unique("room_inbox_receipts_binding_dedupe_unique").on(t.bindingId, t.dedupeKey),
  uniqueIndex("idx_room_inbox_receipts_binding_logical_message")
    .on(t.bindingId, t.logicalMessageId)
    .where(sql`${t.logicalMessageId} IS NOT NULL`),
  index("idx_room_inbox_receipts_native_message").on(t.bindingId, t.nativeMessageId),
  index("idx_room_inbox_receipts_room_time").on(t.projectId, t.roomId, t.receivedAt),
  check("room_inbox_receipts_role_check", sql`${t.role} IN ('user','assistant','tool','system','unknown')`),
  check("room_inbox_receipts_source_check", sql`${t.source} IN ('event','history')`),
]);

export const roomIdempotencyKeys = roomSchema.table("room_idempotency_keys", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandType: text("command_type").notNull(),
  commandHash: text("command_hash").notNull(),
  resultEventId: text("result_event_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_idempotency_keys_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_idempotency_keys_room_key_unique").on(t.roomId, t.idempotencyKey),
  index("idx_room_idempotency_keys_expiry").on(t.projectId, t.expiresAt),
]);

export const roomLeases = roomSchema.table("room_leases", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
  holderId: text("holder_id").notNull(),
  hostId: text("host_id").notNull(),
  epoch: bigint("epoch", { mode: "number" }).notNull(),
  acquiredAt: text("acquired_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  releasedAt: text("released_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_leases_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_leases_resource_epoch_unique").on(t.projectId, t.kind, t.resourceId, t.epoch),
  uniqueIndex("idx_room_leases_active_resource").on(t.projectId, t.kind, t.resourceId).where(sql`${t.releasedAt} IS NULL`),
  index("idx_room_leases_expiry").on(t.projectId, t.expiresAt),
  check("room_leases_kind_check", sql`${t.kind} IN ('room_worker','sender','workspace','human_takeover')`),
]);

export const roomCheckpoints = roomSchema.table("room_checkpoints", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  turnId: text("turn_id"),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
  eventId: text("event_id").notNull(),
  eventCursor: bigint("event_cursor", { mode: "number" }).notNull(),
  projectionHash: text("projection_hash").notNull(),
  projection: jsonb("projection").notNull(),
  protocolState: jsonb("protocol_state").notNull().default({}),
  dagVersion: bigint("dag_version", { mode: "number" }).notNull().default(0),
  bindingCursors: jsonb("binding_cursors").notNull().default({}),
  pendingOutboxIds: jsonb("pending_outbox_ids").notNull().default([]),
  artifactRefs: jsonb("artifact_refs").notNull().default([]),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_checkpoints_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_checkpoints_room_version_unique").on(t.roomId, t.aggregateVersion),
  index("idx_room_checkpoints_latest").on(t.projectId, t.roomId, t.aggregateVersion),
]);

export const roomArtifacts = roomSchema.table("room_artifacts", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id"),
  kind: text("kind").notNull(),
  mediaType: text("media_type").notNull(),
  uri: text("uri").notNull(),
  contentHash: text("content_hash").notNull(),
  producingBindingId: text("producing_binding_id"),
  sourceRevision: text("source_revision"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_artifacts_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_artifacts_node").on(t.projectId, t.roomId, t.nodeId),
  index("idx_room_artifacts_candidate").on(t.candidateId),
]);

export const roomEvidence = roomSchema.table("room_evidence", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id"),
  kind: text("kind").notNull(),
  authoritativeSourceUri: text("authoritative_source_uri").notNull(),
  sourceVersionOrHash: text("source_version_or_hash").notNull(),
  capturedAt: text("captured_at").notNull(),
  collectionMethod: text("collection_method").notNull(),
  collectorBindingId: text("collector_binding_id"),
  contentHash: text("content_hash").notNull(),
  artifactIds: jsonb("artifact_ids").notNull().default([]),
  expiresAt: text("expires_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_evidence_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_evidence_candidate").on(t.projectId, t.roomId, t.candidateId),
  index("idx_room_evidence_expiry").on(t.expiresAt),
]);

export const roomCandidates = roomSchema.table("room_candidates", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  producingBindingId: text("producing_binding_id").notNull(),
  nativeSessionId: text("native_session_id").notNull(),
  happierSessionId: text("happier_session_id").notNull(),
  providerId: text("provider_id").notNull(),
  modelRef: text("model_ref").notNull(),
  protocolId: text("protocol_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  contextVersion: text("context_version").notNull(),
  inputVersion: text("input_version").notNull(),
  configVersion: text("config_version").notNull(),
  contentHash: text("content_hash").notNull(),
  artifactIds: jsonb("artifact_ids").notNull().default([]),
  parentCandidateIds: jsonb("parent_candidate_ids").notNull().default([]),
  gateResultIds: jsonb("gate_result_ids").notNull().default([]),
  reviewIds: jsonb("review_ids").notNull().default([]),
  promotionState: text("promotion_state").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_candidates_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_candidates_node_state").on(t.projectId, t.roomId, t.nodeId, t.promotionState),
  check("room_candidates_promotion_state_check", sql`${t.promotionState} IN ('pending','eligible','promoted','rejected','superseded')`),
]);

export const roomReviews = roomSchema.table("room_reviews", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  blindCandidateRef: text("blind_candidate_ref").notNull(),
  reviewerBindingId: text("reviewer_binding_id").notNull(),
  reviewerNativeSessionId: text("reviewer_native_session_id").notNull(),
  reviewerHappierSessionId: text("reviewer_happier_session_id").notNull(),
  blind: integer("blind").notNull(),
  producerIdentityHidden: integer("producer_identity_hidden").notNull(),
  independentFromProducer: integer("independent_from_producer").notNull(),
  verdict: text("verdict").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  dissentIds: jsonb("dissent_ids").notNull().default([]),
  reviewContentHash: text("review_content_hash").notNull(),
  committedAt: text("committed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_reviews_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_reviews_candidate").on(t.projectId, t.roomId, t.candidateId),
]);

export const roomDissents = roomSchema.table("room_dissents", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  reviewId: text("review_id"),
  severity: text("severity").notNull(),
  state: text("state").notNull(),
  ownerId: text("owner_id").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  contentHash: text("content_hash").notNull(),
  resolution: jsonb("resolution"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_dissents_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_dissents_candidate_state").on(t.projectId, t.roomId, t.candidateId, t.state, t.severity),
]);

export const roomGateResults = roomSchema.table("room_gate_results", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  profileId: text("profile_id").notNull(),
  kind: text("kind").notNull(),
  hard: integer("hard").notNull(),
  status: text("status").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  evaluatorBindingId: text("evaluator_binding_id"),
  command: text("command"),
  exitCode: integer("exit_code"),
  recordedAt: text("recorded_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_gate_results_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_gate_results_candidate").on(t.projectId, t.roomId, t.candidateId, t.hard, t.status),
]);

export const roomPromotions = roomSchema.table("room_promotions", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  decision: text("decision").notNull(),
  decisionActorType: text("decision_actor_type").notNull(),
  decisionActorId: text("decision_actor_id").notNull(),
  hardGateResultIds: jsonb("hard_gate_result_ids").notNull().default([]),
  reviewIds: jsonb("review_ids").notNull().default([]),
  unresolvedDissentIds: jsonb("unresolved_dissent_ids").notNull().default([]),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  rationale: text("rationale").notNull(),
  decidedAt: text("decided_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_promotions_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_promotions_candidate").on(t.projectId, t.roomId, t.candidateId, t.decidedAt),
]);

export const roomConfidenceSnapshots = roomSchema.table("room_confidence_snapshots", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  nodeId: text("node_id").notNull(),
  candidateId: text("candidate_id"),
  band: text("band").notNull(),
  methodologyVersion: text("methodology_version").notNull(),
  inputEvidenceHash: text("input_evidence_hash").notNull(),
  dimensions: jsonb("dimensions").notNull(),
  staleEvidenceIds: jsonb("stale_evidence_ids").notNull().default([]),
  unresolvedDissentIds: jsonb("unresolved_dissent_ids").notNull().default([]),
  modelSelfReportExcluded: integer("model_self_report_excluded").notNull(),
  computedAt: text("computed_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_confidence_snapshots_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_confidence_snapshots_latest").on(t.projectId, t.roomId, t.nodeId, t.computedAt),
  check("room_confidence_snapshots_band_check", sql`${t.band} IN ('high','medium','low','unknown')`),
]);

export const roomAlerts = roomSchema.table("room_alerts", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  severity: text("severity").notNull(),
  state: text("state").notNull(),
  deduplicationKey: text("deduplication_key").notNull(),
  rootCause: text("root_cause").notNull(),
  impact: text("impact").notNull(),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  attemptedRecovery: jsonb("attempted_recovery").notNull().default([]),
  nextRetryAt: text("next_retry_at"),
  actions: jsonb("actions").notNull().default([]),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_alerts_room_project_fkey",
  }).onDelete("cascade"),
  uniqueIndex("idx_room_alerts_open_dedupe").on(t.projectId, t.roomId, t.deduplicationKey).where(sql`${t.resolvedAt} IS NULL`),
  index("idx_room_alerts_project_state").on(t.projectId, t.state, t.severity, t.openedAt),
]);

export const roomGlobalConcurrencyState = roomSchema.table("room_global_concurrency_state", {
  id: text("id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("room_global_concurrency_state_id_check", sql`${t.id} = 'room-global-concurrency-v1'`),
  check("room_global_concurrency_state_revision_check", sql`${t.revision} BETWEEN 0 AND 9007199254740991`),
  check("room_global_concurrency_state_updated_at_check", sql`btrim(${t.updatedAt}) <> ''`),
]);

export const roomGlobalConcurrencyClaims = roomSchema.table("room_global_concurrency_claims", {
  id: text("id").primaryKey(),
  ...scopedRoomColumns(),
  workClass: text("work_class").notNull(),
  slots: integer("slots").notNull(),
  holderId: text("holder_id").notNull(),
  leaseId: text("lease_id").notNull(),
  fence: bigint("fence", { mode: "number" }).notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  releasedAt: text("released_at"),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_global_concurrency_claims_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_global_concurrency_claims_id_project_unique").on(t.id, t.projectId),
  index("idx_room_global_concurrency_claims_active")
    .on(t.projectId, t.workClass, t.expiresAt, t.id)
    .where(sql`${t.releasedAt} IS NULL`),
  index("idx_room_global_concurrency_claims_expiry")
    .on(t.expiresAt, t.id)
    .where(sql`${t.releasedAt} IS NULL`),
  check("room_global_concurrency_claims_work_class_check", sql`${t.workClass} IN ('normal','verifier','recovery')`),
  check("room_global_concurrency_claims_slots_check", sql`${t.slots} BETWEEN 1 AND 2147483647`),
  check("room_global_concurrency_claims_fence_check", sql`${t.fence} BETWEEN 1 AND 9007199254740991`),
  check("room_global_concurrency_claims_window_check", sql`${t.expiresAt} > ${t.acquiredAt}`),
  check("room_global_concurrency_claims_nonblank_check", sql`
    btrim(${t.id}) <> ''
    AND btrim(${t.projectId}) <> ''
    AND btrim(${t.roomId}) <> ''
    AND btrim(${t.holderId}) <> ''
    AND btrim(${t.leaseId}) <> ''
    AND btrim(${t.acquiredAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND (${t.releasedAt} IS NULL OR btrim(${t.releasedAt}) <> '')
  `),
]);

export const roomGlobalConcurrencyOperations = roomSchema.table("room_global_concurrency_operations", {
  projectId: text("project_id").notNull(),
  commandKind: text("command_kind").notNull(),
  operationKey: text("operation_key").notNull(),
  claimId: text("claim_id").notNull(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  fence: bigint("fence", { mode: "number" }).notNull(),
  occurredAt: text("occurred_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.commandKind, t.operationKey], name: "room_global_concurrency_operations_primary" }),
  foreignKey({
    columns: [t.claimId, t.projectId],
    foreignColumns: [roomGlobalConcurrencyClaims.id, roomGlobalConcurrencyClaims.projectId],
    name: "room_global_concurrency_operations_claim_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_global_concurrency_operations_claim").on(t.projectId, t.claimId, t.commandKind, t.occurredAt),
  check("room_global_concurrency_operations_kind_check", sql`${t.commandKind} IN ('acquire','release','recover_dangling')`),
  check("room_global_concurrency_operations_action_check", sql`${t.action} IN ('acquired','released','recovered')`),
  check("room_global_concurrency_operations_fence_check", sql`${t.fence} BETWEEN 1 AND 9007199254740991`),
  check("room_global_concurrency_operations_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_global_concurrency_operations_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.operationKey}) <> ''
    AND btrim(${t.claimId}) <> ''
    AND btrim(${t.occurredAt}) <> ''
  `),
]);

export const roomProviderBackpressureStates = roomSchema.table("room_provider_backpressure_states", {
  projectId: text("project_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id").notNull(),
  modelId: text("model_id").notNull(),
  connectorId: text("connector_id").notNull(),
  nodeId: text("node_id").notNull(),
  circuitState: text("circuit_state").notNull(),
  consecutiveFailures: bigint("consecutive_failures", { mode: "number" }).notNull().default(0),
  retryAttempt: bigint("retry_attempt", { mode: "number" }).notNull().default(0),
  retryNotBefore: text("retry_not_before"),
  openUntil: text("open_until"),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  lastUpdatedAt: text("last_updated_at").notNull(),
}, (t) => [
  primaryKey({
    columns: [t.projectId, t.scopeKey],
    name: "room_provider_backpressure_states_primary",
  }),
  unique("room_provider_backpressure_states_scope_unique")
    .on(t.projectId, t.providerId, t.accountId, t.modelId, t.connectorId, t.nodeId),
  index("idx_room_provider_backpressure_states_provider")
    .on(t.projectId, t.providerId, t.accountId, t.modelId, t.connectorId, t.nodeId),
  check("room_provider_backpressure_states_circuit_check", sql`${t.circuitState} IN ('closed','open','half_open')`),
  check("room_provider_backpressure_states_failure_check", sql`${t.consecutiveFailures} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_states_retry_check", sql`${t.retryAttempt} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_states_revision_check", sql`${t.revision} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_states_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.scopeKey}) <> ''
    AND btrim(${t.providerId}) <> ''
    AND btrim(${t.accountId}) <> ''
    AND btrim(${t.modelId}) <> ''
    AND btrim(${t.connectorId}) <> ''
    AND btrim(${t.nodeId}) <> ''
    AND btrim(${t.lastUpdatedAt}) <> ''
    AND (${t.retryNotBefore} IS NULL OR btrim(${t.retryNotBefore}) <> '')
    AND (${t.openUntil} IS NULL OR btrim(${t.openUntil}) <> '')
  `),
]);

export const roomProviderBackpressureReservations = roomSchema.table("room_provider_backpressure_reservations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  roomId: text("room_id").notNull(),
  requestId: text("request_id").notNull(),
  claimId: text("claim_id").notNull(),
  leaseId: text("lease_id").notNull(),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
  expectedAggregateVersion: bigint("expected_aggregate_version", { mode: "number" }).notNull(),
  workClass: text("work_class").notNull(),
  isHalfOpenProbe: boolean("is_half_open_probe").notNull().default(false),
  circuitOpenMs: integer("circuit_open_ms").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  releasedAt: text("released_at"),
  releaseOutcome: text("release_outcome"),
}, (t) => [
  foreignKey({
    columns: [t.projectId, t.scopeKey],
    foreignColumns: [roomProviderBackpressureStates.projectId, roomProviderBackpressureStates.scopeKey],
    name: "room_provider_backpressure_reservations_state_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_provider_backpressure_reservations_room_project_fkey",
  }).onDelete("cascade"),
  unique("room_provider_backpressure_reservations_id_project_unique").on(t.id, t.projectId),
  unique("room_provider_backpressure_reservations_request_unique").on(t.projectId, t.requestId),
  index("idx_room_provider_backpressure_reservations_active")
    .on(t.projectId, t.scopeKey, t.expiresAt, t.id)
    .where(sql`${t.releasedAt} IS NULL`),
  index("idx_room_provider_backpressure_reservations_room")
    .on(t.projectId, t.roomId, t.leaseId, t.leaseEpoch, t.id),
  check("room_provider_backpressure_reservations_work_class_check", sql`${t.workClass} IN ('normal','verifier','recovery')`),
  check("room_provider_backpressure_reservations_epoch_check", sql`${t.leaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_backpressure_reservations_version_check", sql`${t.expectedAggregateVersion} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_reservations_circuit_open_ms_check", sql`${t.circuitOpenMs} BETWEEN 1 AND 2147483647`),
  check("room_provider_backpressure_reservations_window_check", sql`${t.expiresAt} > ${t.acquiredAt}`),
  check("room_provider_backpressure_reservations_release_outcome_check", sql`${t.releaseOutcome} IS NULL OR ${t.releaseOutcome} IN ('worker_completed','worker_failed','controller_stop','room_not_runnable','lease_lost','recovery_withheld','semantic_inbox_stopped','renew_guard_lost','provider_backpressure','pre_start_authority_lost','start_audit_failed','unknown','expired')`),
  check("room_provider_backpressure_reservations_nonblank_check", sql`
    btrim(${t.id}) <> ''
    AND btrim(${t.projectId}) <> ''
    AND btrim(${t.scopeKey}) <> ''
    AND btrim(${t.roomId}) <> ''
    AND btrim(${t.requestId}) <> ''
    AND btrim(${t.claimId}) <> ''
    AND btrim(${t.leaseId}) <> ''
    AND btrim(${t.acquiredAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND (${t.releasedAt} IS NULL OR btrim(${t.releasedAt}) <> '')
  `),
]);

/**
 * FNXC:RoomProviderCleanupLedger 2026-07-20-00:18:
 * A provider reservation that was admitted after its caller timed out cannot be
 * released by a replacement Room worker. Keep an immutable, room-scoped cleanup
 * action until the original reservation expires; the cleanup worker may only
 * record that expiry, never forge the original provider-release fence.
 */
export const roomProviderBackpressureCleanupActions = roomSchema.table("room_provider_backpressure_cleanup_actions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  roomId: text("room_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  outboxId: text("outbox_id"),
  outboxBindingId: text("outbox_binding_id"),
  outboxAttemptId: text("outbox_attempt_id"),
  outboxAttemptCount: integer("outbox_attempt_count"),
  reservationId: text("reservation_id").notNull(),
  requestId: text("request_id").notNull(),
  claimId: text("claim_id").notNull(),
  originalLeaseId: text("original_lease_id").notNull(),
  originalLeaseHolderId: text("original_lease_holder_id").notNull(),
  originalLeaseHostId: text("original_lease_host_id").notNull(),
  originalLeaseEpoch: bigint("original_lease_epoch", { mode: "number" }).notNull(),
  expectedAggregateVersion: bigint("expected_aggregate_version", { mode: "number" }).notNull(),
  reservationExpiresAt: text("reservation_expires_at").notNull(),
  completionKind: text("completion_kind").notNull(),
  state: text("state").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimToken: text("claim_token"),
  claimLeaseId: text("claim_lease_id"),
  claimLeaseEpoch: bigint("claim_lease_epoch", { mode: "number" }),
  claimedAt: text("claimed_at"),
  claimExpiresAt: text("claim_expires_at"),
  lastErrorCode: text("last_error_code"),
  completedAt: text("completed_at"),
  outboxUnblockedAt: text("outbox_unblocked_at"),
  outboxFinalizedAt: text("outbox_finalized_at"),
  outboxFinalizationOutcome: text("outbox_finalization_outcome"),
  outboxFinalizationReason: text("outbox_finalization_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_provider_backpressure_cleanup_actions_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.reservationId, t.projectId],
    foreignColumns: [roomProviderBackpressureReservations.id, roomProviderBackpressureReservations.projectId],
    name: "room_provider_backpressure_cleanup_actions_reservation_project_fkey",
  }).onDelete("restrict"),
  unique("room_provider_backpressure_cleanup_actions_id_project_unique").on(t.id, t.projectId),
  unique("room_provider_backpressure_cleanup_actions_idempotency_unique").on(t.projectId, t.roomId, t.idempotencyKey),
  unique("room_provider_backpressure_cleanup_actions_reservation_kind_unique").on(t.projectId, t.reservationId, t.completionKind),
  index("idx_room_provider_backpressure_cleanup_actions_claimable")
    .on(t.projectId, t.roomId, t.state, t.reservationExpiresAt, t.claimExpiresAt, t.createdAt),
  check("room_provider_backpressure_cleanup_actions_completion_kind_check", sql`${t.completionKind} IN ('pre_send_not_started','pre_claim_not_started','late_admission_not_started')`),
  /*
  FNXC:RoomProviderPreClaimTargetShape 2026-07-20-22:48:
  The durable ledger must distinguish an exact claimed attempt from an exact
  pending generation. Pre-claim evidence has no attempt row, while targetless
  evidence preserves only the historical inert outbox-id form without binding
  or attempt identity for pre-send/late-admission cleanup records.
  */
  check("room_provider_backpressure_cleanup_actions_target_shape_check", sql`
    (
      ${t.completionKind} = 'pre_claim_not_started'
      AND ${t.outboxId} IS NOT NULL
      AND ${t.outboxBindingId} IS NOT NULL
      AND ${t.outboxAttemptId} IS NULL
      AND ${t.outboxAttemptCount} BETWEEN 0 AND 2147483647
    )
    OR (
      ${t.completionKind} = 'pre_send_not_started'
      AND (
        (
          ${t.outboxBindingId} IS NULL
          AND ${t.outboxAttemptId} IS NULL
          AND ${t.outboxAttemptCount} IS NULL
        )
        OR (
          ${t.outboxId} IS NOT NULL
          AND ${t.outboxBindingId} IS NOT NULL
          AND ${t.outboxAttemptId} IS NOT NULL
          AND ${t.outboxAttemptCount} BETWEEN 1 AND 2147483647
        )
      )
    )
    OR (
      ${t.completionKind} = 'late_admission_not_started'
      AND ${t.outboxBindingId} IS NULL
      AND ${t.outboxAttemptId} IS NULL
      AND ${t.outboxAttemptCount} IS NULL
    )
  `),
  check("room_provider_backpressure_cleanup_actions_state_check", sql`${t.state} IN ('pending','claimed','expired','released')`),
  check("room_provider_backpressure_cleanup_actions_attempt_count_check", sql`${t.attemptCount} BETWEEN 0 AND 2147483647`),
  check("room_provider_backpressure_cleanup_actions_original_epoch_check", sql`${t.originalLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_backpressure_cleanup_actions_claim_epoch_check", sql`${t.claimLeaseEpoch} IS NULL OR ${t.claimLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_backpressure_cleanup_actions_version_check", sql`${t.expectedAggregateVersion} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_cleanup_actions_state_shape_check", sql`
    (${t.state} = 'pending'
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.lastErrorCode} IS NULL AND ${t.completedAt} IS NULL)
    OR (${t.state} = 'claimed'
      AND ${t.claimToken} IS NOT NULL AND ${t.claimLeaseId} IS NOT NULL AND ${t.claimLeaseEpoch} IS NOT NULL
      AND ${t.claimedAt} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL
      AND ${t.lastErrorCode} IS NULL AND ${t.completedAt} IS NULL)
    OR (${t.state} = 'expired'
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.lastErrorCode} = 'reservation_expired_unreleased' AND ${t.completedAt} IS NOT NULL)
    OR (${t.state} = 'released'
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.lastErrorCode} IS NULL AND ${t.completedAt} IS NOT NULL)
  `),
  check("room_provider_backpressure_cleanup_actions_outbox_finalization_shape_check", sql`
    (${t.outboxFinalizedAt} IS NULL
      AND ${t.outboxFinalizationOutcome} IS NULL
      AND ${t.outboxFinalizationReason} IS NULL
      AND ${t.outboxUnblockedAt} IS NULL)
    OR (${t.outboxFinalizedAt} IS NOT NULL
      AND ${t.outboxFinalizationOutcome} = 'unblocked'
      AND ${t.outboxFinalizationReason} IS NULL
      AND ${t.outboxUnblockedAt} = ${t.outboxFinalizedAt})
    OR (${t.outboxFinalizedAt} IS NOT NULL
      AND ${t.outboxFinalizationOutcome} = 'withheld'
      AND ${t.outboxFinalizationReason} IS NOT NULL
      AND ${t.outboxUnblockedAt} IS NULL)
  `),
  check("room_provider_backpressure_cleanup_actions_time_check", sql`
    ${t.reservationExpiresAt} > ${t.createdAt}
    AND (${t.claimExpiresAt} IS NULL OR ${t.claimedAt} IS NULL OR ${t.claimExpiresAt} > ${t.claimedAt})
    AND (${t.completedAt} IS NULL OR ${t.completedAt} >= ${t.createdAt})
  `),
  check("room_provider_backpressure_cleanup_actions_nonblank_check", sql`
    btrim(${t.id}) <> '' AND btrim(${t.projectId}) <> '' AND btrim(${t.roomId}) <> ''
    AND btrim(${t.idempotencyKey}) <> '' AND btrim(${t.reservationId}) <> ''
    AND btrim(${t.requestId}) <> '' AND btrim(${t.claimId}) <> ''
    AND btrim(${t.originalLeaseId}) <> '' AND btrim(${t.originalLeaseHolderId}) <> ''
    AND btrim(${t.originalLeaseHostId}) <> '' AND btrim(${t.reservationExpiresAt}) <> ''
    AND btrim(${t.completionKind}) <> '' AND btrim(${t.state}) <> ''
    AND btrim(${t.createdAt}) <> '' AND btrim(${t.updatedAt}) <> ''
    AND (${t.outboxId} IS NULL OR btrim(${t.outboxId}) <> '')
    AND (${t.outboxBindingId} IS NULL OR btrim(${t.outboxBindingId}) <> '')
    AND (${t.outboxAttemptId} IS NULL OR btrim(${t.outboxAttemptId}) <> '')
    AND (${t.outboxAttemptCount} IS NULL OR ${t.outboxAttemptCount} BETWEEN 0 AND 2147483647)
    AND (${t.claimToken} IS NULL OR btrim(${t.claimToken}) <> '')
    AND (${t.claimLeaseId} IS NULL OR btrim(${t.claimLeaseId}) <> '')
    AND (${t.claimedAt} IS NULL OR btrim(${t.claimedAt}) <> '')
    AND (${t.claimExpiresAt} IS NULL OR btrim(${t.claimExpiresAt}) <> '')
    AND (${t.lastErrorCode} IS NULL OR btrim(${t.lastErrorCode}) <> '')
    AND (${t.completedAt} IS NULL OR btrim(${t.completedAt}) <> '')
    AND (${t.outboxUnblockedAt} IS NULL OR btrim(${t.outboxUnblockedAt}) <> '')
    AND (${t.outboxFinalizedAt} IS NULL OR btrim(${t.outboxFinalizedAt}) <> '')
    AND (${t.outboxFinalizationOutcome} IS NULL OR btrim(${t.outboxFinalizationOutcome}) <> '')
    AND (${t.outboxFinalizationReason} IS NULL OR btrim(${t.outboxFinalizationReason}) <> '')
  `),
]);

/*
FNXC:RoomProviderAdmissionRecoveryReceipt 2026-07-21-01:31:
The Core receipt is immutable evidence that the standard sender-fenced timeout
path was actually admitted into the durable control plane. Restart recovery
must compare this historical identity rather than trusting an Engine marker.
*/
export const roomProviderAdmissionRecoveryReceipts = roomSchema.table("room_provider_admission_recovery_receipts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  roomId: text("room_id").notNull(),
  outboxId: text("outbox_id").notNull(),
  outboxBindingId: text("outbox_binding_id").notNull(),
  outboxAttemptCount: integer("outbox_attempt_count").notNull(),
  gateAttemptId: text("gate_attempt_id").notNull(),
  requestHash: text("request_hash").notNull(),
  senderLeaseId: text("sender_lease_id").notNull(),
  senderLeaseHolderId: text("sender_lease_holder_id").notNull(),
  senderLeaseHostId: text("sender_lease_host_id").notNull(),
  senderLeaseEpoch: bigint("sender_lease_epoch", { mode: "number" }).notNull(),
  issuedAt: text("issued_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_provider_admission_recovery_receipt_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.projectId, t.outboxId],
    foreignColumns: [roomOutbox.projectId, roomOutbox.id],
    name: "room_provider_admission_recovery_receipt_outbox_fkey",
  }).onDelete("restrict"),
  unique("room_provider_admission_recovery_receipt_id_project_unique").on(t.id, t.projectId),
  unique("room_provider_admission_recovery_receipt_gate_attempt_unique")
    .on(t.projectId, t.roomId, t.gateAttemptId),
  unique("room_provider_admission_recovery_receipt_target_unique")
    .on(t.projectId, t.roomId, t.outboxId, t.outboxAttemptCount),
  index("idx_room_provider_admission_recovery_receipt_target")
    .on(t.projectId, t.roomId, t.outboxId, t.outboxAttemptCount),
  check("room_provider_admission_recovery_receipt_request_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_provider_admission_recovery_receipt_attempt_count_check", sql`${t.outboxAttemptCount} BETWEEN 0 AND 2147483647`),
  check("room_provider_admission_recovery_receipt_sender_epoch_check", sql`${t.senderLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_admission_recovery_receipt_nonblank_check", sql`
    btrim(${t.id}) <> '' AND btrim(${t.projectId}) <> '' AND btrim(${t.roomId}) <> ''
    AND btrim(${t.outboxId}) <> '' AND btrim(${t.outboxBindingId}) <> ''
    AND btrim(${t.gateAttemptId}) <> '' AND btrim(${t.requestHash}) <> ''
    AND btrim(${t.senderLeaseId}) <> '' AND btrim(${t.senderLeaseHolderId}) <> ''
    AND btrim(${t.senderLeaseHostId}) <> '' AND btrim(${t.issuedAt}) <> ''
  `),
]);

/*
FNXC:RoomProviderAdmissionTimeoutTombstone 2026-07-20-23:10:
A provider-admission deadline is not proof that the provider rejected or
cancelled the request. Persist the exact pending outbox generation and immutable
gate request under its sender fence before returning timeout. The tombstone can
then resolve only by binding a verified reservation to the existing pre-claim
cleanup ledger or by recording an explicit terminal no-permit gate outcome.
Only recovery-claim ownership expires; no tombstone/proof clock transition can
reopen delivery while a late permit is still possible.
*/
export const roomProviderAdmissionTimeoutTombstones = roomSchema.table("room_provider_admission_timeout_tombstones", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  roomId: text("room_id").notNull(),
  gateAttemptId: text("gate_attempt_id").notNull(),
  requestHash: text("request_hash").notNull(),
  outboxId: text("outbox_id").notNull(),
  outboxBindingId: text("outbox_binding_id").notNull(),
  outboxAttemptCount: integer("outbox_attempt_count").notNull(),
  senderLeaseId: text("sender_lease_id").notNull(),
  senderLeaseHolderId: text("sender_lease_holder_id").notNull(),
  senderLeaseHostId: text("sender_lease_host_id").notNull(),
  senderLeaseEpoch: bigint("sender_lease_epoch", { mode: "number" }).notNull(),
  timeoutErrorCode: text("timeout_error_code").notNull(),
  recoveryProtocol: text("recovery_protocol").notNull(),
  recoveryReceiptId: text("recovery_receipt_id"),
  state: text("state").notNull(),
  cleanupActionId: text("cleanup_action_id"),
  reservationId: text("reservation_id"),
  terminalGateOutcomeId: text("terminal_gate_outcome_id"),
  terminalGateOutcome: text("terminal_gate_outcome"),
  terminalAt: text("terminal_at"),
  claimToken: text("claim_token"),
  claimLeaseId: text("claim_lease_id"),
  claimLeaseEpoch: bigint("claim_lease_epoch", { mode: "number" }),
  claimedAt: text("claimed_at"),
  claimExpiresAt: text("claim_expires_at"),
  nextAttemptAt: text("next_attempt_at"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_provider_admission_timeout_room_project_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.projectId, t.outboxId],
    foreignColumns: [roomOutbox.projectId, roomOutbox.id],
    name: "room_provider_admission_timeout_outbox_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.cleanupActionId, t.projectId],
    foreignColumns: [roomProviderBackpressureCleanupActions.id, roomProviderBackpressureCleanupActions.projectId],
    name: "room_provider_admission_timeout_cleanup_action_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.reservationId, t.projectId],
    foreignColumns: [roomProviderBackpressureReservations.id, roomProviderBackpressureReservations.projectId],
    name: "room_provider_admission_timeout_reservation_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [t.recoveryReceiptId, t.projectId],
    foreignColumns: [roomProviderAdmissionRecoveryReceipts.id, roomProviderAdmissionRecoveryReceipts.projectId],
    name: "room_provider_admission_timeout_recovery_receipt_fkey",
  }).onDelete("restrict"),
  unique("room_provider_admission_timeout_gate_attempt_unique")
    .on(t.projectId, t.roomId, t.gateAttemptId),
  unique("room_provider_admission_timeout_target_unique")
    .on(t.projectId, t.roomId, t.outboxId, t.outboxAttemptCount),
  unique("room_provider_admission_timeout_recovery_receipt_unique")
    .on(t.projectId, t.recoveryReceiptId),
  unique("room_provider_admission_timeout_cleanup_action_unique")
    .on(t.projectId, t.cleanupActionId),
  unique("room_provider_admission_timeout_terminal_outcome_unique")
    .on(t.projectId, t.terminalGateOutcomeId),
  unique("room_provider_admission_timeout_claim_token_unique")
    .on(t.projectId, t.claimToken),
  index("idx_room_provider_admission_timeout_unresolved")
    .on(t.projectId, t.roomId, t.state, t.createdAt),
  check("room_provider_admission_timeout_request_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_provider_admission_timeout_attempt_count_check", sql`${t.outboxAttemptCount} BETWEEN 0 AND 2147483647`),
  check("room_provider_admission_timeout_sender_epoch_check", sql`${t.senderLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_admission_timeout_recovery_protocol_check", sql`${t.recoveryProtocol} IN ('opaque','core_sender_fenced_v1')`),
  check("room_provider_admission_timeout_recovery_receipt_shape_check", sql`
    (${t.recoveryProtocol} = 'opaque' AND ${t.recoveryReceiptId} IS NULL)
    OR (${t.recoveryProtocol} = 'core_sender_fenced_v1' AND ${t.recoveryReceiptId} IS NOT NULL)
  `),
  check("room_provider_admission_timeout_claim_epoch_check", sql`${t.claimLeaseEpoch} IS NULL OR ${t.claimLeaseEpoch} BETWEEN 1 AND 9007199254740991`),
  check("room_provider_admission_timeout_state_check", sql`${t.state} IN ('pending','reservation_bound','terminal_outcome_recorded','terminal_outcome_claimed','terminal_without_permit')`),
  check("room_provider_admission_timeout_terminal_outcome_check", sql`
    ${t.terminalGateOutcome} IS NULL
    OR ${t.terminalGateOutcome} IN ('deferred_without_permit','cancelled_without_permit','failed_without_permit','core_sender_fenced_no_reservation')
  `),
  check("room_provider_admission_timeout_state_shape_check", sql`
    (${t.state} = 'pending'
      AND ${t.cleanupActionId} IS NULL AND ${t.reservationId} IS NULL
      AND ${t.terminalGateOutcomeId} IS NULL AND ${t.terminalGateOutcome} IS NULL
      AND ${t.terminalAt} IS NULL
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.nextAttemptAt} IS NULL AND ${t.resolvedAt} IS NULL)
    OR (${t.state} = 'reservation_bound'
      AND ${t.cleanupActionId} IS NOT NULL AND ${t.reservationId} IS NOT NULL
      AND ${t.terminalGateOutcomeId} IS NULL AND ${t.terminalGateOutcome} IS NULL
      AND ${t.terminalAt} IS NULL
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.nextAttemptAt} IS NULL AND ${t.resolvedAt} IS NOT NULL)
    OR (${t.state} = 'terminal_outcome_recorded'
      AND ${t.cleanupActionId} IS NULL AND ${t.reservationId} IS NULL
      AND ${t.terminalGateOutcomeId} IS NOT NULL AND ${t.terminalGateOutcome} IS NOT NULL
      AND ${t.terminalAt} IS NOT NULL
      AND ${t.claimToken} IS NULL AND ${t.claimLeaseId} IS NULL AND ${t.claimLeaseEpoch} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimExpiresAt} IS NULL
      AND ${t.nextAttemptAt} IS NULL AND ${t.resolvedAt} IS NULL)
    OR (${t.state} = 'terminal_outcome_claimed'
      AND ${t.cleanupActionId} IS NULL AND ${t.reservationId} IS NULL
      AND ${t.terminalGateOutcomeId} IS NOT NULL AND ${t.terminalGateOutcome} IS NOT NULL
      AND ${t.terminalAt} IS NOT NULL
      AND ${t.claimToken} IS NOT NULL AND ${t.claimLeaseId} IS NOT NULL AND ${t.claimLeaseEpoch} IS NOT NULL
      AND ${t.claimedAt} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL
      AND ${t.nextAttemptAt} IS NULL AND ${t.resolvedAt} IS NULL)
    OR (${t.state} = 'terminal_without_permit'
      AND ${t.cleanupActionId} IS NULL AND ${t.reservationId} IS NULL
      AND ${t.terminalGateOutcomeId} IS NOT NULL AND ${t.terminalGateOutcome} IS NOT NULL
      AND ${t.terminalAt} IS NOT NULL
      AND ${t.claimToken} IS NOT NULL AND ${t.claimLeaseId} IS NOT NULL AND ${t.claimLeaseEpoch} IS NOT NULL
      AND ${t.claimedAt} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL
      AND ${t.nextAttemptAt} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)
  `),
  check("room_provider_admission_timeout_time_check", sql`
    (${t.resolvedAt} IS NULL OR ${t.resolvedAt} >= ${t.createdAt})
    AND (${t.terminalAt} IS NULL OR ${t.resolvedAt} IS NULL OR ${t.terminalAt} <= ${t.resolvedAt})
    AND (${t.claimedAt} IS NULL OR ${t.terminalAt} IS NULL OR ${t.claimedAt} >= ${t.terminalAt})
    AND (${t.claimExpiresAt} IS NULL OR ${t.claimedAt} IS NULL OR ${t.claimExpiresAt} > ${t.claimedAt})
    AND (${t.resolvedAt} IS NULL OR ${t.claimedAt} IS NULL OR ${t.resolvedAt} >= ${t.claimedAt})
    AND (${t.nextAttemptAt} IS NULL OR ${t.resolvedAt} IS NULL OR ${t.nextAttemptAt} > ${t.resolvedAt})
  `),
  check("room_provider_admission_timeout_nonblank_check", sql`
    btrim(${t.id}) <> '' AND btrim(${t.projectId}) <> '' AND btrim(${t.roomId}) <> ''
    AND btrim(${t.gateAttemptId}) <> '' AND btrim(${t.requestHash}) <> ''
    AND btrim(${t.outboxId}) <> '' AND btrim(${t.outboxBindingId}) <> ''
    AND btrim(${t.senderLeaseId}) <> '' AND btrim(${t.senderLeaseHolderId}) <> ''
    AND btrim(${t.senderLeaseHostId}) <> '' AND btrim(${t.timeoutErrorCode}) <> ''
    AND btrim(${t.recoveryProtocol}) <> ''
    AND btrim(${t.state}) <> '' AND btrim(${t.createdAt}) <> '' AND btrim(${t.updatedAt}) <> ''
    AND (${t.recoveryReceiptId} IS NULL OR btrim(${t.recoveryReceiptId}) <> '')
    AND (${t.cleanupActionId} IS NULL OR btrim(${t.cleanupActionId}) <> '')
    AND (${t.reservationId} IS NULL OR btrim(${t.reservationId}) <> '')
    AND (${t.terminalGateOutcomeId} IS NULL OR btrim(${t.terminalGateOutcomeId}) <> '')
    AND (${t.terminalGateOutcome} IS NULL OR btrim(${t.terminalGateOutcome}) <> '')
    AND (${t.terminalAt} IS NULL OR btrim(${t.terminalAt}) <> '')
    AND (${t.claimToken} IS NULL OR btrim(${t.claimToken}) <> '')
    AND (${t.claimLeaseId} IS NULL OR btrim(${t.claimLeaseId}) <> '')
    AND (${t.claimedAt} IS NULL OR btrim(${t.claimedAt}) <> '')
    AND (${t.claimExpiresAt} IS NULL OR btrim(${t.claimExpiresAt}) <> '')
    AND (${t.nextAttemptAt} IS NULL OR btrim(${t.nextAttemptAt}) <> '')
    AND (${t.resolvedAt} IS NULL OR btrim(${t.resolvedAt}) <> '')
  `),
]);

export const roomProviderBackpressureOperations = roomSchema.table("room_provider_backpressure_operations", {
  projectId: text("project_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  requestId: text("request_id").notNull(),
  operationKind: text("operation_kind").notNull(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  stateRevision: bigint("state_revision", { mode: "number" }).notNull(),
  reservationId: text("reservation_id"),
  occurredAt: text("occurred_at").notNull(),
}, (t) => [
  primaryKey({
    columns: [t.projectId, t.scopeKey, t.requestId, t.operationKind],
    name: "room_provider_backpressure_operations_primary",
  }),
  foreignKey({
    columns: [t.projectId, t.scopeKey],
    foreignColumns: [roomProviderBackpressureStates.projectId, roomProviderBackpressureStates.scopeKey],
    name: "room_provider_backpressure_operations_state_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.reservationId, t.projectId],
    foreignColumns: [roomProviderBackpressureReservations.id, roomProviderBackpressureReservations.projectId],
    name: "room_provider_backpressure_operations_reservation_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_provider_backpressure_operations_reservation")
    .on(t.projectId, t.reservationId, t.occurredAt),
  check("room_provider_backpressure_operations_kind_check", sql`${t.operationKind} IN ('dispatch','success','failure')`),
  check("room_provider_backpressure_operations_action_check", sql`${t.action} IN ('admit','hold','recorded')`),
  check("room_provider_backpressure_operations_revision_check", sql`${t.stateRevision} BETWEEN 0 AND 9007199254740991`),
  check("room_provider_backpressure_operations_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_provider_backpressure_operations_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.scopeKey}) <> ''
    AND btrim(${t.requestId}) <> ''
    AND btrim(${t.reason}) <> ''
    AND btrim(${t.occurredAt}) <> ''
  `),
]);

export const roomRbacAuthorizationStates = roomSchema.table("room_rbac_authorization_states", {
  projectId: text("project_id").primaryKey(),
  authorizationVersion: bigint("authorization_version", { mode: "number" }).notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  check("room_rbac_authorization_states_version_check", sql`${t.authorizationVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_rbac_authorization_states_nonblank_check", sql`btrim(${t.projectId}) <> '' AND btrim(${t.updatedAt}) <> ''`),
]);

export const roomTrustedDeviceSessions = roomSchema.table("room_trusted_device_sessions", {
  projectId: text("project_id").notNull(),
  sessionId: text("session_id").notNull(),
  credentialDigest: text("credential_digest").notNull(),
  principalId: text("principal_id").notNull(),
  deviceId: text("device_id").notNull(),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  sessionVersion: bigint("session_version", { mode: "number" }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.sessionId], name: "room_trusted_device_sessions_primary" }),
  unique("room_trusted_device_sessions_credential_digest_unique").on(t.credentialDigest),
  index("idx_room_trusted_device_sessions_principal").on(t.projectId, t.principalId, t.deviceId, t.expiresAt),
  index("idx_room_trusted_device_sessions_active").on(t.projectId, t.expiresAt, t.sessionId).where(sql`${t.revokedAt} IS NULL`),
  check("room_trusted_device_sessions_digest_check", sql`${t.credentialDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_trusted_device_sessions_version_check", sql`${t.sessionVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_trusted_device_sessions_window_check", sql`${t.expiresAt} > ${t.issuedAt}`),
  check("room_trusted_device_sessions_revoke_check", sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.issuedAt}`),
  check("room_trusted_device_sessions_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.sessionId}) <> ''
    AND btrim(${t.principalId}) <> ''
    AND btrim(${t.deviceId}) <> ''
    AND btrim(${t.issuedAt}) <> ''
    AND btrim(${t.expiresAt}) <> ''
    AND (${t.revokedAt} IS NULL OR btrim(${t.revokedAt}) <> '')
  `),
]);

export const roomRbacGrants = roomSchema.table("room_rbac_grants", {
  projectId: text("project_id").notNull(),
  grantId: text("grant_id").notNull(),
  principalId: text("principal_id").notNull(),
  role: text("role").notNull(),
  roomId: text("room_id"),
  grantedAt: text("granted_at").notNull(),
  revokedAt: text("revoked_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.grantId], name: "room_rbac_grants_primary" }),
  foreignKey({
    columns: [t.roomId, t.projectId],
    foreignColumns: [operationalRooms.id, operationalRooms.projectId],
    name: "room_rbac_grants_room_project_fkey",
  }).onDelete("cascade"),
  index("idx_room_rbac_grants_snapshot").on(t.projectId, t.principalId, t.roomId, t.grantedAt).where(sql`${t.revokedAt} IS NULL`),
  check("room_rbac_grants_role_check", sql`${t.role} IN ('owner','admin','operator','observer','auditor')`),
  check("room_rbac_grants_revoke_check", sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.grantedAt}`),
  check("room_rbac_grants_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.grantId}) <> ''
    AND btrim(${t.principalId}) <> ''
    AND btrim(${t.grantedAt}) <> ''
    AND (${t.roomId} IS NULL OR btrim(${t.roomId}) <> '')
    AND (${t.revokedAt} IS NULL OR btrim(${t.revokedAt}) <> '')
  `),
]);

export const roomRbacRegistryOperations = roomSchema.table("room_rbac_registry_operations", {
  projectId: text("project_id").notNull(),
  commandKind: text("command_kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  authorizationVersion: bigint("authorization_version", { mode: "number" }),
  sessionVersion: bigint("session_version", { mode: "number" }),
  occurredAt: text("occurred_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.commandKind, t.idempotencyKey], name: "room_rbac_registry_operations_primary" }),
  index("idx_room_rbac_registry_operations_entity").on(t.projectId, t.entityType, t.entityId, t.occurredAt),
  check("room_rbac_registry_operations_kind_check", sql`${t.commandKind} IN ('issue_trusted_device_session','revoke_trusted_device_session','grant_role','revoke_role_grant')`),
  check("room_rbac_registry_operations_entity_check", sql`${t.entityType} IN ('trusted_device_session','role_grant')`),
  check("room_rbac_registry_operations_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}$'`),
  check("room_rbac_registry_operations_authorization_version_check", sql`${t.authorizationVersion} IS NULL OR ${t.authorizationVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_rbac_registry_operations_session_version_check", sql`${t.sessionVersion} IS NULL OR ${t.sessionVersion} BETWEEN 1 AND 9007199254740991`),
  check("room_rbac_registry_operations_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.commandKind}) <> ''
    AND btrim(${t.idempotencyKey}) <> ''
    AND btrim(${t.entityId}) <> ''
    AND btrim(${t.occurredAt}) <> ''
  `),
]);

export const ROOM_PROJECT_TABLE_NAMES = [
  "operational_rooms",
  "room_seats",
  "room_bindings",
  "room_binding_ingestion_state",
  "room_turns",
  "room_membership_changes",
  "room_events",
  "room_capability_registry_projections",
  "room_blind_review_registries",
  "room_evolution_hypotheses",
  "room_evolution_legacy_provenance_quarantines",
  "room_evolution_trusted_bindings",
  "room_evolution_trusted_binding_revocations",
  "room_evolution_candidate_versions",
  "room_evolution_experiments",
  "room_evolution_benchmark_cases",
  "room_evolution_benchmark_results",
  "room_evolution_gate_results",
  "room_evolution_canaries",
  "room_evolution_canary_observations",
  "room_evolution_canary_success_outcomes",
  "room_evolution_promotion_decisions",
  "room_evolution_rollbacks",
  "room_task_nodes",
  "room_task_edges",
  "room_messages",
  "room_message_targets",
  "room_outbox",
  "room_outbox_attempts",
  "room_inbox_receipts",
  "room_idempotency_keys",
  "room_leases",
  "room_checkpoints",
  "room_artifacts",
  "room_evidence",
  "room_candidates",
  "room_reviews",
  "room_dissents",
  "room_gate_results",
  "room_promotions",
  "room_confidence_snapshots",
  "room_alerts",
  "room_global_concurrency_state",
  "room_global_concurrency_claims",
  "room_global_concurrency_operations",
  "room_provider_backpressure_states",
  "room_provider_backpressure_reservations",
  "room_provider_admission_timeout_tombstones",
  "room_provider_backpressure_operations",
  "room_rbac_authorization_states",
  "room_trusted_device_sessions",
  "room_rbac_grants",
  "room_rbac_registry_operations",
] as const;
