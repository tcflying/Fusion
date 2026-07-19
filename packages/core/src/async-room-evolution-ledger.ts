import { hashRoomValue } from "./room-integrity.js";

export const ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionScopeKindV1 = "project" | "room";
export type RoomEvolutionHypothesisStateV1 =
  | "proposed"
  | "experimenting"
  | "promoted"
  | "rejected"
  | "rolled_back"
  | "inconclusive";
export type RoomEvolutionRiskClassV1 = "low" | "moderate" | "high" | "critical";
export type RoomEvolutionCandidateKindV1 =
  | "prompt"
  | "skill"
  | "context"
  | "task_decomposition"
  | "protocol"
  | "role_assignment"
  | "model_routing"
  | "retry_concurrency"
  | "connector_adapter"
  | "evaluation_rule"
  | "source_code";
export type RoomEvolutionIsolationKindV1 = "branch" | "worktree" | "versioned_policy_store";
export type RoomEvolutionExperimentStateV1 =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "inconclusive";
export type RoomEvolutionCapacityPoolV1 = "evolution_low_priority" | "evolution_paused";
export type RoomEvolutionBenchmarkCaseKindV1 =
  | "golden"
  | "rolling_authorized"
  | "adversarial"
  | "historical_replay";
export type RoomEvolutionEvaluatorKindV1 =
  | "deterministic"
  | "independent_reviewer"
  | "producer_self_report";
export type RoomEvolutionTrustedBindingPurposeV1 =
  | "candidate_producer"
  | "independent_evaluator";
export type RoomEvolutionBenchmarkOutcomeV1 = "passed" | "failed" | "error" | "inconclusive";
export type RoomEvolutionGateClassV1 = "hard" | "optimization";
export type RoomEvolutionGateOutcomeV1 = "passed" | "failed" | "error" | "not_run";
export type RoomEvolutionCanaryStateV1 =
  | "planned"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled";
export type RoomEvolutionPersistedPromotionDecisionV1 =
  | "promoted"
  | "rejected"
  | "inconclusive"
  | "rollback_required";
export type RoomEvolutionAuthorityTierV1 =
  | "automatic_pre_authorized"
  | "independent"
  | "human";
export type RoomEvolutionRollbackTriggerV1 = "automatic" | "operator";
export type RoomEvolutionSignalKindV1 =
  | "failure"
  | "correction"
  | "confidence"
  | "retry"
  | "dissent"
  | "quality"
  | "stability"
  | "utilization"
  | "latency";
export type RoomEvolutionEvidenceSourceV1 =
  | "deterministic_gate"
  | "human_correction"
  | "durable_room_ledger"
  | "independent_review"
  | "authorized_observed_outcome"
  | "room_metric";
export type RoomEvolutionJsonObjectV1 = Readonly<Record<string, unknown>>;

export interface RoomEvolutionLedgerScope {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: RoomEvolutionScopeKindV1;
  readonly scopeKey: string;
}

export interface RoomEvolutionEvidenceRefV1 {
  readonly id: string;
  readonly source: RoomEvolutionEvidenceSourceV1;
  readonly sourceRef: string;
  readonly evidenceHash: string;
  readonly observedAt: string;
}

export interface RoomEvolutionScopedRecordV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: RoomEvolutionScopeKindV1;
  readonly scopeKey: string;
}

export interface RoomEvolutionHypothesisRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly revision: number;
  readonly state: RoomEvolutionHypothesisStateV1;
  readonly sourceSignalKinds: readonly RoomEvolutionSignalKindV1[];
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly declaredScope: readonly string[];
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly expectedMechanism: string;
  readonly affectedDomains: readonly string[];
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface RoomEvolutionCandidateVersionRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly hypothesisId: string;
  readonly versionNumber: number;
  readonly candidateKind: RoomEvolutionCandidateKindV1;
  readonly baseRevision: string;
  readonly candidateRef: string;
  readonly isolationKind: RoomEvolutionIsolationKindV1;
  readonly isolationRef: string;
  readonly immutableInput: RoomEvolutionJsonObjectV1;
  readonly inputHash: string;
  readonly candidateHash: string | null;
  readonly producedByActorId: string;
  readonly producerBindingId: string | null;
  readonly producerBindingVersion: number | null;
  readonly baseCandidateVersionId: string | null;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly createdAt: string;
}

/*
FNXC:RoomEvolutionTrustReceipts 2026-07-19-19:26:
Evolution promotion cannot treat a caller-supplied actor string, candidate hash,
or claimed durable source as authority. These append-only records bind a candidate
producer or independent evaluator to an existing Room binding generation, an
owner/admin-issued grant, scope/version, and expiry. Success canaries retain the
candidate, allocation, artifact, metrics, gate, and evidence hashes and must be
read back before promotion can cite them.
*/
export interface RoomEvolutionTrustedBindingRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly actorId: string;
  readonly purpose: RoomEvolutionTrustedBindingPurposeV1;
  readonly subjectRoomId: string;
  readonly roomBindingId: string;
  readonly roomBindingGeneration: number;
  readonly roleId: string;
  readonly roleVersion: number;
  readonly bindingVersion: number;
  readonly issuedByPrincipalId: string;
  readonly issuerGrantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly integrityHash: string;
}

/** Append-only revocation authority for a previously issued trusted binding. */
export interface RoomEvolutionTrustedBindingRevocationRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly trustedBindingId: string;
  readonly revokedByPrincipalId: string;
  readonly revokerGrantId: string;
  readonly reason: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly revokedAt: string;
}

/** Durable Room membership facts that an identity binding must match at issuance. */
export interface RoomEvolutionTrustedBindingSubjectV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly roomBindingId: string;
  readonly roomBindingGeneration: number;
  readonly roleId: string;
  readonly roleVersion: number;
}

/** Durable RBAC grant facts that authorize trust binding issuance or revocation. */
export interface RoomEvolutionIssuerGrantV1 {
  readonly projectId: string;
  readonly grantId: string;
  readonly principalId: string;
  readonly role: "owner" | "admin" | "operator" | "observer" | "auditor";
  readonly roomId: string | null;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface RoomEvolutionExperimentRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly hypothesisId: string;
  readonly candidateVersionId: string;
  readonly state: RoomEvolutionExperimentStateV1;
  readonly inputSnapshotHash: string;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly authorizationHash: string;
  readonly capacityPool: RoomEvolutionCapacityPoolV1;
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface RoomEvolutionBenchmarkCaseRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly domain: string;
  readonly caseKind: RoomEvolutionBenchmarkCaseKindV1;
  readonly containsPrivateRoomData: boolean;
  readonly sourceAuthorizationId: string | null;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly casePayload: RoomEvolutionJsonObjectV1;
  readonly expectedOutcome: RoomEvolutionJsonObjectV1;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface RoomEvolutionBenchmarkResultRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly benchmarkCaseId: string;
  readonly evaluatorActorId: string;
  readonly evaluatorKind: RoomEvolutionEvaluatorKindV1;
  readonly outcome: RoomEvolutionBenchmarkOutcomeV1;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly completedAt: string;
}

export interface RoomEvolutionGateResultRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly benchmarkResultId: string | null;
  readonly gateName: string;
  readonly gateClass: RoomEvolutionGateClassV1;
  readonly outcome: RoomEvolutionGateOutcomeV1;
  readonly evaluatorActorId: string;
  readonly evaluatorKind: RoomEvolutionEvaluatorKindV1;
  readonly candidateProducerActorId: string;
  readonly candidateHash: string | null;
  readonly candidateBindingId: string | null;
  readonly candidateBindingVersion: number | null;
  readonly evaluatorBindingId: string | null;
  readonly evaluatorBindingVersion: number | null;
  readonly evaluationArtifactHash: string | null;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly metricsHash: string | null;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly promotionEligible: boolean;
  readonly completedAt: string;
}

export interface RoomEvolutionCanaryRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly allocationVersion: number;
  readonly allocation: RoomEvolutionJsonObjectV1;
  readonly successCriteria: RoomEvolutionJsonObjectV1;
  readonly failureCriteria: RoomEvolutionJsonObjectV1;
  readonly state: RoomEvolutionCanaryStateV1;
  readonly rollbackTargetCandidateVersionId: string;
  readonly createdAt: string;
}

export interface RoomEvolutionCanaryObservationRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly canaryId: string;
  readonly metricName: string;
  readonly metricValue: RoomEvolutionJsonObjectV1;
  readonly threshold: RoomEvolutionJsonObjectV1;
  readonly breached: boolean;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly observedAt: string;
}

export interface RoomEvolutionCanarySuccessOutcomeRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly canaryId: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly candidateHash: string;
  readonly candidateBindingId: string;
  readonly candidateBindingVersion: number;
  readonly evaluatorBindingId: string;
  readonly evaluatorBindingVersion: number;
  readonly gateResultIds: readonly string[];
  readonly allocationHash: string;
  readonly artifactHash: string;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly metricsHash: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly completedAt: string;
}

export interface RoomEvolutionPromotionDecisionRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly canaryId: string | null;
  readonly canarySuccessOutcomeId: string | null;
  readonly candidateHash: string | null;
  readonly decisionBindingId: string | null;
  readonly decisionBindingVersion: number | null;
  readonly decision: RoomEvolutionPersistedPromotionDecisionV1;
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly authorityTier: RoomEvolutionAuthorityTierV1;
  readonly candidateProducerActorId: string;
  readonly decisionActorId: string;
  readonly approvalRequestId: string | null;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly decidedAt: string;
}

export interface RoomEvolutionRollbackRecordV1 extends RoomEvolutionScopedRecordV1 {
  readonly promotionDecisionId: string;
  readonly canaryId: string;
  readonly fromCandidateVersionId: string;
  readonly toCandidateVersionId: string;
  readonly triggerKind: RoomEvolutionRollbackTriggerV1;
  readonly reason: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly executedAt: string;
}

export type RoomEvolutionLedgerTable =
  | "room_evolution_hypotheses"
  | "room_evolution_candidate_versions"
  | "room_evolution_trusted_bindings"
  | "room_evolution_experiments"
  | "room_evolution_benchmark_cases"
  | "room_evolution_benchmark_results"
  | "room_evolution_gate_results"
  | "room_evolution_canaries"
  | "room_evolution_canary_observations"
  | "room_evolution_trusted_binding_revocations"
  | "room_evolution_canary_success_outcomes"
  | "room_evolution_promotion_decisions"
  | "room_evolution_rollbacks";

export type RoomEvolutionLedgerEntry =
  | { readonly table: "room_evolution_hypotheses"; readonly record: RoomEvolutionHypothesisRecordV1 }
  | { readonly table: "room_evolution_candidate_versions"; readonly record: RoomEvolutionCandidateVersionRecordV1 }
  | { readonly table: "room_evolution_trusted_bindings"; readonly record: RoomEvolutionTrustedBindingRecordV1 }
  | { readonly table: "room_evolution_experiments"; readonly record: RoomEvolutionExperimentRecordV1 }
  | { readonly table: "room_evolution_benchmark_cases"; readonly record: RoomEvolutionBenchmarkCaseRecordV1 }
  | { readonly table: "room_evolution_benchmark_results"; readonly record: RoomEvolutionBenchmarkResultRecordV1 }
  | { readonly table: "room_evolution_gate_results"; readonly record: RoomEvolutionGateResultRecordV1 }
  | { readonly table: "room_evolution_canaries"; readonly record: RoomEvolutionCanaryRecordV1 }
  | { readonly table: "room_evolution_canary_observations"; readonly record: RoomEvolutionCanaryObservationRecordV1 }
  | { readonly table: "room_evolution_trusted_binding_revocations"; readonly record: RoomEvolutionTrustedBindingRevocationRecordV1 }
  | { readonly table: "room_evolution_canary_success_outcomes"; readonly record: RoomEvolutionCanarySuccessOutcomeRecordV1 }
  | { readonly table: "room_evolution_promotion_decisions"; readonly record: RoomEvolutionPromotionDecisionRecordV1 }
  | { readonly table: "room_evolution_rollbacks"; readonly record: RoomEvolutionRollbackRecordV1 };

