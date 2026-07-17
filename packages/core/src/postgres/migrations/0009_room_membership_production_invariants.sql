-- FNXC:SessionRoomMembershipProduction 2026-07-18-06:12:
-- Native and Happier Session ownership is machine-wide, not project-local.
-- Pending turn-boundary additions/replacements reserve those identities before
-- their future seat/binding projection exists. Historical binding generations
-- and applied/failed requests remain immutable and do not retain ownership.

ALTER TABLE project.room_membership_changes
  ADD COLUMN IF NOT EXISTS reserved_connector_id text,
  ADD COLUMN IF NOT EXISTS reserved_provider_id text,
  ADD COLUMN IF NOT EXISTS reserved_native_session_id text,
  ADD COLUMN IF NOT EXISTS reserved_happier_session_id text,
  ADD COLUMN IF NOT EXISTS failed_at text,
  ADD COLUMN IF NOT EXISTS failure_code text;

UPDATE project.room_membership_changes
SET
  reserved_connector_id = CASE kind
    WHEN 'add' THEN payload->'binding'->>'connectorId'
    WHEN 'replace' THEN payload->'replacement'->>'connectorId'
    ELSE NULL
  END,
  reserved_provider_id = CASE kind
    WHEN 'add' THEN payload->'binding'->>'providerId'
    WHEN 'replace' THEN payload->'replacement'->>'providerId'
    ELSE NULL
  END,
  reserved_native_session_id = CASE kind
    WHEN 'add' THEN payload->'binding'->>'nativeSessionId'
    WHEN 'replace' THEN payload->'replacement'->>'nativeSessionId'
    ELSE NULL
  END,
  reserved_happier_session_id = CASE kind
    WHEN 'add' THEN payload->'binding'->>'happierSessionId'
    WHEN 'replace' THEN payload->'replacement'->>'happierSessionId'
    ELSE NULL
  END
WHERE kind IN ('add', 'replace');

DO $fusion$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project.room_membership_changes
    WHERE state = 'waiting_turn_boundary'
      AND kind IN ('add', 'replace')
      AND (
        COALESCE(btrim(reserved_connector_id), '') = ''
        OR COALESCE(btrim(reserved_provider_id), '') = ''
        OR COALESCE(btrim(reserved_native_session_id), '') = ''
      )
  ) THEN
    RAISE EXCEPTION 'pending Room membership binding is missing its Session identity reservation'
      USING
        ERRCODE = '23514',
        DETAIL = 'Repair or quarantine malformed waiting add/replace rows before applying migration 0009.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM project.room_membership_changes AS pending
    JOIN project.room_bindings AS active
      ON active.state IN (
        'pending',
        'attached',
        'paused',
        'authentication_blocked',
        'host_unavailable',
        'delivery_uncertain'
      )
      AND (
        (
          active.provider_id = pending.reserved_provider_id
          AND active.native_session_id = pending.reserved_native_session_id
        )
        OR (
          pending.reserved_happier_session_id IS NOT NULL
          AND active.connector_id = pending.reserved_connector_id
          AND active.happier_session_id = pending.reserved_happier_session_id
        )
      )
    WHERE pending.state = 'waiting_turn_boundary'
      AND pending.kind IN ('add', 'replace')
  ) THEN
    RAISE EXCEPTION 'pending and active Room bindings already share one Session identity'
      USING
        ERRCODE = '23505',
        DETAIL = 'Resolve active-versus-pending Session ownership before applying migration 0009.';
  END IF;
END
$fusion$;

DROP INDEX IF EXISTS project.idx_room_bindings_active_native_session;
DROP INDEX IF EXISTS project.idx_room_bindings_active_happier_session;

CREATE UNIQUE INDEX idx_room_bindings_active_native_session
  ON project.room_bindings(provider_id, native_session_id)
  WHERE state IN (
    'pending',
    'attached',
    'paused',
    'authentication_blocked',
    'host_unavailable',
    'delivery_uncertain'
  );

CREATE UNIQUE INDEX idx_room_bindings_active_happier_session
  ON project.room_bindings(connector_id, happier_session_id)
  WHERE happier_session_id IS NOT NULL
    AND state IN (
      'pending',
      'attached',
      'paused',
      'authentication_blocked',
      'host_unavailable',
      'delivery_uncertain'
    );

CREATE UNIQUE INDEX idx_room_membership_changes_pending_native_session
  ON project.room_membership_changes(reserved_provider_id, reserved_native_session_id)
  WHERE state = 'waiting_turn_boundary'
    AND reserved_provider_id IS NOT NULL
    AND reserved_native_session_id IS NOT NULL;

CREATE UNIQUE INDEX idx_room_membership_changes_pending_happier_session
  ON project.room_membership_changes(reserved_connector_id, reserved_happier_session_id)
  WHERE state = 'waiting_turn_boundary'
    AND reserved_connector_id IS NOT NULL
    AND reserved_happier_session_id IS NOT NULL;
