-- Bind task-dispatch delivery intent directly to the exact running node claim.
-- Generic Room messages intentionally retain NULL linkage and never alter task
-- state when a connector rejects them.

-- FNXC:SessionRoomPostgres 2026-07-21-22:28:
-- Existing embedded clusters can contain this migration's DDL without its
-- bookkeeping marker after an interrupted upgrade. Re-check each named
-- constraint before adding it so startup can resume without weakening either
-- the claim-shape or composite lineage invariant.

ALTER TABLE project.room_outbox
  ADD COLUMN IF NOT EXISTS dispatch_task_node_id text,
  ADD COLUMN IF NOT EXISTS dispatch_claim_node_version bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'project.room_outbox'::regclass
      AND conname = 'room_outbox_dispatch_task_claim_check'
  ) THEN
    ALTER TABLE project.room_outbox
      ADD CONSTRAINT room_outbox_dispatch_task_claim_check CHECK (
        (dispatch_task_node_id IS NULL AND dispatch_claim_node_version IS NULL)
        OR (
          dispatch_task_node_id IS NOT NULL
          AND dispatch_claim_node_version BETWEEN 1 AND 9007199254740991
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'project.room_outbox'::regclass
      AND conname = 'room_outbox_dispatch_task_node_room_project_fkey'
  ) THEN
    ALTER TABLE project.room_outbox
      ADD CONSTRAINT room_outbox_dispatch_task_node_room_project_fkey
        FOREIGN KEY (dispatch_task_node_id, room_id, project_id)
        REFERENCES project.room_task_nodes(id, room_id, project_id)
        ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_room_outbox_dispatch_task
  ON project.room_outbox(project_id, room_id, dispatch_task_node_id);
