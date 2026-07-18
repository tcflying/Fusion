import { describe, expect, it } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

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
  roomMessageTargets,
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

const pgDialect = new PgDialect();

function normalizeCheckSql(value: string): string {
  return value
    .replace(/"project"\."[^"]+"\."([^"]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function declarativeChecks(table: Parameters<typeof getTableConfig>[0]): Map<string, string> {
  return new Map(
    getTableConfig(table).checks.map((constraint) => [
      constraint.name,
      normalizeCheckSql(pgDialect.sqlToQuery(constraint.value).sql),
    ]),
  );
}

function migrationCheck(migrationSql: string, constraintName: string): string {
  const marker = `ADD CONSTRAINT ${constraintName} CHECK (`;
  const markerIndex = migrationSql.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Migration is missing CHECK constraint ${constraintName}`);
  }

  const expressionStart = markerIndex + marker.length;
  let depth = 1;
  let quote: "'" | '"' | undefined;

  for (let cursor = expressionStart; cursor < migrationSql.length; cursor += 1) {
    const character = migrationSql[cursor];
    if (quote !== undefined) {
      if (character === quote) {
        if (migrationSql[cursor + 1] === quote) {
          cursor += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return normalizeCheckSql(migrationSql.slice(expressionStart, cursor));
      }
    }
  }

  throw new Error(`Migration CHECK constraint ${constraintName} is not balanced`);
}

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
      "room_message_targets",
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
      roomMessageTargets,
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
    expect(SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual(["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012"]);
    const roomSql = await readSchemaMigrationSql("0001");
    const ownershipSql = await readSchemaMigrationSql("0002");
    const outboxIdentitySql = await readSchemaMigrationSql("0003");
    const connectorIngestionSql = await readSchemaMigrationSql("0004");
    const deliveryReconciliationSql = await readSchemaMigrationSql("0005");
    const membershipFutureSeatsSql = await readSchemaMigrationSql("0006");
    const roomRunAuditProjectScopeSql = await readSchemaMigrationSql("0007");
    const roomRunAuditOutboxSql = await readSchemaMigrationSql("0008");
    const membershipProductionInvariantsSql = await readSchemaMigrationSql("0009");
    const nativeSenderTakeoverSql = await readSchemaMigrationSql("0010");
    const messageRoutingSql = await readSchemaMigrationSql("0011");
    const taskGraphCommandsSql = await readSchemaMigrationSql("0012");

    for (const tableName of ROOM_PROJECT_TABLE_NAMES.filter((name) => ![
      "room_binding_ingestion_state",
      "room_message_targets",
    ].includes(name))) {
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
    expect(nativeSenderTakeoverSql).toContain("project.room_binding_ingestion_state");
    expect(nativeSenderTakeoverSql).toContain("takeover_id");
    expect(nativeSenderTakeoverSql).toContain("blocked_outbox_ids");
    expect(nativeSenderTakeoverSql).toContain("room_binding_ingestion_takeover_projection_check");
    expect(messageRoutingSql).toContain("project.room_message_targets");
    expect(messageRoutingSql).toContain("room_bindings_id_seat_room_project_unique");
    expect(messageRoutingSql).toContain("target_seat_ids");
    expect(messageRoutingSql).toContain("idempotency_key");
    expect(messageRoutingSql).toContain("expected_aggregate_version");
    expect(taskGraphCommandsSql).toContain("task_graph_version");
    expect(taskGraphCommandsSql).toContain("role_requirements");
    expect(taskGraphCommandsSql).toContain("acceptance_evidence_ids");
    expect(taskGraphCommandsSql).toContain("room_task_edges_from_room_project_fkey");
    expect(taskGraphCommandsSql).toContain("room_task_edges_kind_check");
  });

  it("models typed task-graph command projections on the existing Room tables", () => {
    expect({
      taskGraphVersion: operationalRooms.taskGraphVersion.name,
      roleRequirements: roomTaskNodes.roleRequirements.name,
      capabilityRequirements: roomTaskNodes.capabilityRequirements.name,
      resourceHints: roomTaskNodes.resourceHints.name,
      authorityScope: roomTaskNodes.authorityScope.name,
      retryPolicy: roomTaskNodes.retryPolicy.name,
      acceptanceEvidenceIds: roomTaskNodes.acceptanceEvidenceIds.name,
      reopenedByEvidenceId: roomTaskNodes.reopenedByEvidenceId.name,
    }).toEqual({
      taskGraphVersion: "task_graph_version",
      roleRequirements: "role_requirements",
      capabilityRequirements: "capability_requirements",
      resourceHints: "resource_hints",
      authorityScope: "authority_scope",
      retryPolicy: "retry_policy",
      acceptanceEvidenceIds: "acceptance_evidence_ids",
      reopenedByEvidenceId: "reopened_by_evidence_id",
    });
  });

  it("keeps task-graph CHECK constraints aligned with migration 0012", async () => {
    const migrationSql = await readSchemaMigrationSql("0012");
    const roomChecks = declarativeChecks(operationalRooms);
    const nodeChecks = declarativeChecks(roomTaskNodes);
    const edgeChecks = declarativeChecks(roomTaskEdges);

    expect(Object.fromEntries([
      "operational_rooms_aggregate_version_check",
      "operational_rooms_task_graph_version_check",
    ].map((name) => [name, roomChecks.get(name)]))).toEqual({
      operational_rooms_aggregate_version_check: "aggregate_version BETWEEN 0 AND 9007199254740991",
      operational_rooms_task_graph_version_check: "task_graph_version BETWEEN 0 AND 9007199254740991",
    });

    for (const constraintName of [
      "operational_rooms_aggregate_version_check",
      "operational_rooms_task_graph_version_check",
      "room_task_nodes_node_version_check",
      "room_task_nodes_progress_signature_check",
      "room_task_nodes_role_requirements_check",
      "room_task_nodes_capability_requirements_check",
      "room_task_nodes_resource_hints_check",
      "room_task_nodes_authority_scope_check",
      "room_task_nodes_retry_policy_check",
      "room_task_nodes_acceptance_evidence_ids_check",
      "room_task_nodes_acceptance_projection_check",
      "room_task_edges_kind_check",
      "room_task_edges_self_check",
    ]) {
      const checks = constraintName.startsWith("operational_rooms_")
        ? roomChecks
        : constraintName.startsWith("room_task_edges_")
          ? edgeChecks
          : nodeChecks;
      expect(checks.get(constraintName), constraintName).toBe(migrationCheck(migrationSql, constraintName));
    }
  });

  it("models durable routed-message targets and backward-compatible provenance", () => {
    expect({
      targetSeatIds: roomMessages.targetSeatIds.name,
      idempotencyKey: roomMessages.idempotencyKey.name,
      expectedAggregateVersion: roomMessages.expectedAggregateVersion.name,
      messageId: roomMessageTargets.messageId.name,
      selectorKind: roomMessageTargets.selectorKind.name,
      selectorRef: roomMessageTargets.selectorRef.name,
      targetKind: roomMessageTargets.targetKind.name,
      seatId: roomMessageTargets.seatId.name,
      bindingId: roomMessageTargets.bindingId.name,
      ordinal: roomMessageTargets.ordinal.name,
    }).toEqual({
      targetSeatIds: "target_seat_ids",
      idempotencyKey: "idempotency_key",
      expectedAggregateVersion: "expected_aggregate_version",
      messageId: "message_id",
      selectorKind: "selector_kind",
      selectorRef: "selector_ref",
      targetKind: "target_kind",
      seatId: "seat_id",
      bindingId: "binding_id",
      ordinal: "ordinal",
    });
  });

  it("models the native IDE sender takeover projection on binding ingestion state", () => {
    expect({
      takeoverId: roomBindingIngestionState.takeoverId.name,
      takeoverEpoch: roomBindingIngestionState.takeoverEpoch.name,
      takeoverState: roomBindingIngestionState.takeoverState.name,
      autoSenderLeaseEpoch: roomBindingIngestionState.autoSenderLeaseEpoch.name,
      reconcileFromCursor: roomBindingIngestionState.reconcileFromCursor.name,
      confirmedCursor: roomBindingIngestionState.confirmedCursor.name,
      blockedOutboxIds: roomBindingIngestionState.blockedOutboxIds.name,
    }).toEqual({
      takeoverId: "takeover_id",
      takeoverEpoch: "takeover_epoch",
      takeoverState: "takeover_state",
      autoSenderLeaseEpoch: "auto_sender_lease_epoch",
      reconcileFromCursor: "reconcile_from_cursor",
      confirmedCursor: "confirmed_cursor",
      blockedOutboxIds: "blocked_outbox_ids",
    });
  });
});
