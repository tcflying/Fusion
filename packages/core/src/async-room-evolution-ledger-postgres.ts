import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
  RoomEvolutionLedgerError,
  type RoomEvolutionBenchmarkCaseRecordV1,
  type RoomEvolutionBenchmarkResultRecordV1,
  type RoomEvolutionCanarySuccessOutcomeRecordV1,
  type RoomEvolutionCanaryObservationRecordV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionExperimentRecordV1,
  type RoomEvolutionGateResultRecordV1,
  type RoomEvolutionHypothesisRecordV1,
  type RoomEvolutionIssuerGrantV1,
  type RoomEvolutionJsonObjectV1,
  type RoomEvolutionLedgerAppendOutcome,
  type RoomEvolutionLedgerEntry,
  type RoomEvolutionLedgerPersistence,
  type RoomEvolutionLedgerReferenceQuery,
  type RoomEvolutionLedgerReferenceSnapshot,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionLedgerTransaction,
  type RoomEvolutionPromotionDecisionRecordV1,
  type RoomEvolutionRollbackRecordV1,
  type RoomEvolutionTrustedBindingRecordV1,
  type RoomEvolutionTrustedBindingRevocationRecordV1,
} from "./async-room-evolution-ledger.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomEvolutionBenchmarkCases,
  roomEvolutionBenchmarkResults,
  roomEvolutionCanaries,
  roomEvolutionCanaryObservations,
  roomEvolutionCanarySuccessOutcomes,
  roomEvolutionCandidateVersions,
  roomEvolutionExperiments,
  roomEvolutionGateResults,
  roomEvolutionHypotheses,
  roomEvolutionPromotionDecisions,
  roomEvolutionRollbacks,
  roomEvolutionTrustedBindingRevocations,
  roomEvolutionTrustedBindings,
  roomBindings,
  roomRbacGrants,
  roomSeats,
} from "./postgres/schema/room.js";

export class AsyncRoomEvolutionLedgerPostgresPersistence implements RoomEvolutionLedgerPersistence {
  constructor(private readonly layer: AsyncDataLayer) {}

  async transaction<TResult>(
    operation: (transaction: RoomEvolutionLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.layer.transactionImmediate(async (tx) =>
      operation(new DrizzleRoomEvolutionLedgerTransaction(tx, this.layer.projectId)));
  }
}

class DrizzleRoomEvolutionLedgerTransaction implements RoomEvolutionLedgerTransaction {
  constructor(
    private readonly tx: DbTransaction,
    private readonly boundProjectId: string | undefined,
  ) {}

  async resolveReferences(
    input: RoomEvolutionLedgerReferenceQuery,
  ): Promise<RoomEvolutionLedgerReferenceSnapshot> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    return {
      scope: { ...input.scope },
      hypotheses: await loadHypotheses(this.tx, input.scope, input.hypothesisIds),
      candidateVersions: await loadCandidateVersions(this.tx, input.scope, input.candidateVersionIds),
      trustedBindings: await loadTrustedBindings(this.tx, input.scope, input.trustedBindingIds),
      experiments: await loadExperiments(this.tx, input.scope, input.experimentIds),
      benchmarkCases: await loadBenchmarkCases(this.tx, input.scope, input.benchmarkCaseIds),
      benchmarkResults: await loadBenchmarkResults(this.tx, input.scope, input.benchmarkResultIds),
      gateResults: await loadGateResults(this.tx, input.scope, input.gateResultIds),
      canaries: await loadCanaries(this.tx, input.scope, input.canaryIds),
      canaryObservations: await loadCanaryObservations(this.tx, input.scope, input.canaryObservationIds),
      canarySuccessOutcomes: await loadCanarySuccessOutcomes(this.tx, input.scope, input.canarySuccessOutcomeIds),
      promotionDecisions: await loadPromotionDecisions(this.tx, input.scope, input.promotionDecisionIds),
      rollbacks: await loadRollbacks(this.tx, input.scope, input.rollbackIds),
    };
  }

