-- FNXC:SessionRoomMessageRouting 2026-07-18-11:26:
-- Routed operator messages retain their original selector, authority,
-- idempotency/version provenance, and the ordered targets resolved at commit.
-- Historical messages remain readable: resolved seat IDs are derived from the
-- legacy seats selector while command provenance stays nullable when unknown.

ALTER TABLE project.room_seats
ADD CONSTRAINT room_seats_id_room_project_unique
UNIQUE (id, room_id, project_id);

ALTER TABLE project.room_bindings
ADD CONSTRAINT room_bindings_id_seat_room_project_unique
UNIQUE (id, seat_id, room_id, project_id);

ALTER TABLE project.room_messages
  ADD COLUMN IF NOT EXISTS target_seat_ids jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS expected_aggregate_version bigint;

UPDATE project.room_messages
SET target_seat_ids = CASE
  WHEN jsonb_typeof(target->'seatIds') = 'array' THEN target->'seatIds'
  ELSE '[]'::jsonb
END
WHERE target_seat_ids IS NULL;

ALTER TABLE project.room_messages
  ALTER COLUMN target_seat_ids SET DEFAULT '[]'::jsonb,
  ALTER COLUMN target_seat_ids SET NOT NULL,
  ADD CONSTRAINT room_messages_id_room_project_unique
    UNIQUE (id, room_id, project_id),
  ADD CONSTRAINT room_messages_target_seat_ids_check CHECK (
    jsonb_typeof(target_seat_ids) = 'array'
  ) NOT VALID,
  ADD CONSTRAINT room_messages_expected_aggregate_version_check CHECK (
    expected_aggregate_version IS NULL
    OR expected_aggregate_version BETWEEN 0 AND 9007199254740991
  ) NOT VALID;

ALTER TABLE project.room_messages
  VALIDATE CONSTRAINT room_messages_target_seat_ids_check,
  VALIDATE CONSTRAINT room_messages_expected_aggregate_version_check;

CREATE TABLE IF NOT EXISTS project.room_message_targets (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  message_id text NOT NULL,
  selector_kind text NOT NULL,
  selector_ref text,
  target_kind text NOT NULL,
  seat_id text,
  binding_id text,
  ordinal integer NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_message_targets_message_room_project_fkey
    FOREIGN KEY (message_id, room_id, project_id)
    REFERENCES project.room_messages(id, room_id, project_id) ON DELETE CASCADE,
  CONSTRAINT room_message_targets_seat_room_project_fkey
    FOREIGN KEY (seat_id, room_id, project_id)
    REFERENCES project.room_seats(id, room_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_message_targets_binding_seat_room_project_fkey
    FOREIGN KEY (binding_id, seat_id, room_id, project_id)
    REFERENCES project.room_bindings(id, seat_id, room_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_message_targets_message_ordinal_unique
    UNIQUE (message_id, ordinal),
  CONSTRAINT room_message_targets_message_seat_unique
    UNIQUE (message_id, seat_id),
  CONSTRAINT room_message_targets_selector_kind_check CHECK (
    selector_kind IN ('controller','all','group','seats')
  ),
  CONSTRAINT room_message_targets_target_kind_check CHECK (
    target_kind IN ('controller','seat')
  ),
  CONSTRAINT room_message_targets_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT room_message_targets_selector_ref_check CHECK (
    (selector_kind = 'group' AND selector_ref IS NOT NULL AND btrim(selector_ref) <> '')
    OR (selector_kind <> 'group' AND selector_ref IS NULL)
  ),
  CONSTRAINT room_message_targets_shape_check CHECK (
    (
      selector_kind = 'controller'
      AND target_kind = 'controller'
      AND seat_id IS NULL
      AND binding_id IS NULL
      AND ordinal = 0
    )
    OR
    (
      selector_kind IN ('all','group','seats')
      AND target_kind = 'seat'
      AND seat_id IS NOT NULL
      AND binding_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_room_message_targets_room_message
  ON project.room_message_targets(project_id, room_id, message_id, ordinal);
