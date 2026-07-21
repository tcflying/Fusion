CREATE TABLE project.room_global_concurrency_state (
  id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  updated_at text NOT NULL,
  CONSTRAINT room_global_concurrency_state_id_check
    CHECK (id = 'room-global-concurrency-v1'),
  CONSTRAINT room_global_concurrency_state_revision_check
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  CONSTRAINT room_global_concurrency_state_updated_at_check
    CHECK (btrim(updated_at) <> '')
);

CREATE TABLE project.room_global_concurrency_claims (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  work_class text NOT NULL,
  slots integer NOT NULL,
  holder_id text NOT NULL,
  lease_id text NOT NULL,
  fence bigint NOT NULL,
  acquired_at text NOT NULL,
  expires_at text NOT NULL,
  released_at text,
  CONSTRAINT room_global_concurrency_claims_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_global_concurrency_claims_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT room_global_concurrency_claims_work_class_check
    CHECK (work_class IN ('normal','verifier','recovery')),
  CONSTRAINT room_global_concurrency_claims_slots_check
    CHECK (slots BETWEEN 1 AND 2147483647),
  CONSTRAINT room_global_concurrency_claims_fence_check
    CHECK (fence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_global_concurrency_claims_window_check
    CHECK (expires_at > acquired_at),
  CONSTRAINT room_global_concurrency_claims_nonblank_check
    CHECK (
      btrim(id) <> ''
      AND btrim(project_id) <> ''
      AND btrim(room_id) <> ''
      AND btrim(holder_id) <> ''
      AND btrim(lease_id) <> ''
      AND btrim(acquired_at) <> ''
      AND btrim(expires_at) <> ''
      AND (released_at IS NULL OR btrim(released_at) <> '')
    )
);

CREATE INDEX idx_room_global_concurrency_claims_active
  ON project.room_global_concurrency_claims(project_id, work_class, expires_at, id)
  WHERE released_at IS NULL;

CREATE INDEX idx_room_global_concurrency_claims_expiry
  ON project.room_global_concurrency_claims(expires_at, id)
  WHERE released_at IS NULL;

CREATE TABLE project.room_global_concurrency_operations (
  project_id text NOT NULL,
  command_kind text NOT NULL,
  operation_key text NOT NULL,
  claim_id text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  fence bigint NOT NULL,
  occurred_at text NOT NULL,
  CONSTRAINT room_global_concurrency_operations_primary
    PRIMARY KEY (project_id, command_kind, operation_key),
  CONSTRAINT room_global_concurrency_operations_claim_project_fkey
    FOREIGN KEY (claim_id, project_id)
    REFERENCES project.room_global_concurrency_claims(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_global_concurrency_operations_kind_check
    CHECK (command_kind IN ('acquire','release','recover_dangling')),
  CONSTRAINT room_global_concurrency_operations_action_check
    CHECK (action IN ('acquired','released','recovered')),
  CONSTRAINT room_global_concurrency_operations_fence_check
    CHECK (fence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_global_concurrency_operations_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_global_concurrency_operations_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(operation_key) <> ''
      AND btrim(claim_id) <> ''
      AND btrim(occurred_at) <> ''
    )
);

CREATE INDEX idx_room_global_concurrency_operations_claim
  ON project.room_global_concurrency_operations(project_id, claim_id, command_kind, occurred_at);