export interface RoomEvolutionLedgerReferenceQuery {
  readonly scope: RoomEvolutionLedgerScope;
  readonly hypothesisIds: readonly string[];
  readonly candidateVersionIds: readonly string[];
  readonly trustedBindingIds: readonly string[];
  readonly experimentIds: readonly string[];
  readonly benchmarkCaseIds: readonly string[];
  readonly benchmarkResultIds: readonly string[];
  readonly gateResultIds: readonly string[];
  readonly canaryIds: readonly string[];
  readonly canaryObservationIds: readonly string[];
  readonly canarySuccessOutcomeIds: readonly string[];
  readonly promotionDecisionIds: readonly string[];
  readonly rollbackIds: readonly string[];
}

export interface RoomEvolutionLedgerReferenceSnapshot {
  readonly scope: RoomEvolutionLedgerScope;
  readonly hypotheses: readonly RoomEvolutionHypothesisRecordV1[];
  readonly candidateVersions: readonly RoomEvolutionCandidateVersionRecordV1[];
  readonly trustedBindings: readonly RoomEvolutionTrustedBindingRecordV1[];
  readonly experiments: readonly RoomEvolutionExperimentRecordV1[];
  readonly benchmarkCases: readonly RoomEvolutionBenchmarkCaseRecordV1[];
  readonly benchmarkResults: readonly RoomEvolutionBenchmarkResultRecordV1[];
  readonly gateResults: readonly RoomEvolutionGateResultRecordV1[];
  readonly canaries: readonly RoomEvolutionCanaryRecordV1[];
  readonly canaryObservations: readonly RoomEvolutionCanaryObservationRecordV1[];
  readonly canarySuccessOutcomes: readonly RoomEvolutionCanarySuccessOutcomeRecordV1[];
  readonly promotionDecisions: readonly RoomEvolutionPromotionDecisionRecordV1[];
  readonly rollbacks: readonly RoomEvolutionRollbackRecordV1[];
}

export type RoomEvolutionLedgerAppendOutcome =
  | { readonly status: "inserted"; readonly recordId: string }
  | { readonly status: "conflict"; readonly recordId: string };

export interface RoomEvolutionLedgerTransaction {
  resolveReferences(input: RoomEvolutionLedgerReferenceQuery): Promise<RoomEvolutionLedgerReferenceSnapshot>;
  findTrustedBindingRevocation(
    scope: RoomEvolutionLedgerScope,
    trustedBindingId: string,
  ): Promise<Pick<RoomEvolutionTrustedBindingRevocationRecordV1, "trustedBindingId" | "revokedAt"> | null>;
  resolveTrustedBindingSubject(input: {
    readonly projectId: string;
    readonly roomId: string;
    readonly roomBindingId: string;
  }): Promise<RoomEvolutionTrustedBindingSubjectV1 | null>;
  resolveEvolutionIssuerGrant(input: {
    readonly projectId: string;
    readonly grantId: string;
  }): Promise<RoomEvolutionIssuerGrantV1 | null>;
  findCanarySuccessOutcome(
    scope: RoomEvolutionLedgerScope,
    canaryId: string,
  ): Promise<RoomEvolutionCanarySuccessOutcomeRecordV1 | null>;
  append(input: {
    readonly scope: RoomEvolutionLedgerScope;
    readonly entry: RoomEvolutionLedgerEntry;
  }): Promise<RoomEvolutionLedgerAppendOutcome>;
}

export interface RoomEvolutionLedgerPersistence {
  transaction<TResult>(
    operation: (transaction: RoomEvolutionLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface RoomEvolutionLedgerAppendResult<
  TTable extends RoomEvolutionLedgerTable,
  TRecord,
> {
  readonly table: TTable;
  readonly record: TRecord;
}

export interface AppendRoomEvolutionHypothesisInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly revision: number;
  readonly state: RoomEvolutionHypothesisStateV1;
  readonly sourceSignalKinds: readonly RoomEvolutionSignalKindV1[];
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly declaredScope: readonly string[];
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly expectedMechanism: string;
  readonly affectedDomains: readonly string[];
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface AppendRoomEvolutionCandidateVersionInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly hypothesisId: string;
  readonly versionNumber: number;
  readonly candidateKind: RoomEvolutionCandidateKindV1;
  readonly baseRevision: string;
  readonly candidateRef: string;
  readonly isolationKind: RoomEvolutionIsolationKindV1;
  readonly isolationRef: string;
  readonly immutableInput: RoomEvolutionJsonObjectV1;
  readonly inputHash: string;
  readonly producedByActorId: string;
  readonly baseCandidateVersionId: string | null;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly createdAt: string;
}

export interface AppendRoomEvolutionTrustedBindingInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly actorId: string;
  readonly purpose: RoomEvolutionTrustedBindingPurposeV1;
  readonly subjectRoomId: string;
  readonly roomBindingId: string;
  readonly roomBindingGeneration: number;
  readonly roleId: string;
  readonly roleVersion: number;
  readonly bindingVersion: number;
  readonly issuedByPrincipalId: string;
  readonly issuerGrantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface AppendRoomEvolutionTrustedBindingRevocationInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly trustedBindingId: string;
  readonly revokedByPrincipalId: string;
  readonly revokerGrantId: string;
  readonly reason: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly revokedAt: string;
}

export interface AppendVerifiedRoomEvolutionCandidateVersionInputV1 {
  readonly candidate: AppendRoomEvolutionCandidateVersionInputV1;
  readonly candidateHash: string;
  readonly producerBindingId: string;
  readonly producerBindingVersion: number;
}

export interface AppendRoomEvolutionExperimentInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly hypothesisId: string;
  readonly candidateVersionId: string;
  readonly state: RoomEvolutionExperimentStateV1;
  readonly inputSnapshotHash: string;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly authorizationHash: string;
  readonly capacityPool: RoomEvolutionCapacityPoolV1;
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface AppendRoomEvolutionBenchmarkCaseInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly domain: string;
  readonly caseKind: RoomEvolutionBenchmarkCaseKindV1;
  readonly containsPrivateRoomData: boolean;
  readonly sourceAuthorizationId: string | null;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly casePayload: RoomEvolutionJsonObjectV1;
  readonly expectedOutcome: RoomEvolutionJsonObjectV1;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface AppendRoomEvolutionBenchmarkResultInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly benchmarkCaseId: string;
  readonly evaluatorActorId: string;
  readonly evaluatorKind: RoomEvolutionEvaluatorKindV1;
  readonly outcome: RoomEvolutionBenchmarkOutcomeV1;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly completedAt: string;
}

export interface AppendRoomEvolutionGateResultInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly benchmarkResultId: string | null;
  readonly gateName: string;
  readonly gateClass: RoomEvolutionGateClassV1;
  readonly outcome: RoomEvolutionGateOutcomeV1;
  readonly evaluatorActorId: string;
  readonly evaluatorKind: RoomEvolutionEvaluatorKindV1;
  readonly candidateProducerActorId: string;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly promotionEligible: boolean;
  readonly completedAt: string;
}

export interface AppendVerifiedRoomEvolutionGateResultInputV1 {
  readonly gate: AppendRoomEvolutionGateResultInputV1;
  readonly candidateHash: string;
  readonly candidateBindingId: string;
  readonly candidateBindingVersion: number;
  readonly evaluatorBindingId: string;
  readonly evaluatorBindingVersion: number;
  readonly evaluationArtifactHash: string;
}

export interface AppendRoomEvolutionCanaryInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly allocationVersion: number;
  readonly allocation: RoomEvolutionJsonObjectV1;
  readonly successCriteria: RoomEvolutionJsonObjectV1;
  readonly failureCriteria: RoomEvolutionJsonObjectV1;
  readonly state: RoomEvolutionCanaryStateV1;
  readonly rollbackTargetCandidateVersionId: string;
  readonly createdAt: string;
}

export interface AppendRoomEvolutionCanaryObservationInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly canaryId: string;
  readonly metricName: string;
  readonly metricValue: RoomEvolutionJsonObjectV1;
  readonly threshold: RoomEvolutionJsonObjectV1;
  readonly breached: boolean;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly observedAt: string;
}

export interface AppendRoomEvolutionCanarySuccessOutcomeInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly canaryId: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly candidateHash: string;
  readonly candidateBindingId: string;
  readonly candidateBindingVersion: number;
  readonly evaluatorBindingId: string;
  readonly evaluatorBindingVersion: number;
  readonly gateResultIds: readonly string[];
  readonly allocationHash: string;
  readonly artifactHash: string;
  readonly metrics: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly completedAt: string;
}

export interface AppendRoomEvolutionPromotionDecisionInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly canaryId: string | null;
  readonly decision: RoomEvolutionPersistedPromotionDecisionV1;
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly authorityTier: RoomEvolutionAuthorityTierV1;
  readonly candidateProducerActorId: string;
  readonly decisionActorId: string;
  readonly approvalRequestId: string | null;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly decidedAt: string;
}

export interface AppendVerifiedRoomEvolutionPromotionDecisionInputV1 {
  readonly decision: AppendRoomEvolutionPromotionDecisionInputV1;
  readonly canarySuccessOutcomeId: string;
  readonly decisionBindingId: string;
  readonly decisionBindingVersion: number;
}

export interface AppendRoomEvolutionRollbackInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly promotionDecisionId: string;
  readonly canaryId: string;
  readonly fromCandidateVersionId: string;
  readonly toCandidateVersionId: string;
  readonly triggerKind: RoomEvolutionRollbackTriggerV1;
  readonly reason: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evidenceHash: string;
  readonly executedAt: string;
}

export type RoomEvolutionLedgerErrorCode =
  | "invalid_input"
  | "invalid_hash"
  | "invalid_reference"
  | "reference_not_found"
  | "scope_mismatch"
  | "immutable_conflict"
  | "self_acceptance_forbidden"
  | "trusted_binding_expired"
  | "trusted_binding_revoked"
  | "policy_violation";

export class RoomEvolutionLedgerError extends Error {
  constructor(
    readonly code: RoomEvolutionLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionLedgerError";
  }
}

export class AsyncRoomEvolutionLedger {
  constructor(private readonly persistence: RoomEvolutionLedgerPersistence) {}

  /**
   * Reads only canonical, scope-checked durable records. Engine callers use this
   * to inspect identity bindings and canary receipts without bypassing the ledger.
   */
  async readReferences(input: RoomEvolutionLedgerReferenceQuery): Promise<RoomEvolutionLedgerReferenceSnapshot> {
    const scope = normalizeScope(input.scope);
    const query = referenceQuery(scope, input);
    return this.persistence.transaction(async (transaction) => {
      const snapshot = normalizeReferenceSnapshot(await transaction.resolveReferences(immutableCopy(query)));
      assertReferenceSnapshot(snapshot, query);
      return immutableCopy(snapshot);
    });
  }

