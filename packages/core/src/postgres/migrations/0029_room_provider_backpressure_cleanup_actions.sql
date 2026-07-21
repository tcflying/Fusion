-- FNXC:RoomProviderCleanupLedger 2026-07-20-00:18:
-- Persist cleanup ownership for provider reservations admitted after a caller
-- deadline. A replacement worker can only record original-reservation expiry;
-- this ledger never grants it authority to forge an old provider release.

CREATE TABLE project.room_provider_backpressure_cleanup_actions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  idempotency_key text NOT NULL,
  outbox_id text,
  reservation_id text NOT NULL,
  request_id text NOT NULL,
  claim_id text NOT NULL,
  original_lease_id text NOT NULL,
  original_lease_holder_id text NOT NULL,
  original_lease_host_id text NOT NULL,
  original_lease_epoch bigint NOT NULL,
  expected_aggregate_version bigint NOT NULL,
  reservation_expires_at text NOT NULL,
  completion_kind text NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token text,
  claim_lease_id text,
  claim_lease_epoch bigint,
  claimed_at text,
  claim_expires_at text,
  last_error_code text,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_provider_backpressure_cleanup_actions_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_backpressure_cleanup_actions_reservation_project_fkey
    FOREIGN KEY (reservation_id, project_id)
    REFERENCES project.room_provider_backpressure_reservations(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_backpressure_cleanup_actions_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT room_provider_backpressure_cleanup_actions_idempotency_unique
    UNIQUE (project_id, room_id, idempotency_key),
  CONSTRAINT room_provider_backpressure_cleanup_actions_reservation_kind_unique
    UNIQUE (project_id, reservation_id, completion_kind),
  CONSTRAINT room_provider_backpressure_cleanup_actions_completion_kind_check
    CHECK (completion_kind IN ('pre_send_not_started','late_admission_not_started')),
  CONSTRAINT room_provider_backpressure_cleanup_actions_state_check
    CHECK (state IN ('pending','claimed','expired','released')),
  CONSTRAINT room_provider_backpressure_cleanup_actions_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 2147483647),
  CONSTRAINT room_provider_backpressure_cleanup_actions_original_epoch_check
    CHECK (original_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_cleanup_actions_claim_epoch_check
    CHECK (claim_lease_epoch IS NULL OR claim_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_cleanup_actions_version_check
    CHECK (expected_aggregate_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_cleanup_actions_state_shape_check
    CHECK (
      (state = 'pending'
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND last_error_code IS NULL AND completed_at IS NULL)
      OR (state = 'claimed'
        AND claim_token IS NOT NULL AND claim_lease_id IS NOT NULL AND claim_lease_epoch IS NOT NULL
        AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
        AND last_error_code IS NULL AND completed_at IS NULL)
      OR (state = 'expired'
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND last_error_code = 'reservation_expired_unreleased' AND completed_at IS NOT NULL)
      OR (state = 'released'
        AND claim_token IS NULL AND claim_lease_id IS NULL AND claim_lease_epoch IS NULL
        AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND last_error_code IS NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT room_provider_backpressure_cleanup_actions_time_check
    CHECK (
      reservation_expires_at > created_at
      AND (claim_expires_at IS NULL OR claimed_at IS NULL OR claim_expires_at > claimed_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
    ),
  CONSTRAINT room_provider_backpressure_cleanup_actions_nonblank_check
    CHECK (
      btrim(id) <> '' AND btrim(project_id) <> '' AND btrim(room_id) <> ''
      AND btrim(idempotency_key) <> '' AND btrim(reservation_id) <> ''
      AND btrim(request_id) <> '' AND btrim(claim_id) <> ''
      AND btrim(original_lease_id) <> '' AND btrim(original_lease_holder_id) <> ''
      AND btrim(original_lease_host_id) <> '' AND btrim(reservation_expires_at) <> ''
      AND btrim(completion_kind) <> '' AND btrim(state) <> ''
      AND btrim(created_at) <> '' AND btrim(updated_at) <> ''
      AND (outbox_id IS NULL OR btrim(outbox_id) <> '')
      AND (claim_token IS NULL OR btrim(claim_token) <> '')
      AND (claim_lease_id IS NULL OR btrim(claim_lease_id) <> '')
      AND (claimed_at IS NULL OR btrim(claimed_at) <> '')
      AND (claim_expires_at IS NULL OR btrim(claim_expires_at) <> '')
      AND (last_error_code IS NULL OR btrim(last_error_code) <> '')
      AND (completed_at IS NULL OR btrim(completed_at) <> '')
    )
);

CREATE INDEX idx_room_provider_backpressure_cleanup_actions_claimable
  ON project.room_provider_backpressure_cleanup_actions(project_id, room_id, state, reservation_expires_at, claim_expires_at, created_at);
