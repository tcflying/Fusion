-- Persist one authoritative receive cursor/state per immutable Room binding and
-- strengthen inbox idempotency independently of connector cursor replay.

ALTER TABLE project.room_bindings
  ADD CONSTRAINT room_bindings_id_room_project_unique
  UNIQUE (id, room_id, project_id);

CREATE TABLE IF NOT EXISTS project.room_binding_ingestion_state (
  binding_id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  mode text NOT NULL,
  transcript_cursor text,
  status_cursor text,
  last_native_message_id text,
  last_payload_hash text,
  connector_status text,
  native_writer_detected boolean NOT NULL DEFAULT false,
  gap_expected_cursor text,
  gap_observed_cursor text,
  gap_detected_at text,
  last_transcript_at text,
  last_status_at text,
  last_mode_at text,
  updated_at text NOT NULL,
  CONSTRAINT room_binding_ingestion_state_binding_room_project_fkey
    FOREIGN KEY (binding_id, room_id, project_id)
    REFERENCES project.room_bindings(id, room_id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_binding_ingestion_mode_check CHECK (
    mode IN ('starting','streaming','polling','reconciling','degraded','stopped')
  ),
  CONSTRAINT room_binding_ingestion_status_check CHECK (
    connector_status IS NULL OR connector_status IN ('idle','running','waiting_input','paused','lost','unknown')
  )
);
CREATE INDEX IF NOT EXISTS idx_room_binding_ingestion_room_mode
  ON project.room_binding_ingestion_state(project_id, room_id, mode);

ALTER TABLE project.room_inbox_receipts
  ADD COLUMN IF NOT EXISTS logical_message_id text,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS occurred_at text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS legacy_placeholder boolean NOT NULL DEFAULT false;

WITH ranked_legacy_receipts AS (
  SELECT
    id,
    native_message_id,
    row_number() OVER (
      PARTITION BY binding_id, native_message_id
      ORDER BY received_at, id
    ) AS native_rank
  FROM project.room_inbox_receipts
)
UPDATE project.room_inbox_receipts AS receipt
SET
  dedupe_key = CASE
    WHEN receipt.native_message_id IS NOT NULL AND ranked.native_rank = 1
      THEN 'native:' || receipt.native_message_id
    WHEN receipt.native_message_id IS NOT NULL
      THEN 'legacy-native-overlap:' || receipt.native_message_id || ':' || receipt.id
    ELSE 'legacy-fallback:' || receipt.id
  END,
  role = 'unknown',
  occurred_at = received_at,
  source = 'history',
  legacy_placeholder = true
FROM ranked_legacy_receipts AS ranked
WHERE receipt.id = ranked.id
  AND (
    receipt.dedupe_key IS NULL
    OR receipt.role IS NULL
    OR receipt.occurred_at IS NULL
    OR receipt.source IS NULL
  );

ALTER TABLE project.room_inbox_receipts
  ALTER COLUMN dedupe_key SET NOT NULL,
  ALTER COLUMN role SET NOT NULL,
  ALTER COLUMN occurred_at SET NOT NULL,
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE project.room_inbox_receipts
  ADD CONSTRAINT room_inbox_receipts_binding_dedupe_unique UNIQUE (binding_id, dedupe_key),
  ADD CONSTRAINT room_inbox_receipts_binding_room_project_fkey
    FOREIGN KEY (binding_id, room_id, project_id)
    REFERENCES project.room_bindings(id, room_id, project_id) ON DELETE CASCADE,
  ADD CONSTRAINT room_inbox_receipts_role_check CHECK (role IN ('user','assistant','tool','system','unknown')),
  ADD CONSTRAINT room_inbox_receipts_source_check CHECK (source IN ('event','history'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_inbox_receipts_binding_logical_message
  ON project.room_inbox_receipts(binding_id, logical_message_id)
  WHERE logical_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_room_inbox_receipts_native_message
  ON project.room_inbox_receipts(binding_id, native_message_id);
