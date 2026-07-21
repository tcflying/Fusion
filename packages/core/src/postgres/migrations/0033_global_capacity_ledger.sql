CREATE TABLE central.global_capacity_state (
  id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  policy_hash text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT global_capacity_state_id_check
    CHECK (id = 'global-capacity-ledger-v1'),
  CONSTRAINT global_capacity_state_revision_check
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  CONSTRAINT global_capacity_state_policy_hash_check
    CHECK (btrim(policy_hash) <> ''),
  CONSTRAINT global_capacity_state_updated_at_check
    CHECK (btrim(updated_at) <> '')
);

CREATE TABLE central.global_capacity_claims (
  id text NOT NULL,
  project_id text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  work_class text NOT NULL,
  slots integer NOT NULL,
  holder_id text NOT NULL,
  lease_id text NOT NULL,
  fence bigint NOT NULL,
  acquired_at text NOT NULL,
  expires_at text NOT NULL,
  released_at text,
  CONSTRAINT global_capacity_claims_primary
    PRIMARY KEY (project_id, id),
  CONSTRAINT global_capacity_claims_resource_kind_check
    CHECK (resource_kind IN ('room_worker','legacy_task','legacy_triage')),
  CONSTRAINT global_capacity_claims_work_class_check
    CHECK (work_class IN ('normal','verifier','recovery')),
  CONSTRAINT global_capacity_claims_slots_check
    CHECK (slots BETWEEN 1 AND 2147483647),
  CONSTRAINT global_capacity_claims_fence_check
    CHECK (fence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT global_capacity_claims_window_check
    CHECK (expires_at > acquired_at),
  CONSTRAINT global_capacity_claims_nonblank_check
    CHECK (
      btrim(id) <> ''
      AND btrim(project_id) <> ''
      AND btrim(resource_kind) <> ''
      AND btrim(resource_id) <> ''
      AND btrim(work_class) <> ''
      AND btrim(holder_id) <> ''
      AND btrim(lease_id) <> ''
      AND btrim(acquired_at) <> ''
      AND btrim(expires_at) <> ''
      AND (released_at IS NULL OR btrim(released_at) <> '')
    )
);

CREATE INDEX idx_global_capacity_claims_active
  ON central.global_capacity_claims(project_id, resource_kind, work_class, expires_at, id)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX idx_global_capacity_claims_active_resource
  ON central.global_capacity_claims(project_id, resource_kind, resource_id)
  WHERE released_at IS NULL;

CREATE INDEX idx_global_capacity_claims_expiry
  ON central.global_capacity_claims(expires_at, id)
  WHERE released_at IS NULL;

CREATE TABLE central.global_capacity_operations (
  project_id text NOT NULL,
  command_kind text NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  claim_id text,
  fence bigint,
  occurred_at text NOT NULL,
  CONSTRAINT global_capacity_operations_primary
    PRIMARY KEY (project_id, command_kind, operation_id),
  CONSTRAINT global_capacity_operations_kind_check
    CHECK (command_kind IN ('acquire','renew','release')),
  CONSTRAINT global_capacity_operations_action_check
    CHECK (action IN ('acquired','renewed','released','held','rejected')),
  CONSTRAINT global_capacity_operations_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT global_capacity_operations_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(command_kind) <> ''
      AND btrim(operation_id) <> ''
      AND btrim(request_hash) <> ''
      AND btrim(action) <> ''
      AND btrim(reason) <> ''
      AND btrim(occurred_at) <> ''
      AND (claim_id IS NULL OR btrim(claim_id) <> '')
    )
);

CREATE INDEX idx_global_capacity_operations_claim
  ON central.global_capacity_operations(project_id, claim_id, command_kind, occurred_at);