  async appendHypothesis(
    input: AppendRoomEvolutionHypothesisInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_hypotheses", RoomEvolutionHypothesisRecordV1>> {
    const normalized = normalizeHypothesisInput(input);
    return this.persistence.transaction(async (transaction) =>
      this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_hypotheses",
        record: normalized.record,
      }));
  }

  async appendCandidateVersion(
    input: AppendRoomEvolutionCandidateVersionInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1>> {
    const normalized = normalizeCandidateVersionInput(input);
    return this.persistence.transaction(async (transaction) =>
      this.appendCandidateVersionRecord(transaction, normalized.scope, normalized.record));
  }

  async appendTrustedBinding(
    input: AppendRoomEvolutionTrustedBindingInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_trusted_bindings", RoomEvolutionTrustedBindingRecordV1>> {
    const normalized = normalizeTrustedBindingInput(input);
    return this.persistence.transaction(async (transaction) => {
      const subject = await transaction.resolveTrustedBindingSubject({
        projectId: normalized.scope.projectId,
        roomId: normalized.record.subjectRoomId,
        roomBindingId: normalized.record.roomBindingId,
      });
      if (!matchesTrustedBindingSubject(normalized.record, subject)) {
        throw invalidReference(
          "Trusted evolution binding must match a durable Room binding generation, role, and role version",
        );
      }
      const issuerGrant = await transaction.resolveEvolutionIssuerGrant({
        projectId: normalized.scope.projectId,
        grantId: normalized.record.issuerGrantId,
      });
      assertActiveEvolutionAuthority(
        issuerGrant,
        normalized.record.issuedByPrincipalId,
        normalized.record.subjectRoomId,
        normalized.record.issuedAt,
        "trusted evolution binding issuer",
      );
      const appended = await this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_trusted_bindings",
        record: normalized.record,
      });
      const readBack = await this.resolveReferences(transaction, normalized.scope, {
        trustedBindingIds: [appended.record.id],
      });
      const persisted = requireReference(readBack.trustedBindings, appended.record.id, "trusted evolution binding");
      if (!sameTrustedBinding(persisted, normalized.record)) {
        throw new RoomEvolutionLedgerError(
          "immutable_conflict",
          "Trusted evolution binding read-back differs from the appended durable record",
        );
      }
      return {
        table: "room_evolution_trusted_bindings",
        record: immutableCopy(persisted),
      };
    });
  }

  async appendTrustedBindingRevocation(
    input: AppendRoomEvolutionTrustedBindingRevocationInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_trusted_binding_revocations", RoomEvolutionTrustedBindingRevocationRecordV1>> {
    const normalized = normalizeTrustedBindingRevocationInput(input);
    return this.persistence.transaction(async (transaction) => {
      const existing = await transaction.findTrustedBindingRevocation(normalized.scope, normalized.record.trustedBindingId);
      if (existing !== null) {
        throw new RoomEvolutionLedgerError(
          "immutable_conflict",
          "A durable trusted evolution binding revocation already exists for " + normalized.record.trustedBindingId,
        );
      }
      const references = await this.resolveReferences(transaction, normalized.scope, {
        trustedBindingIds: [normalized.record.trustedBindingId],
      });
      const trustedBinding = requireReference(
        references.trustedBindings,
        normalized.record.trustedBindingId,
        "trusted evolution binding",
      );
      const revokerGrant = await transaction.resolveEvolutionIssuerGrant({
        projectId: normalized.scope.projectId,
        grantId: normalized.record.revokerGrantId,
      });
      assertActiveEvolutionAuthority(
        revokerGrant,
        normalized.record.revokedByPrincipalId,
        trustedBinding.subjectRoomId,
        normalized.record.revokedAt,
        "trusted evolution binding revoker",
      );
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_trusted_binding_revocations",
        record: normalized.record,
      });
    });
  }

  async appendVerifiedCandidateVersion(
    input: AppendVerifiedRoomEvolutionCandidateVersionInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1>> {
    const normalized = normalizeVerifiedCandidateVersionInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        trustedBindingIds: [normalized.producerBindingId],
      });
      const binding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.producerBindingId,
        normalized.producerBindingVersion,
        "candidate_producer",
        normalized.record.createdAt,
        "candidate producer",
      );
      if (binding.actorId !== normalized.record.producedByActorId) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "Verified candidate producer must match its trusted Room binding identity",
        );
      }
      return this.appendCandidateVersionRecord(transaction, normalized.scope, normalized.record);
    });
  }

  async appendExperiment(
    input: AppendRoomEvolutionExperimentInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_experiments", RoomEvolutionExperimentRecordV1>> {
    const normalized = normalizeExperimentInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        hypothesisIds: [normalized.record.hypothesisId],
        candidateVersionIds: [normalized.record.candidateVersionId],
      });
      const candidate = requireReference(references.candidateVersions, normalized.record.candidateVersionId, "candidate version");
      if (candidate.hypothesisId !== normalized.record.hypothesisId) {
        throw invalidReference("Experiment candidate does not belong to its hypothesis");
      }
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_experiments",
        record: normalized.record,
      });
    });
  }

  async appendBenchmarkCase(
    input: AppendRoomEvolutionBenchmarkCaseInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_benchmark_cases", RoomEvolutionBenchmarkCaseRecordV1>> {
    const normalized = normalizeBenchmarkCaseInput(input);
    return this.persistence.transaction(async (transaction) =>
      this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_benchmark_cases",
        record: normalized.record,
      }));
  }

  async appendBenchmarkResult(
    input: AppendRoomEvolutionBenchmarkResultInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_benchmark_results", RoomEvolutionBenchmarkResultRecordV1>> {
    const normalized = normalizeBenchmarkResultInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: [normalized.record.candidateVersionId],
        experimentIds: [normalized.record.experimentId],
        benchmarkCaseIds: [normalized.record.benchmarkCaseId],
      });
      const experiment = requireReference(references.experiments, normalized.record.experimentId, "experiment");
      if (experiment.candidateVersionId !== normalized.record.candidateVersionId) {
        throw invalidReference("Benchmark result candidate does not match its experiment");
      }
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_benchmark_results",
        record: normalized.record,
      });
    });
  }

  async appendGateResult(
    input: AppendRoomEvolutionGateResultInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_gate_results", RoomEvolutionGateResultRecordV1>> {
    const normalized = normalizeGateResultInput(input);
    if (normalized.record.promotionEligible) {
      throw new RoomEvolutionLedgerError(
        "policy_violation",
        "Promotion-eligible gates require a verified candidate and independent evaluator binding",
      );
    }
    return this.persistence.transaction(async (transaction) =>
      this.appendGateResultRecord(transaction, normalized.scope, normalized.record));
  }

  async appendVerifiedGateResult(
    input: AppendVerifiedRoomEvolutionGateResultInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_gate_results", RoomEvolutionGateResultRecordV1>> {
    const normalized = normalizeVerifiedGateResultInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: [normalized.record.candidateVersionId],
        experimentIds: [normalized.record.experimentId],
        benchmarkResultIds: compactIds(normalized.record.benchmarkResultId),
        trustedBindingIds: [normalized.candidateBindingId, normalized.evaluatorBindingId],
      });
      const candidate = requireReference(references.candidateVersions, normalized.record.candidateVersionId, "candidate version");
      const experiment = requireReference(references.experiments, normalized.record.experimentId, "experiment");
      const benchmarkResult = optionalReference(references.benchmarkResults, normalized.record.benchmarkResultId);
      if (experiment.candidateVersionId !== candidate.id) {
        throw invalidReference("Gate candidate does not match its experiment");
      }
      if (benchmarkResult !== null
        && (benchmarkResult.experimentId !== experiment.id || benchmarkResult.candidateVersionId !== candidate.id)) {
        throw invalidReference("Gate benchmark result does not match its candidate and experiment");
      }
      if (candidate.producedByActorId !== normalized.record.candidateProducerActorId) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "Gate candidate producer identity must match the immutable candidate record",
        );
      }
      const candidateBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.candidateBindingId,
        normalized.candidateBindingVersion,
        "candidate_producer",
        normalized.record.completedAt,
        "gate candidate",
      );
      if (normalized.evaluatorBindingId === candidateBinding.id
        || normalized.record.evaluatorActorId === candidateBinding.actorId) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "A candidate producer cannot supply the independent evaluator identity",
        );
      }
      const evaluatorBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.evaluatorBindingId,
        normalized.evaluatorBindingVersion,
        "independent_evaluator",
        normalized.record.completedAt,
        "gate evaluator",
      );
      if (candidate.candidateHash !== normalized.candidateHash
        || candidate.producerBindingId !== normalized.candidateBindingId
        || candidate.producerBindingVersion !== normalized.candidateBindingVersion
        || candidateBinding.actorId !== candidate.producedByActorId) {
        throw invalidReference("Verified gate candidate hash and producer binding must match the durable candidate record");
      }
      if (normalized.record.outcome !== "passed"
        || normalized.record.evaluatorKind === "producer_self_report"
        || normalized.record.evaluatorActorId !== evaluatorBinding.actorId
        || sameTrustedBindingPrincipal(candidateBinding, evaluatorBinding)) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "A promotion-eligible gate requires an independent passing evaluator",
        );
      }
      return this.appendGateResultRecord(transaction, normalized.scope, normalized.record);
    });
  }

  async appendCanary(
    input: AppendRoomEvolutionCanaryInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_canaries", RoomEvolutionCanaryRecordV1>> {
    const normalized = normalizeCanaryInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: [
          normalized.record.candidateVersionId,
          normalized.record.rollbackTargetCandidateVersionId,
        ],
        experimentIds: [normalized.record.experimentId],
      });
      const candidate = requireReference(references.candidateVersions, normalized.record.candidateVersionId, "candidate version");
      const experiment = requireReference(references.experiments, normalized.record.experimentId, "experiment");
      if (experiment.candidateVersionId !== candidate.id) {
        throw invalidReference("Canary candidate does not match its experiment");
      }
      if (candidate.rollbackTargetCandidateVersionId !== normalized.record.rollbackTargetCandidateVersionId) {
        throw invalidReference("Canary rollback target is not the candidate's declared rollback lineage");
      }
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_canaries",
        record: normalized.record,
      });
    });
  }

  async appendCanaryObservation(
    input: AppendRoomEvolutionCanaryObservationInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_canary_observations", RoomEvolutionCanaryObservationRecordV1>> {
    const normalized = normalizeCanaryObservationInput(input);
    return this.persistence.transaction(async (transaction) => {
      await this.resolveReferences(transaction, normalized.scope, {
        canaryIds: [normalized.record.canaryId],
      });
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_canary_observations",
        record: normalized.record,
      });
    });
  }

  async appendCanarySuccessOutcome(
    input: AppendRoomEvolutionCanarySuccessOutcomeInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_canary_success_outcomes", RoomEvolutionCanarySuccessOutcomeRecordV1>> {
    const normalized = normalizeCanarySuccessOutcomeInput(input);
    return this.persistence.transaction(async (transaction) => {
      const existing = await transaction.findCanarySuccessOutcome(normalized.scope, normalized.record.canaryId);
      if (existing !== null) {
        throw new RoomEvolutionLedgerError(
          "immutable_conflict",
          "A durable successful canary outcome already exists for " + normalized.record.canaryId,
        );
      }
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: [normalized.record.candidateVersionId],
        experimentIds: [normalized.record.experimentId],
        gateResultIds: normalized.record.gateResultIds,
        canaryIds: [normalized.record.canaryId],
        trustedBindingIds: [normalized.record.candidateBindingId, normalized.record.evaluatorBindingId],
      });
      const candidate = requireReference(references.candidateVersions, normalized.record.candidateVersionId, "candidate version");
      const experiment = requireReference(references.experiments, normalized.record.experimentId, "experiment");
      const canary = requireReference(references.canaries, normalized.record.canaryId, "canary");
      const candidateBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.record.candidateBindingId,
        normalized.record.candidateBindingVersion,
        "candidate_producer",
        normalized.record.completedAt,
        "canary candidate",
      );
      const evaluatorBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.record.evaluatorBindingId,
        normalized.record.evaluatorBindingVersion,
        "independent_evaluator",
        normalized.record.completedAt,
        "canary evaluator",
      );
      if (experiment.candidateVersionId !== candidate.id
        || canary.experimentId !== experiment.id
        || canary.candidateVersionId !== candidate.id) {
        throw invalidReference("Successful canary outcome must match its durable candidate, experiment, and allocation");
      }
      if (candidate.candidateHash !== normalized.record.candidateHash
        || candidate.producerBindingId !== normalized.record.candidateBindingId
        || candidate.producerBindingVersion !== normalized.record.candidateBindingVersion
        || candidateBinding.actorId !== candidate.producedByActorId) {
        throw invalidReference("Successful canary outcome must match the verified candidate hash and producer binding");
      }
      if (sameTrustedBindingPrincipal(candidateBinding, evaluatorBinding)) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "Canary success requires an evaluator independent of the candidate producer",
        );
      }
      if (normalized.record.allocationHash !== hashRoomValue(canary.allocation)) {
        throw invalidReference("Successful canary outcome allocation hash does not match the durable canary allocation");
      }
      for (const gate of references.gateResults) {
        if (!gate.promotionEligible
          || gate.outcome !== "passed"
          || gate.candidateVersionId !== candidate.id
          || gate.candidateHash !== candidate.candidateHash
          || gate.candidateBindingId !== candidate.producerBindingId
          || gate.candidateBindingVersion !== candidate.producerBindingVersion
          || gate.evaluatorBindingId !== evaluatorBinding.id
          || gate.evaluatorBindingVersion !== evaluatorBinding.bindingVersion
          || gate.evaluationArtifactHash === null
          || gate.metricsHash === null) {
          throw invalidReference("Successful canary outcome requires durable independent gate attestations for the same candidate");
        }
      }
      const appended = await this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_canary_success_outcomes",
        record: normalized.record,
      });
      const readBack = await this.resolveReferences(transaction, normalized.scope, {
        canarySuccessOutcomeIds: [appended.record.id],
      });
      const persisted = requireReference(readBack.canarySuccessOutcomes, appended.record.id, "successful canary outcome");
      if (!sameCanarySuccessOutcome(persisted, normalized.record)) {
        throw new RoomEvolutionLedgerError(
          "immutable_conflict",
          "Successful canary outcome read-back differs from the appended durable receipt",
        );
      }
      return {
        table: "room_evolution_canary_success_outcomes",
        record: immutableCopy(persisted),
      };
    });
  }

  async appendPromotionDecision(
    input: AppendRoomEvolutionPromotionDecisionInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1>> {
    const normalized = normalizePromotionDecisionInput(input);
    if (normalized.record.decision === "promoted") {
      throw new RoomEvolutionLedgerError(
        "policy_violation",
        "Promotions require a read-back verified successful canary outcome and independent decision binding",
      );
    }
    return this.persistence.transaction(async (transaction) =>
      this.appendPromotionDecisionRecord(transaction, normalized.scope, normalized.record));
  }

  async appendVerifiedPromotionDecision(
    input: AppendVerifiedRoomEvolutionPromotionDecisionInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1>> {
    const normalized = normalizeVerifiedPromotionDecisionInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: compactIds(
          normalized.record.candidateVersionId,
          normalized.record.rollbackTargetCandidateVersionId,
        ),
        experimentIds: [normalized.record.experimentId],
        canaryIds: compactIds(normalized.record.canaryId),
        canarySuccessOutcomeIds: [normalized.canarySuccessOutcomeId],
        trustedBindingIds: [normalized.decisionBindingId],
      });
      const candidate = requireReference(references.candidateVersions, normalized.record.candidateVersionId, "candidate version");
      const experiment = requireReference(references.experiments, normalized.record.experimentId, "experiment");
      const canary = optionalReference(references.canaries, normalized.record.canaryId);
      const successfulCanary = requireReference(
        references.canarySuccessOutcomes,
        normalized.canarySuccessOutcomeId,
        "successful canary outcome",
      );
      const decisionBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        references.trustedBindings,
        normalized.decisionBindingId,
        normalized.decisionBindingVersion,
        "independent_evaluator",
        normalized.record.decidedAt,
        "promotion decision",
      );
      if (candidate.producerBindingId === null || candidate.producerBindingVersion === null) {
        throw new RoomEvolutionLedgerError(
          "policy_violation",
          "Promotion requires a candidate with a durable trusted producer binding",
        );
      }
      const candidateBindingReferences = await this.resolveReferences(transaction, normalized.scope, {
        trustedBindingIds: [candidate.producerBindingId],
      });
      const candidateBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        candidateBindingReferences.trustedBindings,
        candidate.producerBindingId,
        candidate.producerBindingVersion,
        "candidate_producer",
        normalized.record.decidedAt,
        "promotion candidate",
      );
      const receiptEvaluatorBindingReferences = await this.resolveReferences(transaction, normalized.scope, {
        trustedBindingIds: [successfulCanary.evaluatorBindingId],
      });
      const receiptEvaluatorBinding = await requireTrustedBinding(
        transaction,
        normalized.scope,
        receiptEvaluatorBindingReferences.trustedBindings,
        successfulCanary.evaluatorBindingId,
        successfulCanary.evaluatorBindingVersion,
        "independent_evaluator",
        normalized.record.decidedAt,
        "promotion canary evaluator",
      );
      if (experiment.candidateVersionId !== candidate.id) {
        throw invalidReference("Promotion candidate does not match its experiment");
      }
      if (candidate.producedByActorId !== normalized.record.candidateProducerActorId
        || candidate.candidateHash === null
        || normalized.record.decisionActorId !== decisionBinding.actorId
        || candidateBinding.actorId !== candidate.producedByActorId
        || sameTrustedBindingPrincipal(candidateBinding, decisionBinding)
        || sameTrustedBindingPrincipal(candidateBinding, receiptEvaluatorBinding)) {
        throw new RoomEvolutionLedgerError(
          "self_acceptance_forbidden",
          "Candidate producer cannot authoritatively accept its own evolution candidate",
        );
      }
      if (normalized.record.decision === "promoted") {
        if (canary === null || normalized.record.rollbackTargetCandidateVersionId === null) {
          throw new RoomEvolutionLedgerError(
            "policy_violation",
            "Promotion requires a durable canary and a declared rollback target",
          );
        }
        if (canary.candidateVersionId !== candidate.id
          || canary.rollbackTargetCandidateVersionId !== normalized.record.rollbackTargetCandidateVersionId) {
          throw invalidReference("Promotion canary does not bind the same candidate rollback lineage");
        }
        if (successfulCanary.canaryId !== canary.id
          || successfulCanary.experimentId !== experiment.id
          || successfulCanary.candidateVersionId !== candidate.id
          || successfulCanary.candidateHash !== candidate.candidateHash
          || successfulCanary.candidateBindingId !== candidate.producerBindingId
          || successfulCanary.candidateBindingVersion !== candidate.producerBindingVersion) {
          throw new RoomEvolutionLedgerError(
            "self_acceptance_forbidden",
            "Promotion must cite the same durable successful canary and an independent decision binding",
          );
        }
      }
      if ((normalized.record.riskClass === "high" || normalized.record.riskClass === "critical")
        && (normalized.record.authorityTier !== "human" || normalized.record.approvalRequestId === null)) {
        throw new RoomEvolutionLedgerError(
          "policy_violation",
          "High-risk evolution promotion requires a human authority and approval request",
        );
      }
      return this.appendPromotionDecisionRecord(transaction, normalized.scope, immutableCopy({
        ...normalized.record,
        candidateHash: candidate.candidateHash,
      }));
    });
  }

  async appendRollback(
    input: AppendRoomEvolutionRollbackInputV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_rollbacks", RoomEvolutionRollbackRecordV1>> {
    const normalized = normalizeRollbackInput(input);
    return this.persistence.transaction(async (transaction) => {
      const references = await this.resolveReferences(transaction, normalized.scope, {
        candidateVersionIds: [normalized.record.fromCandidateVersionId, normalized.record.toCandidateVersionId],
        canaryIds: [normalized.record.canaryId],
        promotionDecisionIds: [normalized.record.promotionDecisionId],
      });
      const canary = requireReference(references.canaries, normalized.record.canaryId, "canary");
      const decision = requireReference(
        references.promotionDecisions,
        normalized.record.promotionDecisionId,
        "promotion decision",
      );
      if (decision.candidateVersionId !== normalized.record.fromCandidateVersionId
        || canary.candidateVersionId !== normalized.record.fromCandidateVersionId
        || canary.rollbackTargetCandidateVersionId !== normalized.record.toCandidateVersionId
        || decision.rollbackTargetCandidateVersionId !== normalized.record.toCandidateVersionId) {
        throw invalidReference("Rollback does not match the durable canary and promotion rollback lineage");
      }
      if (decision.decision !== "promoted" && decision.decision !== "rollback_required") {
        throw new RoomEvolutionLedgerError(
          "policy_violation",
          "Rollback requires a promoted or rollback-required durable decision",
        );
      }
      return this.appendRecord(transaction, normalized.scope, {
        table: "room_evolution_rollbacks",
        record: normalized.record,
      });
    });
  }

  private async appendCandidateVersionRecord(
    transaction: RoomEvolutionLedgerTransaction,
    scope: RoomEvolutionLedgerScope,
    record: RoomEvolutionCandidateVersionRecordV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1>> {
    const references = await this.resolveReferences(transaction, scope, {
      hypothesisIds: [record.hypothesisId],
      candidateVersionIds: compactIds(record.baseCandidateVersionId, record.rollbackTargetCandidateVersionId),
    });
    const hypothesis = requireReference(references.hypotheses, record.hypothesisId, "hypothesis");
    const base = optionalReference(references.candidateVersions, record.baseCandidateVersionId);
    const rollback = optionalReference(references.candidateVersions, record.rollbackTargetCandidateVersionId);
    if (record.versionNumber === 1 && base !== null) {
      throw invalidReference("Initial candidate version cannot name a base candidate");
    }
    if (record.versionNumber > 1 && base === null) {
      throw invalidReference("Candidate version after v1 requires a base candidate");
    }
    if (base !== null && (base.hypothesisId !== hypothesis.id || base.versionNumber >= record.versionNumber)) {
      throw invalidReference("Candidate base must be an earlier version of the same hypothesis");
    }
    if (rollback !== null && rollback.id === record.id) {
      throw invalidReference("Candidate rollback target cannot be the candidate itself");
    }
    return this.appendRecord(transaction, scope, {
      table: "room_evolution_candidate_versions",
      record,
    });
  }

  private async appendGateResultRecord(
    transaction: RoomEvolutionLedgerTransaction,
    scope: RoomEvolutionLedgerScope,
    record: RoomEvolutionGateResultRecordV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_gate_results", RoomEvolutionGateResultRecordV1>> {
    const references = await this.resolveReferences(transaction, scope, {
      candidateVersionIds: [record.candidateVersionId],
      experimentIds: [record.experimentId],
      benchmarkResultIds: compactIds(record.benchmarkResultId),
    });
    const candidate = requireReference(references.candidateVersions, record.candidateVersionId, "candidate version");
    const experiment = requireReference(references.experiments, record.experimentId, "experiment");
    const benchmarkResult = optionalReference(references.benchmarkResults, record.benchmarkResultId);
    if (experiment.candidateVersionId !== candidate.id) {
      throw invalidReference("Gate candidate does not match its experiment");
    }
    if (benchmarkResult !== null
      && (benchmarkResult.experimentId !== experiment.id || benchmarkResult.candidateVersionId !== candidate.id)) {
      throw invalidReference("Gate benchmark result does not match its candidate and experiment");
    }
    if (candidate.producedByActorId !== record.candidateProducerActorId) {
      throw new RoomEvolutionLedgerError(
        "self_acceptance_forbidden",
        "Gate candidate producer identity must match the immutable candidate record",
      );
    }
    return this.appendRecord(transaction, scope, {
      table: "room_evolution_gate_results",
      record,
    });
  }

  private async appendPromotionDecisionRecord(
    transaction: RoomEvolutionLedgerTransaction,
    scope: RoomEvolutionLedgerScope,
    record: RoomEvolutionPromotionDecisionRecordV1,
  ): Promise<RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1>> {
    const references = await this.resolveReferences(transaction, scope, {
      candidateVersionIds: compactIds(record.candidateVersionId, record.rollbackTargetCandidateVersionId),
      experimentIds: [record.experimentId],
      canaryIds: compactIds(record.canaryId),
      canarySuccessOutcomeIds: compactIds(record.canarySuccessOutcomeId),
    });
    const candidate = requireReference(references.candidateVersions, record.candidateVersionId, "candidate version");
    const experiment = requireReference(references.experiments, record.experimentId, "experiment");
    const canary = optionalReference(references.canaries, record.canaryId);
    if (experiment.candidateVersionId !== candidate.id) {
      throw invalidReference("Promotion candidate does not match its experiment");
    }
    if (candidate.producedByActorId !== record.candidateProducerActorId
      || record.decisionActorId === candidate.producedByActorId) {
      throw new RoomEvolutionLedgerError(
        "self_acceptance_forbidden",
        "Candidate producer cannot authoritatively accept its own evolution candidate",
      );
    }
    if (record.decision === "promoted") {
      if (record.canarySuccessOutcomeId === null
        || canary === null
        || record.rollbackTargetCandidateVersionId === null
        || record.candidateHash === null
        || record.decisionBindingId === null
        || record.decisionBindingVersion === null) {
        throw new RoomEvolutionLedgerError(
          "policy_violation",
          "Promotion requires a verified durable canary outcome, decision binding, and rollback target",
        );
      }
      const successfulCanary = requireReference(
        references.canarySuccessOutcomes,
        record.canarySuccessOutcomeId,
        "successful canary outcome",
      );
      if (canary.candidateVersionId !== candidate.id
        || canary.rollbackTargetCandidateVersionId !== record.rollbackTargetCandidateVersionId
        || successfulCanary.canaryId !== canary.id
        || successfulCanary.candidateVersionId !== candidate.id
        || successfulCanary.candidateHash !== record.candidateHash) {
        throw invalidReference("Promotion canary receipt does not bind the same candidate rollback lineage");
      }
    }
    if ((record.riskClass === "high" || record.riskClass === "critical")
      && (record.authorityTier !== "human" || record.approvalRequestId === null)) {
      throw new RoomEvolutionLedgerError(
        "policy_violation",
        "High-risk evolution promotion requires a human authority and approval request",
      );
    }
    return this.appendRecord(transaction, scope, {
      table: "room_evolution_promotion_decisions",
      record,
    });
  }

  private async resolveReferences(
    transaction: RoomEvolutionLedgerTransaction,
    scope: RoomEvolutionLedgerScope,
    requested: Partial<Omit<RoomEvolutionLedgerReferenceQuery, "scope">>,
  ): Promise<RoomEvolutionLedgerReferenceSnapshot> {
    const query = referenceQuery(scope, requested);
    const snapshot = normalizeReferenceSnapshot(await transaction.resolveReferences(immutableCopy(query)));
    assertReferenceSnapshot(snapshot, query);
    return snapshot;
  }

  private async appendRecord<TEntry extends RoomEvolutionLedgerEntry>(
    transaction: RoomEvolutionLedgerTransaction,
    scope: RoomEvolutionLedgerScope,
    entry: TEntry,
  ): Promise<RoomEvolutionLedgerAppendResult<TEntry["table"], TEntry["record"]>> {
    const immutableEntry = immutableCopy(entry);
    const outcome = await transaction.append(immutableCopy({ scope, entry: immutableEntry }));
    if (outcome.status !== "inserted" || outcome.recordId !== immutableEntry.record.id) {
      throw new RoomEvolutionLedgerError(
        "immutable_conflict",
        "Room evolution ledger refuses to overwrite " + immutableEntry.table + " record " + immutableEntry.record.id,
      );
    }
    return immutableCopy({
      table: immutableEntry.table,
      record: immutableEntry.record,
    }) as RoomEvolutionLedgerAppendResult<TEntry["table"], TEntry["record"]>;
  }
}

