-- FNXC:RoomEvolutionController 2026-07-19-13:21: Controlled evolution keeps
-- append-only project/Room evidence and rollback lineage in the existing project
-- schema. The store/controller must append records; no candidate is editable in place.

CREATE TABLE project.room_evolution_hypotheses (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  source_signal_kinds jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  declared_scope jsonb NOT NULL,
  risk_class text NOT NULL,
  expected_mechanism text NOT NULL,
  affected_domains jsonb NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_evolution_hypotheses_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_hypotheses_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_hypotheses_scope_revision_unique
    UNIQUE (project_id, scope_key, revision),
  CONSTRAINT room_evolution_hypotheses_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_hypotheses_revision_check
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT room_evolution_hypotheses_state_check
    CHECK (state IN ('proposed','experimenting','promoted','rejected','rolled_back','inconclusive')),
  CONSTRAINT room_evolution_hypotheses_signal_shape_check
    CHECK (jsonb_typeof(source_signal_kinds) = 'array'),
  CONSTRAINT room_evolution_hypotheses_evidence_shape_check
    CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_hypotheses_declared_scope_check
    CHECK (jsonb_typeof(declared_scope) = 'array'),
  CONSTRAINT room_evolution_hypotheses_domains_shape_check
    CHECK (jsonb_typeof(affected_domains) = 'array'),
  CONSTRAINT room_evolution_hypotheses_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_hypotheses_risk_check
    CHECK (risk_class IN ('low','moderate','high','critical')),
  CONSTRAINT room_evolution_hypotheses_nonblank_check
    CHECK (
      btrim(expected_mechanism) <> ''
      AND btrim(created_by_actor_id) <> ''
      AND btrim(created_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_hypotheses_scope_state
  ON project.room_evolution_hypotheses(project_id, scope_key, state, created_at);

CREATE TABLE project.room_evolution_candidate_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  hypothesis_id text NOT NULL,
  version_number integer NOT NULL,
  candidate_kind text NOT NULL,
  base_revision text NOT NULL,
  candidate_ref text NOT NULL,
  isolation_kind text NOT NULL,
  isolation_ref text NOT NULL,
  immutable_input jsonb NOT NULL,
  input_hash text NOT NULL,
  produced_by_actor_id text NOT NULL,
  base_candidate_version_id text,
  rollback_target_candidate_version_id text,
  created_at text NOT NULL,
  CONSTRAINT room_evolution_candidates_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_candidates_hypothesis_scope_fkey
    FOREIGN KEY (hypothesis_id, project_id, scope_key)
    REFERENCES project.room_evolution_hypotheses(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_candidates_base_scope_fkey
    FOREIGN KEY (base_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_candidates_rollback_scope_fkey
    FOREIGN KEY (rollback_target_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_candidates_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_candidates_hypothesis_version_unique
    UNIQUE (project_id, scope_key, hypothesis_id, version_number),
  CONSTRAINT room_evolution_candidates_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_candidates_version_check
    CHECK (version_number BETWEEN 1 AND 2147483647),
  CONSTRAINT room_evolution_candidates_kind_check
    CHECK (candidate_kind IN ('prompt','skill','context','task_decomposition','protocol','role_assignment','model_routing','retry_concurrency','connector_adapter','evaluation_rule','source_code')),
  CONSTRAINT room_evolution_candidates_isolation_check
    CHECK (isolation_kind IN ('branch','worktree','versioned_policy_store')),
  CONSTRAINT room_evolution_candidates_source_isolation_check
    CHECK (candidate_kind <> 'source_code' OR isolation_kind IN ('branch','worktree')),
  CONSTRAINT room_evolution_candidates_input_shape_check
    CHECK (jsonb_typeof(immutable_input) = 'object'),
  CONSTRAINT room_evolution_candidates_hash_check
    CHECK (input_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_candidates_lineage_check
    CHECK (
      id <> COALESCE(base_candidate_version_id, '')
      AND id <> COALESCE(rollback_target_candidate_version_id, '')
      AND (version_number = 1 OR base_candidate_version_id IS NOT NULL)
    ),
  CONSTRAINT room_evolution_candidates_nonblank_check
    CHECK (
      btrim(base_revision) <> ''
      AND btrim(candidate_ref) <> ''
      AND btrim(base_revision) <> btrim(candidate_ref)
      AND btrim(isolation_ref) <> ''
      AND btrim(produced_by_actor_id) <> ''
      AND btrim(created_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_candidates_scope_created
  ON project.room_evolution_candidate_versions(project_id, scope_key, created_at);

CREATE TABLE project.room_evolution_experiments (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  hypothesis_id text NOT NULL,
  candidate_version_id text NOT NULL,
  state text NOT NULL,
  input_snapshot_hash text NOT NULL,
  authorization_evidence jsonb NOT NULL,
  authorization_hash text NOT NULL,
  capacity_pool text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_evolution_experiments_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_experiments_hypothesis_scope_fkey
    FOREIGN KEY (hypothesis_id, project_id, scope_key)
    REFERENCES project.room_evolution_hypotheses(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_experiments_candidate_scope_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_experiments_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_experiments_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_experiments_state_check
    CHECK (state IN ('planned','running','completed','failed','cancelled','inconclusive')),
  CONSTRAINT room_evolution_experiments_pool_check
    CHECK (capacity_pool IN ('evolution_low_priority','evolution_paused')),
  CONSTRAINT room_evolution_experiments_authorization_shape_check
    CHECK (jsonb_typeof(authorization_evidence) = 'object'),
  CONSTRAINT room_evolution_experiments_hashes_check
    CHECK (
      input_snapshot_hash ~ '^sha256:[a-f0-9]{64}$'
      AND authorization_hash ~ '^sha256:[a-f0-9]{64}$'
    ),
  CONSTRAINT room_evolution_experiments_nonblank_check
    CHECK (btrim(created_by_actor_id) <> '' AND btrim(created_at) <> '')
);

CREATE INDEX idx_room_evolution_experiments_scope_state
  ON project.room_evolution_experiments(project_id, scope_key, state, created_at);

CREATE TABLE project.room_evolution_benchmark_cases (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  domain text NOT NULL,
  case_kind text NOT NULL,
  contains_private_room_data boolean NOT NULL,
  source_authorization_id text,
  authorization_evidence jsonb NOT NULL,
  case_payload jsonb NOT NULL,
  expected_outcome jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_evolution_benchmarks_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_benchmarks_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_benchmarks_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_benchmarks_case_kind_check
    CHECK (case_kind IN ('golden','rolling_authorized','adversarial','historical_replay')),
  CONSTRAINT room_evolution_benchmarks_private_data_check
    CHECK (
      NOT contains_private_room_data
      OR (
        source_authorization_id IS NOT NULL
        AND btrim(source_authorization_id) <> ''
        AND jsonb_typeof(authorization_evidence) = 'object'
        AND authorization_evidence <> '{}'::jsonb
      )
    ),
  CONSTRAINT room_evolution_benchmarks_payload_shape_check
    CHECK (
      jsonb_typeof(authorization_evidence) = 'object'
      AND jsonb_typeof(case_payload) = 'object'
      AND jsonb_typeof(expected_outcome) = 'object'
    ),
  CONSTRAINT room_evolution_benchmarks_hash_check
    CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_benchmarks_nonblank_check
    CHECK (btrim(domain) <> '' AND btrim(created_at) <> '')
);

CREATE INDEX idx_room_evolution_benchmarks_scope_domain
  ON project.room_evolution_benchmark_cases(project_id, scope_key, domain, case_kind, created_at);

CREATE TABLE project.room_evolution_benchmark_results (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  benchmark_case_id text NOT NULL,
  evaluator_actor_id text NOT NULL,
  evaluator_kind text NOT NULL,
  outcome text NOT NULL,
  metrics jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  completed_at text NOT NULL,
  CONSTRAINT room_evolution_benchmark_results_room_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_benchmark_results_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_benchmark_results_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_benchmark_results_case_fkey
    FOREIGN KEY (benchmark_case_id, project_id, scope_key)
    REFERENCES project.room_evolution_benchmark_cases(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_benchmark_results_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_benchmark_results_run_unique
    UNIQUE (project_id, scope_key, experiment_id, candidate_version_id, benchmark_case_id, evaluator_actor_id),
  CONSTRAINT room_evolution_benchmark_results_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_benchmark_results_evaluator_check
    CHECK (evaluator_kind IN ('deterministic','independent_reviewer','producer_self_report')),
  CONSTRAINT room_evolution_benchmark_results_outcome_check
    CHECK (outcome IN ('passed','failed','error','inconclusive')),
  CONSTRAINT room_evolution_benchmark_results_payload_shape_check
    CHECK (jsonb_typeof(metrics) = 'object' AND jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_benchmark_results_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_benchmark_results_nonblank_check
    CHECK (btrim(evaluator_actor_id) <> '' AND btrim(completed_at) <> '')
);

CREATE INDEX idx_room_evolution_benchmark_results_scope
  ON project.room_evolution_benchmark_results(project_id, scope_key, experiment_id, completed_at);

CREATE TABLE project.room_evolution_gate_results (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  benchmark_result_id text,
  gate_name text NOT NULL,
  gate_class text NOT NULL,
  outcome text NOT NULL,
  evaluator_actor_id text NOT NULL,
  evaluator_kind text NOT NULL,
  candidate_producer_actor_id text NOT NULL,
  metrics jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  promotion_eligible boolean NOT NULL,
  completed_at text NOT NULL,
  CONSTRAINT room_evolution_gate_results_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_gate_results_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_gate_results_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_gate_results_benchmark_fkey
    FOREIGN KEY (benchmark_result_id, project_id, scope_key)
    REFERENCES project.room_evolution_benchmark_results(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_gate_results_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_gate_results_identity_unique
    UNIQUE (project_id, scope_key, experiment_id, candidate_version_id, gate_name, evaluator_actor_id),
  CONSTRAINT room_evolution_gate_results_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_gate_results_class_check
    CHECK (gate_class IN ('hard','optimization')),
  CONSTRAINT room_evolution_gate_results_outcome_check
    CHECK (outcome IN ('passed','failed','error','not_run')),
  CONSTRAINT room_evolution_gate_results_evaluator_check
    CHECK (evaluator_kind IN ('deterministic','independent_reviewer','producer_self_report')),
  CONSTRAINT room_evolution_gate_results_payload_shape_check
    CHECK (jsonb_typeof(metrics) = 'object' AND jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_gate_results_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_gate_results_independence_check
    CHECK (
      NOT promotion_eligible
      OR (
        outcome = 'passed'
        AND evaluator_kind IN ('deterministic','independent_reviewer')
        AND evaluator_actor_id <> candidate_producer_actor_id
      )
    ),
  CONSTRAINT room_evolution_gate_results_nonblank_check
    CHECK (
      btrim(gate_name) <> ''
      AND btrim(evaluator_actor_id) <> ''
      AND btrim(candidate_producer_actor_id) <> ''
      AND btrim(completed_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_gate_results_scope
  ON project.room_evolution_gate_results(project_id, scope_key, experiment_id, gate_class, completed_at);

CREATE TABLE project.room_evolution_canaries (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  allocation_version integer NOT NULL,
  allocation jsonb NOT NULL,
  success_criteria jsonb NOT NULL,
  failure_criteria jsonb NOT NULL,
  state text NOT NULL,
  rollback_target_candidate_version_id text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_evolution_canaries_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canaries_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canaries_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canaries_rollback_target_fkey
    FOREIGN KEY (rollback_target_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canaries_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_canaries_allocation_unique
    UNIQUE (project_id, scope_key, candidate_version_id, allocation_version),
  CONSTRAINT room_evolution_canaries_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_canaries_allocation_version_check
    CHECK (allocation_version BETWEEN 1 AND 2147483647),
  CONSTRAINT room_evolution_canaries_state_check
    CHECK (state IN ('planned','running','paused','succeeded','failed','rolled_back','cancelled')),
  CONSTRAINT room_evolution_canaries_payload_shape_check
    CHECK (
      jsonb_typeof(allocation) = 'object'
      AND jsonb_typeof(success_criteria) = 'object'
      AND jsonb_typeof(failure_criteria) = 'object'
    ),
  CONSTRAINT room_evolution_canaries_lineage_check
    CHECK (candidate_version_id <> rollback_target_candidate_version_id),
  CONSTRAINT room_evolution_canaries_nonblank_check
    CHECK (btrim(created_at) <> '')
);

CREATE INDEX idx_room_evolution_canaries_scope_state
  ON project.room_evolution_canaries(project_id, scope_key, state, created_at);

CREATE TABLE project.room_evolution_canary_observations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  canary_id text NOT NULL,
  metric_name text NOT NULL,
  metric_value jsonb NOT NULL,
  threshold jsonb NOT NULL,
  breached boolean NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  observed_at text NOT NULL,
  CONSTRAINT room_evolution_canary_observations_room_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_observations_canary_fkey
    FOREIGN KEY (canary_id, project_id, scope_key)
    REFERENCES project.room_evolution_canaries(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_observations_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_canary_observations_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_canary_observations_payload_check
    CHECK (
      jsonb_typeof(metric_value) = 'object'
      AND jsonb_typeof(threshold) = 'object'
      AND jsonb_typeof(evidence) = 'array'
    ),
  CONSTRAINT room_evolution_canary_observations_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_canary_observations_nonblank_check
    CHECK (btrim(metric_name) <> '' AND btrim(observed_at) <> '')
);

CREATE INDEX idx_room_evolution_canary_observations_scope
  ON project.room_evolution_canary_observations(project_id, scope_key, canary_id, observed_at);

CREATE TABLE project.room_evolution_promotion_decisions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  canary_id text,
  decision text NOT NULL,
  risk_class text NOT NULL,
  authority_tier text NOT NULL,
  candidate_producer_actor_id text NOT NULL,
  decision_actor_id text NOT NULL,
  approval_request_id text,
  authorization_evidence jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  rollback_target_candidate_version_id text,
  decided_at text NOT NULL,
  CONSTRAINT room_evolution_promotions_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_canary_fkey
    FOREIGN KEY (canary_id, project_id, scope_key)
    REFERENCES project.room_evolution_canaries(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_rollback_target_fkey
    FOREIGN KEY (rollback_target_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_approval_request_fkey
    FOREIGN KEY (approval_request_id)
    REFERENCES project.approval_requests(id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_promotions_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_promotions_candidate_decision_unique
    UNIQUE (project_id, scope_key, experiment_id, candidate_version_id, decided_at),
  CONSTRAINT room_evolution_promotions_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_promotions_decision_check
    CHECK (decision IN ('promoted','rejected','inconclusive','rollback_required')),
  CONSTRAINT room_evolution_promotions_risk_check
    CHECK (risk_class IN ('low','moderate','high','critical')),
  CONSTRAINT room_evolution_promotions_authority_check
    CHECK (authority_tier IN ('automatic_pre_authorized','independent','human')),
  CONSTRAINT room_evolution_promotions_payload_shape_check
    CHECK (jsonb_typeof(authorization_evidence) = 'object' AND jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_promotions_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_promotions_no_self_accept_check
    CHECK (decision <> 'promoted' OR decision_actor_id <> candidate_producer_actor_id),
  CONSTRAINT room_evolution_promotions_canary_check
    CHECK (decision <> 'promoted' OR (canary_id IS NOT NULL AND rollback_target_candidate_version_id IS NOT NULL)),
  CONSTRAINT room_evolution_promotions_high_risk_check
    CHECK (risk_class NOT IN ('high','critical') OR (authority_tier = 'human' AND approval_request_id IS NOT NULL)),
  CONSTRAINT room_evolution_promotions_nonblank_check
    CHECK (
      btrim(candidate_producer_actor_id) <> ''
      AND btrim(decision_actor_id) <> ''
      AND btrim(decided_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_promotions_scope_decision
  ON project.room_evolution_promotion_decisions(project_id, scope_key, decision, decided_at);

CREATE TABLE project.room_evolution_rollbacks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  promotion_decision_id text NOT NULL,
  canary_id text NOT NULL,
  from_candidate_version_id text NOT NULL,
  to_candidate_version_id text NOT NULL,
  trigger_kind text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  executed_at text NOT NULL,
  CONSTRAINT room_evolution_rollbacks_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_rollbacks_promotion_fkey
    FOREIGN KEY (promotion_decision_id, project_id, scope_key)
    REFERENCES project.room_evolution_promotion_decisions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_rollbacks_canary_fkey
    FOREIGN KEY (canary_id, project_id, scope_key)
    REFERENCES project.room_evolution_canaries(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_rollbacks_from_candidate_fkey
    FOREIGN KEY (from_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_rollbacks_to_candidate_fkey
    FOREIGN KEY (to_candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key)
    ON DELETE RESTRICT,
  CONSTRAINT room_evolution_rollbacks_id_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_rollbacks_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
        )
      )
    ),
  CONSTRAINT room_evolution_rollbacks_trigger_check
    CHECK (trigger_kind IN ('automatic','operator')),
  CONSTRAINT room_evolution_rollbacks_payload_shape_check
    CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_rollbacks_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_rollbacks_lineage_check
    CHECK (from_candidate_version_id <> to_candidate_version_id),
  CONSTRAINT room_evolution_rollbacks_nonblank_check
    CHECK (btrim(reason) <> '' AND btrim(executed_at) <> '')
);

CREATE INDEX idx_room_evolution_rollbacks_scope_time
  ON project.room_evolution_rollbacks(project_id, scope_key, executed_at);

CREATE FUNCTION project.room_evolution_reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'room evolution history is append-only: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER room_evolution_hypotheses_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_hypotheses
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_candidate_versions_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_candidate_versions
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_experiments_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_experiments
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_benchmark_cases_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_benchmark_cases
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_benchmark_results_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_benchmark_results
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_gate_results_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_gate_results
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_canaries_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_canaries
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_canary_observations_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_canary_observations
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_promotion_decisions_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_promotion_decisions
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
CREATE TRIGGER room_evolution_rollbacks_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_rollbacks
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