  async findTrustedBindingRevocation(
    scope: RoomEvolutionLedgerScope,
    trustedBindingId: string,
  ): Promise<Pick<RoomEvolutionTrustedBindingRevocationRecordV1, "trustedBindingId" | "revokedAt"> | null> {
    assertBoundProjectScope(this.boundProjectId, scope);
    await assertRoomScope(this.tx, scope);
    const rows = await this.tx
      .select({
        trustedBindingId: roomEvolutionTrustedBindingRevocations.trustedBindingId,
        revokedAt: roomEvolutionTrustedBindingRevocations.revokedAt,
      })
      .from(roomEvolutionTrustedBindingRevocations)
      .where(and(
        eq(roomEvolutionTrustedBindingRevocations.projectId, scope.projectId),
        eq(roomEvolutionTrustedBindingRevocations.scopeKind, scope.scopeKind),
        eq(roomEvolutionTrustedBindingRevocations.scopeKey, scope.scopeKey),
        scope.roomId === null
          ? isNull(roomEvolutionTrustedBindingRevocations.roomId)
          : eq(roomEvolutionTrustedBindingRevocations.roomId, scope.roomId),
        eq(roomEvolutionTrustedBindingRevocations.trustedBindingId, trustedBindingId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async resolveTrustedBindingSubject(input: {
    readonly projectId: string;
    readonly roomId: string;
    readonly roomBindingId: string;
  }) {
    assertBoundProjectId(this.boundProjectId, input.projectId);
    const bindingRows = await this.tx
      .select()
      .from(roomBindings)
      .where(and(
        eq(roomBindings.projectId, input.projectId),
        eq(roomBindings.roomId, input.roomId),
        eq(roomBindings.id, input.roomBindingId),
      ))
      .limit(1);
    const binding = bindingRows[0];
    if (!binding) return null;
    const seatRows = await this.tx
      .select()
      .from(roomSeats)
      .where(and(
        eq(roomSeats.projectId, input.projectId),
        eq(roomSeats.roomId, input.roomId),
        eq(roomSeats.id, binding.seatId),
      ))
      .limit(1);
    const seat = seatRows[0];
    if (!seat) return null;
    return {
      projectId: input.projectId,
      roomId: input.roomId,
      roomBindingId: binding.id,
      roomBindingGeneration: binding.generation,
      roleId: seat.role,
      roleVersion: seat.roleVersion,
    } as const;
  }

  async resolveEvolutionIssuerGrant(input: {
    readonly projectId: string;
    readonly grantId: string;
  }) {
    assertBoundProjectId(this.boundProjectId, input.projectId);
    const rows = await this.tx
      .select()
      .from(roomRbacGrants)
      .where(and(
        eq(roomRbacGrants.projectId, input.projectId),
        eq(roomRbacGrants.grantId, input.grantId),
      ))
      .limit(1);
    const grant = rows[0];
    if (!grant) return null;
    return {
      projectId: grant.projectId,
      grantId: grant.grantId,
      principalId: grant.principalId,
      role: issuerGrantRole(grant.role),
      roomId: grant.roomId,
      grantedAt: grant.grantedAt,
      revokedAt: grant.revokedAt,
    } as const;
  }

  async findCanarySuccessOutcome(
    scope: RoomEvolutionLedgerScope,
    canaryId: string,
  ): Promise<RoomEvolutionCanarySuccessOutcomeRecordV1 | null> {
    assertBoundProjectScope(this.boundProjectId, scope);
    await assertRoomScope(this.tx, scope);
    const rows = await this.tx.select().from(roomEvolutionCanarySuccessOutcomes).where(and(
      eq(roomEvolutionCanarySuccessOutcomes.projectId, scope.projectId),
      eq(roomEvolutionCanarySuccessOutcomes.scopeKind, scope.scopeKind),
      eq(roomEvolutionCanarySuccessOutcomes.scopeKey, scope.scopeKey),
      scope.roomId === null
        ? isNull(roomEvolutionCanarySuccessOutcomes.roomId)
        : eq(roomEvolutionCanarySuccessOutcomes.roomId, scope.roomId),
      eq(roomEvolutionCanarySuccessOutcomes.canaryId, canaryId),
    )).limit(1);
    return rows[0] ? rowToCanarySuccessOutcome(rows[0]) : null;
  }

  async append(input: {
    readonly scope: RoomEvolutionLedgerScope;
    readonly entry: RoomEvolutionLedgerEntry;
  }): Promise<RoomEvolutionLedgerAppendOutcome> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    assertEntryScope(input.scope, input.entry);
    await assertRoomScope(this.tx, input.scope);
    switch (input.entry.table) {
      case "room_evolution_hypotheses":
        return appendHypothesis(this.tx, input.scope, input.entry.record);
      case "room_evolution_candidate_versions":
        return appendCandidateVersion(this.tx, input.scope, input.entry.record);
      case "room_evolution_trusted_bindings":
        return appendTrustedBinding(this.tx, input.scope, input.entry.record);
      case "room_evolution_experiments":
        return appendExperiment(this.tx, input.scope, input.entry.record);
      case "room_evolution_benchmark_cases":
        return appendBenchmarkCase(this.tx, input.scope, input.entry.record);
      case "room_evolution_benchmark_results":
        return appendBenchmarkResult(this.tx, input.scope, input.entry.record);
      case "room_evolution_gate_results":
        return appendGateResult(this.tx, input.scope, input.entry.record);
      case "room_evolution_canaries":
        return appendCanary(this.tx, input.scope, input.entry.record);
      case "room_evolution_canary_observations":
        return appendCanaryObservation(this.tx, input.scope, input.entry.record);
      case "room_evolution_trusted_binding_revocations":
        return appendTrustedBindingRevocation(this.tx, input.scope, input.entry.record);
      case "room_evolution_canary_success_outcomes":
        return appendCanarySuccessOutcome(this.tx, input.scope, input.entry.record);
      case "room_evolution_promotion_decisions":
        return appendPromotionDecision(this.tx, input.scope, input.entry.record);
      case "room_evolution_rollbacks":
        return appendRollback(this.tx, input.scope, input.entry.record);
      default:
        throw new RoomEvolutionLedgerError("invalid_input", "Unsupported Room evolution ledger entry");
    }
  }
}

async function appendHypothesis(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionHypothesisRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionHypotheses)
    .values({
      id: record.id,
      ...scopeValues(scope),
      revision: record.revision,
      state: record.state,
      sourceSignalKinds: record.sourceSignalKinds,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      declaredScope: record.declaredScope,
      riskClass: record.riskClass,
      expectedMechanism: record.expectedMechanism,
      affectedDomains: record.affectedDomains,
      createdByActorId: record.createdByActorId,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomEvolutionHypotheses.id })
    .returning({ id: roomEvolutionHypotheses.id });
  return insertOutcome(record.id, rows);
}

async function appendCandidateVersion(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionCandidateVersionRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionCandidateVersions)
    .values({
      id: record.id,
      ...scopeValues(scope),
      hypothesisId: record.hypothesisId,
      versionNumber: record.versionNumber,
      candidateKind: record.candidateKind,
      baseRevision: record.baseRevision,
      candidateRef: record.candidateRef,
      isolationKind: record.isolationKind,
      isolationRef: record.isolationRef,
      immutableInput: record.immutableInput,
      inputHash: record.inputHash,
      candidateHash: record.candidateHash,
      producedByActorId: record.producedByActorId,
      producerBindingId: record.producerBindingId,
      producerBindingVersion: record.producerBindingVersion,
      baseCandidateVersionId: record.baseCandidateVersionId,
      rollbackTargetCandidateVersionId: record.rollbackTargetCandidateVersionId,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomEvolutionCandidateVersions.id })
    .returning({ id: roomEvolutionCandidateVersions.id });
  return insertOutcome(record.id, rows);
}

async function appendTrustedBinding(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionTrustedBindingRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionTrustedBindings)
    .values({
      id: record.id,
      ...scopeValues(scope),
      actorId: record.actorId,
      purpose: record.purpose,
      subjectRoomId: record.subjectRoomId,
      roomBindingId: record.roomBindingId,
      roomBindingGeneration: record.roomBindingGeneration,
      roleId: record.roleId,
      roleVersion: record.roleVersion,
      bindingVersion: record.bindingVersion,
      issuedByPrincipalId: record.issuedByPrincipalId,
      issuerGrantId: record.issuerGrantId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      integrityHash: record.integrityHash,
    })
    .onConflictDoNothing({ target: roomEvolutionTrustedBindings.id })
    .returning({ id: roomEvolutionTrustedBindings.id });
  return insertOutcome(record.id, rows);
}