function normalizeHypothesisInput(input: AppendRoomEvolutionHypothesisInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionHypothesisRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "revision", "state", "sourceSignalKinds", "evidence", "evidenceHash", "declaredScope",
    "riskClass", "expectedMechanism", "affectedDomains", "createdByActorId", "createdAt",
  ], "hypothesis input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "hypothesis id");
  assertPositiveInteger(input.revision, "hypothesis revision");
  assertOneOf(input.state, HYPOTHESIS_STATES, "hypothesis state");
  const sourceSignalKinds = normalizeStringList(input.sourceSignalKinds, "hypothesis source signal kinds", SIGNAL_KINDS);
  const hypothesisEvidence = normalizeEvidence(input.evidence, "hypothesis evidence");
  assertHash(input.evidenceHash, "hypothesis evidence hash");
  const declaredScope = normalizeStringList(input.declaredScope, "hypothesis declared scope");
  assertOneOf(input.riskClass, RISK_CLASSES, "hypothesis risk class");
  assertNonBlank(input.expectedMechanism, "hypothesis expected mechanism");
  const affectedDomains = normalizeStringList(input.affectedDomains, "hypothesis affected domains");
  assertIdentifier(input.createdByActorId, "hypothesis creator");
  assertTimestamp(input.createdAt, "hypothesis creation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      revision: input.revision,
      state: input.state,
      sourceSignalKinds: sourceSignalKinds as readonly RoomEvolutionSignalKindV1[],
      evidence: hypothesisEvidence,
      evidenceHash: input.evidenceHash,
      declaredScope,
      riskClass: input.riskClass,
      expectedMechanism: input.expectedMechanism,
      affectedDomains,
      createdByActorId: input.createdByActorId,
      createdAt: input.createdAt,
    }),
  };
}

