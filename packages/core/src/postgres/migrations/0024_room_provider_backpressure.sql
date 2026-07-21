CREATE TABLE project.room_provider_backpressure_states (
  project_id text NOT NULL,
  scope_key text NOT NULL,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  model_id text NOT NULL,
  connector_id text NOT NULL,
  node_id text NOT NULL,
  circuit_state text NOT NULL,
  consecutive_failures bigint NOT NULL DEFAULT 0,
  retry_attempt bigint NOT NULL DEFAULT 0,
  retry_not_before text,
  open_until text,
  revision bigint NOT NULL DEFAULT 0,
  last_updated_at text NOT NULL,
  CONSTRAINT room_provider_backpressure_states_primary
    PRIMARY KEY (project_id, scope_key),
  CONSTRAINT room_provider_backpressure_states_scope_unique
    UNIQUE (project_id, provider_id, account_id, model_id, connector_id, node_id),
  CONSTRAINT room_provider_backpressure_states_circuit_check
    CHECK (circuit_state IN ('closed','open','half_open')),
  CONSTRAINT room_provider_backpressure_states_failure_check
    CHECK (consecutive_failures BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_states_retry_check
    CHECK (retry_attempt BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_states_revision_check
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_states_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(scope_key) <> ''
      AND btrim(provider_id) <> ''
      AND btrim(account_id) <> ''
      AND btrim(model_id) <> ''
      AND btrim(connector_id) <> ''
      AND btrim(node_id) <> ''
      AND btrim(last_updated_at) <> ''
      AND (retry_not_before IS NULL OR btrim(retry_not_before) <> '')
      AND (open_until IS NULL OR btrim(open_until) <> '')
    )
);

CREATE INDEX idx_room_provider_backpressure_states_provider
  ON project.room_provider_backpressure_states(project_id, provider_id, account_id, model_id, connector_id, node_id);

CREATE TABLE project.room_provider_backpressure_reservations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  scope_key text NOT NULL,
  room_id text NOT NULL,
  request_id text NOT NULL,
  claim_id text NOT NULL,
  lease_id text NOT NULL,
  lease_epoch bigint NOT NULL,
  expected_aggregate_version bigint NOT NULL,
  work_class text NOT NULL,
  is_half_open_probe boolean NOT NULL DEFAULT false,
  circuit_open_ms integer NOT NULL,
  acquired_at text NOT NULL,
  expires_at text NOT NULL,
  released_at text,
  release_outcome text,
  CONSTRAINT room_provider_backpressure_reservations_state_fkey
    FOREIGN KEY (project_id, scope_key)
    REFERENCES project.room_provider_backpressure_states(project_id, scope_key)
    ON DELETE CASCADE,
  CONSTRAINT room_provider_backpressure_reservations_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_provider_backpressure_reservations_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT room_provider_backpressure_reservations_request_unique
    UNIQUE (project_id, request_id),
  CONSTRAINT room_provider_backpressure_reservations_work_class_check
    CHECK (work_class IN ('normal','verifier','recovery')),
  CONSTRAINT room_provider_backpressure_reservations_epoch_check
    CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_reservations_version_check
    CHECK (expected_aggregate_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_reservations_circuit_open_ms_check
    CHECK (circuit_open_ms BETWEEN 1 AND 2147483647),
  CONSTRAINT room_provider_backpressure_reservations_window_check
    CHECK (expires_at > acquired_at),
  CONSTRAINT room_provider_backpressure_reservations_release_outcome_check
    CHECK (release_outcome IS NULL OR release_outcome IN ('worker_completed','worker_failed','controller_stop','room_not_runnable','lease_lost','recovery_withheld','semantic_inbox_stopped','renew_guard_lost','provider_backpressure','pre_start_authority_lost','start_audit_failed','unknown','expired')),
  CONSTRAINT room_provider_backpressure_reservations_nonblank_check
    CHECK (
      btrim(id) <> ''
      AND btrim(project_id) <> ''
      AND btrim(scope_key) <> ''
      AND btrim(room_id) <> ''
      AND btrim(request_id) <> ''
      AND btrim(claim_id) <> ''
      AND btrim(lease_id) <> ''
      AND btrim(acquired_at) <> ''
      AND btrim(expires_at) <> ''
      AND (released_at IS NULL OR btrim(released_at) <> '')
    )
);

CREATE INDEX idx_room_provider_backpressure_reservations_active
  ON project.room_provider_backpressure_reservations(project_id, scope_key, expires_at, id)
  WHERE released_at IS NULL;

CREATE INDEX idx_room_provider_backpressure_reservations_room
  ON project.room_provider_backpressure_reservations(project_id, room_id, lease_id, lease_epoch, id);

CREATE TABLE project.room_provider_backpressure_operations (
  project_id text NOT NULL,
  scope_key text NOT NULL,
  request_id text NOT NULL,
  operation_kind text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  state_revision bigint NOT NULL,
  reservation_id text,
  occurred_at text NOT NULL,
  CONSTRAINT room_provider_backpressure_operations_primary
    PRIMARY KEY (project_id, scope_key, request_id, operation_kind),
  CONSTRAINT room_provider_backpressure_operations_state_fkey
    FOREIGN KEY (project_id, scope_key)
    REFERENCES project.room_provider_backpressure_states(project_id, scope_key)
    ON DELETE CASCADE,
  CONSTRAINT room_provider_backpressure_operations_reservation_project_fkey
    FOREIGN KEY (reservation_id, project_id)
    REFERENCES project.room_provider_backpressure_reservations(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_provider_backpressure_operations_kind_check
    CHECK (operation_kind IN ('dispatch','success','failure')),
  CONSTRAINT room_provider_backpressure_operations_action_check
    CHECK (action IN ('admit','hold','recorded')),
  CONSTRAINT room_provider_backpressure_operations_revision_check
    CHECK (state_revision BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_provider_backpressure_operations_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_provider_backpressure_operations_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(scope_key) <> ''
      AND btrim(request_id) <> ''
      AND btrim(reason) <> ''
      AND btrim(occurred_at) <> ''
    )
);

CREATE INDEX idx_room_provider_backpressure_operations_reservation
  ON project.room_provider_backpressure_operations(project_id, reservation_id, occurred_at);