async function appendExperiment(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionExperimentRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionExperiments)
    .values({
      id: record.id,
      ...scopeValues(scope),
      hypothesisId: record.hypothesisId,
      candidateVersionId: record.candidateVersionId,
      state: record.state,
      inputSnapshotHash: record.inputSnapshotHash,
      authorizationEvidence: record.authorizationEvidence,
      authorizationHash: record.authorizationHash,
      capacityPool: record.capacityPool,
      createdByActorId: record.createdByActorId,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomEvolutionExperiments.id })
    .returning({ id: roomEvolutionExperiments.id });
  return insertOutcome(record.id, rows);
}

async function appendBenchmarkCase(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionBenchmarkCaseRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionBenchmarkCases)
    .values({
      id: record.id,
      ...scopeValues(scope),
      domain: record.domain,
      caseKind: record.caseKind,
      containsPrivateRoomData: record.containsPrivateRoomData,
      sourceAuthorizationId: record.sourceAuthorizationId,
      authorizationEvidence: record.authorizationEvidence,
      casePayload: record.casePayload,
      expectedOutcome: record.expectedOutcome,
      contentHash: record.contentHash,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomEvolutionBenchmarkCases.id })
    .returning({ id: roomEvolutionBenchmarkCases.id });
  return insertOutcome(record.id, rows);
}

async function appendBenchmarkResult(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionBenchmarkResultRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionBenchmarkResults)
    .values({
      id: record.id,
      ...scopeValues(scope),
      experimentId: record.experimentId,
      candidateVersionId: record.candidateVersionId,
      benchmarkCaseId: record.benchmarkCaseId,
      evaluatorActorId: record.evaluatorActorId,
      evaluatorKind: record.evaluatorKind,
      outcome: record.outcome,
      metrics: record.metrics,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      completedAt: record.completedAt,
    })
    .onConflictDoNothing({ target: roomEvolutionBenchmarkResults.id })
    .returning({ id: roomEvolutionBenchmarkResults.id });
  return insertOutcome(record.id, rows);
}

async function appendGateResult(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionGateResultRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionGateResults)
    .values({
      id: record.id,
      ...scopeValues(scope),
      experimentId: record.experimentId,
      candidateVersionId: record.candidateVersionId,
      benchmarkResultId: record.benchmarkResultId,
      gateName: record.gateName,
      gateClass: record.gateClass,
      outcome: record.outcome,
      evaluatorActorId: record.evaluatorActorId,
      evaluatorKind: record.evaluatorKind,
      candidateProducerActorId: record.candidateProducerActorId,
      candidateHash: record.candidateHash,
      candidateBindingId: record.candidateBindingId,
      candidateBindingVersion: record.candidateBindingVersion,
      evaluatorBindingId: record.evaluatorBindingId,
      evaluatorBindingVersion: record.evaluatorBindingVersion,
      evaluationArtifactHash: record.evaluationArtifactHash,
      metrics: record.metrics,
      metricsHash: record.metricsHash,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      promotionEligible: record.promotionEligible,
      completedAt: record.completedAt,
    })
    .onConflictDoNothing({ target: roomEvolutionGateResults.id })
    .returning({ id: roomEvolutionGateResults.id });
  return insertOutcome(record.id, rows);
}

