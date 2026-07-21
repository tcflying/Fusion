-- FNXC:RoomHostCompositionOperatorAuthority 2026-07-20-09:18:
-- A Room execution bundle is selected deliberately by the central host for one
-- registered project and one concrete host. The record stores only static
-- adapter identities and placement policy; live provider/session facts remain
-- external verified observations and must not be copied into policy_json.
CREATE TABLE central.room_host_composition_operator_policy_authority (
  project_id text NOT NULL REFERENCES central.projects(id) ON DELETE RESTRICT,
  host_id text NOT NULL,
  bundle_id text NOT NULL,
  issuer text NOT NULL,
  policy_json jsonb NOT NULL,
  policy_hash text NOT NULL,
  revision bigint NOT NULL,
  issued_at text NOT NULL,
  updated_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  revoked_reason text,
  CONSTRAINT room_host_composition_operator_policy_authority_primary
    PRIMARY KEY (project_id, host_id),
  CONSTRAINT room_host_composition_operator_policy_authority_policy_json_check
    CHECK (jsonb_typeof(policy_json) = 'object'),
  CONSTRAINT room_host_composition_operator_policy_authority_policy_hash_check
    CHECK (policy_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT room_host_composition_operator_policy_authority_revision_check
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT room_host_composition_operator_policy_authority_window_check
    CHECK (expires_at > issued_at),
  CONSTRAINT room_host_composition_operator_policy_authority_revocation_check
    CHECK (
      (revoked_at IS NULL AND revoked_reason IS NULL)
      OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
    ),
  CONSTRAINT room_host_composition_operator_policy_authority_nonblank_check CHECK (
    btrim(project_id) <> ''
    AND btrim(host_id) <> ''
    AND btrim(bundle_id) <> ''
    AND btrim(issuer) <> ''
    AND btrim(policy_hash) <> ''
    AND btrim(issued_at) <> ''
    AND btrim(updated_at) <> ''
    AND btrim(expires_at) <> ''
    AND (revoked_at IS NULL OR btrim(revoked_at) <> '')
    AND (revoked_reason IS NULL OR btrim(revoked_reason) <> '')
  )
);

CREATE INDEX idx_room_host_composition_operator_policy_authority_active
  ON central.room_host_composition_operator_policy_authority(project_id, host_id, expires_at)
  WHERE revoked_at IS NULL;
