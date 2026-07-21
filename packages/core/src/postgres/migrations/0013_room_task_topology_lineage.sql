-- FNXC:SessionRoomTaskTopology 2026-07-18-15:20:
-- Dynamic split/merge/cancel/remove commands retain immutable node and edge
-- lineage in the existing Room DAG tables. Retired edges remain auditable but
-- no longer participate in active shape uniqueness or graph computation.
--
-- FNXC:SessionRoomTaskTopology 2026-07-18-15:58:
-- Single-row topology facts must reject SQL UNKNOWN, require real JSON strings,
-- and retain only canonical, calendar-valid UTC ISO timestamps.
--
-- FNXC:SessionRoomTaskTopology 2026-07-18-16:12:
-- Ordinary edges have no creation operation and no derived lineage. Derived
-- edges require both a nonblank creation operation and nonempty source lineage.

ALTER TABLE project.room_task_nodes
  ADD COLUMN IF NOT EXISTS origin jsonb,
  ADD COLUMN IF NOT EXISTS terminal_lineage jsonb;

UPDATE project.room_task_nodes
SET origin = '{"kind":"created"}'::jsonb
WHERE origin IS NULL;

ALTER TABLE project.room_task_nodes
  DROP CONSTRAINT IF EXISTS room_task_nodes_origin_check,
  DROP CONSTRAINT IF EXISTS room_task_nodes_terminal_lineage_check;

ALTER TABLE project.room_task_nodes
  ALTER COLUMN origin SET DEFAULT '{"kind":"created"}'::jsonb,
  ALTER COLUMN origin SET NOT NULL,
  ADD CONSTRAINT room_task_nodes_origin_check CHECK (
    (
      jsonb_typeof(origin) = 'object'
      AND (
        origin = '{"kind":"created"}'::jsonb
        OR (
          origin ?& ARRAY['kind','operationId','sourceNodeIds']
          AND origin - 'kind' - 'operationId' - 'sourceNodeIds' = '{}'::jsonb
          AND jsonb_typeof(origin->'kind') = 'string'
          AND origin->>'kind' IN ('split_child','merge_result')
          AND jsonb_typeof(origin->'operationId') = 'string'
          AND btrim(origin->>'operationId') <> ''
          AND CASE WHEN jsonb_typeof(origin->'sourceNodeIds') = 'array'
            THEN jsonb_array_length(origin->'sourceNodeIds') > 0
              AND NOT jsonb_path_exists(origin->'sourceNodeIds', '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
              AND project.room_jsonb_text_array_is_unique(origin->'sourceNodeIds')
              AND (
                (origin->>'kind' = 'split_child' AND jsonb_array_length(origin->'sourceNodeIds') = 1)
                OR (origin->>'kind' = 'merge_result' AND jsonb_array_length(origin->'sourceNodeIds') >= 2)
              )
            ELSE false
          END
        )
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT room_task_nodes_terminal_lineage_check CHECK (
    (
      terminal_lineage IS NULL
      OR (
        jsonb_typeof(terminal_lineage) = 'object'
        AND terminal_lineage ?& ARRAY['kind','operationId','at','reasonHash']
        AND terminal_lineage - 'kind' - 'operationId' - 'at' - 'reasonHash' = '{}'::jsonb
        AND jsonb_typeof(terminal_lineage->'kind') = 'string'
        AND terminal_lineage->>'kind' IN ('split','merge','cancel')
        AND jsonb_typeof(terminal_lineage->'operationId') = 'string'
        AND btrim(terminal_lineage->>'operationId') <> ''
        AND CASE
          WHEN jsonb_typeof(terminal_lineage->'at') = 'string'
            AND terminal_lineage->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
          THEN to_char((terminal_lineage->>'at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = terminal_lineage->>'at'
          ELSE false
        END
        AND jsonb_typeof(terminal_lineage->'reasonHash') = 'string'
        AND terminal_lineage->>'reasonHash' ~ '^sha256:[0-9a-f]{64}$'
        AND state = 'cancelled'
      )
    ) IS TRUE
  );

ALTER TABLE project.room_task_edges
  ADD COLUMN IF NOT EXISTS retired_at text,
  ADD COLUMN IF NOT EXISTS retired_by_operation_id text,
  ADD COLUMN IF NOT EXISTS created_by_operation_id text,
  ADD COLUMN IF NOT EXISTS derived_from_edge_ids jsonb;

UPDATE project.room_task_edges
SET derived_from_edge_ids = '[]'::jsonb
WHERE derived_from_edge_ids IS NULL;

UPDATE project.room_task_edges
SET created_by_operation_id = NULL
WHERE derived_from_edge_ids = '[]'::jsonb;

ALTER TABLE project.room_task_edges
  DROP CONSTRAINT IF EXISTS room_task_edges_retirement_check,
  DROP CONSTRAINT IF EXISTS room_task_edges_derived_lineage_check;

ALTER TABLE project.room_task_edges
  ALTER COLUMN derived_from_edge_ids SET DEFAULT '[]'::jsonb,
  ALTER COLUMN derived_from_edge_ids SET NOT NULL,
  ADD CONSTRAINT room_task_edges_retirement_check CHECK (
    (
      (retired_at IS NULL AND retired_by_operation_id IS NULL)
      OR (
        retired_at IS NOT NULL
        AND CASE
          WHEN retired_at ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
          THEN to_char(retired_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = retired_at
          ELSE false
        END
        AND retired_by_operation_id IS NOT NULL
        AND btrim(retired_by_operation_id) <> ''
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT room_task_edges_derived_lineage_check CHECK (
    (
      CASE WHEN jsonb_typeof(derived_from_edge_ids) = 'array'
        THEN NOT jsonb_path_exists(derived_from_edge_ids, '$[*] ? (@.type() != "string" || @ like_regex "^\\s*$")')
          AND project.room_jsonb_text_array_is_unique(derived_from_edge_ids)
          AND (
            (created_by_operation_id IS NULL AND derived_from_edge_ids = '[]'::jsonb)
            OR (
              created_by_operation_id IS NOT NULL
              AND btrim(created_by_operation_id) <> ''
              AND jsonb_array_length(derived_from_edge_ids) > 0
            )
          )
        ELSE false
      END
    ) IS TRUE
  );

ALTER TABLE project.room_task_edges
  DROP CONSTRAINT IF EXISTS room_task_edges_shape_unique;

DROP INDEX IF EXISTS room_task_edges_active_shape_unique;

CREATE UNIQUE INDEX room_task_edges_active_shape_unique
  ON project.room_task_edges(project_id, room_id, from_node_id, to_node_id, kind)
  WHERE retired_at IS NULL;