async function appendCanary(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionCanaryRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionCanaries)
    .values({
      id: record.id,
      ...scopeValues(scope),
      experimentId: record.experimentId,
      candidateVersionId: record.candidateVersionId,
      allocationVersion: record.allocationVersion,
      allocation: record.allocation,
      successCriteria: record.successCriteria,
      failureCriteria: record.failureCriteria,
      state: record.state,
      rollbackTargetCandidateVersionId: record.rollbackTargetCandidateVersionId,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomEvolutionCanaries.id })
    .returning({ id: roomEvolutionCanaries.id });
  return insertOutcome(record.id, rows);
}

async function appendCanaryObservation(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionCanaryObservationRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionCanaryObservations)
    .values({
      id: record.id,
      ...scopeValues(scope),
      canaryId: record.canaryId,
      metricName: record.metricName,
      metricValue: record.metricValue,
      threshold: record.threshold,
      breached: record.breached,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      observedAt: record.observedAt,
    })
    .onConflictDoNothing({ target: roomEvolutionCanaryObservations.id })
    .returning({ id: roomEvolutionCanaryObservations.id });
  return insertOutcome(record.id, rows);
}

async function appendTrustedBindingRevocation(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionTrustedBindingRevocationRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionTrustedBindingRevocations)
    .values({
      id: record.id,
      ...scopeValues(scope),
      trustedBindingId: record.trustedBindingId,
      revokedByPrincipalId: record.revokedByPrincipalId,
      revokerGrantId: record.revokerGrantId,
      reason: record.reason,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      revokedAt: record.revokedAt,
    })
    .onConflictDoNothing()
    .returning({ id: roomEvolutionTrustedBindingRevocations.id });
  return insertOutcome(record.id, rows);
}

async function appendCanarySuccessOutcome(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionCanarySuccessOutcomeRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionCanarySuccessOutcomes)
    .values({
      id: record.id,
      ...scopeValues(scope),
      canaryId: record.canaryId,
      experimentId: record.experimentId,
      candidateVersionId: record.candidateVersionId,
      candidateHash: record.candidateHash,
      candidateBindingId: record.candidateBindingId,
      candidateBindingVersion: record.candidateBindingVersion,
      evaluatorBindingId: record.evaluatorBindingId,
      evaluatorBindingVersion: record.evaluatorBindingVersion,
      gateResultIds: record.gateResultIds,
      allocationHash: record.allocationHash,
      artifactHash: record.artifactHash,
      metrics: record.metrics,
      metricsHash: record.metricsHash,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      completedAt: record.completedAt,
    })
    .onConflictDoNothing()
    .returning({ id: roomEvolutionCanarySuccessOutcomes.id });
  return insertOutcome(record.id, rows);
}

async function appendPromotionDecision(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionPromotionDecisionRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionPromotionDecisions)
    .values({
      id: record.id,
      ...scopeValues(scope),
      experimentId: record.experimentId,
      candidateVersionId: record.candidateVersionId,
      canaryId: record.canaryId,
      canarySuccessOutcomeId: record.canarySuccessOutcomeId,
      candidateHash: record.candidateHash,
      decisionBindingId: record.decisionBindingId,
      decisionBindingVersion: record.decisionBindingVersion,
      decision: record.decision,
      riskClass: record.riskClass,
      authorityTier: record.authorityTier,
      candidateProducerActorId: record.candidateProducerActorId,
      decisionActorId: record.decisionActorId,
      approvalRequestId: record.approvalRequestId,
      authorizationEvidence: record.authorizationEvidence,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      rollbackTargetCandidateVersionId: record.rollbackTargetCandidateVersionId,
      decidedAt: record.decidedAt,
    })
    .onConflictDoNothing({ target: roomEvolutionPromotionDecisions.id })
    .returning({ id: roomEvolutionPromotionDecisions.id });
  return insertOutcome(record.id, rows);
}

async function appendRollback(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  record: RoomEvolutionRollbackRecordV1,
): Promise<RoomEvolutionLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvolutionRollbacks)
    .values({
      id: record.id,
      ...scopeValues(scope),
      promotionDecisionId: record.promotionDecisionId,
      canaryId: record.canaryId,
      fromCandidateVersionId: record.fromCandidateVersionId,
      toCandidateVersionId: record.toCandidateVersionId,
      triggerKind: record.triggerKind,
      reason: record.reason,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      executedAt: record.executedAt,
    })
    .onConflictDoNothing({ target: roomEvolutionRollbacks.id })
    .returning({ id: roomEvolutionRollbacks.id });
  return insertOutcome(record.id, rows);
}

