-- FNXC:RoomProviderAdmissionTimeoutTombstone 2026-07-20-23:10:
-- A caller deadline cannot prove that provider admission ended without a
-- permit. Fence the exact pending outbox generation first, then resolve this
-- durable tombstone only through a verified reservation cleanup binding or an
-- explicit terminal no-permit gate outcome. No clock-only expiry transition is
-- represented by this schema; claim expiry only transfers recovery ownership.

CREATE TABLE project.room_provider_admission_timeout_tombstones (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  gate_attempt_id text NOT NULL,
  request_hash text NOT NULL,
  outbox_id text NOT NULL,
  outbox_binding_id text NOT NULL,
  outbox_attempt_count integer NOT NULL,
  sender_lease_id text NOT NULL,
  sender_lease_holder_id text NOT NULL,
  sender_lease_host_id text NOT NULL,
  sender_lease_epoch bigint NOT NULL,
  timeout_error_code text NOT NULL,
  state text NOT NULL,
  cleanup_action_id text,
  reservation_id text,
  terminal_gate_outcome_id text,
  terminal_gate_outcome text,
  terminal_at text,
  claim_token text,
  claim_lease_id text,
  claim_lease_epoch bigint,
  claimed_at text,
  claim_expires_at text,
  next_attempt_at text,
  resolved_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_provider_admission_timeout_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_timeout_outbox_fkey
    FOREIGN KEY (project_id, outbox_id)
    REFERENCES project.room_outbox(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_timeout_cleanup_action_fkey
    FOREIGN KEY (cleanup_action_id, project_id)
    REFERENCES project.room_provider_backpressure_cleanup_actions(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_timeout_reservation_fkey
    FOREIGN KEY (reservation_id, project_id)
    REFERENCES project.room_provider_backpressure_reservations(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_timeout_gate_attempt_unique
    UNIQUE (project_id, room_id, gate_attempt_id),
  CONSTRAINT room_provider_admission_timeout_target_unique
    UNIQUE (project_id, room_id, outbox_id, outbox_attempt_count),
  CONSTRAINT room_provider_admission_timeout_cleanup_action_unique
    UNIQUE (project_id, cleanup_action_id),
  CONSTRAINT room_provider_admission_timeout_terminal_outcome_unique
    UNIQUE (project_id, terminal_gate_outcome_id),
  CONSTRAINT room_provider_admission_timeout_claim_token_unique
    UNIQUE (project_id, claim_token),
  CONSTRAINT room_provider_admission_timeout_request_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_provider_admission_timeout_attempt_count_check
    CHECK (outbox_attempt_count BETWEEN 0 AND 2147483647),
  CONSTRAINT room_provider_admission_timeout_sender_epoch_check
    CHECK (sender_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_admission_timeout_claim_epoch_check
    CHECK (claim_lease_epoch IS NULL OR claim_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_admission_timeout_state_check
    CHECK (state IN ('pending','reservation_bound','terminal_outcome_recorded','terminal_outcome_claimed','terminal_without_permit')),
  CONSTRAINT room_provider_admission_timeout_terminal_outcome_check
    CHECK (
      terminal_gate_outcome IS NULL
      OR terminal_gate_outcome IN ('deferred_without_permit','cancelled_without_permit','failed_without_permit')
    ),
  CONSTRAINT room_provider_admission_timeout_state_shape_check
    CHECK (
      (state = 'pending'
        AND cleanup_action_id IS NULL AND reservation_id IS NULL
        AND terminal_gate_outcome_id IS NULL AND terminal_gate_outcome IS NULL
        AND terminal_at IS NULL
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND next_attempt_at IS NULL AND resolved_at IS NULL)
      OR (state = 'reservation_bound'
        AND cleanup_action_id IS NOT NULL AND reservation_id IS NOT NULL
        AND terminal_gate_outcome_id IS NULL AND terminal_gate_outcome IS NULL
        AND terminal_at IS NULL
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND next_attempt_at IS NULL AND resolved_at IS NOT NULL)
      OR (state = 'terminal_outcome_recorded'
        AND cleanup_action_id IS NULL AND reservation_id IS NULL
        AND terminal_gate_outcome_id IS NOT NULL AND terminal_gate_outcome IS NOT NULL
        AND terminal_at IS NOT NULL
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND next_attempt_at IS NULL AND resolved_at IS NULL)
      OR (state = 'terminal_outcome_claimed'
        AND cleanup_action_id IS NULL AND reservation_id IS NULL
        AND terminal_gate_outcome_id IS NOT NULL AND terminal_gate_outcome IS NOT NULL
        AND terminal_at IS NOT NULL
        AND claim_token IS NOT NULL AND claim_lease_id IS NOT NULL AND claim_lease_epoch IS NOT NULL
        AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
        AND next_attempt_at IS NULL AND resolved_at IS NULL)
      OR (state = 'terminal_without_permit'
        AND cleanup_action_id IS NULL AND reservation_id IS NULL
        AND terminal_gate_outcome_id IS NOT NULL AND terminal_gate_outcome IS NOT NULL
        AND terminal_at IS NOT NULL
        AND claim_token IS NOT NULL AND claim_lease_id IS NOT NULL AND claim_lease_epoch IS NOT NULL
        AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
        AND next_attempt_at IS NOT NULL AND resolved_at IS NOT NULL)
    ),
  CONSTRAINT room_provider_admission_timeout_time_check
    CHECK (
      (resolved_at IS NULL OR resolved_at >= created_at)
      AND (terminal_at IS NULL OR resolved_at IS NULL OR terminal_at <= resolved_at)
      AND (claimed_at IS NULL OR terminal_at IS NULL OR claimed_at >= terminal_at)
      AND (claim_expires_at IS NULL OR claimed_at IS NULL OR claim_expires_at > claimed_at)
      AND (resolved_at IS NULL OR claimed_at IS NULL OR resolved_at >= claimed_at)
      AND (next_attempt_at IS NULL OR resolved_at IS NULL OR next_attempt_at > resolved_at)
    ),
  CONSTRAINT room_provider_admission_timeout_nonblank_check
    CHECK (
      btrim(id) <> '' AND btrim(project_id) <> '' AND btrim(room_id) <> ''
      AND btrim(gate_attempt_id) <> '' AND btrim(request_hash) <> ''
      AND btrim(outbox_id) <> '' AND btrim(outbox_binding_id) <> ''
      AND btrim(sender_lease_id) <> '' AND btrim(sender_lease_holder_id) <> ''
      AND btrim(sender_lease_host_id) <> '' AND btrim(timeout_error_code) <> ''
      AND btrim(state) <> '' AND btrim(created_at) <> '' AND btrim(updated_at) <> ''
      AND (cleanup_action_id IS NULL OR btrim(cleanup_action_id) <> '')
      AND (reservation_id IS NULL OR btrim(reservation_id) <> '')
      AND (terminal_gate_outcome_id IS NULL OR btrim(terminal_gate_outcome_id) <> '')
      AND (terminal_gate_outcome IS NULL OR btrim(terminal_gate_outcome) <> '')
      AND (terminal_at IS NULL OR btrim(terminal_at) <> '')
      AND (claim_token IS NULL OR btrim(claim_token) <> '')
      AND (claim_lease_id IS NULL OR btrim(claim_lease_id) <> '')
      AND (claimed_at IS NULL OR btrim(claimed_at) <> '')
      AND (claim_expires_at IS NULL OR btrim(claim_expires_at) <> '')
      AND (next_attempt_at IS NULL OR btrim(next_attempt_at) <> '')
      AND (resolved_at IS NULL OR btrim(resolved_at) <> '')
    )
);

CREATE INDEX idx_room_provider_admission_timeout_unresolved
  ON project.room_provider_admission_timeout_tombstones(project_id, room_id, state, created_at);
