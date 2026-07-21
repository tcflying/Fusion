import {
  evaluateRoomEvolutionCanary,
  hashRoomValue,
  type AppendRoomEvolutionCanaryObservationInputV1,
  type AppendRoomEvolutionPromotionDecisionInputV1,
  type AppendRoomEvolutionRollbackInputV1,
  type EvaluateRoomEvolutionCanaryInputV1,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionRiskClassV1,
} from "@fusion/core";

export const ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionCanaryRollbackRuntimeRequestV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly canaryId: string;
  readonly expectedCandidateVersionId: string;
  readonly targetVersionId: string;
  readonly roomIds: readonly string[];
  readonly turnBoundaryOnly: true;
}

export interface RoomEvolutionCanaryRollbackRuntimeReceiptV1 {
  readonly status: "rolled_back";
  readonly canaryId: string;
  readonly targetVersionId: string;
  readonly roomIds: readonly string[];
  readonly completedAt: string;
}

export interface RoomEvolutionCanaryRollbackRuntimePortV1 {
  rollback(
    input: RoomEvolutionCanaryRollbackRuntimeRequestV1,
  ): Promise<RoomEvolutionCanaryRollbackRuntimeReceiptV1>;
}

export interface RoomEvolutionCanaryRollbackLedgerPortV1 {
  appendCanaryObservation(
    input: AppendRoomEvolutionCanaryObservationInputV1,
  ): Promise<{ readonly table: "room_evolution_canary_observations"; readonly record: { readonly id: string } }>;
  appendPromotionDecision(
    input: AppendRoomEvolutionPromotionDecisionInputV1,
  ): Promise<{ readonly table: "room_evolution_promotion_decisions"; readonly record: { readonly id: string } }>;
  appendRollback(
    input: AppendRoomEvolutionRollbackInputV1,
  ): Promise<{ readonly table: "room_evolution_rollbacks"; readonly record: { readonly id: string } }>;
}

export interface RoomEvolutionCanaryRollbackCoordinatorDependenciesV1 {
  readonly ledger: RoomEvolutionCanaryRollbackLedgerPortV1;
  readonly runtime: RoomEvolutionCanaryRollbackRuntimePortV1;
}

export interface EvaluateAndRollbackRoomEvolutionCanaryInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly experimentId: string;
  readonly canaryId: string;
  readonly promotionDecisionId: string;
  readonly rollbackId: string;
  readonly candidateProducerActorId: string;
  readonly decisionActorId: string;
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly authorityTier: "automatic_pre_authorized" | "independent" | "human";
  readonly approvalRequestId: string | null;
  readonly authorizationEvidence: Readonly<Record<string, unknown>>;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly evaluation: EvaluateRoomEvolutionCanaryInputV1;
}

export type RoomEvolutionCanaryRollbackCoordinatorResultV1 =
  | { readonly status: "withheld"; readonly reason: string }
  | { readonly status: "evaluation_withheld"; readonly reason: string }
  | { readonly status: "promotion_eligible"; readonly allocationId: string }
  | {
    readonly status: "persistence_failed";
    readonly stage: "observation" | "decision" | "rollback_history";
    readonly reason: string;
  }
  | {
    readonly status: "rollback_execution_failed";
    readonly rollback: { readonly targetVersionId: string; readonly roomIds: readonly string[] };
    readonly reason: string;
  }
  | {
    readonly status: "rolled_back";
    readonly rollback: { readonly targetVersionId: string; readonly roomIds: readonly string[]; readonly executedAt: string };
  };

export class RoomEvolutionCanaryRollbackCoordinator {
  public constructor(
    private readonly dependencies: RoomEvolutionCanaryRollbackCoordinatorDependenciesV1,
  ) {}

