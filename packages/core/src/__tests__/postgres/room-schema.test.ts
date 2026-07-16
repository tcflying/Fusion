import { describe, expect, it } from "vitest";

import {
  ROOM_PROJECT_TABLE_NAMES,
  operationalRooms,
  roomAlerts,
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
    expect(SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual(["0000", "0001", "0002", "0003"]);
    const roomSql = await readSchemaMigrationSql("0001");
    const ownershipSql = await readSchemaMigrationSql("0002");
    const outboxIdentitySql = await readSchemaMigrationSql("0003");

    for (const tableName of ROOM_PROJECT_TABLE_NAMES) {
      expect(roomSql).toContain(`project.${tableName}`);
    }
    expect(roomSql).toContain("UNIQUE (room_id, aggregate_version)");
    expect(roomSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_room_outbox_logical_message");
    expect(ownershipSql).toContain("idx_room_bindings_active_native_session");
    expect(ownershipSql).toContain("idx_room_bindings_active_happier_session");
    expect(outboxIdentitySql).toContain("local_message_id");
    expect(outboxIdentitySql).toContain("idx_room_outbox_local_message");
  });
});