function normalizeCandidateVersionInput(input: AppendRoomEvolutionCandidateVersionInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionCandidateVersionRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "hypothesisId", "versionNumber", "candidateKind", "baseRevision", "candidateRef",
    "isolationKind", "isolationRef", "immutableInput", "inputHash", "producedByActorId",
    "baseCandidateVersionId", "rollbackTargetCandidateVersionId", "createdAt",
  ], "candidate version input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "candidate version id");
  assertIdentifier(input.hypothesisId, "candidate hypothesis id");
  assertPositiveInteger(input.versionNumber, "candidate version number");
  assertOneOf(input.candidateKind, CANDIDATE_KINDS, "candidate kind");
  assertNonBlank(input.baseRevision, "candidate base revision");
  assertNonBlank(input.candidateRef, "candidate reference");
  if (input.baseRevision === input.candidateRef) {
    throw new RoomEvolutionLedgerError("policy_violation", "Candidate reference must differ from its base revision");
  }
  assertOneOf(input.isolationKind, ISOLATION_KINDS, "candidate isolation kind");
  if (input.candidateKind === "source_code"
    && input.isolationKind !== "branch"
    && input.isolationKind !== "worktree") {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Source-code evolution candidates require branch or worktree isolation",
    );
  }
  assertNonBlank(input.isolationRef, "candidate isolation reference");
  assertJsonObject(input.immutableInput, "candidate immutable input");
  assertHash(input.inputHash, "candidate input hash");
  assertIdentifier(input.producedByActorId, "candidate producer");
  assertNullableIdentifier(input.baseCandidateVersionId, "candidate base version id");
  assertNullableIdentifier(input.rollbackTargetCandidateVersionId, "candidate rollback target id");
  if (input.id === input.baseCandidateVersionId || input.id === input.rollbackTargetCandidateVersionId) {
    throw invalidReference("Candidate cannot reference itself in its lineage");
  }
  if (input.versionNumber === 1 && input.baseCandidateVersionId !== null) {
    throw invalidReference("Initial candidate version cannot name a base candidate");
  }
  if (input.versionNumber > 1 && input.baseCandidateVersionId === null) {
    throw invalidReference("Candidate version after v1 requires a base candidate");
  }
  assertTimestamp(input.createdAt, "candidate creation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      hypothesisId: input.hypothesisId,
      versionNumber: input.versionNumber,
      candidateKind: input.candidateKind,
      baseRevision: input.baseRevision,
      candidateRef: input.candidateRef,
      isolationKind: input.isolationKind,
      isolationRef: input.isolationRef,
      immutableInput: immutableCopy(input.immutableInput),
      inputHash: input.inputHash,
      candidateHash: null,
      producedByActorId: input.producedByActorId,
      producerBindingId: null,
      producerBindingVersion: null,
      baseCandidateVersionId: input.baseCandidateVersionId,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      createdAt: input.createdAt,
    }),
  };
}

function normalizeTrustedBindingInput(input: AppendRoomEvolutionTrustedBindingInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionTrustedBindingRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "actorId", "purpose", "subjectRoomId", "roomBindingId", "roomBindingGeneration",
    "roleId", "roleVersion", "bindingVersion", "issuedByPrincipalId", "issuerGrantId", "issuedAt", "expiresAt",
  ], "trusted evolution binding input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "trusted evolution binding id");
  assertIdentifier(input.actorId, "trusted evolution binding actor");
  assertOneOf(input.purpose, TRUSTED_BINDING_PURPOSES, "trusted evolution binding purpose");
  assertIdentifier(input.subjectRoomId, "trusted evolution binding Room id");
  if (scope.scopeKind === "room" && scope.roomId !== input.subjectRoomId) {
    throw new RoomEvolutionLedgerError(
      "scope_mismatch",
      "Room-scoped trusted evolution bindings must use the scoped operational Room",
    );
  }
  assertIdentifier(input.roomBindingId, "trusted evolution Room binding id");
  assertPositiveInteger(input.roomBindingGeneration, "trusted evolution Room binding generation");
  assertIdentifier(input.roleId, "trusted evolution binding role id");
  assertPositiveInteger(input.roleVersion, "trusted evolution binding role version");
  assertPositiveInteger(input.bindingVersion, "trusted evolution binding version");
  assertIdentifier(input.issuedByPrincipalId, "trusted evolution binding issuer");
  assertIdentifier(input.issuerGrantId, "trusted evolution binding issuer grant");
  assertTimestamp(input.issuedAt, "trusted evolution binding issuance time");
  assertTimestamp(input.expiresAt, "trusted evolution binding expiry time");
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Trusted evolution binding expiry must be after issuance",
    );
  }
  const recordWithoutHash = {
    contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
    id: input.id,
    ...scopeRecord(scope),
    actorId: input.actorId,
    purpose: input.purpose,
    subjectRoomId: input.subjectRoomId,
    roomBindingId: input.roomBindingId,
    roomBindingGeneration: input.roomBindingGeneration,
    roleId: input.roleId,
    roleVersion: input.roleVersion,
    bindingVersion: input.bindingVersion,
    issuedByPrincipalId: input.issuedByPrincipalId,
    issuerGrantId: input.issuerGrantId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  } as const;
  return {
    scope,
    record: immutableCopy({
      ...recordWithoutHash,
      integrityHash: hashRoomValue(recordWithoutHash),
    }),
  };
}

function normalizeTrustedBindingRevocationInput(input: AppendRoomEvolutionTrustedBindingRevocationInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionTrustedBindingRevocationRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "trustedBindingId", "revokedByPrincipalId", "revokerGrantId", "reason", "evidence",
    "evidenceHash", "revokedAt",
  ], "trusted evolution binding revocation input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "trusted evolution binding revocation id");
  assertIdentifier(input.trustedBindingId, "trusted evolution binding revocation binding id");
  assertIdentifier(input.revokedByPrincipalId, "trusted evolution binding revoker");
  assertIdentifier(input.revokerGrantId, "trusted evolution binding revoker grant");
  assertNonBlank(input.reason, "trusted evolution binding revocation reason");
  const evidence = normalizeEvidence(input.evidence, "trusted evolution binding revocation evidence");
  assertHash(input.evidenceHash, "trusted evolution binding revocation evidence hash");
  assertTimestamp(input.revokedAt, "trusted evolution binding revocation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      trustedBindingId: input.trustedBindingId,
      revokedByPrincipalId: input.revokedByPrincipalId,
      revokerGrantId: input.revokerGrantId,
      reason: input.reason,
      evidence,
      evidenceHash: input.evidenceHash,
      revokedAt: input.revokedAt,
    }),
  };
}

function normalizeVerifiedCandidateVersionInput(input: AppendVerifiedRoomEvolutionCandidateVersionInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionCandidateVersionRecordV1;
  readonly producerBindingId: string;
  readonly producerBindingVersion: number;
} {
  assertExactKeys(input, ["candidate", "candidateHash", "producerBindingId", "producerBindingVersion"], "verified candidate input");
  const normalized = normalizeCandidateVersionInput(input.candidate);
  assertHash(input.candidateHash, "verified candidate hash");
  assertIdentifier(input.producerBindingId, "verified candidate producer binding id");
  assertPositiveInteger(input.producerBindingVersion, "verified candidate producer binding version");
  return {
    scope: normalized.scope,
    record: immutableCopy({
      ...normalized.record,
      candidateHash: input.candidateHash,
      producerBindingId: input.producerBindingId,
      producerBindingVersion: input.producerBindingVersion,
    }),
    producerBindingId: input.producerBindingId,
    producerBindingVersion: input.producerBindingVersion,
  };
}

function normalizeExperimentInput(input: AppendRoomEvolutionExperimentInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionExperimentRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "hypothesisId", "candidateVersionId", "state", "inputSnapshotHash",
    "authorizationEvidence", "authorizationHash", "capacityPool", "createdByActorId", "createdAt",
  ], "experiment input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "experiment id");
  assertIdentifier(input.hypothesisId, "experiment hypothesis id");
  assertIdentifier(input.candidateVersionId, "experiment candidate version id");
  assertOneOf(input.state, EXPERIMENT_STATES, "experiment state");
  assertHash(input.inputSnapshotHash, "experiment input snapshot hash");
  assertNonEmptyJsonObject(input.authorizationEvidence, "experiment authorization evidence");
  assertHash(input.authorizationHash, "experiment authorization hash");
  assertOneOf(input.capacityPool, CAPACITY_POOLS, "experiment capacity pool");
  assertIdentifier(input.createdByActorId, "experiment creator");
  assertTimestamp(input.createdAt, "experiment creation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      hypothesisId: input.hypothesisId,
      candidateVersionId: input.candidateVersionId,
      state: input.state,
      inputSnapshotHash: input.inputSnapshotHash,
      authorizationEvidence: immutableCopy(input.authorizationEvidence),
      authorizationHash: input.authorizationHash,
      capacityPool: input.capacityPool,
      createdByActorId: input.createdByActorId,
      createdAt: input.createdAt,
    }),
  };
}