  public async evaluateAndRollback(
    rawInput: EvaluateAndRollbackRoomEvolutionCanaryInputV1,
  ): Promise<RoomEvolutionCanaryRollbackCoordinatorResultV1> {
    const input = validateInput(rawInput);
    if (input === null) return freeze({ status: "withheld" as const, reason: "invalid_request" });
    if (!isLedgerPort(this.dependencies?.ledger) || !isRuntimePort(this.dependencies?.runtime)) {
      return freeze({ status: "withheld" as const, reason: "required_port_unavailable" });
    }

    const evaluation = evaluateRoomEvolutionCanary(input.evaluation);
    if (!evaluation.ok) return freeze({ status: "evaluation_withheld" as const, reason: evaluation.reason.code });
    if (evaluation.status === "eligible_for_independent_promotion") {
      return freeze({ status: "promotion_eligible" as const, allocationId: evaluation.allocationId });
    }

    const evidenceHash = hashRoomValue({ canaryId: input.canaryId, evidence: input.evidence });
    const observation = buildObservation(input, evidenceHash, evaluation.rollback);
    const observationResult = await appendObservation(this.dependencies.ledger, observation);
    if (observationResult !== null) return observationResult;

    const decision = buildRollbackDecision(input, evidenceHash, evaluation.rollback);
    const decisionResult = await appendDecision(this.dependencies.ledger, decision);
    if (decisionResult !== null) return decisionResult;

    const runtimeRequest = freeze({
      contractVersion: ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION,
      scope: cloneScope(input.scope),
      canaryId: input.canaryId,
      expectedCandidateVersionId: input.evaluation.allocation.candidateVersionId,
      targetVersionId: evaluation.rollback.targetVersionId,
      roomIds: freeze([...evaluation.rollback.roomIds]),
      turnBoundaryOnly: true as const,
    });
    let runtimeReceipt: RoomEvolutionCanaryRollbackRuntimeReceiptV1;
    try {
      runtimeReceipt = await this.dependencies.runtime.rollback(runtimeRequest);
    } catch (error) {
      return rollbackExecutionFailed(evaluation.rollback.targetVersionId, evaluation.rollback.roomIds, messageOf(error));
    }
    if (!isMatchingRuntimeReceipt(runtimeReceipt, runtimeRequest)) {
      return rollbackExecutionFailed(
        evaluation.rollback.targetVersionId,
        evaluation.rollback.roomIds,
        "runtime_receipt_invalid",
      );
    }

    const rollback = buildRollback(input, evidenceHash, evaluation.rollback, runtimeReceipt.completedAt);
    const rollbackResult = await appendRollback(this.dependencies.ledger, rollback);
    if (rollbackResult !== null) return rollbackResult;
    return freeze({
      status: "rolled_back" as const,
      rollback: freeze({
        targetVersionId: evaluation.rollback.targetVersionId,
        roomIds: freeze([...evaluation.rollback.roomIds]),
        executedAt: runtimeReceipt.completedAt,
      }),
    });
  }
}

function validateInput(value: unknown): EvaluateAndRollbackRoomEvolutionCanaryInputV1 | null {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION) return null;
  const input = value as unknown as EvaluateAndRollbackRoomEvolutionCanaryInputV1;
  if (!isScope(input.scope) || !isIdentifier(input.experimentId) || !isIdentifier(input.canaryId)
    || !isIdentifier(input.promotionDecisionId) || !isIdentifier(input.rollbackId)
    || !isIdentifier(input.candidateProducerActorId) || !isIdentifier(input.decisionActorId)
    || input.candidateProducerActorId === input.decisionActorId || !isRiskClass(input.riskClass)
    || !isAuthorityTier(input.authorityTier) || !isOptionalIdentifier(input.approvalRequestId)
    || !isRecord(input.authorizationEvidence) || !isEvidence(input.evidence) || !isEvaluation(input.evaluation)) return null;
  if (input.scope.projectId !== input.evaluation.allocation.projectId) return null;
  if ((input.riskClass === "high" || input.riskClass === "critical")
    && (input.authorityTier !== "human" || input.approvalRequestId === null)) return null;
  return input;
}

