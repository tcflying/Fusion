-- FNXC:SessionRoomSenderTakeover 2026-07-18-07:05:
-- Native IDE sender takeover must survive process restart as one complete,
-- epoch-fenced projection. Existing ingestion rows remain no-takeover rows;
-- only the blocked outbox collection receives its neutral empty-array value.

CREATE OR REPLACE FUNCTION project.room_jsonb_text_array_is_unique(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT count(*) = count(DISTINCT element)
  FROM jsonb_array_elements_text(candidate) AS entries(element)
$$;

ALTER TABLE project.room_binding_ingestion_state
  ADD COLUMN IF NOT EXISTS takeover_id text,
  ADD COLUMN IF NOT EXISTS takeover_epoch bigint,
  ADD COLUMN IF NOT EXISTS takeover_state text,
  ADD COLUMN IF NOT EXISTS auto_sender_lease_epoch bigint,
  ADD COLUMN IF NOT EXISTS reconcile_from_cursor text,
  ADD COLUMN IF NOT EXISTS confirmed_cursor text,
  ADD COLUMN IF NOT EXISTS blocked_outbox_ids jsonb;

UPDATE project.room_binding_ingestion_state
SET blocked_outbox_ids = '[]'::jsonb
WHERE blocked_outbox_ids IS NULL;

ALTER TABLE project.room_binding_ingestion_state
  ALTER COLUMN blocked_outbox_ids SET DEFAULT '[]'::jsonb,
  ALTER COLUMN blocked_outbox_ids SET NOT NULL;

ALTER TABLE project.room_binding_ingestion_state
  ADD CONSTRAINT room_binding_ingestion_takeover_state_check CHECK (
    takeover_state IS NULL
    OR takeover_state IN (
      'reconciling',
      'ready_for_transfer',
      'human_active',
      'releasing',
      'automatic_resumed',
      'blocked_delivery_uncertain'
    )
  ) NOT VALID,
  ADD CONSTRAINT room_binding_ingestion_takeover_epoch_check CHECK (
    (takeover_epoch IS NULL OR takeover_epoch BETWEEN 1 AND 9007199254740991)
    AND (
      auto_sender_lease_epoch IS NULL
      OR auto_sender_lease_epoch BETWEEN 1 AND 9007199254740991
    )
  ) NOT VALID,
  ADD CONSTRAINT room_binding_ingestion_blocked_outbox_ids_check CHECK (
    jsonb_typeof(blocked_outbox_ids) = 'array'
    AND NOT jsonb_path_exists(
      blocked_outbox_ids,
      '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")'
    )
    AND project.room_jsonb_text_array_is_unique(blocked_outbox_ids)
  ) NOT VALID,
  ADD CONSTRAINT room_binding_ingestion_takeover_projection_check CHECK (
    (
      takeover_id IS NULL
      AND takeover_epoch IS NULL
      AND takeover_state IS NULL
      AND auto_sender_lease_epoch IS NULL
      AND reconcile_from_cursor IS NULL
      AND confirmed_cursor IS NULL
      AND blocked_outbox_ids = '[]'::jsonb
    )
    OR
    (
      takeover_id IS NOT NULL
      AND btrim(takeover_id) <> ''
      AND takeover_epoch IS NOT NULL
      AND takeover_state IS NOT NULL
      AND auto_sender_lease_epoch IS NOT NULL
      AND (
        takeover_state NOT IN ('reconciling', 'ready_for_transfer', 'human_active', 'releasing', 'automatic_resumed', 'blocked_delivery_uncertain')
        OR takeover_state IN ('reconciling', 'blocked_delivery_uncertain')
        OR (takeover_state IN ('releasing', 'automatic_resumed') AND NOT native_writer_detected)
        OR (takeover_state IN ('ready_for_transfer', 'human_active') AND native_writer_detected)
      )
      AND (reconcile_from_cursor IS NULL OR btrim(reconcile_from_cursor) <> '')
      AND (confirmed_cursor IS NULL OR btrim(confirmed_cursor) <> '')
    )
  ) NOT VALID,
  ADD CONSTRAINT room_binding_ingestion_takeover_payload_check CHECK (
    CASE takeover_state
      WHEN 'reconciling' THEN blocked_outbox_ids = '[]'::jsonb
      WHEN 'ready_for_transfer' THEN confirmed_cursor IS NOT NULL AND blocked_outbox_ids = '[]'::jsonb
      WHEN 'human_active' THEN confirmed_cursor IS NOT NULL AND blocked_outbox_ids = '[]'::jsonb
      WHEN 'releasing' THEN blocked_outbox_ids = '[]'::jsonb
      WHEN 'automatic_resumed' THEN confirmed_cursor IS NOT NULL AND blocked_outbox_ids = '[]'::jsonb
      WHEN 'blocked_delivery_uncertain' THEN blocked_outbox_ids <> '[]'::jsonb
      ELSE true
    END
  ) NOT VALID;

ALTER TABLE project.room_binding_ingestion_state
  VALIDATE CONSTRAINT room_binding_ingestion_takeover_state_check,
  VALIDATE CONSTRAINT room_binding_ingestion_takeover_epoch_check,
  VALIDATE CONSTRAINT room_binding_ingestion_blocked_outbox_ids_check,
  VALIDATE CONSTRAINT room_binding_ingestion_takeover_projection_check,
  VALIDATE CONSTRAINT room_binding_ingestion_takeover_payload_check;