function normalizeBenchmarkCaseInput(input: AppendRoomEvolutionBenchmarkCaseInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionBenchmarkCaseRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "domain", "caseKind", "containsPrivateRoomData", "sourceAuthorizationId",
    "authorizationEvidence", "casePayload", "expectedOutcome", "contentHash", "createdAt",
  ], "benchmark case input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "benchmark case id");
  assertNonBlank(input.domain, "benchmark case domain");
  assertOneOf(input.caseKind, BENCHMARK_CASE_KINDS, "benchmark case kind");
  assertBoolean(input.containsPrivateRoomData, "benchmark private-data marker");
  assertNullableIdentifier(input.sourceAuthorizationId, "benchmark source authorization id");
  assertJsonObject(input.authorizationEvidence, "benchmark authorization evidence");
  if (input.containsPrivateRoomData
    && (input.sourceAuthorizationId === null || Object.keys(input.authorizationEvidence).length === 0)) {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Private Room benchmark data requires an authorization id and durable authorization evidence",
    );
  }
  assertJsonObject(input.casePayload, "benchmark case payload");
  assertJsonObject(input.expectedOutcome, "benchmark expected outcome");
  assertHash(input.contentHash, "benchmark content hash");
  assertTimestamp(input.createdAt, "benchmark creation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      domain: input.domain,
      caseKind: input.caseKind,
      containsPrivateRoomData: input.containsPrivateRoomData,
      sourceAuthorizationId: input.sourceAuthorizationId,
      authorizationEvidence: immutableCopy(input.authorizationEvidence),
      casePayload: immutableCopy(input.casePayload),
      expectedOutcome: immutableCopy(input.expectedOutcome),
      contentHash: input.contentHash,
      createdAt: input.createdAt,
    }),
  };
}

function normalizeBenchmarkResultInput(input: AppendRoomEvolutionBenchmarkResultInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionBenchmarkResultRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "experimentId", "candidateVersionId", "benchmarkCaseId", "evaluatorActorId",
    "evaluatorKind", "outcome", "metrics", "evidence", "evidenceHash", "completedAt",
  ], "benchmark result input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "benchmark result id");
  assertIdentifier(input.experimentId, "benchmark result experiment id");
  assertIdentifier(input.candidateVersionId, "benchmark result candidate id");
  assertIdentifier(input.benchmarkCaseId, "benchmark result case id");
  assertIdentifier(input.evaluatorActorId, "benchmark evaluator");
  assertOneOf(input.evaluatorKind, EVALUATOR_KINDS, "benchmark evaluator kind");
  assertOneOf(input.outcome, BENCHMARK_OUTCOMES, "benchmark outcome");
  assertJsonObject(input.metrics, "benchmark metrics");
  const benchmarkEvidence = normalizeEvidence(input.evidence, "benchmark result evidence");
  assertHash(input.evidenceHash, "benchmark result evidence hash");
  assertTimestamp(input.completedAt, "benchmark completion time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      benchmarkCaseId: input.benchmarkCaseId,
      evaluatorActorId: input.evaluatorActorId,
      evaluatorKind: input.evaluatorKind,
      outcome: input.outcome,
      metrics: immutableCopy(input.metrics),
      evidence: benchmarkEvidence,
      evidenceHash: input.evidenceHash,
      completedAt: input.completedAt,
    }),
  };
}

function normalizeGateResultInput(input: AppendRoomEvolutionGateResultInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionGateResultRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "experimentId", "candidateVersionId", "benchmarkResultId", "gateName", "gateClass",
    "outcome", "evaluatorActorId", "evaluatorKind", "candidateProducerActorId", "metrics", "evidence",
    "evidenceHash", "promotionEligible", "completedAt",
  ], "gate result input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "gate result id");
  assertIdentifier(input.experimentId, "gate experiment id");
  assertIdentifier(input.candidateVersionId, "gate candidate id");
  assertNullableIdentifier(input.benchmarkResultId, "gate benchmark result id");
  assertNonBlank(input.gateName, "gate name");
  assertOneOf(input.gateClass, GATE_CLASSES, "gate class");
  assertOneOf(input.outcome, GATE_OUTCOMES, "gate outcome");
  assertIdentifier(input.evaluatorActorId, "gate evaluator");
  assertOneOf(input.evaluatorKind, EVALUATOR_KINDS, "gate evaluator kind");
  assertIdentifier(input.candidateProducerActorId, "gate candidate producer");
  assertJsonObject(input.metrics, "gate metrics");
  const gateEvidence = normalizeEvidence(input.evidence, "gate evidence");
  assertHash(input.evidenceHash, "gate evidence hash");
  assertBoolean(input.promotionEligible, "gate promotion eligibility");
  assertTimestamp(input.completedAt, "gate completion time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      benchmarkResultId: input.benchmarkResultId,
      gateName: input.gateName,
      gateClass: input.gateClass,
      outcome: input.outcome,
      evaluatorActorId: input.evaluatorActorId,
      evaluatorKind: input.evaluatorKind,
      candidateProducerActorId: input.candidateProducerActorId,
      candidateHash: null,
      candidateBindingId: null,
      candidateBindingVersion: null,
      evaluatorBindingId: null,
      evaluatorBindingVersion: null,
      evaluationArtifactHash: null,
      metrics: immutableCopy(input.metrics),
      metricsHash: null,
      evidence: gateEvidence,
      evidenceHash: input.evidenceHash,
      promotionEligible: input.promotionEligible,
      completedAt: input.completedAt,
    }),
  };
}

function normalizeVerifiedGateResultInput(input: AppendVerifiedRoomEvolutionGateResultInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionGateResultRecordV1;
  readonly candidateHash: string;
  readonly candidateBindingId: string;
  readonly candidateBindingVersion: number;
  readonly evaluatorBindingId: string;
  readonly evaluatorBindingVersion: number;
} {
  assertExactKeys(input, [
    "gate", "candidateHash", "candidateBindingId", "candidateBindingVersion", "evaluatorBindingId",
    "evaluatorBindingVersion", "evaluationArtifactHash",
  ], "verified gate input");
  const normalized = normalizeGateResultInput(input.gate);
  assertHash(input.candidateHash, "verified gate candidate hash");
  assertIdentifier(input.candidateBindingId, "verified gate candidate binding id");
  assertPositiveInteger(input.candidateBindingVersion, "verified gate candidate binding version");
  assertIdentifier(input.evaluatorBindingId, "verified gate evaluator binding id");
  assertPositiveInteger(input.evaluatorBindingVersion, "verified gate evaluator binding version");
  assertHash(input.evaluationArtifactHash, "verified gate evaluation artifact hash");
  if (!normalized.record.promotionEligible) {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Verified independent gates must explicitly be promotion eligible",
    );
  }
  return {
    scope: normalized.scope,
    record: immutableCopy({
      ...normalized.record,
      candidateHash: input.candidateHash,
      candidateBindingId: input.candidateBindingId,
      candidateBindingVersion: input.candidateBindingVersion,
      evaluatorBindingId: input.evaluatorBindingId,
      evaluatorBindingVersion: input.evaluatorBindingVersion,
      evaluationArtifactHash: input.evaluationArtifactHash,
      metricsHash: hashRoomValue(normalized.record.metrics),
    }),
    candidateHash: input.candidateHash,
    candidateBindingId: input.candidateBindingId,
    candidateBindingVersion: input.candidateBindingVersion,
    evaluatorBindingId: input.evaluatorBindingId,
    evaluatorBindingVersion: input.evaluatorBindingVersion,
  };
}

function normalizeCanaryInput(input: AppendRoomEvolutionCanaryInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionCanaryRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "experimentId", "candidateVersionId", "allocationVersion", "allocation",
    "successCriteria", "failureCriteria", "state", "rollbackTargetCandidateVersionId", "createdAt",
  ], "canary input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "canary id");
  assertIdentifier(input.experimentId, "canary experiment id");
  assertIdentifier(input.candidateVersionId, "canary candidate id");
  assertPositiveInteger(input.allocationVersion, "canary allocation version");
  assertJsonObject(input.allocation, "canary allocation");
  assertJsonObject(input.successCriteria, "canary success criteria");
  assertJsonObject(input.failureCriteria, "canary failure criteria");
  assertOneOf(input.state, CANARY_STATES, "canary state");
  assertIdentifier(input.rollbackTargetCandidateVersionId, "canary rollback target");
  if (input.candidateVersionId === input.rollbackTargetCandidateVersionId) {
    throw invalidReference("Canary rollback target cannot be the candidate itself");
  }
  assertTimestamp(input.createdAt, "canary creation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      allocationVersion: input.allocationVersion,
      allocation: immutableCopy(input.allocation),
      successCriteria: immutableCopy(input.successCriteria),
      failureCriteria: immutableCopy(input.failureCriteria),
      state: input.state,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      createdAt: input.createdAt,
    }),
  };
}

function normalizeCanaryObservationInput(input: AppendRoomEvolutionCanaryObservationInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionCanaryObservationRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "canaryId", "metricName", "metricValue", "threshold", "breached", "evidence",
    "evidenceHash", "observedAt",
  ], "canary observation input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "canary observation id");
  assertIdentifier(input.canaryId, "canary observation canary id");
  assertNonBlank(input.metricName, "canary observation metric name");
  assertJsonObject(input.metricValue, "canary observation metric value");
  assertJsonObject(input.threshold, "canary observation threshold");
  assertBoolean(input.breached, "canary observation breached marker");
  const observationEvidence = normalizeEvidence(input.evidence, "canary observation evidence");
  assertHash(input.evidenceHash, "canary observation evidence hash");
  assertTimestamp(input.observedAt, "canary observation time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      canaryId: input.canaryId,
      metricName: input.metricName,
      metricValue: immutableCopy(input.metricValue),
      threshold: immutableCopy(input.threshold),
      breached: input.breached,
      evidence: observationEvidence,
      evidenceHash: input.evidenceHash,
      observedAt: input.observedAt,
    }),
  };
}

function normalizeCanarySuccessOutcomeInput(input: AppendRoomEvolutionCanarySuccessOutcomeInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionCanarySuccessOutcomeRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "canaryId", "experimentId", "candidateVersionId", "candidateHash", "candidateBindingId",
    "candidateBindingVersion", "evaluatorBindingId", "evaluatorBindingVersion", "gateResultIds", "allocationHash",
    "artifactHash", "metrics", "evidence", "evidenceHash", "completedAt",
  ], "successful canary outcome input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "successful canary outcome id");
  assertIdentifier(input.canaryId, "successful canary outcome canary id");
  assertIdentifier(input.experimentId, "successful canary outcome experiment id");
  assertIdentifier(input.candidateVersionId, "successful canary outcome candidate id");
  assertHash(input.candidateHash, "successful canary outcome candidate hash");
  assertIdentifier(input.candidateBindingId, "successful canary outcome candidate binding id");
  assertPositiveInteger(input.candidateBindingVersion, "successful canary outcome candidate binding version");
  assertIdentifier(input.evaluatorBindingId, "successful canary outcome evaluator binding id");
  assertPositiveInteger(input.evaluatorBindingVersion, "successful canary outcome evaluator binding version");
  const gateResultIds = canonicalIds(input.gateResultIds, "successful canary outcome gate ids");
  if (gateResultIds.length === 0) {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Successful canary outcomes require at least one durable independent gate",
    );
  }
  assertHash(input.allocationHash, "successful canary outcome allocation hash");
  assertHash(input.artifactHash, "successful canary outcome artifact hash");
  assertJsonObject(input.metrics, "successful canary outcome metrics");
  const outcomeEvidence = normalizeEvidence(input.evidence, "successful canary outcome evidence");
  assertHash(input.evidenceHash, "successful canary outcome evidence hash");
  assertTimestamp(input.completedAt, "successful canary outcome completion time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      canaryId: input.canaryId,
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      candidateHash: input.candidateHash,
      candidateBindingId: input.candidateBindingId,
      candidateBindingVersion: input.candidateBindingVersion,
      evaluatorBindingId: input.evaluatorBindingId,
      evaluatorBindingVersion: input.evaluatorBindingVersion,
      gateResultIds,
      allocationHash: input.allocationHash,
      artifactHash: input.artifactHash,
      metrics: immutableCopy(input.metrics),
      metricsHash: hashRoomValue(input.metrics),
      evidence: outcomeEvidence,
      evidenceHash: input.evidenceHash,
      completedAt: input.completedAt,
    }),
  };
}

