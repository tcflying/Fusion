-- FNXC:RoomProviderPreClaimTargetShape 2026-07-20-22:48:
-- 0037 may already be present in an upgraded database, so this forward-only
-- guard rejects mixed cleanup targets without mutating historical migration
-- text. It retains historical inert outbox-id-only records but fails closed on
-- any invented binding/attempt identity or unsafe pre-claim shape.

ALTER TABLE project.room_provider_backpressure_cleanup_actions
  ADD CONSTRAINT room_provider_backpressure_cleanup_actions_target_shape_check
  CHECK (
    (
      completion_kind = 'pre_claim_not_started'
      AND outbox_id IS NOT NULL
      AND outbox_binding_id IS NOT NULL
      AND outbox_attempt_id IS NULL
      AND outbox_attempt_count BETWEEN 0 AND 2147483647
    )
    OR (
      completion_kind = 'pre_send_not_started'
      AND (
        (
          outbox_binding_id IS NULL
          AND outbox_attempt_id IS NULL
          AND outbox_attempt_count IS NULL
        )
        OR (
          outbox_id IS NOT NULL
          AND outbox_binding_id IS NOT NULL
          AND outbox_attempt_id IS NOT NULL
          AND outbox_attempt_count BETWEEN 1 AND 2147483647
        )
      )
    )
    OR (
      completion_kind = 'late_admission_not_started'
      AND outbox_binding_id IS NULL
      AND outbox_attempt_id IS NULL
      AND outbox_attempt_count IS NULL
    )
  );
