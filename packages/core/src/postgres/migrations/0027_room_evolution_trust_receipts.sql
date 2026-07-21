-- Durable identity bindings and success receipts for controlled Room evolution.
-- This migration extends the append-only 0022 ledger without rewriting history.

CREATE TABLE project.room_evolution_trusted_bindings (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  actor_id text NOT NULL,
  purpose text NOT NULL,
  subject_room_id text NOT NULL,
  room_binding_id text NOT NULL,
  room_binding_generation integer NOT NULL,
  role_id text NOT NULL,
  role_version integer NOT NULL,
  binding_version integer NOT NULL,
  issued_by_principal_id text NOT NULL,
  issuer_grant_id text NOT NULL,
  issued_at text NOT NULL,
  expires_at text NOT NULL,
  integrity_hash text NOT NULL,
  CONSTRAINT room_evolution_trusted_bindings_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_trusted_bindings_version_scope_unique
    UNIQUE (id, project_id, scope_key, binding_version),
  CONSTRAINT room_evolution_trusted_bindings_identity_version_unique
    UNIQUE (project_id, scope_key, room_binding_id, room_binding_generation, purpose, binding_version),
  CONSTRAINT room_evolution_trusted_bindings_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_bindings_subject_room_project_fkey
    FOREIGN KEY (subject_room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_bindings_binding_room_project_fkey
    FOREIGN KEY (room_binding_id, subject_room_id, project_id)
    REFERENCES project.room_bindings(id, room_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_bindings_issuer_grant_fkey
    FOREIGN KEY (project_id, issuer_grant_id)
    REFERENCES project.room_rbac_grants(project_id, grant_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_bindings_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (
          scope_kind = 'room'
          AND room_id IS NOT NULL
          AND btrim(room_id) <> ''
          AND scope_key = ('room:' || room_id)
          AND room_id = subject_room_id
        )
      )
    ),
  CONSTRAINT room_evolution_trusted_bindings_purpose_check
    CHECK (purpose IN ('candidate_producer','independent_evaluator')),
  CONSTRAINT room_evolution_trusted_bindings_version_check
    CHECK (
      room_binding_generation BETWEEN 1 AND 2147483647
      AND role_version BETWEEN 1 AND 2147483647
      AND binding_version BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT room_evolution_trusted_bindings_hash_check
    CHECK (integrity_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_trusted_bindings_window_check
    CHECK (expires_at::timestamptz > issued_at::timestamptz),
  CONSTRAINT room_evolution_trusted_bindings_nonblank_check
    CHECK (
      btrim(actor_id) <> ''
      AND btrim(subject_room_id) <> ''
      AND btrim(room_binding_id) <> ''
      AND btrim(role_id) <> ''
      AND btrim(issued_by_principal_id) <> ''
      AND btrim(issuer_grant_id) <> ''
      AND btrim(issued_at) <> ''
      AND btrim(expires_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_trusted_bindings_scope
  ON project.room_evolution_trusted_bindings(project_id, scope_key, purpose, expires_at);

CREATE FUNCTION project.room_evolution_validate_trusted_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  durable_role_id text;
  durable_role_version integer;
  issuer_role text;
  issuer_room_id text;
  issuer_granted_at text;
  issuer_revoked_at text;
  issuer_principal_id text;
BEGIN
  SELECT seat.role, seat.role_version
    INTO durable_role_id, durable_role_version
    FROM project.room_bindings AS binding
    JOIN project.room_seats AS seat
      ON seat.id = binding.seat_id
      AND seat.room_id = binding.room_id
      AND seat.project_id = binding.project_id
   WHERE binding.id = NEW.room_binding_id
     AND binding.project_id = NEW.project_id
     AND binding.room_id = NEW.subject_room_id
     AND binding.generation = NEW.room_binding_generation;
  IF NOT FOUND
    OR durable_role_id <> NEW.role_id
    OR durable_role_version <> NEW.role_version THEN
    RAISE EXCEPTION 'trusted Room evolution binding must match durable binding generation and seat role';
  END IF;

  SELECT grant_record.principal_id, grant_record.role, grant_record.room_id,
         grant_record.granted_at, grant_record.revoked_at
    INTO issuer_principal_id, issuer_role, issuer_room_id, issuer_granted_at, issuer_revoked_at
    FROM project.room_rbac_grants AS grant_record
   WHERE grant_record.project_id = NEW.project_id
     AND grant_record.grant_id = NEW.issuer_grant_id;
  IF NOT FOUND
    OR issuer_principal_id <> NEW.issued_by_principal_id
    OR issuer_role NOT IN ('owner','admin')
    OR (issuer_room_id IS NOT NULL AND issuer_room_id <> NEW.subject_room_id)
    OR issuer_granted_at::timestamptz > NEW.issued_at::timestamptz
    OR (issuer_revoked_at IS NOT NULL AND issuer_revoked_at::timestamptz <= NEW.issued_at::timestamptz) THEN
    RAISE EXCEPTION 'trusted Room evolution binding requires an active owner/admin issuer grant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER room_evolution_trusted_bindings_validate
  BEFORE INSERT ON project.room_evolution_trusted_bindings
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_validate_trusted_binding();

CREATE TABLE project.room_evolution_trusted_binding_revocations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  trusted_binding_id text NOT NULL,
  revoked_by_principal_id text NOT NULL,
  revoker_grant_id text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  revoked_at text NOT NULL,
  CONSTRAINT room_evolution_trusted_binding_revocations_binding_scope_unique
    UNIQUE (project_id, scope_key, trusted_binding_id),
  CONSTRAINT room_evolution_trusted_binding_revocations_binding_fkey
    FOREIGN KEY (trusted_binding_id, project_id, scope_key)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_binding_revocations_grant_fkey
    FOREIGN KEY (project_id, revoker_grant_id)
    REFERENCES project.room_rbac_grants(project_id, grant_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_binding_revocations_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_trusted_binding_revocations_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (scope_kind = 'room' AND room_id IS NOT NULL AND scope_key = ('room:' || room_id))
      )
    ),
  CONSTRAINT room_evolution_trusted_binding_revocations_payload_check
    CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT room_evolution_trusted_binding_revocations_hash_check
    CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_evolution_trusted_binding_revocations_nonblank_check
    CHECK (
      btrim(revoked_by_principal_id) <> ''
      AND btrim(revoker_grant_id) <> ''
      AND btrim(reason) <> ''
      AND btrim(revoked_at) <> ''
    )
);

CREATE FUNCTION project.room_evolution_validate_trusted_binding_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subject_room_id text;
  revoker_principal_id text;
  revoker_role text;
  revoker_room_id text;
  revoker_granted_at text;
  revoker_revoked_at text;
BEGIN
  SELECT trusted.subject_room_id
    INTO subject_room_id
    FROM project.room_evolution_trusted_bindings AS trusted
   WHERE trusted.id = NEW.trusted_binding_id
     AND trusted.project_id = NEW.project_id
     AND trusted.scope_key = NEW.scope_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trusted Room evolution binding revocation must reference a durable binding in scope';
  END IF;

  SELECT grant_record.principal_id, grant_record.role, grant_record.room_id,
         grant_record.granted_at, grant_record.revoked_at
    INTO revoker_principal_id, revoker_role, revoker_room_id, revoker_granted_at, revoker_revoked_at
    FROM project.room_rbac_grants AS grant_record
   WHERE grant_record.project_id = NEW.project_id
     AND grant_record.grant_id = NEW.revoker_grant_id;
  IF NOT FOUND
    OR revoker_principal_id <> NEW.revoked_by_principal_id
    OR revoker_role NOT IN ('owner','admin')
    OR (revoker_room_id IS NOT NULL AND revoker_room_id <> subject_room_id)
    OR revoker_granted_at::timestamptz > NEW.revoked_at::timestamptz
    OR (revoker_revoked_at IS NOT NULL AND revoker_revoked_at::timestamptz <= NEW.revoked_at::timestamptz) THEN
    RAISE EXCEPTION 'trusted Room evolution binding revocation requires an active owner/admin grant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER room_evolution_trusted_binding_revocations_validate
  BEFORE INSERT ON project.room_evolution_trusted_binding_revocations
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_validate_trusted_binding_revocation();

ALTER TABLE project.room_evolution_candidate_versions
  ADD COLUMN candidate_hash text,
  ADD COLUMN producer_binding_id text,
  ADD COLUMN producer_binding_version integer,
  ADD CONSTRAINT room_evolution_candidates_verified_shape_check CHECK (
    (candidate_hash IS NULL AND producer_binding_id IS NULL AND producer_binding_version IS NULL)
    OR (
      candidate_hash ~ '^sha256:[a-f0-9]{64}$'
      AND producer_binding_id IS NOT NULL
      AND producer_binding_version BETWEEN 1 AND 2147483647
    )
  ),
  ADD CONSTRAINT room_evolution_candidates_producer_binding_fkey
    FOREIGN KEY (producer_binding_id, project_id, scope_key, producer_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version)
    ON DELETE RESTRICT;

ALTER TABLE project.room_evolution_gate_results
  ADD COLUMN candidate_hash text,
  ADD COLUMN candidate_binding_id text,
  ADD COLUMN candidate_binding_version integer,
  ADD COLUMN evaluator_binding_id text,
  ADD COLUMN evaluator_binding_version integer,
  ADD COLUMN evaluation_artifact_hash text,
  ADD COLUMN metrics_hash text,
  ADD CONSTRAINT room_evolution_gate_results_verified_shape_check CHECK (
    promotion_eligible = false
    OR (
      candidate_hash ~ '^sha256:[a-f0-9]{64}$'
      AND candidate_binding_id IS NOT NULL
      AND candidate_binding_version BETWEEN 1 AND 2147483647
      AND evaluator_binding_id IS NOT NULL
      AND evaluator_binding_version BETWEEN 1 AND 2147483647
      AND evaluation_artifact_hash ~ '^sha256:[a-f0-9]{64}$'
      AND metrics_hash ~ '^sha256:[a-f0-9]{64}$'
    )
  ) NOT VALID,
  ADD CONSTRAINT room_evolution_gate_results_candidate_binding_fkey
    FOREIGN KEY (candidate_binding_id, project_id, scope_key, candidate_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT room_evolution_gate_results_evaluator_binding_fkey
    FOREIGN KEY (evaluator_binding_id, project_id, scope_key, evaluator_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version)
    ON DELETE RESTRICT;

CREATE TABLE project.room_evolution_canary_success_outcomes (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  canary_id text NOT NULL,
  experiment_id text NOT NULL,
  candidate_version_id text NOT NULL,
  candidate_hash text NOT NULL,
  candidate_binding_id text NOT NULL,
  candidate_binding_version integer NOT NULL,
  evaluator_binding_id text NOT NULL,
  evaluator_binding_version integer NOT NULL,
  gate_result_ids jsonb NOT NULL,
  allocation_hash text NOT NULL,
  artifact_hash text NOT NULL,
  metrics jsonb NOT NULL,
  metrics_hash text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  completed_at text NOT NULL,
  CONSTRAINT room_evolution_canary_success_outcomes_scope_unique
    UNIQUE (id, project_id, scope_key),
  CONSTRAINT room_evolution_canary_success_outcomes_canary_unique
    UNIQUE (project_id, scope_key, canary_id),
  CONSTRAINT room_evolution_canary_success_outcomes_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_canary_fkey
    FOREIGN KEY (canary_id, project_id, scope_key)
    REFERENCES project.room_evolution_canaries(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_experiment_fkey
    FOREIGN KEY (experiment_id, project_id, scope_key)
    REFERENCES project.room_evolution_experiments(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_candidate_fkey
    FOREIGN KEY (candidate_version_id, project_id, scope_key)
    REFERENCES project.room_evolution_candidate_versions(id, project_id, scope_key) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_candidate_binding_fkey
    FOREIGN KEY (candidate_binding_id, project_id, scope_key, candidate_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_evaluator_binding_fkey
    FOREIGN KEY (evaluator_binding_id, project_id, scope_key, evaluator_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version) ON DELETE RESTRICT,
  CONSTRAINT room_evolution_canary_success_outcomes_scope_check
    CHECK (
      btrim(project_id) <> ''
      AND (
        (scope_kind = 'project' AND room_id IS NULL AND scope_key = ('project:' || project_id))
        OR (scope_kind = 'room' AND room_id IS NOT NULL AND scope_key = ('room:' || room_id))
      )
    ),
  CONSTRAINT room_evolution_canary_success_outcomes_payload_check
    CHECK (
      jsonb_typeof(gate_result_ids) = 'array'
      AND jsonb_array_length(gate_result_ids) > 0
      AND jsonb_typeof(metrics) = 'object'
      AND jsonb_typeof(evidence) = 'array'
    ),
  CONSTRAINT room_evolution_canary_success_outcomes_hash_check
    CHECK (
      candidate_hash ~ '^sha256:[a-f0-9]{64}$'
      AND allocation_hash ~ '^sha256:[a-f0-9]{64}$'
      AND artifact_hash ~ '^sha256:[a-f0-9]{64}$'
      AND metrics_hash ~ '^sha256:[a-f0-9]{64}$'
      AND evidence_hash ~ '^sha256:[a-f0-9]{64}$'
    ),
  CONSTRAINT room_evolution_canary_success_outcomes_version_check
    CHECK (
      candidate_binding_version BETWEEN 1 AND 2147483647
      AND evaluator_binding_version BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT room_evolution_canary_success_outcomes_nonblank_check
    CHECK (btrim(completed_at) <> '')
);

CREATE INDEX idx_room_evolution_canary_success_outcomes_scope
  ON project.room_evolution_canary_success_outcomes(project_id, scope_key, completed_at);

ALTER TABLE project.room_evolution_promotion_decisions
  ADD COLUMN canary_success_outcome_id text,
  ADD COLUMN candidate_hash text,
  ADD COLUMN decision_binding_id text,
  ADD COLUMN decision_binding_version integer,
  ADD CONSTRAINT room_evolution_promotions_verified_shape_check CHECK (
    decision <> 'promoted'
    OR (
      canary_success_outcome_id IS NOT NULL
      AND candidate_hash ~ '^sha256:[a-f0-9]{64}$'
      AND decision_binding_id IS NOT NULL
      AND decision_binding_version BETWEEN 1 AND 2147483647
      AND canary_id IS NOT NULL
      AND rollback_target_candidate_version_id IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT room_evolution_promotions_success_outcome_fkey
    FOREIGN KEY (canary_success_outcome_id, project_id, scope_key)
    REFERENCES project.room_evolution_canary_success_outcomes(id, project_id, scope_key)
    ON DELETE RESTRICT,
  ADD CONSTRAINT room_evolution_promotions_decision_binding_fkey
    FOREIGN KEY (decision_binding_id, project_id, scope_key, decision_binding_version)
    REFERENCES project.room_evolution_trusted_bindings(id, project_id, scope_key, binding_version)
    ON DELETE RESTRICT;

CREATE TRIGGER room_evolution_trusted_bindings_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_trusted_bindings
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();

CREATE TRIGGER room_evolution_trusted_binding_revocations_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_trusted_binding_revocations
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();

CREATE TRIGGER room_evolution_canary_success_outcomes_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_canary_success_outcomes
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
