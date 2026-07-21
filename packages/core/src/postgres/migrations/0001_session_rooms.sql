-- FNXC:SessionRoomPostgres 2026-07-17-03:20:
-- Durable operational Session Room schema. This is an additive migration over
-- the immutable 0000 baseline so existing PostgreSQL installations receive the
-- same tables as fresh installs. All Room state stays in the canonical project
-- schema and uses the existing fusion_schema_migrations ledger.

CREATE TABLE IF NOT EXISTS project.operational_rooms (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  objective text NOT NULL,
  protocol_id text NOT NULL,
  protocol_version integer NOT NULL,
  protocol_phase_id text,
  lifecycle_state text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 0,
  membership_version bigint NOT NULL DEFAULT 0,
  active_turn_id text,
  completion_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT operational_rooms_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT operational_rooms_lifecycle_check CHECK (
    lifecycle_state IN ('draft','ready','running','paused','completed','completed_with_risks','partial','blocked','cancelled','failed','archived')
  )
);
CREATE INDEX IF NOT EXISTS idx_operational_rooms_project_state
  ON project.operational_rooms(project_id, lifecycle_state, updated_at);

CREATE TABLE IF NOT EXISTS project.room_seats (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  role text NOT NULL,
  role_version integer NOT NULL DEFAULT 1,
  role_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  permission_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL,
  active_binding_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_seats_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_seats_room_id_unique UNIQUE (room_id, id),
  CONSTRAINT room_seats_state_check CHECK (
    state IN ('pending','ready','active','paused','waiting','lost','removed')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_seats_project_room_state
  ON project.room_seats(project_id, room_id, state);

CREATE TABLE IF NOT EXISTS project.room_bindings (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  seat_id text NOT NULL,
  generation integer NOT NULL,
  connector_id text NOT NULL,
  provider_id text NOT NULL,
  native_session_id text NOT NULL,
  happier_session_id text,
  server_profile_id text,
  host_id text NOT NULL,
  state text NOT NULL,
  attached_at text NOT NULL,
  detached_at text,
  replaced_by_binding_id text,
  replacement_reason text,
  CONSTRAINT room_bindings_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_bindings_seat_fkey
    FOREIGN KEY (seat_id) REFERENCES project.room_seats(id) ON DELETE CASCADE,
  CONSTRAINT room_bindings_seat_generation_unique UNIQUE (seat_id, generation),
  CONSTRAINT room_bindings_generation_check CHECK (generation > 0),
  CONSTRAINT room_bindings_state_check CHECK (
    state IN ('pending','attached','paused','authentication_blocked','host_unavailable','delivery_uncertain','detached','replaced','failed')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_bindings_native_session
  ON project.room_bindings(provider_id, native_session_id);
CREATE INDEX IF NOT EXISTS idx_room_bindings_room_state
  ON project.room_bindings(project_id, room_id, state);

CREATE TABLE IF NOT EXISTS project.room_turns (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  sequence bigint NOT NULL,
  protocol_phase_id text NOT NULL,
  membership_version bigint NOT NULL,
  state text NOT NULL,
  started_at text,
  ended_at text,
  CONSTRAINT room_turns_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_turns_room_sequence_unique UNIQUE (room_id, sequence),
  CONSTRAINT room_turns_id_room_project_unique UNIQUE (id, room_id, project_id),
  CONSTRAINT room_turns_state_check CHECK (
    state IN ('pending','running','waiting','checkpointed','completed','cancelled','uncertain')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_turns_room_state
  ON project.room_turns(project_id, room_id, state);

CREATE TABLE IF NOT EXISTS project.room_membership_changes (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  seat_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  requested_at text NOT NULL,
  requested_by text NOT NULL,
  effective_after_turn_id text,
  applied_at text,
  state text NOT NULL,
  CONSTRAINT room_membership_changes_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_membership_changes_seat_fkey
    FOREIGN KEY (seat_id) REFERENCES project.room_seats(id) ON DELETE CASCADE,
  CONSTRAINT room_membership_changes_state_check CHECK (
    state IN ('requested','waiting_turn_boundary','applied','cancelled','failed')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_membership_changes_pending
  ON project.room_membership_changes(project_id, room_id, state, requested_at);

CREATE TABLE IF NOT EXISTS project.room_events (
  id text PRIMARY KEY,
  cursor bigint GENERATED ALWAYS AS IDENTITY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  aggregate_version bigint NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  payload jsonb NOT NULL,
  occurred_at text NOT NULL,
  CONSTRAINT room_events_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_events_room_aggregate_version_unique UNIQUE (room_id, aggregate_version),
  CONSTRAINT room_events_id_project_unique UNIQUE (project_id, id),
  CONSTRAINT room_events_cursor_unique UNIQUE (cursor)
);
CREATE INDEX IF NOT EXISTS idx_room_events_project_room_time
  ON project.room_events(project_id, room_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_room_events_project_cursor
  ON project.room_events(project_id, cursor);
CREATE INDEX IF NOT EXISTS idx_room_events_correlation
  ON project.room_events(correlation_id);

CREATE TABLE IF NOT EXISTS project.room_task_nodes (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  parent_node_id text,
  objective text NOT NULL,
  state text NOT NULL,
  assigned_seat_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_gate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress_signature text,
  node_version bigint NOT NULL DEFAULT 0,
  accepted_at text,
  invalidated_by_evidence_id text,
  CONSTRAINT room_task_nodes_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_task_nodes_state_check CHECK (
    state IN ('pending','ready','running','waiting_dependency','waiting_approval','rate_limited','retrying','accepted','blocked','failed','cancelled')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_task_nodes_room_state
  ON project.room_task_nodes(project_id, room_id, state);
CREATE INDEX IF NOT EXISTS idx_room_task_nodes_parent
  ON project.room_task_nodes(parent_node_id);

CREATE TABLE IF NOT EXISTS project.room_task_edges (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  kind text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_task_edges_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_task_edges_from_fkey
    FOREIGN KEY (from_node_id) REFERENCES project.room_task_nodes(id) ON DELETE CASCADE,
  CONSTRAINT room_task_edges_to_fkey
    FOREIGN KEY (to_node_id) REFERENCES project.room_task_nodes(id) ON DELETE CASCADE,
  CONSTRAINT room_task_edges_shape_unique UNIQUE (room_id, from_node_id, to_node_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_room_task_edges_to
  ON project.room_task_edges(room_id, to_node_id);

CREATE TABLE IF NOT EXISTS project.room_messages (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  turn_id text,
  node_id text,
  origin_type text NOT NULL,
  origin_id text NOT NULL,
  intent text NOT NULL,
  target jsonb NOT NULL,
  authority jsonb NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at text NOT NULL,
  CONSTRAINT room_messages_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_time
  ON project.room_messages(project_id, room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_room_messages_turn
  ON project.room_messages(turn_id);

CREATE TABLE IF NOT EXISTS project.room_outbox (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  message_id text NOT NULL,
  binding_id text NOT NULL,
  logical_message_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  delivery_state text NOT NULL,
  native_acknowledgement jsonb,
  native_cursor text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  next_attempt_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_outbox_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_outbox_message_fkey
    FOREIGN KEY (message_id) REFERENCES project.room_messages(id) ON DELETE CASCADE,
  CONSTRAINT room_outbox_binding_fkey
    FOREIGN KEY (binding_id) REFERENCES project.room_bindings(id) ON DELETE CASCADE,
  CONSTRAINT room_outbox_delivery_state_check CHECK (
    delivery_state IN ('pending','dispatching','confirmed','delivery_uncertain','rejected','cancelled')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_outbox_logical_message
  ON project.room_outbox(binding_id, logical_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_outbox_id_project_unique
  ON project.room_outbox(project_id, id);
CREATE INDEX IF NOT EXISTS idx_room_outbox_dispatch
  ON project.room_outbox(project_id, delivery_state, next_attempt_at);

CREATE TABLE IF NOT EXISTS project.room_outbox_attempts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  outbox_id text NOT NULL,
  attempt integer NOT NULL,
  started_at text NOT NULL,
  ended_at text,
  outcome text NOT NULL,
  error_code text,
  evidence_ref text,
  CONSTRAINT room_outbox_attempts_outbox_fkey
    FOREIGN KEY (outbox_id) REFERENCES project.room_outbox(id) ON DELETE CASCADE,
  CONSTRAINT room_outbox_attempts_number_unique UNIQUE (outbox_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_room_outbox_attempts_room
  ON project.room_outbox_attempts(project_id, room_id, started_at);

CREATE TABLE IF NOT EXISTS project.room_inbox_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  binding_id text NOT NULL,
  native_message_id text,
  native_cursor text NOT NULL,
  payload_hash text NOT NULL,
  received_at text NOT NULL,
  CONSTRAINT room_inbox_receipts_binding_fkey
    FOREIGN KEY (binding_id) REFERENCES project.room_bindings(id) ON DELETE CASCADE,
  CONSTRAINT room_inbox_receipts_binding_cursor_unique UNIQUE (binding_id, native_cursor)
);
CREATE INDEX IF NOT EXISTS idx_room_inbox_receipts_room_time
  ON project.room_inbox_receipts(project_id, room_id, received_at);

CREATE TABLE IF NOT EXISTS project.room_idempotency_keys (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  command_hash text NOT NULL,
  result_event_id text,
  created_at text NOT NULL,
  expires_at text,
  CONSTRAINT room_idempotency_keys_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_idempotency_keys_room_key_unique UNIQUE (room_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_room_idempotency_keys_expiry
  ON project.room_idempotency_keys(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project.room_leases (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  holder_id text NOT NULL,
  host_id text NOT NULL,
  epoch bigint NOT NULL,
  acquired_at text NOT NULL,
  heartbeat_at text NOT NULL,
  expires_at text NOT NULL,
  released_at text,
  CONSTRAINT room_leases_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_leases_resource_epoch_unique UNIQUE (project_id, kind, resource_id, epoch),
  CONSTRAINT room_leases_kind_check CHECK (
    kind IN ('room_worker','sender','workspace','human_takeover')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_leases_active_resource
  ON project.room_leases(project_id, kind, resource_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_room_leases_expiry
  ON project.room_leases(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project.room_checkpoints (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  turn_id text,
  aggregate_version bigint NOT NULL,
  event_id text NOT NULL,
  event_cursor bigint NOT NULL,
  projection_hash text NOT NULL,
  projection jsonb NOT NULL,
  protocol_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  dag_version bigint NOT NULL DEFAULT 0,
  binding_cursors jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_outbox_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at text NOT NULL,
  CONSTRAINT room_checkpoints_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_checkpoints_room_version_unique UNIQUE (room_id, aggregate_version)
);
CREATE INDEX IF NOT EXISTS idx_room_checkpoints_latest
  ON project.room_checkpoints(project_id, room_id, aggregate_version);

CREATE TABLE IF NOT EXISTS project.room_artifacts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text,
  kind text NOT NULL,
  media_type text NOT NULL,
  uri text NOT NULL,
  content_hash text NOT NULL,
  producing_binding_id text,
  source_revision text,
  size_bytes bigint,
  created_at text NOT NULL,
  CONSTRAINT room_artifacts_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_artifacts_node
  ON project.room_artifacts(project_id, room_id, node_id);
CREATE INDEX IF NOT EXISTS idx_room_artifacts_candidate
  ON project.room_artifacts(candidate_id);

CREATE TABLE IF NOT EXISTS project.room_evidence (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text,
  kind text NOT NULL,
  authoritative_source_uri text NOT NULL,
  source_version_or_hash text NOT NULL,
  captured_at text NOT NULL,
  collection_method text NOT NULL,
  collector_binding_id text,
  content_hash text NOT NULL,
  artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at text,
  CONSTRAINT room_evidence_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_evidence_candidate
  ON project.room_evidence(project_id, room_id, candidate_id);
CREATE INDEX IF NOT EXISTS idx_room_evidence_expiry
  ON project.room_evidence(expires_at);

CREATE TABLE IF NOT EXISTS project.room_candidates (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  producing_binding_id text NOT NULL,
  native_session_id text NOT NULL,
  happier_session_id text NOT NULL,
  provider_id text NOT NULL,
  model_ref text NOT NULL,
  protocol_id text NOT NULL,
  protocol_version integer NOT NULL,
  context_version text NOT NULL,
  input_version text NOT NULL,
  config_version text NOT NULL,
  content_hash text NOT NULL,
  artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  parent_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  gate_result_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  promotion_state text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_candidates_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_candidates_promotion_state_check CHECK (
    promotion_state IN ('pending','eligible','promoted','rejected','superseded')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_candidates_node_state
  ON project.room_candidates(project_id, room_id, node_id, promotion_state);

CREATE TABLE IF NOT EXISTS project.room_reviews (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text NOT NULL,
  blind_candidate_ref text NOT NULL,
  reviewer_binding_id text NOT NULL,
  reviewer_native_session_id text NOT NULL,
  reviewer_happier_session_id text NOT NULL,
  blind integer NOT NULL,
  producer_identity_hidden integer NOT NULL,
  independent_from_producer integer NOT NULL,
  verdict text NOT NULL,
  rubric_version text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  dissent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_content_hash text NOT NULL,
  committed_at text NOT NULL,
  CONSTRAINT room_reviews_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_reviews_candidate
  ON project.room_reviews(project_id, room_id, candidate_id);

CREATE TABLE IF NOT EXISTS project.room_dissents (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text NOT NULL,
  review_id text,
  severity text NOT NULL,
  state text NOT NULL,
  owner_id text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL,
  resolution jsonb,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_dissents_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_dissents_candidate_state
  ON project.room_dissents(project_id, room_id, candidate_id, state, severity);

CREATE TABLE IF NOT EXISTS project.room_gate_results (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text NOT NULL,
  profile_id text NOT NULL,
  kind text NOT NULL,
  hard integer NOT NULL,
  status text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluator_binding_id text,
  command text,
  exit_code integer,
  recorded_at text NOT NULL,
  CONSTRAINT room_gate_results_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_gate_results_candidate
  ON project.room_gate_results(project_id, room_id, candidate_id, hard, status);

CREATE TABLE IF NOT EXISTS project.room_promotions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text NOT NULL,
  decision text NOT NULL,
  decision_actor_type text NOT NULL,
  decision_actor_id text NOT NULL,
  hard_gate_result_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  unresolved_dissent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text NOT NULL,
  decided_at text NOT NULL,
  CONSTRAINT room_promotions_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_promotions_candidate
  ON project.room_promotions(project_id, room_id, candidate_id, decided_at);

CREATE TABLE IF NOT EXISTS project.room_confidence_snapshots (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  candidate_id text,
  band text NOT NULL,
  methodology_version text NOT NULL,
  input_evidence_hash text NOT NULL,
  dimensions jsonb NOT NULL,
  stale_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  unresolved_dissent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_self_report_excluded integer NOT NULL,
  computed_at text NOT NULL,
  CONSTRAINT room_confidence_snapshots_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_confidence_snapshots_band_check CHECK (band IN ('high','medium','low','unknown'))
);
CREATE INDEX IF NOT EXISTS idx_room_confidence_snapshots_latest
  ON project.room_confidence_snapshots(project_id, room_id, node_id, computed_at);

CREATE TABLE IF NOT EXISTS project.room_alerts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  severity text NOT NULL,
  state text NOT NULL,
  deduplication_key text NOT NULL,
  root_cause text NOT NULL,
  impact text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempted_recovery jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_retry_at text,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  opened_at text NOT NULL,
  resolved_at text,
  CONSTRAINT room_alerts_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_alerts_open_dedupe
  ON project.room_alerts(project_id, room_id, deduplication_key)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_room_alerts_project_state
  ON project.room_alerts(project_id, state, severity, opened_at);
