-- FNXC:RoomCapabilityRegistry 2026-07-19-10:01:
-- Keep one project-and-Room-scoped current registry projection. Its source
-- event, integrity hash, and accepted room-worker epoch make recovery replay
-- auditable without inventing connector/reporter capability data.

CREATE TABLE project.room_capability_registry_projections (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  registry_id text NOT NULL,
  revision bigint NOT NULL,
  aggregate_version bigint NOT NULL,
  registry jsonb NOT NULL,
  registry_integrity_hash text NOT NULL,
  source_event_id text NOT NULL,
  worker_lease_id text NOT NULL,
  worker_holder_id text NOT NULL,
  worker_host_id text NOT NULL,
  worker_lease_epoch bigint NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_capability_registry_projections_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_capability_registry_projections_source_event_fkey
    FOREIGN KEY (project_id, source_event_id)
    REFERENCES project.room_events(project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT room_capability_registry_projections_room_project_unique
    UNIQUE (project_id, room_id),
  CONSTRAINT room_capability_registry_projections_source_event_unique
    UNIQUE (source_event_id),
  CONSTRAINT room_capability_registry_projections_revision_check
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_capability_registry_projections_aggregate_version_check
    CHECK (aggregate_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_capability_registry_projections_worker_epoch_check
    CHECK (worker_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_capability_registry_projections_registry_shape_check
    CHECK (jsonb_typeof(registry) = 'object'),
  CONSTRAINT room_capability_registry_projections_hash_matches_registry_check
    CHECK (registry_integrity_hash = registry->>'integrityHash'),
  CONSTRAINT room_capability_registry_projections_nonblank_check
    CHECK (
      btrim(id) <> ''
      AND btrim(registry_id) <> ''
      AND btrim(registry_integrity_hash) <> ''
      AND btrim(source_event_id) <> ''
      AND btrim(worker_lease_id) <> ''
      AND btrim(worker_holder_id) <> ''
      AND btrim(worker_host_id) <> ''
      AND btrim(created_at) <> ''
      AND btrim(updated_at) <> ''
    )
);

CREATE INDEX idx_room_capability_registry_projections_project_room
  ON project.room_capability_registry_projections(project_id, room_id);
