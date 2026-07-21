import {
  evaluateRoomEvolutionRiskTier,
  evaluateRoomEvolutionPromotion,
  hashRoomValue,
  type AppendRoomEvolutionPromotionDecisionInputV1 as AppendCorePromotionDecisionInputV1,
  type AsyncRoomEvolutionLedger,
  type RoomEvolutionAuthorityTierV1,
  type RoomEvolutionChangeSurfaceV1,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionJsonObjectV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionPersistedPromotionDecisionV1,
  type RoomEvolutionPromotionDecisionRecordV1,
  type RoomEvolutionRiskClassV1,
  type RoomEvolutionRiskTierGateV1,
} from "@fusion/core";

import type {
  AppendRoomEvolutionPromotionDecisionInputV1,
  RoomEvolutionPromotionCommandIdentityV1,
  RoomEvolutionPromotionDecisionLedgerPortV1,
  RoomEvolutionPromotionDecisionLedgerRecordV1,
  RoomEvolutionPromotionDurableDecisionV1,
} from "./room-evolution-promotion-commit-coordinator.js";

export const ROOM_EVOLUTION_PROMOTION_LEDGER_ADAPTER_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionPromotionContextSnapshotV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_PROMOTION_LEDGER_ADAPTER_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly proposalId: string;
  readonly candidateHash: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly canaryId: string | null;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly riskClass: RoomEvolutionRiskClassV1;
  readonly changeSurfaces: readonly RoomEvolutionChangeSurfaceV1[];
  readonly autoPromotionPreAuthorized: boolean;
  readonly hardGates: readonly RoomEvolutionRiskTierGateV1[];
  readonly authorityTier: RoomEvolutionAuthorityTierV1;
  readonly candidateProducerActorId: string;
  readonly decisionActorId: string;
  readonly approvalRequestId: string | null;
  readonly authorizationEvidence: RoomEvolutionJsonObjectV1;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
}

export interface RoomEvolutionPromotionContextReaderV1 {
  readPromotionContext(input: {
    readonly command: RoomEvolutionPromotionCommandIdentityV1;
    readonly decision: RoomEvolutionPromotionDurableDecisionV1;
    readonly evaluation: AppendRoomEvolutionPromotionDecisionInputV1["evaluation"];
  }): Promise<RoomEvolutionPromotionContextSnapshotV1 | null>;
}

export type RoomEvolutionPromotionDecisionLedgerV1 = Pick<AsyncRoomEvolutionLedger, "appendPromotionDecision">;

export interface RoomEvolutionPromotionLedgerAdapterDependenciesV1 {
  readonly contextReader: RoomEvolutionPromotionContextReaderV1;
  readonly ledger: RoomEvolutionPromotionDecisionLedgerV1;
}

export type RoomEvolutionPromotionLedgerAdapterErrorCodeV1 =
  | "invalid_input"
  | "context_snapshot_unavailable"
  | "context_snapshot_invalid"
  | "self_acceptance_forbidden"
  | "high_risk_authorization_required"
  | "risk_policy_withheld"
  | "promotion_lineage_missing"
  | "ledger_response_invalid";

export class RoomEvolutionPromotionLedgerAdapterError extends Error {
  public constructor(
    readonly code: RoomEvolutionPromotionLedgerAdapterErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionPromotionLedgerAdapterError";
  }
}

export class RoomEvolutionPromotionLedgerAdapter implements RoomEvolutionPromotionDecisionLedgerPortV1 {
  public constructor(
    private readonly dependencies: RoomEvolutionPromotionLedgerAdapterDependenciesV1,
  ) {}

  public async appendDecision(
    input: AppendRoomEvolutionPromotionDecisionInputV1,
  ): Promise<RoomEvolutionPromotionDecisionLedgerRecordV1> {
    const normalized = normalizeInput(input);
    const context = await this.requireContextReader().readPromotionContext({
      command: normalized.command,
      decision: normalized.decision,
      evaluation: normalized.evaluation,
    });
    if (context === null) {
      throw new RoomEvolutionPromotionLedgerAdapterError(
        "context_snapshot_unavailable",
        `No immutable promotion context was available for decision ${normalized.decision.id}.`,
      );
    }
    const appendInput = deriveAppendInput(normalized, context);
    const appended = await this.requireLedger().appendPromotionDecision(appendInput);
    assertAppendResult(appended, appendInput);
    return freeze({ recordId: appendInput.id, decisionId: appendInput.id, replayed: false });
  }

  private requireContextReader(): RoomEvolutionPromotionContextReaderV1 {
    const reader = this.dependencies?.contextReader;
    if (reader === undefined || typeof reader.readPromotionContext !== "function") {
      throw new RoomEvolutionPromotionLedgerAdapterError(
        "invalid_input",
        "Room evolution promotion ledger adapter requires a promotion context reader.",
      );
    }
    return reader;
  }

