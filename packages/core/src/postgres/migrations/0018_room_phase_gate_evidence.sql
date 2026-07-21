-- FNXC:RoomPhaseGateEvidence 2026-07-18-08:41:
-- A phase transition may cite only immutable evidence persisted before the
-- transition command. The JSON payload remains self-contained because replay
-- must validate the exact historical protocol, candidate, source, evaluator,
-- and producer-lineage proof without consulting mutable connector state.

CREATE TABLE IF NOT EXISTS project.room_phase_gate_evidence (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  producer_lineage jsonb NOT NULL,
  evidence_not_before text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_phase_gate_evidence_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_phase_gate_evidence_evidence_shape_check
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT room_phase_gate_evidence_lineage_shape_check
    CHECK (jsonb_typeof(producer_lineage) = 'object'),
  CONSTRAINT room_phase_gate_evidence_nonblank_check
    CHECK (
      btrim(id) <> ''
      AND btrim(evidence_hash) <> ''
      AND btrim(evidence_not_before) <> ''
      AND btrim(created_at) <> ''
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS room_phase_gate_evidence_source_unique
  ON project.room_phase_gate_evidence(project_id, room_id, ((evidence->'source'->>'recordId')));

CREATE INDEX IF NOT EXISTS idx_room_phase_gate_evidence_room_created
  ON project.room_phase_gate_evidence(project_id, room_id, created_at, id);
