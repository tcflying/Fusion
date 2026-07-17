-- FNXC:SessionRoomAuditOutbox 2026-07-18-02:23:
-- Durable, project-scoped Room lifecycle audit delivery. Claims expire so a
-- replacement controller can replay after a crash; exhausted rows remain
-- visible for operator recovery and stable event ids make sink replay safe.
CREATE SCHEMA IF NOT EXISTS project;

CREATE TABLE IF NOT EXISTS project.run_audit_outbox (
  id text PRIMARY KEY,
  dispatch_sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  room_id text NOT NULL,
  timestamp text NOT NULL,
  task_id text,
  agent_id text NOT NULL,
  run_id text NOT NULL,
  domain text NOT NULL,
  mutation_type text NOT NULL,
  target text NOT NULL,
  metadata jsonb,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  claim_token text,
  claim_expires_at text,
  last_error_code text,
  delivered_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT run_audit_outbox_dispatch_sequence_unique UNIQUE (dispatch_sequence),
  CONSTRAINT run_audit_outbox_state_check CHECK (
    state IN ('pending','dispatching','exhausted','delivered')
  )
);

CREATE INDEX IF NOT EXISTS "idxRunAuditOutboxDispatch"
  ON project.run_audit_outbox(project_id, state, next_attempt_at, claim_expires_at);

CREATE INDEX IF NOT EXISTS "idxRunAuditOutboxRoom"
  ON project.run_audit_outbox(project_id, room_id, dispatch_sequence);