function normalizePromotionDecisionInput(input: AppendRoomEvolutionPromotionDecisionInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionPromotionDecisionRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "experimentId", "candidateVersionId", "canaryId", "decision", "riskClass",
    "authorityTier", "candidateProducerActorId", "decisionActorId", "approvalRequestId",
    "authorizationEvidence", "evidence", "evidenceHash", "rollbackTargetCandidateVersionId", "decidedAt",
  ], "promotion decision input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "promotion decision id");
  assertIdentifier(input.experimentId, "promotion experiment id");
  assertIdentifier(input.candidateVersionId, "promotion candidate id");
  assertNullableIdentifier(input.canaryId, "promotion canary id");
  assertOneOf(input.decision, PROMOTION_DECISIONS, "promotion decision");
  assertOneOf(input.riskClass, RISK_CLASSES, "promotion risk class");
  assertOneOf(input.authorityTier, AUTHORITY_TIERS, "promotion authority tier");
  assertIdentifier(input.candidateProducerActorId, "promotion candidate producer");
  assertIdentifier(input.decisionActorId, "promotion decision actor");
  assertNullableIdentifier(input.approvalRequestId, "promotion approval request id");
  assertNonEmptyJsonObject(input.authorizationEvidence, "promotion authorization evidence");
  const promotionEvidence = normalizeEvidence(input.evidence, "promotion evidence");
  assertHash(input.evidenceHash, "promotion evidence hash");
  assertNullableIdentifier(input.rollbackTargetCandidateVersionId, "promotion rollback target id");
  assertTimestamp(input.decidedAt, "promotion decision time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      canaryId: input.canaryId,
      canarySuccessOutcomeId: null,
      candidateHash: null,
      decisionBindingId: null,
      decisionBindingVersion: null,
      decision: input.decision,
      riskClass: input.riskClass,
      authorityTier: input.authorityTier,
      candidateProducerActorId: input.candidateProducerActorId,
      decisionActorId: input.decisionActorId,
      approvalRequestId: input.approvalRequestId,
      authorizationEvidence: immutableCopy(input.authorizationEvidence),
      evidence: promotionEvidence,
      evidenceHash: input.evidenceHash,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      decidedAt: input.decidedAt,
    }),
  };
}

function normalizeVerifiedPromotionDecisionInput(input: AppendVerifiedRoomEvolutionPromotionDecisionInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionPromotionDecisionRecordV1;
  readonly canarySuccessOutcomeId: string;
  readonly decisionBindingId: string;
  readonly decisionBindingVersion: number;
} {
  assertExactKeys(input, ["decision", "canarySuccessOutcomeId", "decisionBindingId", "decisionBindingVersion"], "verified promotion decision input");
  const normalized = normalizePromotionDecisionInput(input.decision);
  assertIdentifier(input.canarySuccessOutcomeId, "verified promotion successful canary outcome id");
  assertIdentifier(input.decisionBindingId, "verified promotion decision binding id");
  assertPositiveInteger(input.decisionBindingVersion, "verified promotion decision binding version");
  if (normalized.record.decision !== "promoted") {
    throw new RoomEvolutionLedgerError(
      "policy_violation",
      "Verified promotion decisions must have the promoted outcome",
    );
  }
  return {
    scope: normalized.scope,
    record: immutableCopy({
      ...normalized.record,
      canarySuccessOutcomeId: input.canarySuccessOutcomeId,
      candidateHash: null,
      decisionBindingId: input.decisionBindingId,
      decisionBindingVersion: input.decisionBindingVersion,
    }),
    canarySuccessOutcomeId: input.canarySuccessOutcomeId,
    decisionBindingId: input.decisionBindingId,
    decisionBindingVersion: input.decisionBindingVersion,
  };
}

function normalizeRollbackInput(input: AppendRoomEvolutionRollbackInputV1): {
  readonly scope: RoomEvolutionLedgerScope;
  readonly record: RoomEvolutionRollbackRecordV1;
} {
  assertExactKeys(input, [
    "scope", "id", "promotionDecisionId", "canaryId", "fromCandidateVersionId", "toCandidateVersionId",
    "triggerKind", "reason", "evidence", "evidenceHash", "executedAt",
  ], "rollback input");
  const scope = normalizeScope(input.scope);
  assertIdentifier(input.id, "rollback id");
  assertIdentifier(input.promotionDecisionId, "rollback promotion decision id");
  assertIdentifier(input.canaryId, "rollback canary id");
  assertIdentifier(input.fromCandidateVersionId, "rollback source candidate id");
  assertIdentifier(input.toCandidateVersionId, "rollback target candidate id");
  if (input.fromCandidateVersionId === input.toCandidateVersionId) {
    throw invalidReference("Rollback target cannot be the source candidate");
  }
  assertOneOf(input.triggerKind, ROLLBACK_TRIGGERS, "rollback trigger kind");
  assertNonBlank(input.reason, "rollback reason");
  const rollbackEvidence = normalizeEvidence(input.evidence, "rollback evidence");
  assertHash(input.evidenceHash, "rollback evidence hash");
  assertTimestamp(input.executedAt, "rollback execution time");
  return {
    scope,
    record: immutableCopy({
      contractVersion: ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION,
      id: input.id,
      ...scopeRecord(scope),
      promotionDecisionId: input.promotionDecisionId,
      canaryId: input.canaryId,
      fromCandidateVersionId: input.fromCandidateVersionId,
      toCandidateVersionId: input.toCandidateVersionId,
      triggerKind: input.triggerKind,
      reason: input.reason,
      evidence: rollbackEvidence,
      evidenceHash: input.evidenceHash,
      executedAt: input.executedAt,
    }),
  };
}

function normalizeScope(input: RoomEvolutionLedgerScope): RoomEvolutionLedgerScope {
  assertExactKeys(input, ["projectId", "roomId", "scopeKind", "scopeKey"], "evolution scope");
  assertIdentifier(input.projectId, "evolution scope project id");
  if (input.scopeKind === "project") {
    if (input.roomId !== null || input.scopeKey !== "project:" + input.projectId) {
      throw new RoomEvolutionLedgerError(
        "scope_mismatch",
        "Project scope requires null Room id and the canonical project scope key",
      );
    }
  } else if (input.scopeKind === "room") {
    assertIdentifier(input.roomId, "evolution scope Room id");
    if (input.scopeKey !== "room:" + input.roomId) {
      throw new RoomEvolutionLedgerError("scope_mismatch", "Room scope key must bind the submitted Room id");
    }
  } else {
    throw new RoomEvolutionLedgerError("invalid_input", "Evolution scope kind is unsupported");
  }
  return immutableCopy({
    projectId: input.projectId,
    roomId: input.roomId,
    scopeKind: input.scopeKind,
    scopeKey: input.scopeKey,
  });
}

function scopeRecord(scope: RoomEvolutionLedgerScope): Pick<
  RoomEvolutionScopedRecordV1,
  "projectId" | "roomId" | "scopeKind" | "scopeKey"
> {
  return {
    projectId: scope.projectId,
    roomId: scope.roomId,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
  };
}

function referenceQuery(
  scope: RoomEvolutionLedgerScope,
  requested: Partial<Omit<RoomEvolutionLedgerReferenceQuery, "scope">>,
): RoomEvolutionLedgerReferenceQuery {
  return {
    scope,
    hypothesisIds: canonicalIds(requested.hypothesisIds ?? [], "hypothesis reference ids"),
    candidateVersionIds: canonicalIds(requested.candidateVersionIds ?? [], "candidate version reference ids"),
    trustedBindingIds: canonicalIds(requested.trustedBindingIds ?? [], "trusted binding reference ids"),
    experimentIds: canonicalIds(requested.experimentIds ?? [], "experiment reference ids"),
    benchmarkCaseIds: canonicalIds(requested.benchmarkCaseIds ?? [], "benchmark case reference ids"),
    benchmarkResultIds: canonicalIds(requested.benchmarkResultIds ?? [], "benchmark result reference ids"),
    gateResultIds: canonicalIds(requested.gateResultIds ?? [], "gate result reference ids"),
    canaryIds: canonicalIds(requested.canaryIds ?? [], "canary reference ids"),
    canaryObservationIds: canonicalIds(requested.canaryObservationIds ?? [], "canary observation reference ids"),
    canarySuccessOutcomeIds: canonicalIds(requested.canarySuccessOutcomeIds ?? [], "successful canary outcome reference ids"),
    promotionDecisionIds: canonicalIds(requested.promotionDecisionIds ?? [], "promotion decision reference ids"),
    rollbackIds: canonicalIds(requested.rollbackIds ?? [], "rollback reference ids"),
  };
}

function assertReferenceSnapshot(
  snapshot: RoomEvolutionLedgerReferenceSnapshot,
  query: RoomEvolutionLedgerReferenceQuery,
): void {
  assertScopesEqual(snapshot.scope, query.scope, "reference snapshot");
  assertReferenceSet(snapshot.hypotheses, query.hypothesisIds, query.scope, "hypothesis");
  assertReferenceSet(snapshot.candidateVersions, query.candidateVersionIds, query.scope, "candidate version");
  assertReferenceSet(snapshot.trustedBindings, query.trustedBindingIds, query.scope, "trusted binding");
  assertReferenceSet(snapshot.experiments, query.experimentIds, query.scope, "experiment");
  assertReferenceSet(snapshot.benchmarkCases, query.benchmarkCaseIds, query.scope, "benchmark case");
  assertReferenceSet(snapshot.benchmarkResults, query.benchmarkResultIds, query.scope, "benchmark result");
  assertReferenceSet(snapshot.gateResults, query.gateResultIds, query.scope, "gate result");
  assertReferenceSet(snapshot.canaries, query.canaryIds, query.scope, "canary");
  assertReferenceSet(snapshot.canaryObservations, query.canaryObservationIds, query.scope, "canary observation");
  assertReferenceSet(snapshot.canarySuccessOutcomes, query.canarySuccessOutcomeIds, query.scope, "successful canary outcome");
  assertReferenceSet(snapshot.promotionDecisions, query.promotionDecisionIds, query.scope, "promotion decision");
  assertReferenceSet(snapshot.rollbacks, query.rollbackIds, query.scope, "rollback");
}

/*
Older Core persistence adapters can omit newly introduced receipt arrays only
when no caller requested them. Normalize that wire shape to empty arrays first;
any non-empty request still fails closed in assertReferenceSet below.
*/
function normalizeReferenceSnapshot(
  snapshot: RoomEvolutionLedgerReferenceSnapshot,
): RoomEvolutionLedgerReferenceSnapshot {
  const legacySnapshot = snapshot as Partial<RoomEvolutionLedgerReferenceSnapshot>;
  return {
    ...snapshot,
    trustedBindings: legacySnapshot.trustedBindings ?? [],
    canarySuccessOutcomes: legacySnapshot.canarySuccessOutcomes ?? [],
  };
}

function assertReferenceSet<TRecord extends RoomEvolutionScopedRecordV1>(
  records: readonly TRecord[],
  requestedIds: readonly string[],
  scope: RoomEvolutionLedgerScope,
  label: string,
): void {
  if (records.length !== requestedIds.length) {
    throw new RoomEvolutionLedgerError(
      "reference_not_found",
      "Evolution ledger could not resolve every requested " + label + " in scope",
    );
  }
  for (const [index, record] of records.entries()) {
    if (record.id !== requestedIds[index]) {
      throw new RoomEvolutionLedgerError(
        "invalid_reference",
        "Evolution ledger reference snapshot returned " + label + " ids out of canonical request order",
      );
    }
    assertRecordScope(record, scope, label);
  }
}

function assertRecordScope(
  record: RoomEvolutionScopedRecordV1,
  scope: RoomEvolutionLedgerScope,
  label: string,
): void {
  if (record.contractVersion !== ROOM_EVOLUTION_LEDGER_CONTRACT_VERSION) {
    throw new RoomEvolutionLedgerError("invalid_reference", "Unsupported " + label + " contract version");
  }
  if (record.projectId !== scope.projectId
    || record.roomId !== scope.roomId
    || record.scopeKind !== scope.scopeKind
    || record.scopeKey !== scope.scopeKey) {
    throw new RoomEvolutionLedgerError(
      "scope_mismatch",
      "Evolution " + label + " belongs to another project or Room scope",
    );
  }
}

