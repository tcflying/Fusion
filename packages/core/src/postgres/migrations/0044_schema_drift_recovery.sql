/*
FNXC:PostgresSchemaDriftRecovery 2026-07-21-23:05:
Some earlier upgrades recorded their bookkeeping marker before the baseline
DDL reached every table. Replaying the additive compatibility definitions here
is safe for populated databases and makes the runtime schema converge instead
of failing one missing column at a time. No rows are deleted or rewritten.
*/

CREATE TABLE IF NOT EXISTS project.boards (
  project_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  workflow_id text NOT NULL,
  ordering integer NOT NULL DEFAULT 0,
  require_plan_approval integer NOT NULL DEFAULT 0,
  lfg_mode integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyBoardsProjectOrdering" ON project.boards(project_id, ordering);

CREATE TABLE IF NOT EXISTS project.project_auth_users (
  project_id text NOT NULL,
  id text NOT NULL,
  email text NOT NULL,
  display_name text,
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthUsersEmail" ON project.project_auth_users(project_id, email);

CREATE TABLE IF NOT EXISTS project.project_auth_memberships (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthMembershipsUser" ON project.project_auth_memberships(project_id, user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthMembershipsRole" ON project.project_auth_memberships(project_id, role);

CREATE TABLE IF NOT EXISTS project.project_auth_providers (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  metadata text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxLegacyProjectAuthProvidersIdentity" ON project.project_auth_providers(project_id, provider, provider_user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthProvidersUser" ON project.project_auth_providers(project_id, user_id);

CREATE TABLE IF NOT EXISTS project.project_auth_sessions (
  project_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  membership_id text NOT NULL,
  session_token text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id) REFERENCES project.project_auth_users(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, membership_id) REFERENCES project.project_auth_memberships(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsToken" ON project.project_auth_sessions(project_id, session_token);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsUser" ON project.project_auth_sessions(project_id, user_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsMembership" ON project.project_auth_sessions(project_id, membership_id);
CREATE INDEX IF NOT EXISTS "idxLegacyProjectAuthSessionsExpiry" ON project.project_auth_sessions(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project.task_reviewer_runs (
  project_id text NOT NULL,
  id text NOT NULL,
  task_id text NOT NULL,
  board_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  summary text,
  failure_reasons text,
  reviewer_agent_id text,
  rework_round integer NOT NULL DEFAULT 0,
  started_at text NOT NULL,
  completed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  invalidated_at text,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS "idxLegacyTaskReviewerRunsTask" ON project.task_reviewer_runs(project_id, task_id);
CREATE INDEX IF NOT EXISTS "idxLegacyTaskReviewerRunsStatus" ON project.task_reviewer_runs(project_id, status);

CREATE TABLE IF NOT EXISTS project.import_translation_cache (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  provider text NOT NULL,
  repo_key text NOT NULL,
  issue_number integer NOT NULL,
  target_locale text NOT NULL,
  source_hash text NOT NULL,
  translated_title text NOT NULL,
  translated_body text NOT NULL,
  detected_locale text,
  recorded_at text NOT NULL,
  CONSTRAINT import_translation_cache_pkey
    PRIMARY KEY (project_id, provider, repo_key, issue_number, target_locale)
);
CREATE INDEX IF NOT EXISTS "idxImportTranslationCacheRecordedAt" ON project.import_translation_cache(recorded_at);

ALTER TABLE IF EXISTS project.ai_sessions ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.chat_rooms ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.chat_sessions
  ADD COLUMN IF NOT EXISTS owner_project_id text,
  ADD COLUMN IF NOT EXISTS validator_thinking_level text,
  ADD COLUMN IF NOT EXISTS planning_thinking_level text,
  ADD COLUMN IF NOT EXISTS pinned_at text;
ALTER TABLE IF EXISTS project.chat_token_usage ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.cli_sessions ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.eval_runs ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.experiment_sessions ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.mission_contract_assertions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'feature';
ALTER TABLE IF EXISTS project.project_insight_runs ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.project_insights ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.research_runs ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.task_document_revisions ADD COLUMN IF NOT EXISTS legacy_sqlite_id integer;
ALTER TABLE IF EXISTS project.todo_lists ADD COLUMN IF NOT EXISTS owner_project_id text;
ALTER TABLE IF EXISTS project.workflows ADD COLUMN IF NOT EXISTS icon text;

-- Run-audit event IDs are UUIDs generated by Fusion and remain globally unique
-- even though the ownership migration also carries project_id in its key.
CREATE UNIQUE INDEX IF NOT EXISTS "idxRunAuditEventsGlobalId" ON project.run_audit_events(id);

DO $$
BEGIN
  IF to_regprocedure('project.fusion_assign_project_id()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.import_translation_cache;
    CREATE TRIGGER fusion_assign_project_id
      BEFORE INSERT OR UPDATE OF project_id ON project.import_translation_cache
      FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON project.import_translation_cache TO fusion_runtime;
  END IF;
END
$$;