  private requireLedger(): RoomEvolutionPromotionDecisionLedgerV1 {
    const ledger = this.dependencies?.ledger;
    if (ledger === undefined || typeof ledger.appendPromotionDecision !== "function") {
      throw new RoomEvolutionPromotionLedgerAdapterError(
        "invalid_input",
        "Room evolution promotion ledger adapter requires an immutable promotion decision ledger.",
      );
    }
    return ledger;
  }
}

function normalizeInput(
  input: AppendRoomEvolutionPromotionDecisionInputV1,
): AppendRoomEvolutionPromotionDecisionInputV1 {
  if (!isRecord(input) || !isCommand(input.command) || !isDecision(input.decision) || !isEvaluation(input.evaluation)) {
    throw new RoomEvolutionPromotionLedgerAdapterError("invalid_input", "Promotion decision append input is invalid.");
  }
  if (
    input.decision.proposalId !== input.evaluation.proposal.id
    || input.decision.candidateHash !== input.evaluation.proposal.candidateHash
  ) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "invalid_input",
      "Promotion decision must bind the exact evaluated proposal and candidate hash.",
    );
  }
  const evaluated = evaluateRoomEvolutionPromotion(input.evaluation);
  const expectedOutcome = outcomeForEvaluation(evaluated);
  if (
    input.decision.outcome !== expectedOutcome
    || input.decision.runtimeAction !== evaluated.requiredRuntimeAction
    || input.decision.evaluationPath !== evaluated.evaluationPath
    || input.decision.evaluatedAt !== input.evaluation.evaluatedAt
    || hashRoomValue(input.decision.blockers) !== hashRoomValue(evaluated.blockers)
  ) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "invalid_input",
      "Promotion decision does not exactly match the deterministic evaluation result.",
    );
  }
  return freeze({
    command: freeze({ ...input.command }),
    decision: freeze({ ...input.decision, blockers: freeze([...input.decision.blockers].map((blocker) => freeze({ ...blocker }))) }),
    evaluation: freeze(structuredClone(input.evaluation)),
  });
}

function deriveAppendInput(
  input: AppendRoomEvolutionPromotionDecisionInputV1,
  context: RoomEvolutionPromotionContextSnapshotV1,
): AppendCorePromotionDecisionInputV1 {
  assertContext(context, input);
  if (context.decisionActorId === context.candidateProducerActorId) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "self_acceptance_forbidden",
      "Candidate producer cannot authoritatively append its own evolution promotion decision.",
    );
  }
  if (input.decision.outcome === "promoted") {
    const riskDecision = evaluateRoomEvolutionRiskTier({
      contractVersion: 1,
      candidate: {
        id: context.candidateVersionId,
        producerActorId: context.candidateProducerActorId,
        riskClass: context.riskClass,
        changeSurfaces: context.changeSurfaces,
        autoPromotionPreAuthorized: context.autoPromotionPreAuthorized,
      },
      hardGates: context.hardGates,
      requestedAuthority: {
        tier: context.authorityTier,
        actorId: context.decisionActorId,
        approvalRequestId: context.approvalRequestId,
        evaluatedAt: input.decision.evaluatedAt,
      },
    });
    if (!riskDecision.allowed) {
      throw new RoomEvolutionPromotionLedgerAdapterError(
        "risk_policy_withheld",
        `Risk-tier policy withheld promotion: ${riskDecision.blockers.map((entry) => entry.code).join(",")}.`,
      );
    }
  }
  if (
    (context.riskClass === "high" || context.riskClass === "critical")
    && (context.authorityTier !== "human" || context.approvalRequestId === null)
  ) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "high_risk_authorization_required",
      "High-risk evolution decisions require a human authority and durable approval request.",
    );
  }
  if (
    input.decision.outcome === "promoted"
    && (context.canaryId === null || context.rollbackTargetCandidateVersionId === null)
  ) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "promotion_lineage_missing",
      "A promotion decision requires an immutable canary and rollback target lineage.",
    );
  }
  const scope = copyScope(context.scope);
  const evidence = copyEvidence(context.evidence);
  return freeze({
    scope,
    id: input.decision.id,
    experimentId: context.experimentId,
    candidateVersionId: context.candidateVersionId,
    canaryId: context.canaryId,
    decision: mapDecision(input.decision.outcome),
    riskClass: context.riskClass,
    authorityTier: context.authorityTier,
    candidateProducerActorId: context.candidateProducerActorId,
    decisionActorId: context.decisionActorId,
    approvalRequestId: context.approvalRequestId,
    authorizationEvidence: freeze(structuredClone(context.authorizationEvidence)),
    evidence,
    evidenceHash: hashRoomValue({ id: input.decision.id, scope, evidence }),
    rollbackTargetCandidateVersionId: context.rollbackTargetCandidateVersionId,
    decidedAt: input.decision.evaluatedAt,
  });
}

