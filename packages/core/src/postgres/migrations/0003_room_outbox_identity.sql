-- Persist the provider/local idempotency identity before connector dispatch.
-- Existing pre-0003 outbox rows receive a deterministic legacy-safe id; new
-- rows use Fusion's canonical SHA-256 helper before the transaction commits.

ALTER TABLE project.room_outbox
  ADD COLUMN IF NOT EXISTS local_message_id text;

UPDATE project.room_outbox
SET local_message_id = 'fusion-room-legacy-' || md5(
  idempotency_key || ':' || binding_id || ':' || logical_message_id
)
WHERE local_message_id IS NULL;

ALTER TABLE project.room_outbox
  ALTER COLUMN local_message_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_outbox_local_message
  ON project.room_outbox(binding_id, local_message_id);
