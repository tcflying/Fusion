CREATE TABLE project.room_blind_review_registries (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  review_round_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  mapping_integrity_hash text NOT NULL,
  sealed_mapping jsonb NOT NULL,
  review_pack jsonb NOT NULL,
  sealed_at text NOT NULL,
  expires_at text NOT NULL,
  CONSTRAINT room_blind_review_registries_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_blind_review_registries_scope_review_unique
    UNIQUE (project_id, room_id, review_round_id),
  CONSTRAINT room_blind_review_registries_scope_idempotency_unique
    UNIQUE (project_id, room_id, idempotency_key),
  CONSTRAINT room_blind_review_registries_mapping_shape_check
    CHECK (jsonb_typeof(sealed_mapping) = 'object'),
  CONSTRAINT room_blind_review_registries_pack_shape_check
    CHECK (jsonb_typeof(review_pack) = 'object'),
  CONSTRAINT room_blind_review_registries_sealed_hash_commit_check
    CHECK (COALESCE(
      mapping_integrity_hash = sealed_mapping ->> 'integrityHash'
      AND command_hash = sealed_mapping ->> 'commandHash'
      AND review_round_id = sealed_mapping ->> 'reviewRoundId'
      AND review_round_id = review_pack ->> 'reviewRoundId'
      AND review_pack ->> 'purpose' = 'blind_review_only',
      FALSE
    )),
  CONSTRAINT room_blind_review_registries_expiry_check
    CHECK (expires_at > sealed_at),
  CONSTRAINT room_blind_review_registries_hashes_check
    CHECK (
      command_hash ~ '^sha256:[a-f0-9]{64}$'
      AND mapping_integrity_hash ~ '^sha256:[a-f0-9]{64}$'
    ),
  CONSTRAINT room_blind_review_registries_nonblank_check
    CHECK (
      btrim(review_round_id) <> ''
      AND btrim(idempotency_key) <> ''
      AND btrim(sealed_at) <> ''
      AND btrim(expires_at) <> ''
    )
);

CREATE INDEX idx_room_blind_review_registries_project_room
  ON project.room_blind_review_registries(project_id, room_id, sealed_at);