function buildObservation(
  input: EvaluateAndRollbackRoomEvolutionCanaryInputV1,
  evidenceHash: string,
  rollback: { readonly allocationId: string; readonly targetVersionId: string; readonly roomIds: readonly string[]; readonly evaluatedAt: string; readonly reasons: readonly string[] },
): AppendRoomEvolutionCanaryObservationInputV1 {
  return freeze({
    scope: cloneScope(input.scope),
    id: `${input.canaryId}:degradation`,
    canaryId: input.canaryId,
    metricName: "canary_degradation",
    metricValue: freeze({ allocationId: rollback.allocationId, reasons: freeze([...rollback.reasons]) }),
    threshold: freeze({ targetVersionId: rollback.targetVersionId, objectiveCount: rollback.reasons.length }),
    breached: true,
    evidence: cloneEvidence(input.evidence),
    evidenceHash,
    observedAt: rollback.evaluatedAt,
  });
}

function buildRollbackDecision(
  input: EvaluateAndRollbackRoomEvolutionCanaryInputV1,
  evidenceHash: string,
  rollback: { readonly targetVersionId: string; readonly evaluatedAt: string; readonly reasons: readonly string[] },
): AppendRoomEvolutionPromotionDecisionInputV1 {
  return freeze({
    scope: cloneScope(input.scope),
    id: input.promotionDecisionId,
    experimentId: input.experimentId,
    candidateVersionId: input.evaluation.allocation.candidateVersionId,
    canaryId: input.canaryId,
    decision: "rollback_required",
    riskClass: input.riskClass,
    authorityTier: input.authorityTier,
    candidateProducerActorId: input.candidateProducerActorId,
    decisionActorId: input.decisionActorId,
    approvalRequestId: input.approvalRequestId,
    authorizationEvidence: freeze({
      ...input.authorizationEvidence,
      canaryAllocationId: input.evaluation.allocation.id,
      degradationReasons: freeze([...rollback.reasons]),
    }),
    evidence: cloneEvidence(input.evidence),
    evidenceHash,
    rollbackTargetCandidateVersionId: rollback.targetVersionId,
    decidedAt: rollback.evaluatedAt,
  });
}

function buildRollback(
  input: EvaluateAndRollbackRoomEvolutionCanaryInputV1,
  evidenceHash: string,
  rollback: { readonly targetVersionId: string; readonly reasons: readonly string[] },
  executedAt: string,
): AppendRoomEvolutionRollbackInputV1 {
  return freeze({
    scope: cloneScope(input.scope),
    id: input.rollbackId,
    promotionDecisionId: input.promotionDecisionId,
    canaryId: input.canaryId,
    fromCandidateVersionId: input.evaluation.allocation.candidateVersionId,
    toCandidateVersionId: rollback.targetVersionId,
    triggerKind: "automatic",
    reason: rollback.reasons.join(";"),
    evidence: cloneEvidence(input.evidence),
    evidenceHash,
    executedAt,
  });
}

async function appendObservation(
  ledger: RoomEvolutionCanaryRollbackLedgerPortV1,
  input: AppendRoomEvolutionCanaryObservationInputV1,
): Promise<RoomEvolutionCanaryRollbackCoordinatorResultV1 | null> {
  try {
    const result = await ledger.appendCanaryObservation(input);
    if (result.table !== "room_evolution_canary_observations" || result.record.id !== input.id) {
      return persistenceFailed("observation", "ledger_response_invalid");
    }
    return null;
  } catch (error) {
    return persistenceFailed("observation", messageOf(error));
  }
}

async function appendDecision(
  ledger: RoomEvolutionCanaryRollbackLedgerPortV1,
  input: AppendRoomEvolutionPromotionDecisionInputV1,
): Promise<RoomEvolutionCanaryRollbackCoordinatorResultV1 | null> {
  try {
    const result = await ledger.appendPromotionDecision(input);
    if (result.table !== "room_evolution_promotion_decisions" || result.record.id !== input.id) {
      return persistenceFailed("decision", "ledger_response_invalid");
    }
    return null;
  } catch (error) {
    return persistenceFailed("decision", messageOf(error));
  }
}

