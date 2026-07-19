import {
  compareRoomText,
  type AppendRoomPromotionInputV1,
  type AsyncRoomEvidenceLedger,
  type RoomEvidenceLedgerAppendResult,
  type RoomEvidenceLedgerCandidateEvaluation,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceRecordV1,
  type RoomPromotionRecordV1,
} from "@fusion/core";

import type {
  AppendRoomIndependentArbitrationDecisionInputV1,
  RoomIndependentArbitrationCommandIdentityV1,
  RoomIndependentArbitrationDecisionLedgerPortV1,
  RoomIndependentArbitrationDecisionLedgerRecordV1,
  RoomIndependentArbitrationDecisionV1,
} from "./room-independent-arbitration-coordinator.js";

export const ROOM_INDEPENDENT_ARBITRATION_LEDGER_ADAPTER_CONTRACT_VERSION = 1 as const;

export interface RoomIndependentArbitrationPromotionEvidenceSnapshotV1 {
  readonly contractVersion: typeof ROOM_INDEPENDENT_ARBITRATION_LEDGER_ADAPTER_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly nodeId: AppendRoomPromotionInputV1["nodeId"];
  readonly candidateId: AppendRoomPromotionInputV1["candidateId"];
  readonly evaluation: RoomEvidenceLedgerCandidateEvaluation;
  readonly evidence: readonly RoomEvidenceRecordV1[];
}

export interface RoomIndependentArbitrationPromotionEvidenceReaderV1 {
  readPromotionEvidence(input: {
    readonly command: RoomIndependentArbitrationCommandIdentityV1;
    readonly decision: RoomIndependentArbitrationDecisionV1;
    readonly candidateId: AppendRoomPromotionInputV1["candidateId"];
  }): Promise<RoomIndependentArbitrationPromotionEvidenceSnapshotV1 | null>;
}

export type RoomIndependentArbitrationPromotionLedgerV1 = Pick<
  AsyncRoomEvidenceLedger,
  "appendPromotion"
>;

export interface RoomIndependentArbitrationLedgerAdapterDependenciesV1 {
  readonly evidenceReader: RoomIndependentArbitrationPromotionEvidenceReaderV1;
  readonly ledger: RoomIndependentArbitrationPromotionLedgerV1;
}

export type RoomIndependentArbitrationLedgerAdapterErrorCodeV1 =
  | "invalid_input"
  | "non_promotable_decision"
  | "candidate_target_ambiguous"
  | "evidence_snapshot_unavailable"
  | "evidence_snapshot_invalid"
  | "ledger_response_invalid";

export class RoomIndependentArbitrationLedgerAdapterError extends Error {
  public constructor(
    readonly code: RoomIndependentArbitrationLedgerAdapterErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomIndependentArbitrationLedgerAdapterError";
  }
}

/*
FNXC:RoomIndependentArbitrationLedger 2026-07-19-13:32:
OpenSpec 7.4 requires arbitration to remain independent from production and to
write only an immutable, evidence-bound promotion. This adapter re-reads the
candidate's durable evidence through DI, preserves the arbiter identity, and
delegates the final hard-gate, review-independence, dissent, and overwrite
checks to Core's AsyncRoomEvidenceLedger instead of manufacturing acceptance.
*/
export class RoomIndependentArbitrationLedgerAdapter implements RoomIndependentArbitrationDecisionLedgerPortV1 {
  public constructor(
    private readonly dependencies: RoomIndependentArbitrationLedgerAdapterDependenciesV1,
  ) {}

  public async appendDecision(
    input: AppendRoomIndependentArbitrationDecisionInputV1,
  ): Promise<RoomIndependentArbitrationDecisionLedgerRecordV1> {
    const candidateId = selectPromotionCandidate(input);
    const snapshot = await this.dependencies.evidenceReader.readPromotionEvidence({
      command: copyCommand(input.command),
      decision: copyDecision(input.decision),
      candidateId,
    });
    if (snapshot === null) {
      throw new RoomIndependentArbitrationLedgerAdapterError(
        "evidence_snapshot_unavailable",
        `No immutable evidence snapshot was available for arbitration candidate ${candidateId}.`,
      );
    }
    const promotion = derivePromotion(input.decision, candidateId, snapshot);
    const appended = await this.dependencies.ledger.appendPromotion(promotion);
    assertPromotionAppendResult(appended, promotion);
    return freeze({ recordId: appended.record.id, replayed: false });
  }
}

