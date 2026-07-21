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
  roomCapabilityRegistryProjections,
  roomBlindReviewRegistries,
  roomEvolutionHypotheses,
  roomEvolutionLegacyProvenanceQuarantines,
  roomEvolutionTrustedBindings,
  roomEvolutionTrustedBindingRevocations,
  roomEvolutionCandidateVersions,
  roomEvolutionExperiments,
  roomEvolutionBenchmarkCases,
  roomEvolutionBenchmarkResults,
  roomEvolutionGateResults,
  roomEvolutionCanaries,
  roomEvolutionCanaryObservations,
  roomEvolutionCanarySuccessOutcomes,
  roomEvolutionPromotionDecisions,
  roomEvolutionRollbacks,
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
  roomProviderBackpressureStates,
  roomProviderBackpressureReservations,
  roomProviderAdmissionTimeoutTombstones,
  roomProviderBackpressureOperations,
  roomRbacAuthorizationStates,
  roomReviews,
  roomSeats,
  roomTaskEdges,
  roomTaskNodes,
  roomTurns,
  roomArtifacts,
  roomGlobalConcurrencyState,
  roomGlobalConcurrencyClaims,
  roomGlobalConcurrencyOperations,
  roomTrustedDeviceSessions,
  roomRbacGrants,
  roomRbacRegistryOperations,
} from "../../postgres/schema/room.js";
import {
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION,
  SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION,
  SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION,
  SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION,
  SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION,
  SCHEMA_ROOM_MESSAGE_ROUTING_VERSION,
  SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION,
  SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION,
  SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION,
  SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION,
  SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION,
  SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION,
  SCHEMA_ROOM_VERSION,
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
      "room_capability_registry_projections",
      "room_blind_review_registries",
      "room_evolution_hypotheses",
      "room_evolution_legacy_provenance_quarantines",
      "room_evolution_trusted_bindings",
      "room_evolution_trusted_binding_revocations",
      "room_evolution_candidate_versions",
      "room_evolution_experiments",
      "room_evolution_benchmark_cases",
      "room_evolution_benchmark_results",
      "room_evolution_gate_results",
      "room_evolution_canaries",
      "room_evolution_canary_observations",
      "room_evolution_canary_success_outcomes",
      "room_evolution_promotion_decisions",
      "room_evolution_rollbacks",
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
      "room_global_concurrency_state",
      "room_global_concurrency_claims",
      "room_global_concurrency_operations",
      "room_provider_backpressure_states",
      "room_provider_backpressure_reservations",
      "room_provider_admission_timeout_tombstones",
      "room_provider_backpressure_operations",
      "room_rbac_authorization_states",
      "room_trusted_device_sessions",
      "room_rbac_grants",
      "room_rbac_registry_operations",
    ]);

    expect([
      operationalRooms,
      roomSeats,
      roomBindings,
      roomBindingIngestionState,
      roomTurns,
      roomMembershipChanges,
      roomEvents,
      roomCapabilityRegistryProjections,
      roomBlindReviewRegistries,
      roomEvolutionHypotheses,
      roomEvolutionLegacyProvenanceQuarantines,
      roomEvolutionTrustedBindings,
      roomEvolutionTrustedBindingRevocations,
      roomEvolutionCandidateVersions,
      roomEvolutionExperiments,
      roomEvolutionBenchmarkCases,
      roomEvolutionBenchmarkResults,
      roomEvolutionGateResults,
      roomEvolutionCanaries,
      roomEvolutionCanaryObservations,
      roomEvolutionCanarySuccessOutcomes,
      roomEvolutionPromotionDecisions,
      roomEvolutionRollbacks,
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
      roomGlobalConcurrencyState,
      roomGlobalConcurrencyClaims,
      roomGlobalConcurrencyOperations,
      roomProviderBackpressureStates,
      roomProviderBackpressureReservations,
      roomProviderAdmissionTimeoutTombstones,
      roomProviderBackpressureOperations,
      roomRbacAuthorizationStates,
      roomTrustedDeviceSessions,
      roomRbacGrants,
      roomRbacRegistryOperations,
    ]).not.toContain(undefined);
  });

  it("registers an ordered incremental migration after the baseline", async () => {
    expect(SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual(
      Array.from({ length: 75 }, (_, index) => String(index).padStart(4, "0")),
    );
    const roomSql = await readSchemaMigrationSql(SCHEMA_ROOM_VERSION);
    const ownershipSql = await readSchemaMigrationSql(SCHEMA_ROOM_BINDING_OWNERSHIP_VERSION);
    const outboxIdentitySql = await readSchemaMigrationSql(SCHEMA_ROOM_OUTBOX_IDENTITY_VERSION);
    const connectorIngestionSql = await readSchemaMigrationSql(SCHEMA_ROOM_CONNECTOR_INGESTION_VERSION);
    const deliveryReconciliationSql = await readSchemaMigrationSql(SCHEMA_ROOM_DELIVERY_RECONCILIATION_VERSION);
    const membershipFutureSeatsSql = await readSchemaMigrationSql(SCHEMA_ROOM_MEMBERSHIP_FUTURE_SEATS_VERSION);
    const roomRunAuditProjectScopeSql = await readSchemaMigrationSql(SCHEMA_ROOM_RUN_AUDIT_PROJECT_SCOPE_VERSION);
    const roomRunAuditOutboxSql = await readSchemaMigrationSql(SCHEMA_ROOM_RUN_AUDIT_OUTBOX_VERSION);
    const membershipProductionInvariantsSql = await readSchemaMigrationSql(SCHEMA_ROOM_MEMBERSHIP_PRODUCTION_INVARIANTS_VERSION);
    const nativeSenderTakeoverSql = await readSchemaMigrationSql(SCHEMA_ROOM_NATIVE_SENDER_TAKEOVER_VERSION);
    const messageRoutingSql = await readSchemaMigrationSql(SCHEMA_ROOM_MESSAGE_ROUTING_VERSION);
    const taskGraphCommandsSql = await readSchemaMigrationSql(SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION);
    const taskTopologyLineageSql = await readSchemaMigrationSql(SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION);

    const baseRoomTableNames = [
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
    ];

    for (const tableName of baseRoomTableNames) {
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
    expect(roomRunAuditProjectScopeSql).toContain("WHERE (project_id IS NULL");
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
    expect(taskTopologyLineageSql).toContain("terminal_lineage");
    expect(taskTopologyLineageSql).toContain("retired_by_operation_id");
    expect(taskTopologyLineageSql).toContain("created_by_operation_id");
    expect(taskTopologyLineageSql).toContain("derived_from_edge_ids");
    expect(taskTopologyLineageSql).toContain("room_task_edges_active_shape_unique");
    expect(taskTopologyLineageSql).toContain("WHERE retired_at IS NULL");
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
      origin: roomTaskNodes.origin.name,
      terminalLineage: roomTaskNodes.terminalLineage.name,
      retiredAt: roomTaskEdges.retiredAt.name,
      retiredByOperationId: roomTaskEdges.retiredByOperationId.name,
      createdByOperationId: roomTaskEdges.createdByOperationId.name,
      derivedFromEdgeIds: roomTaskEdges.derivedFromEdgeIds.name,
    }).toEqual({
      taskGraphVersion: "task_graph_version",
      roleRequirements: "role_requirements",
      capabilityRequirements: "capability_requirements",
      resourceHints: "resource_hints",
      authorityScope: "authority_scope",
      retryPolicy: "retry_policy",
      acceptanceEvidenceIds: "acceptance_evidence_ids",
      reopenedByEvidenceId: "reopened_by_evidence_id",
      origin: "origin",
      terminalLineage: "terminal_lineage",
      retiredAt: "retired_at",
      retiredByOperationId: "retired_by_operation_id",
      createdByOperationId: "created_by_operation_id",
      derivedFromEdgeIds: "derived_from_edge_ids",
    });
  });

  it("keeps topology-lineage CHECK constraints aligned with the canonical Room migration", async () => {
    const migrationSql = await readSchemaMigrationSql(SCHEMA_ROOM_TASK_TOPOLOGY_LINEAGE_VERSION);
    const nodeChecks = declarativeChecks(roomTaskNodes);
    const edgeChecks = declarativeChecks(roomTaskEdges);

    for (const constraintName of [
      "room_task_nodes_origin_check",
      "room_task_nodes_terminal_lineage_check",
      "room_task_edges_retirement_check",
      "room_task_edges_derived_lineage_check",
    ]) {
      const checks = constraintName.startsWith("room_task_edges_") ? edgeChecks : nodeChecks;
      expect(checks.get(constraintName), constraintName).toBe(migrationCheck(migrationSql, constraintName));
    }

    const originCheck = nodeChecks.get("room_task_nodes_origin_check");
    const terminalLineageCheck = nodeChecks.get("room_task_nodes_terminal_lineage_check");
    const retirementCheck = edgeChecks.get("room_task_edges_retirement_check");
    for (const field of ["kind", "operationId"]) {
      expect(originCheck).toContain(`jsonb_typeof(origin->'${field}') = 'string'`);
    }
    expect(originCheck).toMatch(/\) IS TRUE$/);
    for (const field of ["kind", "operationId", "at", "reasonHash"]) {
      expect(terminalLineageCheck).toContain(`jsonb_typeof(terminal_lineage->'${field}') = 'string'`);
    }
    expect(terminalLineageCheck).toContain("terminal_lineage->>'at' ~ '^[0-9]{4}-");
    expect(terminalLineageCheck).toMatch(/\) IS TRUE$/);
    expect(retirementCheck).toContain("retired_at ~ '^[0-9]{4}-");
    expect(retirementCheck).toMatch(/\) IS TRUE$/);
    const derivedLineageCheck = edgeChecks.get("room_task_edges_derived_lineage_check");
    expect(derivedLineageCheck).toContain("created_by_operation_id IS NULL");
    expect(derivedLineageCheck).toContain("btrim(created_by_operation_id) <> ''");
    expect(derivedLineageCheck).toContain("jsonb_array_length(derived_from_edge_ids) > 0");
    expect(derivedLineageCheck).toMatch(/\) IS TRUE$/);
  });

  it("keeps task-graph CHECK constraints aligned with the canonical Room migration", async () => {
    const migrationSql = await readSchemaMigrationSql(SCHEMA_ROOM_TASK_GRAPH_COMMANDS_VERSION);
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