async function appendRollback(
  ledger: RoomEvolutionCanaryRollbackLedgerPortV1,
  input: AppendRoomEvolutionRollbackInputV1,
): Promise<RoomEvolutionCanaryRollbackCoordinatorResultV1 | null> {
  try {
    const result = await ledger.appendRollback(input);
    if (result.table !== "room_evolution_rollbacks" || result.record.id !== input.id) {
      return persistenceFailed("rollback_history", "ledger_response_invalid");
    }
    return null;
  } catch (error) {
    return persistenceFailed("rollback_history", messageOf(error));
  }
}

function isMatchingRuntimeReceipt(
  value: unknown,
  expected: RoomEvolutionCanaryRollbackRuntimeRequestV1,
): value is RoomEvolutionCanaryRollbackRuntimeReceiptV1 {
  return isRecord(value)
    && value.status === "rolled_back"
    && value.canaryId === expected.canaryId
    && value.targetVersionId === expected.targetVersionId
    && sameStringSet(value.roomIds, expected.roomIds)
    && isUtcTimestamp(value.completedAt);
}

function isLedgerPort(value: unknown): value is RoomEvolutionCanaryRollbackLedgerPortV1 {
  return isRecord(value)
    && typeof value.appendCanaryObservation === "function"
    && typeof value.appendPromotionDecision === "function"
    && typeof value.appendRollback === "function";
}

function isRuntimePort(value: unknown): value is RoomEvolutionCanaryRollbackRuntimePortV1 {
  return isRecord(value) && typeof value.rollback === "function";
}

function isEvaluation(value: unknown): value is EvaluateRoomEvolutionCanaryInputV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isRecord(value.allocation)
    && isIdentifier(value.allocation.id)
    && isIdentifier(value.allocation.projectId)
    && isIdentifier(value.allocation.candidateVersionId)
    && isIdentifier(value.allocation.rollbackTargetVersionId)
    && Array.isArray(value.allocation.roomIds)
    && value.allocation.roomIds.every(isIdentifier)
    && isUtcTimestamp(value.evaluatedAt)
    && Array.isArray(value.roomOutcomes);
}

function isScope(value: unknown): value is RoomEvolutionLedgerScope {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && (value.roomId === null || isIdentifier(value.roomId))
    && (value.scopeKind === "project" || value.scopeKind === "room")
    && isIdentifier(value.scopeKey);
}

function isEvidence(value: unknown): value is readonly RoomEvolutionEvidenceRefV1[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => isRecord(entry)
      && isIdentifier(entry.id)
      && typeof entry.source === "string"
      && typeof entry.sourceRef === "string" && entry.sourceRef.length > 0
      && isHash(entry.evidenceHash)
      && isUtcTimestamp(entry.observedAt));
}

function isRiskClass(value: unknown): value is RoomEvolutionRiskClassV1 {
  return value === "low" || value === "moderate" || value === "high" || value === "critical";
}

function isAuthorityTier(value: unknown): value is "automatic_pre_authorized" | "independent" | "human" {
  return value === "automatic_pre_authorized" || value === "independent" || value === "human";
}

function isOptionalIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every(isIdentifier)
    && new Set(value).size === value.length
    && value.every((entry) => expected.includes(entry));
}

function cloneScope(value: RoomEvolutionLedgerScope): RoomEvolutionLedgerScope {
  return freeze({ ...value });
}

function cloneEvidence(value: readonly RoomEvolutionEvidenceRefV1[]): readonly RoomEvolutionEvidenceRefV1[] {
  return freeze(value.map((entry) => freeze({ ...entry })));
}

function persistenceFailed(
  stage: "observation" | "decision" | "rollback_history",
  reason: string,
): RoomEvolutionCanaryRollbackCoordinatorResultV1 {
  return freeze({ status: "persistence_failed" as const, stage, reason });
}

function rollbackExecutionFailed(
  targetVersionId: string,
  roomIds: readonly string[],
  reason: string,
): RoomEvolutionCanaryRollbackCoordinatorResultV1 {
  return freeze({
    status: "rollback_execution_failed" as const,
    rollback: freeze({ targetVersionId, roomIds: freeze([...roomIds]) }),
    reason,
  });
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
