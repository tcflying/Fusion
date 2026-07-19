-- Persist the active capability-aware role decision and retain superseded
-- revisions for replay, dispatch fencing, and independent-verifier lineage.

CREATE TABLE IF NOT EXISTS project.room_role_assignments (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  revision bigint NOT NULL,
  aggregate_version bigint NOT NULL,
  state text NOT NULL,
  protocol_id text NOT NULL,
  protocol_version integer NOT NULL,
  phase_id text NOT NULL,
  capability_snapshot jsonb NOT NULL,
  constraints jsonb NOT NULL,
  assignment jsonb NOT NULL,
  authoritative_producer_binding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at text NOT NULL,
  superseded_at text,
  CONSTRAINT room_role_assignments_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_role_assignments_room_revision_unique UNIQUE (room_id, revision),
  CONSTRAINT room_role_assignments_state_check
    CHECK (state IN ('active','superseded')),
  CONSTRAINT room_role_assignments_revision_check
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_role_assignments_aggregate_version_check
    CHECK (aggregate_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_role_assignments_protocol_version_check
    CHECK (protocol_version BETWEEN 1 AND 2147483647),
  CONSTRAINT room_role_assignments_phase_id_check
    CHECK (btrim(phase_id) <> ''),
  CONSTRAINT room_role_assignments_snapshot_shape_check
    CHECK (jsonb_typeof(capability_snapshot) = 'object'),
  CONSTRAINT room_role_assignments_constraints_shape_check
    CHECK (jsonb_typeof(constraints) = 'object'),
  CONSTRAINT room_role_assignments_assignment_shape_check
    CHECK (jsonb_typeof(assignment) = 'object'),
  CONSTRAINT room_role_assignments_producer_shape_check
    CHECK (jsonb_typeof(authoritative_producer_binding_ids) = 'array'),
  CONSTRAINT room_role_assignments_state_time_check
    CHECK (
      (state = 'active' AND superseded_at IS NULL)
      OR (state = 'superseded' AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS room_role_assignments_active_room_unique
  ON project.room_role_assignments(project_id, room_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_room_role_assignments_project_room_state
  ON project.room_role_assignments(project_id, room_id, state, revision);
