-- FNXC:RoomEvolutionExecutionRecovery 2026-07-19-21:40:
-- Persist only execution intent, stable effect idempotency, recoverable claims,
-- and immutable outcomes. This migration does not execute a provider, policy,
-- source candidate, or promotion, and it cannot turn an abandoned claim into success.

CREATE TABLE project.room_evolution_execution_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  effect_count integer NOT NULL,
  completed_effect_count integer NOT NULL DEFAULT 0,
  failed_effect_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text,
  CONSTRAINT room_evolution_execution_runs_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_execution_runs_idempotency_unique
    UNIQUE (project_id, scope_key, idempotency_key),
  CONSTRAINT room_evolution_execution_runs_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_execution_runs_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_execution_runs_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_execution_runs_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (scope_kind = 'room' AND room_id IS NOT NULL AND scope_key = ('room:' || room_id))
      )
    ),
  CONSTRAINT room_evolution_execution_runs_payload_check
    CHECK (jsonb_typeof(request) = 'object'),
  CONSTRAINT room_evolution_execution_runs_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_execution_runs_state_check
    CHECK (state IN ('pending','running','succeeded','failed')),
  CONSTRAINT room_evolution_execution_runs_counts_check
    CHECK (
      effect_count BETWEEN 1 AND 2147483647
      AND completed_effect_count BETWEEN 0 AND effect_count
      AND failed_effect_count BETWEEN 0 AND effect_count
      AND completed_effect_count + failed_effect_count <= effect_count
    ),
  CONSTRAINT room_evolution_execution_runs_terminal_check
    CHECK (
      (state IN ('pending','running') AND completed_at IS NULL)
      OR (state IN ('succeeded','failed') AND completed_at IS NOT NULL)
    ),
  CONSTRAINT room_evolution_execution_runs_nonblank_check
    CHECK (
      btrim(experiment_id) <> ''
      AND btrim(candidate_version_id) <> ''
      AND btrim(idempotency_key) <> ''
      AND btrim(created_at) <> ''
      AND btrim(updated_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_execution_runs_scope_state
  ON project.room_evolution_execution_runs(project_id, scope_key, state, updated_at);

CREATE TABLE project.room_evolution_effect_outbox (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  run_id text NOT NULL,
  effect_key text NOT NULL,
  effect_kind text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  next_eligible_at text,
  claim_token text,
  claim_expires_at text,
  claimed_by_worker_id text,
  claimed_at text,
  last_error_code text,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_evolution_effect_outbox_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_effect_outbox_run_key_unique
    UNIQUE (project_id, scope_key, run_id, effect_key),
  CONSTRAINT room_evolution_effect_outbox_run_fkey
    FOREIGN KEY (run_id, project_id, scope_key)
    REFERENCES project.room_evolution_execution_runs(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_effect_outbox_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (scope_kind = 'room' AND room_id IS NOT NULL AND scope_key = ('room:' || room_id))
      )
    ),
  CONSTRAINT room_evolution_effect_outbox_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT room_evolution_effect_outbox_hash_check
    CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_effect_outbox_state_check
    CHECK (state IN ('pending','claimed','retry_scheduled','succeeded','failed')),
  CONSTRAINT room_evolution_effect_outbox_attempts_check
    CHECK (attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 2147483647),
  CONSTRAINT room_evolution_effect_outbox_state_shape_check
    CHECK (
      (state = 'pending'
        AND claim_token IS NULL AND claim_expires_at IS NULL
        AND claimed_by_worker_id IS NULL AND claimed_at IS NULL
        AND next_eligible_at IS NOT NULL AND completed_at IS NULL
        AND last_error_code IS NULL)
      OR (state = 'claimed'
        AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
        AND claimed_by_worker_id IS NOT NULL AND claimed_at IS NOT NULL
        AND next_eligible_at IS NULL AND completed_at IS NULL)
      OR (state = 'retry_scheduled'
        AND claim_token IS NULL AND claim_expires_at IS NULL
        AND claimed_by_worker_id IS NULL AND claimed_at IS NULL
        AND next_eligible_at IS NOT NULL AND completed_at IS NULL
        AND last_error_code IS NOT NULL)
      OR (state IN ('succeeded','failed')
        AND claim_token IS NULL AND claim_expires_at IS NULL
        AND claimed_by_worker_id IS NULL AND claimed_at IS NULL
        AND next_eligible_at IS NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT room_evolution_effect_outbox_nonblank_check
    CHECK (
      btrim(run_id) <> ''
      AND btrim(effect_key) <> ''
      AND btrim(effect_kind) <> ''
      AND btrim(created_at) <> ''
      AND btrim(updated_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_effect_outbox_claimable
  ON project.room_evolution_effect_outbox(project_id, scope_key, state, next_eligible_at, claim_expires_at);

CREATE TABLE project.room_evolution_execution_outcomes (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  run_id text NOT NULL,
  effect_id text NOT NULL,
  claim_token text NOT NULL,
  attempt_count integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  error_code text,
  recorded_at text NOT NULL,
  CONSTRAINT room_evolution_execution_outcomes_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_execution_outcomes_effect_claim_unique
    UNIQUE (project_id, scope_key, effect_id, claim_token),
  CONSTRAINT room_evolution_execution_outcomes_run_fkey
    FOREIGN KEY (run_id, project_id, scope_key)
    REFERENCES project.room_evolution_execution_runs(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_execution_outcomes_effect_fkey
    FOREIGN KEY (effect_id, project_id, scope_key)
    REFERENCES project.room_evolution_effect_outbox(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_execution_outcomes_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (scope_kind = 'room' AND room_id IS NOT NULL AND scope_key = ('room:' || room_id))
      )
    ),
  CONSTRAINT room_evolution_execution_outcomes_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT room_evolution_execution_outcomes_hash_check
    CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_execution_outcomes_kind_check
    CHECK (kind IN ('claim_expired','retry_scheduled','succeeded','failed')),
  CONSTRAINT room_evolution_execution_outcomes_error_shape_check
    CHECK (
      (kind = 'succeeded' AND error_code IS NULL)
      OR (kind <> 'succeeded' AND error_code IS NOT NULL)
    ),
  CONSTRAINT room_evolution_execution_outcomes_attempt_check
    CHECK (attempt_count BETWEEN 1 AND 2147483647),
  CONSTRAINT room_evolution_execution_outcomes_nonblank_check
    CHECK (
      btrim(run_id) <> ''
      AND btrim(effect_id) <> ''
      AND btrim(claim_token) <> ''
      AND btrim(recorded_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_execution_outcomes_run_time
  ON project.room_evolution_execution_outcomes(project_id, scope_key, run_id, recorded_at);