function selectPromotionCandidate(
  input: AppendRoomIndependentArbitrationDecisionInputV1,
): AppendRoomPromotionInputV1["candidateId"] {
  if (!isRecord(input) || !isCommand(input.command) || !isDecision(input.decision)) {
    throw new RoomIndependentArbitrationLedgerAdapterError(
      "invalid_input",
      "Independent-arbitration decision append input is invalid.",
    );
  }
  const decision = input.decision;
  const candidateIds = canonicalIds(decision.candidateIds, "arbitration candidate ids");
  if (decision.decision !== "promoted") {
    if (candidateIds.length !== 1) {
      throw new RoomIndependentArbitrationLedgerAdapterError(
        "candidate_target_ambiguous",
        "A multi-candidate escalation or rejection cannot be represented by one candidate-scoped immutable promotion.",
      );
    }
    throw new RoomIndependentArbitrationLedgerAdapterError(
      "non_promotable_decision",
      `Arbitration decision ${decision.id} is ${decision.decision}, not an immutable promotion.`,
    );
  }
  if (decision.selectedCandidateId === null || !candidateIds.includes(decision.selectedCandidateId)) {
    throw new RoomIndependentArbitrationLedgerAdapterError(
      "invalid_input",
      "An immutable arbitration promotion requires one selected candidate declared by the decision.",
    );
  }
  return decision.selectedCandidateId;
}

function derivePromotion(
  decision: RoomIndependentArbitrationDecisionV1,
  candidateId: AppendRoomPromotionInputV1["candidateId"],
  snapshot: RoomIndependentArbitrationPromotionEvidenceSnapshotV1,
): AppendRoomPromotionInputV1 {
  assertSnapshotScope(snapshot, decision, candidateId);
  const evaluation = snapshot.evaluation;
  const candidate = evaluation.candidate;
  assertCandidate(candidate, decision, candidateId);
  if (!Array.isArray(evaluation.gateResults) || !Array.isArray(evaluation.reviews) || !Array.isArray(evaluation.dissents)) {
    throw evidenceSnapshotInvalid("Candidate evaluation did not contain immutable gate, review, and dissent lists.");
  }
  if (!Array.isArray(evaluation.promotions)) {
    throw evidenceSnapshotInvalid("Candidate evaluation did not contain an immutable promotion list.");
  }
  if (evaluation.promotions.length > 0) {
    throw evidenceSnapshotInvalid(`Candidate ${candidateId} already has an immutable promotion decision.`);
  }
  assertEvaluationRecords(candidate, evaluation);

  const hardGates = evaluation.gateResults.filter((gate) => gate.hard === true);
  if (hardGates.length === 0 || hardGates.some((gate) => gate.status !== "passed")) {
    throw evidenceSnapshotInvalid(`Candidate ${candidateId} does not have an all-passing immutable hard-gate set.`);
  }
  const hardGateResultIds = canonicalIds(hardGates.map((gate) => gate.id), "candidate hard-gate ids");
  assertReferencesAuthorized(hardGateResultIds, decision.hardGateResultIds, "hard-gate");

  const reviewIds = canonicalIds(evaluation.reviews.map((review) => review.id), "candidate review ids");
  assertReferencesAuthorized(reviewIds, decision.reviewIds, "review");
  assertIndependentReviews(candidate, evaluation);

  const unresolvedDissentIds = canonicalIds(
    evaluation.dissents
      .filter((dissent) => dissent.state === "open" || dissent.state === "investigating")
      .map((dissent) => dissent.id),
    "candidate unresolved dissent ids",
  );
  assertReferencesAuthorized(unresolvedDissentIds, decision.unresolvedDissentIds, "unresolved dissent");

  const evidenceIds = canonicalIds([
    ...evaluation.gateResults.flatMap((gate) => gate.evidenceIds),
    ...evaluation.reviews.flatMap((review) => review.evidenceIds),
    ...evaluation.dissents.flatMap((dissent) => dissent.evidenceIds),
  ], "candidate evidence ids");
  assertEvidenceSnapshot(snapshot.evidence, evidenceIds, decision, candidateId);
  assertIndependentArbiter(candidate, evaluation, decision.decisionActorId);

  return freeze({
    scope: copyScope(decision.scope),
    id: decision.id,
    nodeId: decision.nodeId,
    candidateId,
    decision: "promoted",
    decisionActorType: "independent_arbiter",
    decisionActorId: decision.decisionActorId,
    hardGateResultIds: freeze([...hardGateResultIds]),
    reviewIds: freeze([...reviewIds]),
    unresolvedDissentIds: freeze([...unresolvedDissentIds]),
    evidenceIds: freeze([...evidenceIds]),
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
  });
}

