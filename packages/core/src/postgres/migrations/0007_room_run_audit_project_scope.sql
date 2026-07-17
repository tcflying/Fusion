-- FNXC:SessionRoomAudit 2026-07-17-00:55:
-- Room lifecycle and delivery audits must carry a first-class project_id so
-- cross-project reads can filter on a real partition key. Older rows are
-- backfilled once from metadata.projectId for compatibility, but live queries
-- must never treat metadata as the isolation boundary.
--
-- Historical upgrade-path fixtures may only record baseline/room migration
-- versions without ever materializing project.run_audit_events. Guard the DDL
-- so replaying 0007 after those synthetic checkpoints remains idempotent.
DO $$
BEGIN
  IF to_regclass('project.run_audit_events') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE project.run_audit_events
    ADD COLUMN IF NOT EXISTS project_id text;

  UPDATE project.run_audit_events
  SET project_id = metadata->>'projectId'
  WHERE project_id IS NULL
    AND jsonb_typeof(metadata) = 'object'
    AND jsonb_typeof(metadata->'projectId') = 'string';

  -- Existing task/merge audit callers historically did not duplicate the
  -- project id into metadata. Recover their authoritative partition from the
  -- task row before leaving genuinely global/unknown legacy facts as NULL.
  IF to_regclass('project.tasks') IS NOT NULL THEN
    UPDATE project.run_audit_events AS audit
    SET project_id = task.project_id
    FROM project.tasks AS task
    WHERE audit.project_id IS NULL
      AND audit.task_id = task.id
      AND task.project_id IS NOT NULL;
  END IF;

  IF to_regclass('project.archived_tasks') IS NOT NULL THEN
    UPDATE project.run_audit_events AS audit
    SET project_id = task.project_id
    FROM project.archived_tasks AS task
    WHERE audit.project_id IS NULL
      AND audit.task_id = task.id
      AND task.project_id IS NOT NULL;
  END IF;

  CREATE INDEX IF NOT EXISTS "idxRunAuditEventsProjectIdTimestamp"
    ON project.run_audit_events(project_id, timestamp);
END
$$;
