-- FNXC:RoomEvolutionLegacyProvenance 2026-07-19-21:40:
-- A quarantined 0022 success signal is historical context only. It must never
-- be reintroduced as a canary success receipt or promoted proof after 0027.

CREATE FUNCTION project.room_evolution_reject_legacy_provenance_canary_success()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project.room_evolution_legacy_provenance_quarantines AS quarantine
    WHERE quarantine.project_id = NEW.project_id
      AND quarantine.scope_key = NEW.scope_key
      AND quarantine.record_kind = 'canary'
      AND quarantine.record_id = NEW.canary_id
  ) THEN
    RAISE EXCEPTION 'legacy provenance cannot be used as canary success proof';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.gate_result_ids) AS gate_reference(gate_result_id)
    JOIN project.room_evolution_legacy_provenance_quarantines AS quarantine
      ON quarantine.project_id = NEW.project_id
      AND quarantine.scope_key = NEW.scope_key
      AND quarantine.record_kind = 'gate_result'
      AND quarantine.record_id = gate_reference.gate_result_id
  ) THEN
    RAISE EXCEPTION 'legacy provenance cannot be used as canary success proof';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER room_evolution_canary_success_outcomes_legacy_provenance_guard
  BEFORE INSERT ON project.room_evolution_canary_success_outcomes
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_legacy_provenance_canary_success();

CREATE FUNCTION project.room_evolution_reject_legacy_provenance_promotion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.decision = 'promoted' AND EXISTS (
    SELECT 1
    FROM project.room_evolution_legacy_provenance_quarantines AS quarantine
    WHERE quarantine.project_id = NEW.project_id
      AND quarantine.scope_key = NEW.scope_key
      AND quarantine.record_kind = 'canary'
      AND quarantine.record_id = NEW.canary_id
  ) THEN
    RAISE EXCEPTION 'legacy provenance cannot be used as promotion proof';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER room_evolution_promotion_decisions_legacy_provenance_guard
  BEFORE INSERT ON project.room_evolution_promotion_decisions
  FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_legacy_provenance_promotion();
