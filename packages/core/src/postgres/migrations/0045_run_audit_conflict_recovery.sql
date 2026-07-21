/*
FNXC:RunAuditConflictRecovery 2026-07-21-23:15:
The ownership migration keeps project_id in the physical key, while the
runtime audit writer retries by globally unique event id. Preserve that
idempotent writer contract with an additive unique index; the observed UUID
identity is already collision-free across the populated target.
*/
CREATE UNIQUE INDEX IF NOT EXISTS "idxRunAuditEventsGlobalId" ON project.run_audit_events(id);
