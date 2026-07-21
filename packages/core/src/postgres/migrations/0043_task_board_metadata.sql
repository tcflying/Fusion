-- FNXC:PostgresMigrationColumnCoverage 2026-07-21-22:45:
-- Existing PostgreSQL baselines predate the late task-board metadata fields
-- already required by the Drizzle task schema. Add them independently so an
-- upgrade never reaches TaskStore reads with a structurally incomplete tasks
-- table; IF NOT EXISTS keeps interrupted upgrades retryable.

ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS board_id text,
  ADD COLUMN IF NOT EXISTS task_question_interrupt text,
  ADD COLUMN IF NOT EXISTS column_dwell_ms jsonb,
  ADD COLUMN IF NOT EXISTS workflow_transition_notification jsonb,
  ADD COLUMN IF NOT EXISTS planner_oversight_level text,
  ADD COLUMN IF NOT EXISTS awaiting_approval_reason text,
  ADD COLUMN IF NOT EXISTS approved_plan_fingerprint text;
