-- FNXC:RoomProviderAdmissionCoreNoReservation 2026-07-21-01:42:
-- A Core receipt plus an expired original sender can prove only that no durable
-- reservation was written; it must not masquerade as a provider callback.

ALTER TABLE project.room_provider_admission_timeout_tombstones
  DROP CONSTRAINT room_provider_admission_timeout_terminal_outcome_check;

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD CONSTRAINT room_provider_admission_timeout_terminal_outcome_check
  CHECK (
    terminal_gate_outcome IS NULL
    OR terminal_gate_outcome IN (
      'deferred_without_permit',
      'cancelled_without_permit',
      'failed_without_permit',
      'core_sender_fenced_no_reservation'
    )
  );