function assertContext(
  context: RoomEvolutionPromotionContextSnapshotV1,
  input: AppendRoomEvolutionPromotionDecisionInputV1,
): void {
  if (
    !isRecord(context)
    || context.contractVersion !== ROOM_EVOLUTION_PROMOTION_LEDGER_ADAPTER_CONTRACT_VERSION
    || !isScope(context.scope)
    || !isIdentifier(context.proposalId)
    || !isHash(context.candidateHash)
    || !isIdentifier(context.experimentId)
    || !isIdentifier(context.candidateVersionId)
    || (context.canaryId !== null && !isIdentifier(context.canaryId))
    || (context.rollbackTargetCandidateVersionId !== null && !isIdentifier(context.rollbackTargetCandidateVersionId))
    || !isRiskClass(context.riskClass)
    || !isRiskTierContext(context)
    || !isAuthorityTier(context.authorityTier)
    || !isIdentifier(context.candidateProducerActorId)
    || !isIdentifier(context.decisionActorId)
    || (context.approvalRequestId !== null && !isIdentifier(context.approvalRequestId))
    || !isJsonObject(context.authorizationEvidence)
    || !isEvidence(context.evidence)
  ) {
    throw invalidContext("Promotion context snapshot is malformed.");
  }
  if (
    context.proposalId !== input.decision.proposalId
    || context.proposalId !== input.evaluation.proposal.id
    || context.candidateHash !== input.decision.candidateHash
    || context.candidateHash !== input.evaluation.proposal.candidateHash
  ) {
    throw invalidContext("Promotion context snapshot does not bind the exact proposal and candidate hash.");
  }
  if (input.evaluation.canary !== null && context.canaryId !== input.evaluation.canary.canaryId) {
    throw invalidContext("Promotion context snapshot does not bind the exact evaluated durable canary.");
  }
}

function assertAppendResult(
  appended: RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1>,
  expected: AppendCorePromotionDecisionInputV1,
): void {
  if (
    !isRecord(appended)
    || appended.table !== "room_evolution_promotion_decisions"
    || !isRecord(appended.record)
    || appended.record.id !== expected.id
    || appended.record.projectId !== expected.scope.projectId
    || appended.record.roomId !== expected.scope.roomId
    || appended.record.scopeKind !== expected.scope.scopeKind
    || appended.record.scopeKey !== expected.scope.scopeKey
    || appended.record.experimentId !== expected.experimentId
    || appended.record.candidateVersionId !== expected.candidateVersionId
    || appended.record.canaryId !== expected.canaryId
    || appended.record.decision !== expected.decision
    || appended.record.riskClass !== expected.riskClass
    || appended.record.authorityTier !== expected.authorityTier
    || appended.record.candidateProducerActorId !== expected.candidateProducerActorId
    || appended.record.decisionActorId !== expected.decisionActorId
    || appended.record.approvalRequestId !== expected.approvalRequestId
    || appended.record.evidenceHash !== expected.evidenceHash
    || appended.record.rollbackTargetCandidateVersionId !== expected.rollbackTargetCandidateVersionId
    || appended.record.decidedAt !== expected.decidedAt
    || hashRoomValue(appended.record.authorizationEvidence) !== hashRoomValue(expected.authorizationEvidence)
    || hashRoomValue(appended.record.evidence) !== hashRoomValue(expected.evidence)
  ) {
    throw new RoomEvolutionPromotionLedgerAdapterError(
      "ledger_response_invalid",
      "Core promotion decision ledger did not acknowledge the exact immutable append.",
    );
  }
}

function mapDecision(
  outcome: RoomEvolutionPromotionDurableDecisionV1["outcome"],
): RoomEvolutionPersistedPromotionDecisionV1 {
  switch (outcome) {
    case "promoted": return "promoted";
    case "rejected": return "rejected";
    case "rolled_back": return "rollback_required";
    case "inconclusive": return "inconclusive";
  }
}

function outcomeForEvaluation(
  evaluation: ReturnType<typeof evaluateRoomEvolutionPromotion>,
): RoomEvolutionPromotionDurableDecisionV1["outcome"] {
  if (evaluation.requiredRuntimeAction === "promote_candidate") return "promoted";
  if (evaluation.requiredRuntimeAction === "rollback_candidate") return "rolled_back";
  return evaluation.evaluationPath === "hard_gate_blocked" ? "rejected" : "inconclusive";
}

function copyScope(scope: RoomEvolutionLedgerScope): RoomEvolutionLedgerScope {
  return freeze({
    projectId: scope.projectId,
    roomId: scope.roomId,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
  });
}

function copyEvidence(evidence: readonly RoomEvolutionEvidenceRefV1[]): readonly RoomEvolutionEvidenceRefV1[] {
  return freeze(evidence.map((entry) => freeze({ ...entry })));
}

