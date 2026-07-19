-- Persist controller-owned semantic state and typed cross-seat protocol
-- messages. A state is immutable once superseded; one unchanged state can
-- produce only one durable controller escalation.

CREATE TABLE IF NOT EXISTS project.room_semantic_states (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  turn_id text NOT NULL,
  node_id text NOT NULL,
  revision bigint NOT NULL,
  state text NOT NULL,
  protocol_id text NOT NULL,
  protocol_version integer NOT NULL,
  phase_id text NOT NULL,
  semantic_hash text NOT NULL,
  evidence_state_hash text NOT NULL,
  decision_state_hash text NOT NULL,
  state_fingerprint text NOT NULL,
  created_at text NOT NULL,
  superseded_at text,
  CONSTRAINT room_semantic_states_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_states_node_room_project_fkey
    FOREIGN KEY (node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_states_turn_fkey
    FOREIGN KEY (turn_id)
    REFERENCES project.room_turns(id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_states_id_room_project_unique
    UNIQUE (id, room_id, project_id),
  CONSTRAINT room_semantic_states_turn_node_revision_unique
    UNIQUE (turn_id, node_id, revision),
  CONSTRAINT room_semantic_states_state_check
    CHECK (state IN ('active','superseded')),
  CONSTRAINT room_semantic_states_revision_check
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_semantic_states_protocol_version_check
    CHECK (protocol_version BETWEEN 1 AND 2147483647),
  CONSTRAINT room_semantic_states_nonblank_check
    CHECK (
      btrim(protocol_id) <> ''
      AND btrim(phase_id) <> ''
      AND btrim(semantic_hash) <> ''
      AND btrim(evidence_state_hash) <> ''
      AND btrim(decision_state_hash) <> ''
      AND btrim(state_fingerprint) <> ''
    ),
  CONSTRAINT room_semantic_states_state_time_check
    CHECK (
      (state = 'active' AND superseded_at IS NULL)
      OR (state = 'superseded' AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS room_semantic_states_active_turn_node_unique
  ON project.room_semantic_states(project_id, room_id, turn_id, node_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_room_semantic_states_project_room_turn_node
  ON project.room_semantic_states(project_id, room_id, turn_id, node_id, state, revision);

CREATE TABLE IF NOT EXISTS project.room_protocol_messages (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  protocol_message_id text NOT NULL,
  turn_id text NOT NULL,
  node_id text NOT NULL,
  protocol_id text NOT NULL,
  protocol_version integer NOT NULL,
  phase_id text NOT NULL,
  channel_id text NOT NULL,
  issued_at text NOT NULL,
  origin_seat_id text NOT NULL,
  origin_binding_id text NOT NULL,
  origin_role_id text NOT NULL,
  semantic_hash text NOT NULL,
  evidence_state_hash text NOT NULL,
  decision_state_hash text NOT NULL,
  semantic_state_id text NOT NULL,
  semantic_state_revision bigint NOT NULL,
  semantic_state_fingerprint text NOT NULL,
  semantic_loop_fingerprint text NOT NULL,
  protocol_target jsonb NOT NULL,
  reference_bundle jsonb NOT NULL,
  route_outcome text NOT NULL,
  recipient_controller boolean NOT NULL,
  recipient_seat_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_controller_response boolean NOT NULL,
  required_responder_seat_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  audit jsonb NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_protocol_messages_message_room_project_fkey
    FOREIGN KEY (id, room_id, project_id)
    REFERENCES project.room_messages(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_protocol_messages_semantic_state_room_project_fkey
    FOREIGN KEY (semantic_state_id, room_id, project_id)
    REFERENCES project.room_semantic_states(id, room_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_protocol_messages_room_protocol_message_unique
    UNIQUE (project_id, room_id, protocol_message_id),
  CONSTRAINT room_protocol_messages_protocol_version_check
    CHECK (protocol_version BETWEEN 1 AND 2147483647),
  CONSTRAINT room_protocol_messages_semantic_state_revision_check
    CHECK (semantic_state_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_protocol_messages_semantic_loop_fingerprint_check
    CHECK (btrim(semantic_loop_fingerprint) <> ''),
  CONSTRAINT room_protocol_messages_route_outcome_check
    CHECK (route_outcome IN ('route','loop_break')),
  CONSTRAINT room_protocol_messages_json_shape_check
    CHECK (
      jsonb_typeof(protocol_target) = 'object'
      AND jsonb_typeof(reference_bundle) = 'object'
      AND jsonb_typeof(recipient_seat_ids) = 'array'
      AND jsonb_typeof(required_responder_seat_ids) = 'array'
      AND jsonb_typeof(audit) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_room_protocol_messages_turn_node_time
  ON project.room_protocol_messages(project_id, room_id, turn_id, node_id, created_at, id);

CREATE TABLE IF NOT EXISTS project.room_semantic_loop_breaks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  turn_id text NOT NULL,
  node_id text NOT NULL,
  semantic_state_fingerprint text NOT NULL,
  source_message_id text NOT NULL,
  escalation_message_id text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_semantic_loop_breaks_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_loop_breaks_source_message_fkey
    FOREIGN KEY (source_message_id)
    REFERENCES project.room_messages(id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_loop_breaks_escalation_message_fkey
    FOREIGN KEY (escalation_message_id)
    REFERENCES project.room_messages(id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_loop_breaks_state_unique
    UNIQUE (project_id, room_id, turn_id, node_id, semantic_state_fingerprint),
  CONSTRAINT room_semantic_loop_breaks_nonblank_check
    CHECK (
      btrim(semantic_state_fingerprint) <> ''
      AND btrim(source_message_id) <> ''
      AND btrim(escalation_message_id) <> ''
    )
);

CREATE INDEX IF NOT EXISTS idx_room_semantic_loop_breaks_room_node
  ON project.room_semantic_loop_breaks(project_id, room_id, turn_id, node_id, created_at);

CREATE TABLE IF NOT EXISTS project.room_semantic_controller_inbox (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  message_id text NOT NULL,
  protocol_message_id text,
  action_kind text NOT NULL,
  reason_code text,
  payload jsonb NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token text,
  claim_expires_at text,
  claimed_by text,
  processed_at text,
  last_error_code text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_semantic_controller_inbox_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_controller_inbox_message_fkey
    FOREIGN KEY (message_id)
    REFERENCES project.room_messages(id)
    ON DELETE CASCADE,
  CONSTRAINT room_semantic_controller_inbox_message_action_unique
    UNIQUE (project_id, room_id, message_id, action_kind),
  CONSTRAINT room_semantic_controller_inbox_action_kind_check
    CHECK (action_kind IN ('semantic_message','semantic_loop_break')),
  CONSTRAINT room_semantic_controller_inbox_state_check
    CHECK (state IN ('pending','claimed','processed')),
  CONSTRAINT room_semantic_controller_inbox_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_semantic_controller_inbox_payload_shape_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT room_semantic_controller_inbox_claim_shape_check
    CHECK (
      (state = 'pending'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND claimed_by IS NULL
        AND processed_at IS NULL)
      OR (state = 'claimed'
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND claimed_by IS NOT NULL
        AND processed_at IS NULL)
      OR (state = 'processed'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND claimed_by IS NULL
        AND processed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_room_semantic_controller_inbox_claim
  ON project.room_semantic_controller_inbox(project_id, room_id, state, claim_expires_at, created_at);
