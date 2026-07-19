-- Bind task-dispatch delivery intent directly to the exact running node claim.
-- Generic Room messages intentionally retain NULL linkage and never alter task
-- state when a connector rejects them.

ALTER TABLE project.room_outbox
  ADD COLUMN IF NOT EXISTS dispatch_task_node_id text,
  ADD COLUMN IF NOT EXISTS dispatch_claim_node_version bigint;

ALTER TABLE project.room_outbox
  ADD CONSTRAINT room_outbox_dispatch_task_claim_check CHECK (
    (dispatch_task_node_id IS NULL AND dispatch_claim_node_version IS NULL)
    OR (
      dispatch_task_node_id IS NOT NULL
      AND dispatch_claim_node_version BETWEEN 1 AND 9007199254740991
    )
  ),
  ADD CONSTRAINT room_outbox_dispatch_task_node_room_project_fkey
    FOREIGN KEY (dispatch_task_node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_room_outbox_dispatch_task
  ON project.room_outbox(project_id, room_id, dispatch_task_node_id);
