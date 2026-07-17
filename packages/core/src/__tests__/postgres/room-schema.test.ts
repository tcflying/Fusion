import { describe, expect, it } from "vitest";

import {
  ROOM_PROJECT_TABLE_NAMES,
  operationalRooms,
  roomAlerts,
  roomBindingIngestionState,
  roomBindings,
  roomCandidates,
  roomCheckpoints,
  roomConfidenceSnapshots,
  roomDissents,
  roomEvents,
  roomEvidence,
  roomGateResults,
  roomIdempotencyKeys,
  roomInboxReceipts,
  roomLeases,
  roomMembershipChanges,
  roomMessages,
  roomOutbox,
  roomOutboxAttempts,
  roomPromotions,
  roomReviews,
  roomSeats,
  roomTaskEdges,
  roomTaskNodes,
  roomTurns,
  roomArtifacts,
} from "../../postgres/schema/room.js";
import {
  SCHEMA_MIGRATIONS,
  readSchemaMigrationSql,
} from "../../postgres/schema-applier.js";

describe("Session Room PostgreSQL schema", () => {
  it("defines the complete canonical project-schema table set", () => {
    expect(ROOM_PROJECT_TABLE_NAMES).toEqual([
      "operational_rooms",
      "room_seats",
      "room_bindings",
      "room_binding_ingestion_state",
      "room_turns",
      "room_membership_changes",
      "room_events",
      "room_task_nodes",
      "room_task_edges",
      "room_messages",
      "room_outbox",
      "room_outbox_attempts",
      "room_inbox_receipts",
      "room_idempotency_keys",
      "room_leases",
      "room_checkpoints",
      "room_artifacts",
      "room_evidence",
      "room_candidates",
      "room_reviews",
      "room_dissents",
      "room_gate_results",
      "room_promotions",
      "room_confidence_snapshots",
      "room_alerts",
    ]);

    expect([
      operationalRooms,
      roomSeats,
      roomBindings,
      roomBindingIngestionState,
      roomTurns,
      roomMembershipChanges,
      roomEvents,
      roomTaskNodes,
      roomTaskEdges,
      roomMessages,
      roomOutbox,
      roomOutboxAttempts,
      roomInboxReceipts,
      roomIdempotencyKeys,
      roomLeases,
      roomCheckpoints,
      roomArtifacts,
      roomEvidence,
      roomCandidates,
      roomReviews,
      roomDissents,
      roomGateResults,
      roomPromotions,
      roomConfidenceSnapshots,
      roomAlerts,
    ]).not.toContain(undefined);
  });

  it("registers an ordered incremental migration after the baseline", async () => {
    expect(SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual(["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"]);
    const roomSql = await readSchemaMigrationSql("0001");
    const ownershipSql = await readSchemaMigrationSql("0002");
    const outboxIdentitySql = await readSchemaMigrationSql("0003");
    const connectorIngestionSql = await readSchemaMigrationSql("0004");
    const deliveryReconciliationSql = await readSchemaMigrationSql("0005");
    const membershipFutureSeatsSql = await readSchemaMigrationSql("0006");
    const roomRunAuditProjectScopeSql = await readSchemaMigrationSql("0007");
    const roomRunAuditOutboxSql = await readSchemaMigrationSql("0008");
    const membershipProductionInvariantsSql = await readSchemaMigrationSql("0009");

    for (const tableName of ROOM_PROJECT_TABLE_NAMES.filter((name) => name !== "room_binding_ingestion_state")) {
      expect(roomSql).toContain(`project.${tableName}`);
    }
    expect(roomSql).toContain("UNIQUE (room_id, aggregate_version)");
    expect(roomSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_room_outbox_logical_message");
    expect(ownershipSql).toContain("idx_room_bindings_active_native_session");
    expect(ownershipSql).toContain("idx_room_bindings_active_happier_session");
    expect(outboxIdentitySql).toContain("local_message_id");
    expect(outboxIdentitySql).toContain("idx_room_outbox_local_message");
    expect(connectorIngestionSql).toContain("project.room_binding_ingestion_state");
    expect(connectorIngestionSql).toContain("idx_room_inbox_receipts_native_message");
    expect(deliveryReconciliationSql).toContain("reconciliation_from_cursor");
    expect(deliveryReconciliationSql).toContain("reconciliation_evidence_ref");
    expect(deliveryReconciliationSql).toContain("machine_id");
    expect(membershipFutureSeatsSql).toContain("DROP CONSTRAINT IF EXISTS room_membership_changes_seat_fkey");
    expect(roomRunAuditProjectScopeSql).toContain("run_audit_events");
    expect(roomRunAuditProjectScopeSql).toContain("project_id");
    expect(roomRunAuditProjectScopeSql).toContain("metadata->>'projectId'");
    expect(roomRunAuditProjectScopeSql).toContain("WHERE project_id IS NULL");
    expect(roomRunAuditOutboxSql).toContain("run_audit_outbox");
    expect(roomRunAuditOutboxSql).toContain("claim_expires_at");
    expect(roomRunAuditOutboxSql).toContain("attempt_count");
    expect(membershipProductionInvariantsSql).toContain("reserved_native_session_id");
    expect(membershipProductionInvariantsSql).toContain("idx_room_bindings_active_native_session");
  });
});
