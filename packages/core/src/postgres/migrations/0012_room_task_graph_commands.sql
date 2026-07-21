-- FNXC:SessionRoomTaskDag 2026-07-18-12:48:
-- Task-graph commands share the operational Room aggregate and immutable Room
-- event ledger. This migration upgrades the existing Room task-node/edge
-- projections; it intentionally does not introduce a second graph store.

ALTER TABLE project.operational_rooms
  ADD COLUMN IF NOT EXISTS task_graph_version bigint;

UPDATE project.operational_rooms
SET task_graph_version = 0
WHERE task_graph_version IS NULL;

ALTER TABLE project.operational_rooms
  ALTER COLUMN task_graph_version SET DEFAULT 0,
  ALTER COLUMN task_graph_version SET NOT NULL,
  ADD CONSTRAINT operational_rooms_aggregate_version_check CHECK (
    aggregate_version BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT operational_rooms_task_graph_version_check CHECK (
    task_graph_version BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE project.room_task_nodes
  ADD COLUMN IF NOT EXISTS role_requirements jsonb,
  ADD COLUMN IF NOT EXISTS capability_requirements jsonb,
  ADD COLUMN IF NOT EXISTS resource_hints jsonb,
  ADD COLUMN IF NOT EXISTS authority_scope jsonb,
  ADD COLUMN IF NOT EXISTS retry_policy jsonb,
  ADD COLUMN IF NOT EXISTS acceptance_evidence_ids jsonb,
  ADD COLUMN IF NOT EXISTS reopened_by_evidence_id text;

UPDATE project.room_task_nodes
SET
  role_requirements = COALESCE(role_requirements, '[]'::jsonb),
  capability_requirements = COALESCE(capability_requirements, '[]'::jsonb),
  resource_hints = COALESCE(resource_hints, '{"estimatedDurationMs":0,"concurrencyClass":"serial","preferredProviderIds":[]}'::jsonb),
  authority_scope = COALESCE(authority_scope, '{"allowedActions":[],"readPaths":[],"writePaths":[]}'::jsonb),
  retry_policy = COALESCE(retry_policy, '{"maxAttempts":1,"backoff":"fixed","baseDelayMs":0,"recoveryActions":[]}'::jsonb),
  acceptance_evidence_ids = COALESCE(acceptance_evidence_ids, '[]'::jsonb),
  progress_signature = COALESCE(
    NULLIF(btrim(progress_signature), ''),
    format('legacy:0011:%s:v%s', id, node_version)
  );

DO $fusion$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project.room_task_nodes
    WHERE state = 'accepted'
      AND (
        accepted_at IS NULL
        OR btrim(accepted_at) = ''
      )
  ) THEN
    RAISE EXCEPTION 'legacy accepted Room task nodes lack accepted_at'
      USING
        ERRCODE = '23514',
        DETAIL = 'Migration 0012 cannot infer acceptance for legacy accepted nodes without a nonblank accepted_at value.';
  END IF;
END
$fusion$;

UPDATE project.room_task_nodes
SET acceptance_evidence_ids = jsonb_build_array(format(
  'legacy:0011:acceptance:md5:%s',
  md5(jsonb_build_array(project_id, room_id, id, node_version, accepted_at)::text)
))
WHERE state = 'accepted'
  AND accepted_at IS NOT NULL
  AND btrim(accepted_at) <> ''
  AND CASE WHEN jsonb_typeof(acceptance_evidence_ids) = 'array'
    THEN jsonb_array_length(acceptance_evidence_ids) = 0
    ELSE false
  END;

DO $fusion$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project.room_task_nodes
    WHERE state = 'accepted'
      AND NOT CASE WHEN jsonb_typeof(acceptance_evidence_ids) = 'array'
        THEN jsonb_array_length(acceptance_evidence_ids) > 0
        ELSE false
      END
  ) THEN
    RAISE EXCEPTION 'legacy accepted Room task nodes have malformed acceptance evidence'
      USING
        ERRCODE = '23514',
        DETAIL = 'Migration 0012 only synthesizes bounded legacy markers for missing evidence arrays; malformed existing evidence must be repaired.';
  END IF;
