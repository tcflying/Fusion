-- FNXC:RoomProviderAdmissionTimeoutRecovery 2026-07-21-00:55:
-- A pre-permit timeout can be automatically reconciled only when the standard
-- Core gate committed under its exact sender fence. Historic and custom-gate
-- tombstones remain opaque so recovery cannot infer a missing provider permit.

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD COLUMN recovery_protocol text NOT NULL DEFAULT 'opaque';

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD CONSTRAINT room_provider_admission_timeout_recovery_protocol_check
  CHECK (recovery_protocol IN ('opaque', 'core_sender_fenced_v1'));
