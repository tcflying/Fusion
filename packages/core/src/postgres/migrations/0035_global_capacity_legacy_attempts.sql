-- FNXC:GlobalCapacityLegacyAttempt 2026-07-20-04:31:
-- Capacity acquisition is not an execution receipt. Persist a separate legacy
-- task/triage attempt state machine so a replayed acquire operation cannot
-- rerun an already-started external side effect after a process crash.
CREATE TABLE central.global_capacity_legacy_attempts (
  id text NOT NULL,
  project_id text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  state text NOT NULL,
  work_class text NOT NULL,
  slots integer NOT NULL,
  holder_id text NOT NULL,
  lease_id text NOT NULL,
  capacity_fence bigint NOT NULL,
  claim_id text NOT NULL,
  acquire_operation_id text NOT NULL,
  acquire_generation integer NOT NULL,
  last_withheld_operation_id text,
  renew_operation_id text NOT NULL,
  renew_generation integer NOT NULL,
  last_renewal_operation_id text,
  release_operation_id text NOT NULL,
  prepared_at text NOT NULL,
  expires_at text NOT NULL,
  admitted_at text,
  work_started_at text,
  work_start_receipt_id text,
  work_finished_at text,
  released_at text,
  superseded_at text,
  updated_at text NOT NULL,
  CONSTRAINT global_capacity_legacy_attempts_primary PRIMARY KEY (project_id, id),
  CONSTRAINT global_capacity_legacy_attempts_resource_kind_check
    CHECK (resource_kind IN ('legacy_task','legacy_triage')),
  CONSTRAINT global_capacity_legacy_attempts_state_check
    CHECK (state IN ('prepared','withheld','admitted','work_started','work_finished','released','superseded')),
  CONSTRAINT global_capacity_legacy_attempts_work_class_check
    CHECK (work_class IN ('normal','verifier','recovery')),
  CONSTRAINT global_capacity_legacy_attempts_slots_check
    CHECK (slots BETWEEN 1 AND 2147483647),
  CONSTRAINT global_capacity_legacy_attempts_fence_check
    CHECK (capacity_fence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT global_capacity_legacy_attempts_generation_check
    CHECK (acquire_generation BETWEEN 1 AND 2147483647),
  CONSTRAINT global_capacity_legacy_attempts_renew_generation_check
    CHECK (renew_generation BETWEEN 1 AND 2147483647),
  CONSTRAINT global_capacity_legacy_attempts_window_check
    CHECK (expires_at > prepared_at),
  CONSTRAINT global_capacity_legacy_attempts_nonblank_check CHECK (
    btrim(id) <> ''
    AND btrim(project_id) <> ''
    AND btrim(resource_kind) <> ''
    AND btrim(resource_id) <> ''
    AND btrim(state) <> ''
    AND btrim(work_class) <> ''
    AND btrim(holder_id) <> ''
    AND btrim(lease_id) <> ''
    AND btrim(claim_id) <> ''
    AND btrim(acquire_operation_id) <> ''
    AND btrim(renew_operation_id) <> ''
    AND btrim(release_operation_id) <> ''
    AND btrim(prepared_at) <> ''
    AND btrim(expires_at) <> ''
    AND btrim(updated_at) <> ''
    AND (last_withheld_operation_id IS NULL OR btrim(last_withheld_operation_id) <> '')
    AND (last_renewal_operation_id IS NULL OR btrim(last_renewal_operation_id) <> '')
    AND (admitted_at IS NULL OR btrim(admitted_at) <> '')
    AND (work_started_at IS NULL OR btrim(work_started_at) <> '')
    AND (work_start_receipt_id IS NULL OR btrim(work_start_receipt_id) <> '')
    AND (work_finished_at IS NULL OR btrim(work_finished_at) <> '')
    AND (released_at IS NULL OR btrim(released_at) <> '')
    AND (superseded_at IS NULL OR btrim(superseded_at) <> '')
  ),
  CONSTRAINT global_capacity_legacy_attempts_state_timestamps_check CHECK (
    (
      state IN ('prepared','withheld')
      AND admitted_at IS NULL
      AND work_started_at IS NULL
      AND work_start_receipt_id IS NULL
      AND work_finished_at IS NULL
      AND released_at IS NULL
      AND superseded_at IS NULL
    )
    OR (
      state = 'admitted'
      AND admitted_at IS NOT NULL
      AND work_started_at IS NULL
      AND work_start_receipt_id IS NULL
      AND work_finished_at IS NULL
      AND released_at IS NULL
      AND superseded_at IS NULL
    )
    OR (
      state = 'work_started'
      AND admitted_at IS NOT NULL
      AND work_started_at IS NOT NULL
      AND work_start_receipt_id IS NOT NULL
      AND work_finished_at IS NULL
      AND released_at IS NULL
      AND superseded_at IS NULL
    )
    OR (
      state = 'work_finished'
      AND admitted_at IS NOT NULL
      AND work_started_at IS NOT NULL
      AND work_start_receipt_id IS NOT NULL
      AND work_finished_at IS NOT NULL
      AND released_at IS NULL
      AND superseded_at IS NULL
    )
    OR (
      state = 'released'
      AND released_at IS NOT NULL
      AND superseded_at IS NULL
      AND (
        (work_started_at IS NULL AND work_start_receipt_id IS NULL)
        OR (work_started_at IS NOT NULL AND work_start_receipt_id IS NOT NULL)
      )
    )
    OR (
      state = 'superseded'
      AND work_started_at IS NULL
      AND work_start_receipt_id IS NULL
      AND work_finished_at IS NULL
      AND released_at IS NULL
      AND superseded_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX idx_global_capacity_legacy_attempts_active_resource
  ON central.global_capacity_legacy_attempts(project_id, resource_kind, resource_id)
  WHERE state IN ('prepared','withheld','admitted','work_started','work_finished');

CREATE INDEX idx_global_capacity_legacy_attempts_resource_history
  ON central.global_capacity_legacy_attempts(project_id, resource_kind, resource_id, capacity_fence);

CREATE INDEX idx_global_capacity_legacy_attempts_recovery
  ON central.global_capacity_legacy_attempts(state, updated_at)
  WHERE state IN ('work_started','work_finished');