END
$fusion$;

ALTER TABLE project.room_task_nodes
  ALTER COLUMN role_requirements SET DEFAULT '[]'::jsonb,
  ALTER COLUMN role_requirements SET NOT NULL,
  ALTER COLUMN capability_requirements SET DEFAULT '[]'::jsonb,
  ALTER COLUMN capability_requirements SET NOT NULL,
  ALTER COLUMN resource_hints SET DEFAULT '{"estimatedDurationMs":0,"concurrencyClass":"serial","preferredProviderIds":[]}'::jsonb,
  ALTER COLUMN resource_hints SET NOT NULL,
  ALTER COLUMN authority_scope SET DEFAULT '{"allowedActions":[],"readPaths":[],"writePaths":[]}'::jsonb,
  ALTER COLUMN authority_scope SET NOT NULL,
  ALTER COLUMN retry_policy SET DEFAULT '{"maxAttempts":1,"backoff":"fixed","baseDelayMs":0,"recoveryActions":[]}'::jsonb,
  ALTER COLUMN retry_policy SET NOT NULL,
  ALTER COLUMN acceptance_evidence_ids SET DEFAULT '[]'::jsonb,
  ALTER COLUMN acceptance_evidence_ids SET NOT NULL,
  ALTER COLUMN progress_signature SET NOT NULL,
  ADD CONSTRAINT room_task_nodes_id_room_project_unique UNIQUE (id, room_id, project_id),
  ADD CONSTRAINT room_task_nodes_parent_room_project_fkey
    FOREIGN KEY (parent_node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id),
  ADD CONSTRAINT room_task_nodes_node_version_check CHECK (
    node_version BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT room_task_nodes_progress_signature_check CHECK (
    btrim(progress_signature) <> ''
  ),
  ADD CONSTRAINT room_task_nodes_role_requirements_check CHECK (
    CASE WHEN jsonb_typeof(role_requirements) = 'array'
      THEN NOT jsonb_path_exists(role_requirements, '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(role_requirements)
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_capability_requirements_check CHECK (
    CASE WHEN jsonb_typeof(capability_requirements) = 'array'
      THEN NOT jsonb_path_exists(capability_requirements, '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(capability_requirements)
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_resource_hints_check CHECK (
    jsonb_typeof(resource_hints) = 'object'
    AND resource_hints ?& ARRAY['estimatedDurationMs','concurrencyClass','preferredProviderIds']
    AND resource_hints - 'estimatedDurationMs' - 'concurrencyClass' - 'preferredProviderIds' = '{}'::jsonb
    AND jsonb_typeof(resource_hints->'estimatedDurationMs') = 'number'
    AND (resource_hints->>'estimatedDurationMs')::numeric BETWEEN 0 AND 9007199254740991
    AND trunc((resource_hints->>'estimatedDurationMs')::numeric) = (resource_hints->>'estimatedDurationMs')::numeric
    AND resource_hints->>'concurrencyClass' IN ('serial','parallel')
    AND CASE WHEN jsonb_typeof(resource_hints->'preferredProviderIds') = 'array'
      THEN NOT jsonb_path_exists(resource_hints->'preferredProviderIds', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(resource_hints->'preferredProviderIds')
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_authority_scope_check CHECK (
    jsonb_typeof(authority_scope) = 'object'
    AND authority_scope ?& ARRAY['allowedActions','readPaths','writePaths']
    AND authority_scope - 'allowedActions' - 'readPaths' - 'writePaths' = '{}'::jsonb
    AND CASE WHEN jsonb_typeof(authority_scope->'allowedActions') = 'array'
      THEN NOT jsonb_path_exists(authority_scope->'allowedActions', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(authority_scope->'allowedActions')
      ELSE false
    END
    AND CASE WHEN jsonb_typeof(authority_scope->'readPaths') = 'array'
      THEN NOT jsonb_path_exists(authority_scope->'readPaths', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(authority_scope->'readPaths')
      ELSE false
    END
    AND CASE WHEN jsonb_typeof(authority_scope->'writePaths') = 'array'
      THEN NOT jsonb_path_exists(authority_scope->'writePaths', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(authority_scope->'writePaths')
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_retry_policy_check CHECK (
    jsonb_typeof(retry_policy) = 'object'
    AND retry_policy ?& ARRAY['maxAttempts','backoff','baseDelayMs','recoveryActions']
    AND retry_policy - 'maxAttempts' - 'backoff' - 'baseDelayMs' - 'recoveryActions' = '{}'::jsonb
    AND jsonb_typeof(retry_policy->'maxAttempts') = 'number'
    AND (retry_policy->>'maxAttempts')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((retry_policy->>'maxAttempts')::numeric) = (retry_policy->>'maxAttempts')::numeric
    AND retry_policy->>'backoff' IN ('fixed','exponential')
    AND jsonb_typeof(retry_policy->'baseDelayMs') = 'number'
    AND (retry_policy->>'baseDelayMs')::numeric BETWEEN 0 AND 9007199254740991
    AND trunc((retry_policy->>'baseDelayMs')::numeric) = (retry_policy->>'baseDelayMs')::numeric
    AND CASE WHEN jsonb_typeof(retry_policy->'recoveryActions') = 'array'
      THEN NOT jsonb_path_exists(retry_policy->'recoveryActions', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(retry_policy->'recoveryActions')
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_acceptance_evidence_ids_check CHECK (
    CASE WHEN jsonb_typeof(acceptance_evidence_ids) = 'array'
      THEN NOT jsonb_path_exists(acceptance_evidence_ids, '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
        AND project.room_jsonb_text_array_is_unique(acceptance_evidence_ids)
      ELSE false
    END
  ),
  ADD CONSTRAINT room_task_nodes_acceptance_projection_check CHECK (
    CASE WHEN state = 'accepted'
      THEN accepted_at IS NOT NULL
        AND btrim(accepted_at) <> ''
        AND CASE WHEN jsonb_typeof(acceptance_evidence_ids) = 'array'
          THEN jsonb_array_length(acceptance_evidence_ids) > 0
          ELSE false
        END
      ELSE accepted_at IS NULL
        AND acceptance_evidence_ids = '[]'::jsonb
        AND invalidated_by_evidence_id IS NULL
    END
  );

DROP INDEX IF EXISTS project.idx_room_task_nodes_parent;
CREATE INDEX idx_room_task_nodes_parent
  ON project.room_task_nodes(project_id, room_id, parent_node_id);

ALTER TABLE project.room_task_edges
  DROP CONSTRAINT IF EXISTS room_task_edges_from_fkey,
  DROP CONSTRAINT IF EXISTS room_task_edges_to_fkey,
  ADD CONSTRAINT room_task_edges_from_room_project_fkey
    FOREIGN KEY (from_node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id) ON DELETE CASCADE,
  ADD CONSTRAINT room_task_edges_to_room_project_fkey
    FOREIGN KEY (to_node_id, room_id, project_id)
    REFERENCES project.room_task_nodes(id, room_id, project_id) ON DELETE CASCADE,
  ADD CONSTRAINT room_task_edges_kind_check CHECK (
    kind IN ('requires','informs','invalidates')
  ),
  ADD CONSTRAINT room_task_edges_self_check CHECK (from_node_id <> to_node_id);

DROP INDEX IF EXISTS project.idx_room_task_edges_to;
CREATE INDEX idx_room_task_edges_to
  ON project.room_task_edges(project_id, room_id, to_node_id);
