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
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { PROJECT_SCHEMA } from "./_shared.js";

const roomSchema = pgSchema(PROJECT_SCHEMA);

const scopedRoomColumns = () => ({
  projectId: text("project_id").notNull(),
  roomId: text("room_id").notNull(),
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
  bindingId: text("binding_id").primaryKey(),
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
  unique("room_events_cursor_unique").on(t.cursor),
  index("idx_room_events_project_room_time").on(t.projectId, t.roomId, t.occurredAt, t.id),
  index("idx_room_events_project_cursor").on(t.projectId, t.cursor),
  index("idx_room_events_correlation").on(t.correlationId),
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
  uniqueIndex("idx_room_outbox_logical_message").on(t.bindingId, t.logicalMessageId),
  uniqueIndex("idx_room_outbox_local_message").on(t.bindingId, t.localMessageId),
  index("idx_room_outbox_dispatch").on(t.projectId, t.deliveryState, t.nextAttemptAt),
  check("room_outbox_delivery_state_check", sql`${t.deliveryState} IN ('pending','dispatching','confirmed','delivery_uncertain','rejected','cancelled')`),
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
  check("room_provider_backpressure_operations_hash_check", sql`${t.requestHash} ~ '^sha256:[a-f0-9]{64}
  "operational_rooms",
  "room_seats",
  "room_bindings",
  "room_binding_ingestion_state",
  "room_turns",
  "room_membership_changes",
  "room_events",
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
  "room_provider_backpressure_states",
  "room_provider_backpressure_reservations",
  "room_provider_backpressure_operations",
] as const;
`),
  check("room_provider_backpressure_operations_nonblank_check", sql`
    btrim(${t.projectId}) <> ''
    AND btrim(${t.scopeKey}) <> ''
    AND btrim(${t.requestId}) <> ''
    AND btrim(${t.reason}) <> ''
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
] as const;
