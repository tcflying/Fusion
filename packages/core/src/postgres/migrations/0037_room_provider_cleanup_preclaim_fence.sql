-- FNXC:RoomProviderPreClaimCleanupFence 2026-07-20-21:47:
-- Preserve the exact pending outbox generation when an admitted provider
-- reservation cannot be released before any delivery attempt is claimed. The
-- terminal cleanup path may reopen only that fenced generation; no attempt row
-- or provider acknowledgement is fabricated.

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  DROP CONSTRAINT room_provider_backpressure_cleanup_actions_completion_kind_check;

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD CONSTRAINT room_provider_backpressure_cleanup_actions_completion_kind_check
  CHECK (completion_kind IN ('pre_send_not_started','pre_claim_not_started','late_admission_not_started'));

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  DROP CONSTRAINT room_provider_backpressure_cleanup_actions_outbox_attempt_check;

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD CONSTRAINT room_provider_backpressure_cleanup_actions_outbox_attempt_check
  CHECK (outbox_attempt_count IS NULL OR outbox_attempt_count BETWEEN 0 AND 2147483647);

DROP INDEX project.idx_room_provider_cleanup_actions_terminal_finalization;

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
    AND completion_kind IN ('pre_send_not_started', 'pre_claim_not_started');
