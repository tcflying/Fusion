-- FNXC:GlobalCapacityPolicyAuthority 2026-07-20-04:04:
-- Capacity reservations and lease TTL must be installed explicitly by the
-- central host, not inferred from the first project request or settings.
-- This separate singleton is synchronized with global_capacity_state under the
-- ledger advisory lock by the typed authority store.
CREATE TABLE central.global_capacity_policy_authority (
  id text PRIMARY KEY,
  policy_json jsonb NOT NULL,
  policy_hash text NOT NULL,
  revision bigint NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT global_capacity_policy_authority_id_check
    CHECK (id = 'global-capacity-policy-authority-v1'),
  CONSTRAINT global_capacity_policy_authority_policy_json_check
    CHECK (jsonb_typeof(policy_json) = 'object'),
  CONSTRAINT global_capacity_policy_authority_policy_hash_check
    CHECK (policy_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT global_capacity_policy_authority_revision_check
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT global_capacity_policy_authority_updated_at_check
    CHECK (btrim(updated_at) <> '')
);