async function loadHypotheses(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionHypothesisRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionHypotheses).where(and(
    eq(roomEvolutionHypotheses.projectId, scope.projectId),
    eq(roomEvolutionHypotheses.scopeKind, scope.scopeKind),
    eq(roomEvolutionHypotheses.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionHypotheses.roomId) : eq(roomEvolutionHypotheses.roomId, scope.roomId),
    inArray(roomEvolutionHypotheses.id, ids),
  ));
  return orderRequestedRows(ids, rows, "hypothesis").map(rowToHypothesis);
}

async function loadCandidateVersions(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionCandidateVersionRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionCandidateVersions).where(and(
    eq(roomEvolutionCandidateVersions.projectId, scope.projectId),
    eq(roomEvolutionCandidateVersions.scopeKind, scope.scopeKind),
    eq(roomEvolutionCandidateVersions.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionCandidateVersions.roomId) : eq(roomEvolutionCandidateVersions.roomId, scope.roomId),
    inArray(roomEvolutionCandidateVersions.id, ids),
  ));
  return orderRequestedRows(ids, rows, "candidate version").map(rowToCandidateVersion);
}

async function loadTrustedBindings(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionTrustedBindingRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionTrustedBindings).where(and(
    eq(roomEvolutionTrustedBindings.projectId, scope.projectId),
    eq(roomEvolutionTrustedBindings.scopeKind, scope.scopeKind),
    eq(roomEvolutionTrustedBindings.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionTrustedBindings.roomId) : eq(roomEvolutionTrustedBindings.roomId, scope.roomId),
    inArray(roomEvolutionTrustedBindings.id, ids),
  ));
  return orderRequestedRows(ids, rows, "trusted binding").map(rowToTrustedBinding);
}

async function loadExperiments(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionExperimentRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionExperiments).where(and(
    eq(roomEvolutionExperiments.projectId, scope.projectId),
    eq(roomEvolutionExperiments.scopeKind, scope.scopeKind),
    eq(roomEvolutionExperiments.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionExperiments.roomId) : eq(roomEvolutionExperiments.roomId, scope.roomId),
    inArray(roomEvolutionExperiments.id, ids),
  ));
  return orderRequestedRows(ids, rows, "experiment").map(rowToExperiment);
}

async function loadBenchmarkCases(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionBenchmarkCaseRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionBenchmarkCases).where(and(
    eq(roomEvolutionBenchmarkCases.projectId, scope.projectId),
    eq(roomEvolutionBenchmarkCases.scopeKind, scope.scopeKind),
    eq(roomEvolutionBenchmarkCases.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionBenchmarkCases.roomId) : eq(roomEvolutionBenchmarkCases.roomId, scope.roomId),
    inArray(roomEvolutionBenchmarkCases.id, ids),
  ));
  return orderRequestedRows(ids, rows, "benchmark case").map(rowToBenchmarkCase);
}

async function loadBenchmarkResults(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionBenchmarkResultRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionBenchmarkResults).where(and(
    eq(roomEvolutionBenchmarkResults.projectId, scope.projectId),
    eq(roomEvolutionBenchmarkResults.scopeKind, scope.scopeKind),
    eq(roomEvolutionBenchmarkResults.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionBenchmarkResults.roomId) : eq(roomEvolutionBenchmarkResults.roomId, scope.roomId),
    inArray(roomEvolutionBenchmarkResults.id, ids),
  ));
  return orderRequestedRows(ids, rows, "benchmark result").map(rowToBenchmarkResult);
}

async function loadGateResults(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionGateResultRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionGateResults).where(and(
    eq(roomEvolutionGateResults.projectId, scope.projectId),
    eq(roomEvolutionGateResults.scopeKind, scope.scopeKind),
    eq(roomEvolutionGateResults.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionGateResults.roomId) : eq(roomEvolutionGateResults.roomId, scope.roomId),
    inArray(roomEvolutionGateResults.id, ids),
  ));
  return orderRequestedRows(ids, rows, "gate result").map(rowToGateResult);
}

async function loadCanaries(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionCanaryRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionCanaries).where(and(
    eq(roomEvolutionCanaries.projectId, scope.projectId),
    eq(roomEvolutionCanaries.scopeKind, scope.scopeKind),
    eq(roomEvolutionCanaries.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionCanaries.roomId) : eq(roomEvolutionCanaries.roomId, scope.roomId),
    inArray(roomEvolutionCanaries.id, ids),
  ));
  return orderRequestedRows(ids, rows, "canary").map(rowToCanary);
}

async function loadCanaryObservations(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionCanaryObservationRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionCanaryObservations).where(and(
    eq(roomEvolutionCanaryObservations.projectId, scope.projectId),
    eq(roomEvolutionCanaryObservations.scopeKind, scope.scopeKind),
    eq(roomEvolutionCanaryObservations.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionCanaryObservations.roomId) : eq(roomEvolutionCanaryObservations.roomId, scope.roomId),
    inArray(roomEvolutionCanaryObservations.id, ids),
  ));
  return orderRequestedRows(ids, rows, "canary observation").map(rowToCanaryObservation);
}

