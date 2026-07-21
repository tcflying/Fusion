-- FNXC:RoomProviderCleanupOutboxUnblock 2026-07-20-02:05:
-- A terminal pre-send cleanup action may release only the exact uncertain
-- outbox generation that created it. Persist immutable attempt identity and
-- finalization evidence; late admission actions deliberately carry no target.

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD COLUMN outbox_binding_id text,
  ADD COLUMN outbox_attempt_id text,
  ADD COLUMN outbox_attempt_count integer,
  ADD COLUMN outbox_unblocked_at text;

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD CONSTRAINT room_provider_backpressure_cleanup_actions_outbox_attempt_check
  CHECK (outbox_attempt_count IS NULL OR outbox_attempt_count BETWEEN 1 AND 2147483647);
