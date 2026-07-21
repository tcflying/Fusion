-- FNXC:SessionRoomRecoveryPlan 2026-07-19
-- A claimed no-progress recovery action must produce an immutable, scoped
-- controller-plan or operator-escalation receipt before it can be acknowledged.

ALTER TABLE project.room_task_recovery_actions
  ADD CONSTRAINT room_task_recovery_actions_identity_room_project_unique
  UNIQUE (id, room_id, project_id);

CREATE TABLE project.room_task_recovery_plans (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  room_id text NOT NULL,
  recovery_action_id text NOT NULL,
  execution_mode text NOT NULL,
  action_snapshot jsonb NOT NULL,
  action_snapshot_hash text NOT NULL,
  result_receipt jsonb NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT room_task_recovery_plans_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_recovery_plans_action_room_project_fkey
    FOREIGN KEY (recovery_action_id, room_id, project_id)
    REFERENCES project.room_task_recovery_actions(id, room_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_task_recovery_plans_action_room_project_unique
    UNIQUE (recovery_action_id, room_id, project_id),
  CONSTRAINT room_task_recovery_plans_execution_mode_check
    CHECK (execution_mode IN ('controller_plan', 'operator_approval')),
  CONSTRAINT room_task_recovery_plans_action_snapshot_shape_check
    CHECK (jsonb_typeof(action_snapshot) = 'object'),
  CONSTRAINT room_task_recovery_plans_result_receipt_shape_check
    CHECK (jsonb_typeof(result_receipt) = 'object'),
  CONSTRAINT room_task_recovery_plans_nonblank_check
    CHECK (
      btrim(recovery_action_id) <> ''
      AND btrim(action_snapshot_hash) <> ''
      AND btrim(created_at) <> ''
    )
);

CREATE INDEX idx_room_task_recovery_plans_room_created
  ON project.room_task_recovery_plans(project_id, room_id, created_at, id);
