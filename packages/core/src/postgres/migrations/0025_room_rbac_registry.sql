CREATE TABLE project.room_rbac_authorization_states (
  project_id text PRIMARY KEY,
  authorization_version bigint NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT room_rbac_authorization_states_version_check
    CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_rbac_authorization_states_nonblank_check
    CHECK (btrim(project_id) <> '' AND btrim(updated_at) <> '')
);

CREATE TABLE project.room_trusted_device_sessions (
  project_id text NOT NULL,
  session_id text NOT NULL,
  credential_digest text NOT NULL,
  principal_id text NOT NULL,
  device_id text NOT NULL,
  issued_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  session_version bigint NOT NULL,
  CONSTRAINT room_trusted_device_sessions_primary
    PRIMARY KEY (project_id, session_id),
  CONSTRAINT room_trusted_device_sessions_credential_digest_unique
    UNIQUE (credential_digest),
  CONSTRAINT room_trusted_device_sessions_digest_check
    CHECK (credential_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_trusted_device_sessions_version_check
    CHECK (session_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_trusted_device_sessions_window_check
    CHECK (expires_at > issued_at),
  CONSTRAINT room_trusted_device_sessions_revoke_check
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CONSTRAINT room_trusted_device_sessions_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(session_id) <> ''
      AND btrim(principal_id) <> ''
      AND btrim(device_id) <> ''
      AND btrim(issued_at) <> ''
      AND btrim(expires_at) <> ''
      AND (revoked_at IS NULL OR btrim(revoked_at) <> '')
    )
);

CREATE INDEX idx_room_trusted_device_sessions_principal
  ON project.room_trusted_device_sessions(project_id, principal_id, device_id, expires_at);

CREATE INDEX idx_room_trusted_device_sessions_active
  ON project.room_trusted_device_sessions(project_id, expires_at, session_id)
  WHERE revoked_at IS NULL;

CREATE TABLE project.room_rbac_grants (
  project_id text NOT NULL,
  grant_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL,
  room_id text,
  granted_at text NOT NULL,
  revoked_at text,
  CONSTRAINT room_rbac_grants_primary
    PRIMARY KEY (project_id, grant_id),
  CONSTRAINT room_rbac_grants_room_project_fkey
    FOREIGN KEY (room_id, project_id)
    REFERENCES project.operational_rooms(id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT room_rbac_grants_role_check
    CHECK (role IN ('owner','admin','operator','observer','auditor')),
  CONSTRAINT room_rbac_grants_revoke_check
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CONSTRAINT room_rbac_grants_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(grant_id) <> ''
      AND btrim(principal_id) <> ''
      AND btrim(granted_at) <> ''
      AND (room_id IS NULL OR btrim(room_id) <> '')
      AND (revoked_at IS NULL OR btrim(revoked_at) <> '')
    )
);

CREATE INDEX idx_room_rbac_grants_snapshot
  ON project.room_rbac_grants(project_id, principal_id, room_id, granted_at)
  WHERE revoked_at IS NULL;

CREATE TABLE project.room_rbac_registry_operations (
  project_id text NOT NULL,
  command_kind text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  authorization_version bigint,
  session_version bigint,
  occurred_at text NOT NULL,
  CONSTRAINT room_rbac_registry_operations_primary
    PRIMARY KEY (project_id, command_kind, idempotency_key),
  CONSTRAINT room_rbac_registry_operations_kind_check
    CHECK (command_kind IN ('issue_trusted_device_session','revoke_trusted_device_session','grant_role','revoke_role_grant')),
  CONSTRAINT room_rbac_registry_operations_entity_check
    CHECK (entity_type IN ('trusted_device_session','role_grant')),
  CONSTRAINT room_rbac_registry_operations_hash_check
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_rbac_registry_operations_authorization_version_check
    CHECK (authorization_version IS NULL OR authorization_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_rbac_registry_operations_session_version_check
    CHECK (session_version IS NULL OR session_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_rbac_registry_operations_nonblank_check
    CHECK (
      btrim(project_id) <> ''
      AND btrim(command_kind) <> ''
      AND btrim(idempotency_key) <> ''
      AND btrim(entity_id) <> ''
      AND btrim(occurred_at) <> ''
    )
);

CREATE INDEX idx_room_rbac_registry_operations_entity
  ON project.room_rbac_registry_operations(project_id, entity_type, entity_id, occurred_at);