async function loadCanarySuccessOutcomes(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionCanarySuccessOutcomeRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionCanarySuccessOutcomes).where(and(
    eq(roomEvolutionCanarySuccessOutcomes.projectId, scope.projectId),
    eq(roomEvolutionCanarySuccessOutcomes.scopeKind, scope.scopeKind),
    eq(roomEvolutionCanarySuccessOutcomes.scopeKey, scope.scopeKey),
    scope.roomId === null
      ? isNull(roomEvolutionCanarySuccessOutcomes.roomId)
      : eq(roomEvolutionCanarySuccessOutcomes.roomId, scope.roomId),
    inArray(roomEvolutionCanarySuccessOutcomes.id, ids),
  ));
  return orderRequestedRows(ids, rows, "successful canary outcome").map(rowToCanarySuccessOutcome);
}

async function loadPromotionDecisions(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionPromotionDecisionRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionPromotionDecisions).where(and(
    eq(roomEvolutionPromotionDecisions.projectId, scope.projectId),
    eq(roomEvolutionPromotionDecisions.scopeKind, scope.scopeKind),
    eq(roomEvolutionPromotionDecisions.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionPromotionDecisions.roomId) : eq(roomEvolutionPromotionDecisions.roomId, scope.roomId),
    inArray(roomEvolutionPromotionDecisions.id, ids),
  ));
  return orderRequestedRows(ids, rows, "promotion decision").map(rowToPromotionDecision);
}

async function loadRollbacks(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvolutionRollbackRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(roomEvolutionRollbacks).where(and(
    eq(roomEvolutionRollbacks.projectId, scope.projectId),
    eq(roomEvolutionRollbacks.scopeKind, scope.scopeKind),
    eq(roomEvolutionRollbacks.scopeKey, scope.scopeKey),
    scope.roomId === null ? isNull(roomEvolutionRollbacks.roomId) : eq(roomEvolutionRollbacks.roomId, scope.roomId),
    inArray(roomEvolutionRollbacks.id, ids),
  ));
  return orderRequestedRows(ids, rows, "rollback").map(rowToRollback);
}

async function assertRoomScope(tx: DbTransaction, scope: RoomEvolutionLedgerScope): Promise<void> {
  if (scope.roomId === null) return;
  const rows = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(
      eq(operationalRooms.projectId, scope.projectId),
      eq(operationalRooms.id, scope.roomId),
    ))
    .limit(1);
  if (!rows[0]) {
    throw new RoomEvolutionLedgerError(
      "reference_not_found",
      "Evolution ledger could not resolve Room " + scope.roomId + " in the submitted project scope",
    );
  }
}

function assertBoundProjectScope(
  boundProjectId: string | undefined,
  scope: RoomEvolutionLedgerScope,
): void {
  assertBoundProjectId(boundProjectId, scope.projectId);
}

function assertBoundProjectId(boundProjectId: string | undefined, projectId: string): void {
  if (boundProjectId !== undefined && boundProjectId !== projectId) {
    throw new RoomEvolutionLedgerError(
      "scope_mismatch",
      "Evolution ledger scope project " + projectId + " does not match bound project " + boundProjectId,
    );
  }
}

function assertEntryScope(scope: RoomEvolutionLedgerScope, entry: RoomEvolutionLedgerEntry): void {
  const record = entry.record;
  if (record.projectId !== scope.projectId
    || record.roomId !== scope.roomId
    || record.scopeKind !== scope.scopeKind
    || record.scopeKey !== scope.scopeKey) {
    throw new RoomEvolutionLedgerError(
      "scope_mismatch",
      "Evolution ledger entry " + entry.table + ":" + record.id + " belongs to another project or Room scope",
    );
  }
}

function scopeValues(scope: RoomEvolutionLedgerScope): {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: string;
  readonly scopeKey: string;
} {
  return {
    projectId: scope.projectId,
    roomId: scope.roomId,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
  };
}

function insertOutcome(
  recordId: string,
  rows: readonly { readonly id: string }[],
): RoomEvolutionLedgerAppendOutcome {
  return rows[0]
    ? { status: "inserted", recordId: rows[0].id }
    : { status: "conflict", recordId };
}

function orderRequestedRows<TRecord extends { readonly id: string }>(
  ids: readonly string[],
  rows: readonly TRecord[],
  label: string,
): readonly TRecord[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new RoomEvolutionLedgerError(
        "reference_not_found",
        "Evolution ledger could not resolve " + label + " " + id + " in the submitted project and Room scope",
      );
    }
    return row;
  });
}

function rowToHypothesis(
  row: typeof roomEvolutionHypotheses.$inferSelect,
): RoomEvolutionHypothesisRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    revision: row.revision,
    state: row.state as RoomEvolutionHypothesisRecordV1["state"],
    sourceSignalKinds: row.sourceSignalKinds as unknown as readonly RoomEvolutionHypothesisRecordV1["sourceSignalKinds"][number][],
    evidence: row.evidence as unknown as readonly RoomEvolutionHypothesisRecordV1["evidence"][number][],
    evidenceHash: row.evidenceHash,
    declaredScope: row.declaredScope as unknown as readonly string[],
    riskClass: row.riskClass as RoomEvolutionHypothesisRecordV1["riskClass"],
    expectedMechanism: row.expectedMechanism,
    affectedDomains: row.affectedDomains as unknown as readonly string[],
    createdByActorId: row.createdByActorId,
    createdAt: row.createdAt,
  };
}