function assertSnapshotScope(
  snapshot: RoomIndependentArbitrationPromotionEvidenceSnapshotV1,
  decision: RoomIndependentArbitrationDecisionV1,
  candidateId: string,
): void {
  if (
    !isRecord(snapshot)
    || snapshot.contractVersion !== 1
    || !sameScope(snapshot.scope, decision.scope)
    || !isRecord(snapshot.evaluation)
    || !sameScope(snapshot.evaluation.scope, decision.scope)
  ) {
    throw evidenceSnapshotInvalid("Promotion evidence snapshot belongs to another Room scope.");
  }
  if (snapshot.nodeId !== decision.nodeId || snapshot.candidateId !== candidateId) {
    throw evidenceSnapshotInvalid("Promotion evidence snapshot belongs to another Room task node or candidate.");
  }
}

function assertCandidate(
  candidate: RoomEvidenceLedgerCandidateEvaluation["candidate"],
  decision: RoomIndependentArbitrationDecisionV1,
  candidateId: string,
): void {
  if (
    !isRecord(candidate)
    || candidate.id !== candidateId
    || candidate.roomId !== decision.scope.roomId
    || candidate.nodeId !== decision.nodeId
  ) {
    throw evidenceSnapshotInvalid("Candidate evaluation does not resolve the selected arbitration candidate exactly.");
  }
}

function assertIndependentReviews(
  candidate: RoomEvidenceLedgerCandidateEvaluation["candidate"],
  evaluation: RoomEvidenceLedgerCandidateEvaluation,
): void {
  for (const review of evaluation.reviews) {
    if (
      !isRecord(review)
      || review.candidateId !== candidate.id
      || review.roomId !== candidate.roomId
      || review.nodeId !== candidate.nodeId
      || review.independentFromProducer !== true
      || review.reviewerBindingId === candidate.producingBindingId
      || review.reviewerNativeSessionId === candidate.nativeSessionId
      || review.reviewerHappierSessionId === candidate.happierSessionId
    ) {
      throw evidenceSnapshotInvalid(`Review ${review.id} is not an independent review of candidate ${candidate.id}.`);
    }
  }
}

function assertEvaluationRecords(
  candidate: RoomEvidenceLedgerCandidateEvaluation["candidate"],
  evaluation: RoomEvidenceLedgerCandidateEvaluation,
): void {
  for (const gate of evaluation.gateResults) {
    if (
      !isRecord(gate)
      || gate.candidateId !== candidate.id
      || gate.roomId !== candidate.roomId
      || gate.nodeId !== candidate.nodeId
    ) {
      throw evidenceSnapshotInvalid(`Gate ${gate.id} is outside candidate ${candidate.id}'s immutable Room scope.`);
    }
  }
  for (const review of evaluation.reviews) {
    if (
      !isRecord(review)
      || review.candidateId !== candidate.id
      || review.roomId !== candidate.roomId
      || review.nodeId !== candidate.nodeId
    ) {
      throw evidenceSnapshotInvalid(`Review ${review.id} is outside candidate ${candidate.id}'s immutable Room scope.`);
    }
  }
  for (const dissent of evaluation.dissents) {
    if (
      !isRecord(dissent)
      || dissent.candidateId !== candidate.id
      || dissent.roomId !== candidate.roomId
      || dissent.nodeId !== candidate.nodeId
    ) {
      throw evidenceSnapshotInvalid(`Dissent ${dissent.id} is outside candidate ${candidate.id}'s immutable Room scope.`);
    }
  }
}

function assertIndependentArbiter(
  candidate: RoomEvidenceLedgerCandidateEvaluation["candidate"],
  evaluation: RoomEvidenceLedgerCandidateEvaluation,
  actorId: string,
): void {
  if (
    actorId === candidate.producingBindingId
    || actorId === candidate.nativeSessionId
    || actorId === candidate.happierSessionId
  ) {
    throw evidenceSnapshotInvalid(`Arbiter ${actorId} is a producer identity for candidate ${candidate.id}.`);
  }
  const reviewerBindingIds = new Set(evaluation.reviews.map((review) => review.reviewerBindingId));
  if (reviewerBindingIds.size === 1 && reviewerBindingIds.has(actorId)) {
    throw evidenceSnapshotInvalid(`Arbiter ${actorId} is the only independent reviewer for candidate ${candidate.id}.`);
  }
}

function assertEvidenceSnapshot(
  evidence: readonly RoomEvidenceRecordV1[],
  expectedEvidenceIds: readonly string[],
  decision: RoomIndependentArbitrationDecisionV1,
  candidateId: string,
): void {
  if (!Array.isArray(evidence)) throw evidenceSnapshotInvalid("Promotion evidence snapshot did not contain an evidence list.");
  const evidenceIds = canonicalIds(evidence.map((record) => record.id), "promotion evidence snapshot ids");
  if (!sameIds(evidenceIds, expectedEvidenceIds)) {
    throw evidenceSnapshotInvalid("Promotion evidence snapshot did not resolve exactly the candidate evidence references.");
  }
  for (const record of evidence) {
    if (
      !isRecord(record)
      || record.roomId !== decision.scope.roomId
      || record.nodeId !== decision.nodeId
      || (record.candidateId !== null && record.candidateId !== candidateId)
    ) {
      throw evidenceSnapshotInvalid(`Evidence ${record.id} is outside the selected candidate scope.`);
    }
  }
}

