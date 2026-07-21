-- FNXC:RoomProviderCleanupOutboxFinalization 2026-07-20-02:34:
-- Terminal pre-send cleanup must become inert after an exact generation has
-- either been reopened or safely withheld. Never repeatedly claim a stale
-- action and never infer an outbox target from partial legacy evidence.

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD COLUMN outbox_finalized_at text,
  ADD COLUMN outbox_finalization_outcome text,
  ADD COLUMN outbox_finalization_reason text;

UPDATE project.room_provider_backpressure_cleanup_actions
SET outbox_finalized_at = outbox_unblocked_at,
    outbox_finalization_outcome = 'unblocked'
WHERE outbox_unblocked_at IS NOT NULL;

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD CONSTRAINT room_provider_backpressure_cleanup_actions_outbox_finalization_shape_check
  CHECK (
    (outbox_finalized_at IS NULL
      AND outbox_finalization_outcome IS NULL
      AND outbox_finalization_reason IS NULL
      AND outbox_unblocked_at IS NULL)
    OR (outbox_finalized_at IS NOT NULL
      AND outbox_finalization_outcome = 'unblocked'
      AND outbox_finalization_reason IS NULL
      AND outbox_unblocked_at = outbox_finalized_at)
    OR (outbox_finalized_at IS NOT NULL
      AND outbox_finalization_outcome = 'withheld'
      AND outbox_finalization_reason IS NOT NULL
      AND outbox_unblocked_at IS NULL)
  );

CREATE INDEX idx_room_provider_cleanup_actions_terminal_finalization
  ON project.room_provider_backpressure_cleanup_actions (
    project_id,
    room_id,
    completion_kind,
    outbox_finalized_at,
    reservation_expires_at,
    created_at
  )
  WHERE state IN ('released', 'expired')
    AND completion_kind = 'pre_send_not_started';