function rowToCandidateVersion(
  row: typeof roomEvolutionCandidateVersions.$inferSelect,
): RoomEvolutionCandidateVersionRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    hypothesisId: row.hypothesisId,
    versionNumber: row.versionNumber,
    candidateKind: row.candidateKind as RoomEvolutionCandidateVersionRecordV1["candidateKind"],
    baseRevision: row.baseRevision,
    candidateRef: row.candidateRef,
    isolationKind: row.isolationKind as RoomEvolutionCandidateVersionRecordV1["isolationKind"],
    isolationRef: row.isolationRef,
    immutableInput: row.immutableInput as RoomEvolutionJsonObjectV1,
    inputHash: row.inputHash,
    candidateHash: row.candidateHash,
    producedByActorId: row.producedByActorId,
    producerBindingId: row.producerBindingId,
    producerBindingVersion: row.producerBindingVersion,
    baseCandidateVersionId: row.baseCandidateVersionId,
    rollbackTargetCandidateVersionId: row.rollbackTargetCandidateVersionId,
    createdAt: row.createdAt,
  };
}

function rowToTrustedBinding(
  row: typeof roomEvolutionTrustedBindings.$inferSelect,
): RoomEvolutionTrustedBindingRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    actorId: row.actorId,
    purpose: trustedBindingPurpose(row.purpose),
    subjectRoomId: row.subjectRoomId,
    roomBindingId: row.roomBindingId,
    roomBindingGeneration: row.roomBindingGeneration,
    roleId: row.roleId,
    roleVersion: row.roleVersion,
    bindingVersion: row.bindingVersion,
    issuedByPrincipalId: row.issuedByPrincipalId,
    issuerGrantId: row.issuerGrantId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    integrityHash: row.integrityHash,
  };
}

function rowToExperiment(
  row: typeof roomEvolutionExperiments.$inferSelect,
): RoomEvolutionExperimentRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    hypothesisId: row.hypothesisId,
    candidateVersionId: row.candidateVersionId,
    state: row.state as RoomEvolutionExperimentRecordV1["state"],
    inputSnapshotHash: row.inputSnapshotHash,
    authorizationEvidence: row.authorizationEvidence as RoomEvolutionJsonObjectV1,
    authorizationHash: row.authorizationHash,
    capacityPool: row.capacityPool as RoomEvolutionExperimentRecordV1["capacityPool"],
    createdByActorId: row.createdByActorId,
    createdAt: row.createdAt,
  };
}

function rowToBenchmarkCase(
  row: typeof roomEvolutionBenchmarkCases.$inferSelect,
): RoomEvolutionBenchmarkCaseRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    domain: row.domain,
    caseKind: row.caseKind as RoomEvolutionBenchmarkCaseRecordV1["caseKind"],
    containsPrivateRoomData: row.containsPrivateRoomData,
    sourceAuthorizationId: row.sourceAuthorizationId,
    authorizationEvidence: row.authorizationEvidence as RoomEvolutionJsonObjectV1,
    casePayload: row.casePayload as RoomEvolutionJsonObjectV1,
    expectedOutcome: row.expectedOutcome as RoomEvolutionJsonObjectV1,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  };
}

function rowToBenchmarkResult(
  row: typeof roomEvolutionBenchmarkResults.$inferSelect,
): RoomEvolutionBenchmarkResultRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    benchmarkCaseId: row.benchmarkCaseId,
    evaluatorActorId: row.evaluatorActorId,
    evaluatorKind: row.evaluatorKind as RoomEvolutionBenchmarkResultRecordV1["evaluatorKind"],
    outcome: row.outcome as RoomEvolutionBenchmarkResultRecordV1["outcome"],
    metrics: row.metrics as RoomEvolutionJsonObjectV1,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    completedAt: row.completedAt,
  };
}

function rowToGateResult(
  row: typeof roomEvolutionGateResults.$inferSelect,
): RoomEvolutionGateResultRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    benchmarkResultId: row.benchmarkResultId,
    gateName: row.gateName,
    gateClass: row.gateClass as RoomEvolutionGateResultRecordV1["gateClass"],
    outcome: row.outcome as RoomEvolutionGateResultRecordV1["outcome"],
    evaluatorActorId: row.evaluatorActorId,
    evaluatorKind: row.evaluatorKind as RoomEvolutionGateResultRecordV1["evaluatorKind"],
    candidateProducerActorId: row.candidateProducerActorId,
    candidateHash: row.candidateHash,
    candidateBindingId: row.candidateBindingId,
    candidateBindingVersion: row.candidateBindingVersion,
    evaluatorBindingId: row.evaluatorBindingId,
    evaluatorBindingVersion: row.evaluatorBindingVersion,
    evaluationArtifactHash: row.evaluationArtifactHash,
    metrics: row.metrics as RoomEvolutionJsonObjectV1,
    metricsHash: row.metricsHash,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    promotionEligible: row.promotionEligible,
    completedAt: row.completedAt,
  };
}