function assertReferencesAuthorized(
  candidateReferences: readonly string[],
  decisionReferences: readonly string[],
  label: string,
): void {
  const authorized = new Set(canonicalIds(decisionReferences, `arbitration decision ${label} ids`));
  if (candidateReferences.some((reference) => !authorized.has(reference))) {
    throw evidenceSnapshotInvalid(`Candidate ${label} references were not authorized by the immutable arbitration decision.`);
  }
}

function assertPromotionAppendResult(
  appended: RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>,
  expected: AppendRoomPromotionInputV1,
): void {
  if (
    !isRecord(appended)
    || appended.table !== "room_promotions"
    || !isRecord(appended.record)
    || appended.record.id !== expected.id
    || appended.record.roomId !== expected.scope.roomId
    || appended.record.nodeId !== expected.nodeId
    || appended.record.candidateId !== expected.candidateId
    || appended.record.decision !== expected.decision
    || appended.record.decisionActorId !== expected.decisionActorId
  ) {
    throw new RoomIndependentArbitrationLedgerAdapterError(
      "ledger_response_invalid",
      "Core promotion ledger did not acknowledge the exact immutable arbitration promotion append.",
    );
  }
}

function isDecision(value: unknown): value is RoomIndependentArbitrationDecisionV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isIdentifier(value.id)
    && isScope(value.scope)
    && isIdentifier(value.nodeId)
    && (value.decision === "promoted" || value.decision === "rejected" || value.decision === "escalated")
    && (value.selectedCandidateId === null || isIdentifier(value.selectedCandidateId))
    && value.decisionActorType === "independent_arbiter"
    && isIdentifier(value.decisionActorId)
    && isIdentifierList(value.candidateIds)
    && isIdentifierList(value.reviewIds)
    && isIdentifierList(value.hardGateResultIds)
    && isIdentifierList(value.unresolvedDissentIds)
    && Array.isArray(value.requiredActions)
    && isCanonicalText(value.rationale)
    && isTimestamp(value.decidedAt);
}

function isCommand(value: unknown): value is RoomIndependentArbitrationCommandIdentityV1 {
  return isRecord(value)
    && isIdentifier(value.commandId)
    && isIdentifier(value.idempotencyKey)
    && isIdentifier(value.correlationId)
    && (value.causationId === null || isIdentifier(value.causationId));
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value) && isIdentifier(value.projectId) && isIdentifier(value.roomId);
}

function sameScope(left: unknown, right: RoomEvidenceLedgerScope): boolean {
  return isScope(left) && left.projectId === right.projectId && left.roomId === right.roomId;
}

function canonicalIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || !values.every(isIdentifier)) {
    throw evidenceSnapshotInvalid(`${label} must be canonical identifiers.`);
  }
  const sorted = [...values].sort(compareRoomText);
  if (new Set(sorted).size !== sorted.length) {
    throw evidenceSnapshotInvalid(`${label} must not contain duplicate identifiers.`);
  }
  return sorted;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function copyCommand(command: RoomIndependentArbitrationCommandIdentityV1): RoomIndependentArbitrationCommandIdentityV1 {
  return freeze({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    causationId: command.causationId,
  });
}

function copyDecision(decision: RoomIndependentArbitrationDecisionV1): RoomIndependentArbitrationDecisionV1 {
  return freeze({
    ...decision,
    scope: copyScope(decision.scope),
    candidateIds: freeze(canonicalIds(decision.candidateIds, "arbitration candidate ids")),
    reviewIds: freeze(canonicalIds(decision.reviewIds, "arbitration review ids")),
    hardGateResultIds: freeze(canonicalIds(decision.hardGateResultIds, "arbitration hard-gate ids")),
    unresolvedDissentIds: freeze(canonicalIds(decision.unresolvedDissentIds, "arbitration dissent ids")),
    requiredActions: freeze(decision.requiredActions.map((action) => freeze({ ...action }))),
  });
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function evidenceSnapshotInvalid(message: string): RoomIndependentArbitrationLedgerAdapterError {
  return new RoomIndependentArbitrationLedgerAdapterError("evidence_snapshot_invalid", message);
}

function isIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isIdentifier) && new Set(value).size === value.length;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
