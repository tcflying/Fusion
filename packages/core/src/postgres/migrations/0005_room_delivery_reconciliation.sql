-- Persist the exact provider-history boundary captured before an outbound
-- send, plus the immutable evidence reference used to resolve an ambiguous
-- acknowledgement after process failure. Both columns are intentionally
-- nullable for pre-existing rows and providers whose history starts at origin.

ALTER TABLE project.room_outbox
  ADD COLUMN IF NOT EXISTS reconciliation_from_cursor text,
  ADD COLUMN IF NOT EXISTS reconciliation_evidence_ref text;

-- Happier resolves a native provider Session through both its machine and
-- Session identity. Historical bindings cannot be inferred safely, so this is
-- nullable and delivery fails closed until an exact identity is available.
ALTER TABLE project.room_bindings
  ADD COLUMN IF NOT EXISTS machine_id text;