function assertScopesEqual(
  left: RoomEvolutionLedgerScope,
  right: RoomEvolutionLedgerScope,
  label: string,
): void {
  if (left.projectId !== right.projectId
    || left.roomId !== right.roomId
    || left.scopeKind !== right.scopeKind
    || left.scopeKey !== right.scopeKey) {
    throw new RoomEvolutionLedgerError("scope_mismatch", label + " belongs to another project or Room scope");
  }
}

async function requireTrustedBinding(
  transaction: RoomEvolutionLedgerTransaction,
  scope: RoomEvolutionLedgerScope,
  records: readonly RoomEvolutionTrustedBindingRecordV1[],
  id: string,
  bindingVersion: number,
  purpose: RoomEvolutionTrustedBindingPurposeV1,
  asOf: string,
  label: string,
): Promise<RoomEvolutionTrustedBindingRecordV1> {
  const binding = requireReference(records, id, label + " trusted binding");
  assertRecordScope(binding, scope, label + " trusted binding");
  if (binding.bindingVersion !== bindingVersion || binding.purpose !== purpose) {
    throw invalidReference("Evolution " + label + " must use the exact durable trusted binding purpose and version");
  }
  if (binding.integrityHash !== hashRoomValue(trustedBindingWithoutIntegrityHash(binding))) {
    throw invalidReference("Evolution " + label + " trusted binding integrity hash does not match its durable identity fields");
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(asOf)) {
    throw new RoomEvolutionLedgerError(
      "trusted_binding_expired",
      "Evolution " + label + " trusted binding expired before the asserted outcome",
    );
  }
  const revocation = await transaction.findTrustedBindingRevocation(scope, binding.id);
  if (revocation !== null && Date.parse(revocation.revokedAt) <= Date.parse(asOf)) {
    throw new RoomEvolutionLedgerError(
      "trusted_binding_revoked",
      "Evolution " + label + " trusted binding was durably revoked before the asserted outcome",
    );
  }
  return binding;
}

function trustedBindingWithoutIntegrityHash(binding: RoomEvolutionTrustedBindingRecordV1): Omit<
  RoomEvolutionTrustedBindingRecordV1,
  "integrityHash"
> {
  return {
    contractVersion: binding.contractVersion,
    id: binding.id,
    projectId: binding.projectId,
    roomId: binding.roomId,
    scopeKind: binding.scopeKind,
    scopeKey: binding.scopeKey,
    actorId: binding.actorId,
    purpose: binding.purpose,
    subjectRoomId: binding.subjectRoomId,
    roomBindingId: binding.roomBindingId,
    roomBindingGeneration: binding.roomBindingGeneration,
    roleId: binding.roleId,
    roleVersion: binding.roleVersion,
    bindingVersion: binding.bindingVersion,
    issuedByPrincipalId: binding.issuedByPrincipalId,
    issuerGrantId: binding.issuerGrantId,
    issuedAt: binding.issuedAt,
    expiresAt: binding.expiresAt,
  };
}

function sameTrustedBinding(
  left: RoomEvolutionTrustedBindingRecordV1,
  right: RoomEvolutionTrustedBindingRecordV1,
): boolean {
  return left.integrityHash === right.integrityHash && hashRoomValue(left) === hashRoomValue(right);
}

function sameTrustedBindingPrincipal(
  left: RoomEvolutionTrustedBindingRecordV1,
  right: RoomEvolutionTrustedBindingRecordV1,
): boolean {
  return left.actorId === right.actorId
    || (left.roomBindingId === right.roomBindingId
      && left.roomBindingGeneration === right.roomBindingGeneration);
}

function sameCanarySuccessOutcome(
  left: RoomEvolutionCanarySuccessOutcomeRecordV1,
  right: RoomEvolutionCanarySuccessOutcomeRecordV1,
): boolean {
  return hashRoomValue(left) === hashRoomValue(right);
}

function matchesTrustedBindingSubject(
  binding: RoomEvolutionTrustedBindingRecordV1,
  subject: RoomEvolutionTrustedBindingSubjectV1 | null,
): boolean {
  return subject !== null
    && subject.projectId === binding.projectId
    && subject.roomId === binding.subjectRoomId
    && subject.roomBindingId === binding.roomBindingId
    && subject.roomBindingGeneration === binding.roomBindingGeneration
    && subject.roleId === binding.roleId
    && subject.roleVersion === binding.roleVersion;
}

function assertActiveEvolutionAuthority(
  grant: RoomEvolutionIssuerGrantV1 | null,
  principalId: string,
  subjectRoomId: string | null,
  assertedAt: string,
  label: string,
): asserts grant is RoomEvolutionIssuerGrantV1 {
  if (grant === null
    || grant.principalId !== principalId
    || (grant.role !== "owner" && grant.role !== "admin")
    || (grant.roomId !== null && grant.roomId !== subjectRoomId)
    || Date.parse(grant.grantedAt) > Date.parse(assertedAt)
    || (grant.revokedAt !== null && Date.parse(grant.revokedAt) <= Date.parse(assertedAt))) {
    throw invalidReference("Evolution " + label + " must be an active owner/admin grant for the durable Room scope");
  }
}

function requireReference<TRecord extends { readonly id: string }>(
  records: readonly TRecord[],
  id: string,
  label: string,
): TRecord {
  const record = records.find((entry) => entry.id === id);
  if (!record) {
    throw new RoomEvolutionLedgerError("reference_not_found", "Evolution ledger could not resolve " + label + " " + id);
  }
  return record;
}

function optionalReference<TRecord extends { readonly id: string }>(
  records: readonly TRecord[],
  id: string | null,
): TRecord | null {
  return id === null ? null : requireReference(records, id, "reference");
}

function compactIds(...ids: readonly (string | null)[]): readonly string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

function canonicalIds(ids: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(ids)) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be an array");
  }
  const seen = new Set<string>();
  for (const id of ids) {
    assertIdentifier(id, label);
    if (seen.has(id)) throw new RoomEvolutionLedgerError("invalid_reference", label + " must not contain duplicates");
    seen.add(id);
  }
  return immutableCopy([...ids]);
}

function normalizeEvidence(
  input: readonly RoomEvolutionEvidenceRefV1[],
  label: string,
): readonly RoomEvolutionEvidenceRefV1[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " requires at least one immutable evidence reference");
  }
  const ids = new Set<string>();
  const normalized: RoomEvolutionEvidenceRefV1[] = [];
  for (const [index, entry] of input.entries()) {
    assertExactKeys(entry, ["id", "source", "sourceRef", "evidenceHash", "observedAt"], label + "[" + index + "]");
    assertIdentifier(entry.id, label + " id");
    if (ids.has(entry.id)) throw new RoomEvolutionLedgerError("invalid_reference", label + " ids must be unique");
    ids.add(entry.id);
    assertOneOf(entry.source, EVIDENCE_SOURCES, label + " source");
    assertIdentifier(entry.sourceRef, label + " source reference");
    assertHash(entry.evidenceHash, label + " hash");
    assertTimestamp(entry.observedAt, label + " observed time");
    normalized.push({
      id: entry.id,
      source: entry.source,
      sourceRef: entry.sourceRef,
      evidenceHash: entry.evidenceHash,
      observedAt: entry.observedAt,
    });
  }
  return immutableCopy(normalized);
}

function normalizeStringList(
  input: readonly string[],
  label: string,
  allowed: readonly string[] | null = null,
): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " requires at least one value");
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    assertIdentifier(value, label);
    if (allowed !== null) assertOneOf(value, allowed, label);
    if (seen.has(value)) throw new RoomEvolutionLedgerError("invalid_input", label + " must not contain duplicates");
    seen.add(value);
    values.push(value);
  }
  return immutableCopy(values);
}

function assertExactKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!isRecord(value)) throw new RoomEvolutionLedgerError("invalid_input", label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " has an unsupported shape");
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be a canonical identifier");
  }
}

function assertNullableIdentifier(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertIdentifier(value, label);
}

function assertNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be nonblank");
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be a positive safe integer");
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be boolean");
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new RoomEvolutionLedgerError("invalid_hash", label + " must be a lowercase SHA-256 digest");
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be canonical UTC ISO text");
  }
}

function assertOneOf<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
): asserts value is TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " is unsupported");
  }
}

function assertJsonObject(value: unknown, label: string): asserts value is RoomEvolutionJsonObjectV1 {
  if (!isRecord(value)) {
    throw new RoomEvolutionLedgerError("invalid_input", label + " must be a JSON object");
  }
  assertJsonValue(value, label);
}

function assertNonEmptyJsonObject(value: unknown, label: string): asserts value is RoomEvolutionJsonObjectV1 {
  assertJsonObject(value, label);
  if (Object.keys(value).length === 0) {
    throw new RoomEvolutionLedgerError("policy_violation", label + " must not be empty");
  }
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RoomEvolutionLedgerError("invalid_input", label + " has a non-finite JSON number");
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertJsonValue(entry, label + "[" + index + "]");
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, label + "." + key);
    return;
  }
  throw new RoomEvolutionLedgerError("invalid_input", label + " must contain JSON-compatible values");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReference(message: string): RoomEvolutionLedgerError {
  return new RoomEvolutionLedgerError("invalid_reference", message);
}

function immutableCopy<TValue>(value: TValue): TValue {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<TValue>(value: TValue, seen = new WeakSet<object>()): TValue {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HYPOTHESIS_STATES = [
  "proposed", "experimenting", "promoted", "rejected", "rolled_back", "inconclusive",
] as const satisfies readonly RoomEvolutionHypothesisStateV1[];
const RISK_CLASSES = ["low", "moderate", "high", "critical"] as const satisfies readonly RoomEvolutionRiskClassV1[];
const CANDIDATE_KINDS = [
  "prompt", "skill", "context", "task_decomposition", "protocol", "role_assignment", "model_routing",
  "retry_concurrency", "connector_adapter", "evaluation_rule", "source_code",
] as const satisfies readonly RoomEvolutionCandidateKindV1[];
const ISOLATION_KINDS = ["branch", "worktree", "versioned_policy_store"] as const satisfies readonly RoomEvolutionIsolationKindV1[];
const EXPERIMENT_STATES = [
  "planned", "running", "completed", "failed", "cancelled", "inconclusive",
] as const satisfies readonly RoomEvolutionExperimentStateV1[];
const CAPACITY_POOLS = ["evolution_low_priority", "evolution_paused"] as const satisfies readonly RoomEvolutionCapacityPoolV1[];
const BENCHMARK_CASE_KINDS = [
  "golden", "rolling_authorized", "adversarial", "historical_replay",
] as const satisfies readonly RoomEvolutionBenchmarkCaseKindV1[];
const EVALUATOR_KINDS = [
  "deterministic", "independent_reviewer", "producer_self_report",
] as const satisfies readonly RoomEvolutionEvaluatorKindV1[];
const TRUSTED_BINDING_PURPOSES = [
  "candidate_producer", "independent_evaluator",
] as const satisfies readonly RoomEvolutionTrustedBindingPurposeV1[];
const BENCHMARK_OUTCOMES = ["passed", "failed", "error", "inconclusive"] as const satisfies readonly RoomEvolutionBenchmarkOutcomeV1[];
const GATE_CLASSES = ["hard", "optimization"] as const satisfies readonly RoomEvolutionGateClassV1[];
const GATE_OUTCOMES = ["passed", "failed", "error", "not_run"] as const satisfies readonly RoomEvolutionGateOutcomeV1[];
const CANARY_STATES = [
  "planned", "running", "paused", "succeeded", "failed", "rolled_back", "cancelled",
] as const satisfies readonly RoomEvolutionCanaryStateV1[];
const PROMOTION_DECISIONS = [
  "promoted", "rejected", "inconclusive", "rollback_required",
] as const satisfies readonly RoomEvolutionPersistedPromotionDecisionV1[];
const AUTHORITY_TIERS = [
  "automatic_pre_authorized", "independent", "human",
] as const satisfies readonly RoomEvolutionAuthorityTierV1[];
const ROLLBACK_TRIGGERS = ["automatic", "operator"] as const satisfies readonly RoomEvolutionRollbackTriggerV1[];
const SIGNAL_KINDS = [
  "failure", "correction", "confidence", "retry", "dissent", "quality", "stability", "utilization", "latency",
] as const satisfies readonly RoomEvolutionSignalKindV1[];
const EVIDENCE_SOURCES = [
  "deterministic_gate", "human_correction", "durable_room_ledger", "independent_review",
  "authorized_observed_outcome", "room_metric",
] as const satisfies readonly RoomEvolutionEvidenceSourceV1[];