function rowToCanary(
  row: typeof roomEvolutionCanaries.$inferSelect,
): RoomEvolutionCanaryRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    allocationVersion: row.allocationVersion,
    allocation: row.allocation as RoomEvolutionJsonObjectV1,
    successCriteria: row.successCriteria as RoomEvolutionJsonObjectV1,
    failureCriteria: row.failureCriteria as RoomEvolutionJsonObjectV1,
    state: row.state as RoomEvolutionCanaryRecordV1["state"],
    rollbackTargetCandidateVersionId: row.rollbackTargetCandidateVersionId,
    createdAt: row.createdAt,
  };
}

function rowToCanaryObservation(
  row: typeof roomEvolutionCanaryObservations.$inferSelect,
): RoomEvolutionCanaryObservationRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    canaryId: row.canaryId,
    metricName: row.metricName,
    metricValue: row.metricValue as RoomEvolutionJsonObjectV1,
    threshold: row.threshold as RoomEvolutionJsonObjectV1,
    breached: row.breached,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    observedAt: row.observedAt,
  };
}

function rowToCanarySuccessOutcome(
  row: typeof roomEvolutionCanarySuccessOutcomes.$inferSelect,
): RoomEvolutionCanarySuccessOutcomeRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    canaryId: row.canaryId,
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    candidateHash: row.candidateHash,
    candidateBindingId: row.candidateBindingId,
    candidateBindingVersion: row.candidateBindingVersion,
    evaluatorBindingId: row.evaluatorBindingId,
    evaluatorBindingVersion: row.evaluatorBindingVersion,
    gateResultIds: durableIdentifierList(row.gateResultIds, "successful canary outcome gate result ids"),
    allocationHash: row.allocationHash,
    artifactHash: row.artifactHash,
    metrics: row.metrics as RoomEvolutionJsonObjectV1,
    metricsHash: row.metricsHash,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    completedAt: row.completedAt,
  };
}

function rowToPromotionDecision(
  row: typeof roomEvolutionPromotionDecisions.$inferSelect,
): RoomEvolutionPromotionDecisionRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    canaryId: row.canaryId,
    canarySuccessOutcomeId: row.canarySuccessOutcomeId,
    candidateHash: row.candidateHash,
    decisionBindingId: row.decisionBindingId,
    decisionBindingVersion: row.decisionBindingVersion,
    decision: row.decision as RoomEvolutionPromotionDecisionRecordV1["decision"],
    riskClass: row.riskClass as RoomEvolutionPromotionDecisionRecordV1["riskClass"],
    authorityTier: row.authorityTier as RoomEvolutionPromotionDecisionRecordV1["authorityTier"],
    candidateProducerActorId: row.candidateProducerActorId,
    decisionActorId: row.decisionActorId,
    approvalRequestId: row.approvalRequestId,
    authorizationEvidence: row.authorizationEvidence as RoomEvolutionJsonObjectV1,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    rollbackTargetCandidateVersionId: row.rollbackTargetCandidateVersionId,
    decidedAt: row.decidedAt,
  };
}

function rowToRollback(
  row: typeof roomEvolutionRollbacks.$inferSelect,
): RoomEvolutionRollbackRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    promotionDecisionId: row.promotionDecisionId,
    canaryId: row.canaryId,
    fromCandidateVersionId: row.fromCandidateVersionId,
    toCandidateVersionId: row.toCandidateVersionId,
    triggerKind: row.triggerKind as RoomEvolutionRollbackRecordV1["triggerKind"],
    reason: row.reason,
    evidence: row.evidence as unknown as readonly RoomEvolutionEvidenceRefV1[],
    evidenceHash: row.evidenceHash,
    executedAt: row.executedAt,
  };
}

function issuerGrantRole(value: string): RoomEvolutionIssuerGrantV1["role"] {
  if (value === "owner" || value === "admin" || value === "operator" || value === "observer" || value === "auditor") {
    return value;
  }
  throw new RoomEvolutionLedgerError(
    "invalid_reference",
    "Evolution ledger issuer grant has an unsupported durable role",
  );
}

function trustedBindingPurpose(value: string): RoomEvolutionTrustedBindingRecordV1["purpose"] {
  if (value === "candidate_producer" || value === "independent_evaluator") {
    return value;
  }
  throw new RoomEvolutionLedgerError(
    "invalid_reference",
    "Evolution ledger trusted binding has an unsupported durable purpose",
  );
}

function durableIdentifierList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new RoomEvolutionLedgerError(
      "invalid_reference",
      "Evolution ledger " + label + " must be a non-empty durable identifier array",
    );
  }
  return Object.freeze([...value]);
}

function scopeFromRow(row: {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: string;
  readonly scopeKey: string;
}): Pick<RoomEvolutionLedgerScope, "projectId" | "roomId" | "scopeKind" | "scopeKey"> {
  return {
    projectId: row.projectId,
    roomId: row.roomId,
    scopeKind: row.scopeKind as RoomEvolutionLedgerScope["scopeKind"],
    scopeKey: row.scopeKey,
  };
}
