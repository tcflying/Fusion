-- FNXC:RoomProviderAdmissionRecoveryReceipt 2026-07-21-01:31:
-- The old protocol marker was not a Core-issued proof. Forward migration makes
-- all historical marker-only rows opaque, then allows only a same-transaction
-- Core receipt to designate a timeout as restart-reconcilable.

CREATE TABLE project.room_provider_admission_recovery_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  outbox_id text NOT NULL,
  outbox_binding_id text NOT NULL,
  outbox_attempt_count integer NOT NULL,
  gate_attempt_id text NOT NULL,
  request_hash text NOT NULL,
  sender_lease_id text NOT NULL,
  sender_lease_holder_id text NOT NULL,
  sender_lease_host_id text NOT NULL,
  sender_lease_epoch bigint NOT NULL,
  issued_at text NOT NULL,
  CONSTRAINT room_provider_admission_recovery_receipt_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_recovery_receipt_outbox_fkey
    FOREIGN KEY (project_id, outbox_id)
    REFERENCES project.room_outbox(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT room_provider_admission_recovery_receipt_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT room_provider_admission_recovery_receipt_gate_attempt_unique
    UNIQUE (project_id, room_id, gate_attempt_id),
  CONSTRAINT room_provider_admission_recovery_receipt_target_unique
    UNIQUE (project_id, room_id, outbox_id, outbox_attempt_count),
  CONSTRAINT room_provider_admission_recovery_receipt_request_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_provider_admission_recovery_receipt_attempt_count_check
    CHECK (outbox_attempt_count BETWEEN 0 AND 2147483647),
  CONSTRAINT room_provider_admission_recovery_receipt_sender_epoch_check
    CHECK (sender_lease_epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_provider_admission_recovery_receipt_nonblank_check
    CHECK (
      btrim(id) <> '' AND btrim(project_id) <> '' AND btrim(room_id) <> ''
      AND btrim(outbox_id) <> '' AND btrim(outbox_binding_id) <> ''
      AND btrim(gate_attempt_id) <> '' AND btrim(request_hash) <> ''
      AND btrim(sender_lease_id) <> '' AND btrim(sender_lease_holder_id) <> ''
      AND btrim(sender_lease_host_id) <> '' AND btrim(issued_at) <> ''
    )
);

CREATE INDEX idx_room_provider_admission_recovery_receipt_target
  ON project.room_provider_admission_recovery_receipts(project_id, room_id, outbox_id, outbox_attempt_count);

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD COLUMN recovery_receipt_id text;

-- No old marker can be promoted retroactively because it lacks an immutable
-- receipt written while Core held the original sender fence.
UPDATE project.room_provider_admission_timeout_tombstones
  SET recovery_protocol = 'opaque'
  WHERE recovery_protocol = 'core_sender_fenced_v1';

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD CONSTRAINT room_provider_admission_timeout_recovery_receipt_fkey
  FOREIGN KEY (recovery_receipt_id, project_id)
  REFERENCES project.room_provider_admission_recovery_receipts(id, project_id) ON DELETE RESTRICT;

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD CONSTRAINT room_provider_admission_timeout_recovery_receipt_unique
  UNIQUE (project_id, recovery_receipt_id);

ALTER TABLE project.room_provider_admission_timeout_tombstones
  ADD CONSTRAINT room_provider_admission_timeout_recovery_receipt_shape_check
  CHECK (
    (recovery_protocol = 'opaque' AND recovery_receipt_id IS NULL)
    OR (recovery_protocol = 'core_sender_fenced_v1' AND recovery_receipt_id IS NOT NULL)
  );
