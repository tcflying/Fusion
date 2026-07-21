-- FNXC:RoomEvolutionLegacyProvenance 2026-07-19-21:40:
-- Trust receipts introduced by 0027 cannot be reconstructed for legacy 0022
-- promotion signals. Preserve each original record in an append-only quarantine
-- ledger, then fail-close only the legacy eligibility/success fields before 0027
-- adds its verified-provenance constraints.

CREATE TABLE project.room_evolution_legacy_provenance_quarantines (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  record_kind text NOT NULL,
  record_id text NOT NULL,
  quarantine_reason text NOT NULL,
  source_migration_version text NOT NULL,
  legacy_snapshot jsonb NOT NULL,
  quarantined_at text NOT NULL DEFAULT (now()::text),
  CONSTRAINT room_evolution_legacy_provenance_quarantines_record_unique
    UNIQUE (project_id, scope_key, record_kind, record_id),
  CONSTRAINT room_evolution_legacy_provenance_quarantines_scope_check
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
  CONSTRAINT room_evolution_legacy_provenance_quarantines_kind_check
    CHECK (record_kind IN ('gate_result','canary','promotion_decision')),
  CONSTRAINT room_evolution_legacy_provenance_quarantines_source_check
    CHECK (source_migration_version = '0022'),
  CONSTRAINT room_evolution_legacy_provenance_quarantines_snapshot_check
    CHECK (jsonb_typeof(legacy_snapshot) = 'object'),
  CONSTRAINT room_evolution_legacy_provenance_quarantines_nonblank_check
    CHECK (
      btrim(record_id) <> ''
      AND btrim(quarantine_reason) <> ''
      AND btrim(quarantined_at) <> ''
    )
);

CREATE INDEX idx_room_evolution_legacy_provenance_quarantines_scope
  ON project.room_evolution_legacy_provenance_quarantines(project_id, scope_key, record_kind, quarantined_at);

DO $$
BEGIN
  -- A database that already recorded 0027 has passed its strict shape checks.
  -- Leave those records untouched; this bridge only supplies the new audit table
  -- and later guard migration for that historical deployment shape.
  IF EXISTS (
    SELECT 1
    FROM public.fusion_schema_migrations
    WHERE version = '0027'
  ) THEN
    RETURN;
  END IF;

  -- PostgreSQL DDL and the applier run in one transaction. Drop only the three
  -- affected append-only triggers, write immutable originals, fail-close the
  -- unverified status fields, and recreate the exact triggers before commit.
  EXECUTE 'DROP TRIGGER IF EXISTS room_evolution_gate_results_append_only ON project.room_evolution_gate_results';
  EXECUTE 'DROP TRIGGER IF EXISTS room_evolution_canaries_append_only ON project.room_evolution_canaries';
  EXECUTE 'DROP TRIGGER IF EXISTS room_evolution_promotion_decisions_append_only ON project.room_evolution_promotion_decisions';

  INSERT INTO project.room_evolution_legacy_provenance_quarantines (
    id, project_id, room_id, scope_kind, scope_key, record_kind, record_id,
    quarantine_reason, source_migration_version, legacy_snapshot
  )
  SELECT
    '0026a:gate_result:' || gate_result.id,
    gate_result.project_id,
    gate_result.room_id,
    gate_result.scope_kind,
    gate_result.scope_key,
    'gate_result',
    gate_result.id,
    'pre_trust_receipt_promotion_eligibility',
    '0022',
    to_jsonb(gate_result)
  FROM project.room_evolution_gate_results AS gate_result
  WHERE gate_result.promotion_eligible = true
  ON CONFLICT (project_id, scope_key, record_kind, record_id) DO NOTHING;

  INSERT INTO project.room_evolution_legacy_provenance_quarantines (
    id, project_id, room_id, scope_kind, scope_key, record_kind, record_id,
    quarantine_reason, source_migration_version, legacy_snapshot
  )
  SELECT
    '0026a:canary:' || canary.id,
    canary.project_id,
    canary.room_id,
    canary.scope_kind,
    canary.scope_key,
    'canary',
    canary.id,
    'pre_trust_receipt_canary_success',
    '0022',
    to_jsonb(canary)
  FROM project.room_evolution_canaries AS canary
  WHERE canary.state = 'succeeded'
  ON CONFLICT (project_id, scope_key, record_kind, record_id) DO NOTHING;

  INSERT INTO project.room_evolution_legacy_provenance_quarantines (
    id, project_id, room_id, scope_kind, scope_key, record_kind, record_id,
    quarantine_reason, source_migration_version, legacy_snapshot
  )
  SELECT
    '0026a:promotion_decision:' || promotion_record.id,
    promotion_record.project_id,
    promotion_record.room_id,
    promotion_record.scope_kind,
    promotion_record.scope_key,
    'promotion_decision',
    promotion_record.id,
    'pre_trust_receipt_promotion',
    '0022',
    to_jsonb(promotion_record)
  FROM project.room_evolution_promotion_decisions AS promotion_record
  WHERE promotion_record.decision = 'promoted'
  ON CONFLICT (project_id, scope_key, record_kind, record_id) DO NOTHING;

  UPDATE project.room_evolution_gate_results
  SET promotion_eligible = false
  WHERE promotion_eligible = true;

  UPDATE project.room_evolution_canaries
  SET state = 'paused'
  WHERE state = 'succeeded';

  UPDATE project.room_evolution_promotion_decisions
  SET decision = 'inconclusive'
  WHERE decision = 'promoted';

  EXECUTE 'CREATE TRIGGER room_evolution_gate_results_append_only BEFORE UPDATE OR DELETE ON project.room_evolution_gate_results FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation()';
  EXECUTE 'CREATE TRIGGER room_evolution_canaries_append_only BEFORE UPDATE OR DELETE ON project.room_evolution_canaries FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation()';
  EXECUTE 'CREATE TRIGGER room_evolution_promotion_decisions_append_only BEFORE UPDATE OR DELETE ON project.room_evolution_promotion_decisions FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation()';
END;
$$;

CREATE TRIGGER room_evolution_legacy_provenance_quarantines_append_only
  BEFORE UPDATE OR DELETE ON project.room_evolution_legacy_provenance_quarantines
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
