-- FNXC:SessionRoomProgressRecovery 2026-07-19-06:14:
-- Task 5.8 begins with durable inputs and a fenced recovery-action queue.
-- This migration intentionally does not detect no-progress, mutate task state,
-- select a recovery step, or execute a recovery action.

CREATE TABLE IF NOT EXISTS project.room_task_progress_observations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  node_version bigint NOT NULL,
  turn_id text NOT NULL,
  phase_id text NOT NULL,
  round_id text NOT NULL,
  idempotency_key text NOT NULL,
  progress_signature text NOT NULL,
  semantic_hash text NOT NULL,
  evidence_hash text NOT NULL,
  artifact_hash text NOT NULL,
  test_hash text NOT NULL,
  resolved_dissent_hash text NOT NULL,
  origin jsonb NOT NULL,
  observed_at text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_task_progress_observations_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_progress_observations_node_room_project_fkey
    FOREIGN KEY (node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_progress_observations_turn_fkey
    FOREIGN KEY (turn_id, room_id, project_id)
    REFERENCES project.room_turns(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_progress_observations_id_lineage_unique
    UNIQUE (id, node_id, node_version, room_id, project_id),
  CONSTRAINT room_task_progress_observations_round_unique
    UNIQUE (project_id, room_id, node_id, node_version, turn_id, phase_id, round_id),
  CONSTRAINT room_task_progress_observations_idempotency_unique
    UNIQUE (project_id, room_id, idempotency_key),
  CONSTRAINT room_task_progress_observations_node_version_check
    CHECK (node_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_task_progress_observations_origin_shape_check
    CHECK (jsonb_typeof(origin) = 'object'),
  CONSTRAINT room_task_progress_observations_nonblank_check
    CHECK (
      btrim(node_id) <> ''
      AND btrim(turn_id) <> ''
      AND btrim(phase_id) <> ''
      AND btrim(round_id) <> ''
      AND btrim(idempotency_key) <> ''
      AND btrim(progress_signature) <> ''
      AND btrim(semantic_hash) <> ''
      AND btrim(evidence_hash) <> ''
      AND btrim(artifact_hash) <> ''
      AND btrim(test_hash) <> ''
      AND btrim(resolved_dissent_hash) <> ''
      AND btrim(observed_at) <> ''
      AND btrim(created_at) <> ''
    )
);

CREATE INDEX IF NOT EXISTS idx_room_task_progress_observations_node_time
  ON project.room_task_progress_observations(
    project_id,
    room_id,
    node_id,
    node_version,
    turn_id,
    phase_id,
    observed_at,
    id
  );

CREATE TABLE IF NOT EXISTS project.room_task_recovery_actions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  node_id text NOT NULL,
  node_version bigint NOT NULL,
  observation_id text NOT NULL,
  action_id text NOT NULL,
  action_snapshot jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token text,
  claim_expires_at text,
  claimed_by_worker_id text,
  claimed_at text,
  next_eligible_at text NOT NULL,
  result_payload jsonb,
  last_error_code text,
  operator_approval_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  processed_at text,
  CONSTRAINT room_task_recovery_actions_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_recovery_actions_node_room_project_fkey
    FOREIGN KEY (node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_recovery_actions_observation_lineage_fkey
    FOREIGN KEY (observation_id, node_id, node_version, room_id, project_id)
    REFERENCES project.room_task_progress_observations(id, node_id, node_version, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_recovery_actions_operator_approval_fkey
    FOREIGN KEY (project_id, operator_approval_id)
    REFERENCES project.approval_requests(project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT room_task_recovery_actions_observation_action_unique
    UNIQUE (project_id, room_id, observation_id, action_id),
  CONSTRAINT room_task_recovery_actions_node_version_check
    CHECK (node_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_task_recovery_actions_state_check
    CHECK (state IN ('pending','claimed','processed')),
  CONSTRAINT room_task_recovery_actions_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_task_recovery_actions_action_snapshot_shape_check
    CHECK (jsonb_typeof(action_snapshot) = 'object'),
  CONSTRAINT room_task_recovery_actions_policy_snapshot_shape_check
    CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  CONSTRAINT room_task_recovery_actions_result_shape_check
    CHECK (result_payload IS NULL OR jsonb_typeof(result_payload) = 'object'),
  CONSTRAINT room_task_recovery_actions_nonblank_check
    CHECK (
      btrim(node_id) <> ''
      AND btrim(observation_id) <> ''
      AND btrim(action_id) <> ''
      AND btrim(next_eligible_at) <> ''
      AND btrim(created_at) <> ''
      AND btrim(updated_at) <> ''
      AND (last_error_code IS NULL OR btrim(last_error_code) <> '')
      AND (operator_approval_id IS NULL OR btrim(operator_approval_id) <> '')
    ),
  CONSTRAINT room_task_recovery_actions_claim_shape_check
    CHECK (
      (state = 'pending'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND claimed_by_worker_id IS NULL
        AND claimed_at IS NULL
        AND processed_at IS NULL
        AND result_payload IS NULL)
      OR (state = 'claimed'
        AND claim_token IS NOT NULL
        AND btrim(claim_token) <> ''
        AND claim_expires_at IS NOT NULL
        AND btrim(claim_expires_at) <> ''
        AND claimed_by_worker_id IS NOT NULL
        AND btrim(claimed_by_worker_id) <> ''
        AND claimed_at IS NOT NULL
        AND btrim(claimed_at) <> ''
        AND processed_at IS NULL
        AND result_payload IS NULL)
      OR (state = 'processed'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND claimed_by_worker_id IS NULL
        AND claimed_at IS NULL
        AND processed_at IS NOT NULL
        AND btrim(processed_at) <> ''
        AND result_payload IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_room_task_recovery_actions_claim
  ON project.room_task_recovery_actions(
    project_id,
    room_id,
    state,
    next_eligible_at,
    claim_expires_at,
    created_at
  );

CREATE INDEX IF NOT EXISTS idx_room_task_recovery_actions_node
  ON project.room_task_recovery_actions(
    project_id,
    room_id,
    node_id,
    node_version,
    created_at,
    id
  );

CREATE INDEX IF NOT EXISTS idx_room_task_recovery_actions_operator_approval
  ON project.room_task_recovery_actions(operator_approval_id);