function isCommand(value: unknown): value is RoomEvolutionPromotionCommandIdentityV1 {
  return isRecord(value)
    && isIdentifier(value.commandId)
    && isIdentifier(value.idempotencyKey)
    && isIdentifier(value.correlationId)
    && (value.causationId === null || isIdentifier(value.causationId));
}

function isDecision(value: unknown): value is RoomEvolutionPromotionDurableDecisionV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isIdentifier(value.id)
    && isIdentifier(value.proposalId)
    && isHash(value.candidateHash)
    && (value.outcome === "promoted" || value.outcome === "rejected" || value.outcome === "rolled_back" || value.outcome === "inconclusive")
    && (value.runtimeAction === "none" || value.runtimeAction === "promote_candidate" || value.runtimeAction === "rollback_candidate")
    && (value.evaluationPath === "hard_gate_blocked" || value.evaluationPath === "canary_blocked" || value.evaluationPath === "eligible")
    && Array.isArray(value.blockers)
    && isTimestamp(value.evaluatedAt);
}

function isEvaluation(value: unknown): value is AppendRoomEvolutionPromotionDecisionInputV1["evaluation"] {
  return isRecord(value)
    && value.contractVersion === 1
    && isRecord(value.proposal)
    && isIdentifier(value.proposal.id)
    && isHash(value.proposal.candidateHash)
    && isTimestamp(value.evaluatedAt);
}

function isScope(value: unknown): value is RoomEvolutionLedgerScope {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && (value.roomId === null || isIdentifier(value.roomId))
    && (value.scopeKind === "project" || value.scopeKind === "room")
    && isIdentifier(value.scopeKey);
}

function isEvidence(value: unknown): value is readonly RoomEvolutionEvidenceRefV1[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !isIdentifier(entry.id)
      || ids.has(entry.id)
      || !isEvidenceSource(entry.source)
      || !isIdentifier(entry.sourceRef)
      || !isHash(entry.evidenceHash)
      || !isTimestamp(entry.observedAt)
    ) return false;
    ids.add(entry.id);
  }
  return true;
}

function isEvidenceSource(value: unknown): value is RoomEvolutionEvidenceRefV1["source"] {
  return value === "deterministic_gate"
    || value === "human_correction"
    || value === "durable_room_ledger"
    || value === "independent_review"
    || value === "authorized_observed_outcome"
    || value === "room_metric";
}

function isRiskClass(value: unknown): value is RoomEvolutionRiskClassV1 {
  return value === "low" || value === "moderate" || value === "high" || value === "critical";
}

function isRiskTierContext(value: RoomEvolutionPromotionContextSnapshotV1): boolean {
  return Array.isArray(value.changeSurfaces)
    && value.changeSurfaces.length > 0
    && value.changeSurfaces.every(isChangeSurface)
    && new Set(value.changeSurfaces).size === value.changeSurfaces.length
    && typeof value.autoPromotionPreAuthorized === "boolean"
    && Array.isArray(value.hardGates)
    && value.hardGates.every(isRiskTierGate);
}

function isChangeSurface(value: unknown): value is RoomEvolutionChangeSurfaceV1 {
  return value === "policy"
    || value === "prompt"
    || value === "skill"
    || value === "context"
    || value === "task_decomposition"
    || value === "role_assignment"
    || value === "model_routing"
    || value === "retry_concurrency"
    || value === "connector_adapter"
    || value === "evaluation_rule"
    || value === "source"
    || value === "permission"
    || value === "authentication"
    || value === "network"
    || value === "destructive_action"
    || value === "evaluator";
}

function isRiskTierGate(value: unknown): value is RoomEvolutionRiskTierGateV1 {
  return isRecord(value)
    && isRiskTierGateClass(value.gateClass)
    && (value.outcome === "passed" || value.outcome === "failed" || value.outcome === "not_run" || value.outcome === "error")
    && isIdentifier(value.evaluatorActorId);
}

function isRiskTierGateClass(value: unknown): value is RoomEvolutionRiskTierGateV1["gateClass"] {
  return value === "correctness"
    || value === "security"
    || value === "user_constraints"
    || value === "evidence_integrity"
    || value === "regression"
    || value === "independent_security_review"
    || value === "independent_runtime_validation"
    || value === "rollback_lineage";
}

function isAuthorityTier(value: unknown): value is RoomEvolutionAuthorityTierV1 {
  return value === "automatic_pre_authorized" || value === "independent" || value === "human";
}

function isJsonObject(value: unknown): value is RoomEvolutionJsonObjectV1 {
  return isRecord(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidContext(message: string): RoomEvolutionPromotionLedgerAdapterError {
  return new RoomEvolutionPromotionLedgerAdapterError("context_snapshot_invalid", message);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}
