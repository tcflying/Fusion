import { compareRoomText, type RoomEvidenceLedgerScope } from "@fusion/core";

export const ROOM_INDEPENDENT_ARBITRATION_COORDINATOR_CONTRACT_VERSION = 1 as const;

type ReviewVerdict = "accept" | "repair_required" | "reject" | "abstain";
type HardGateStatus = "passed" | "failed" | "error" | "not_run";
type DissentSeverity = "info" | "minor" | "major" | "critical";
type RiskSeverity = "low" | "medium" | "high" | "critical";
type DissentState = "open" | "investigating" | "resolved" | "accepted_residual";

export interface RoomIndependentArbitrationCandidateV1 {
  readonly id: string;
  readonly producerBindingIds: readonly string[];
}

/** A caller may only pass reviews that are already durably recorded by an adapter. */
export interface RoomIndependentArbitrationReviewV1 {
  readonly id: string;
  readonly candidateId: string;
  readonly reviewerBindingId: string;
  readonly independentFromProducer: boolean;
  readonly evidenceIds: readonly string[];
  readonly verdict: ReviewVerdict;
}

export interface RoomIndependentArbitrationHardGateResultV1 {
  readonly id: string;
  readonly candidateId: string;
  readonly hard: true;
  readonly status: HardGateStatus;
  readonly evidenceIds: readonly string[];
}

export interface RoomIndependentArbitrationDissentV1 {
  readonly id: string;
  readonly candidateId: string;
  readonly severity: DissentSeverity;
  readonly state: DissentState;
  readonly ownerId: string;
  readonly evidenceIds: readonly string[];
}

export interface RoomIndependentArbitrationRiskPolicyV1 {
  readonly minimumIndependentReviewsPerCandidate: number;
  readonly tieRisk: RiskSeverity;
  readonly allowedResidualDissentSeverities: readonly DissentSeverity[];
}

export interface RoomIndependentArbitrationArbiterV1 {
  readonly bindingId: string;
  readonly selectedCandidateId: string | null;
  readonly rationale: string;
}

export interface RoomIndependentArbitrationCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RequestRoomIndependentArbitrationV1 {
  readonly contractVersion: typeof ROOM_INDEPENDENT_ARBITRATION_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly nodeId: string;
  readonly candidates: readonly RoomIndependentArbitrationCandidateV1[];
  readonly reviews: readonly RoomIndependentArbitrationReviewV1[];
  readonly hardGateResults: readonly RoomIndependentArbitrationHardGateResultV1[];
  readonly dissents: readonly RoomIndependentArbitrationDissentV1[];
  readonly riskPolicy: RoomIndependentArbitrationRiskPolicyV1;
  readonly arbiter: RoomIndependentArbitrationArbiterV1;
  readonly command: RoomIndependentArbitrationCommandIdentityV1;
  readonly decisionId: string;
  readonly decidedAt: string;
}

export type RoomIndependentArbitrationRequiredActionKindV1 =
  | "obtain_independent_review"
  | "operator_resolve_high_risk_tie"
  | "operator_resolve_dissent"
  | "operator_accept_residual_risk"
  | "record_arbiter_selection";

export interface RoomIndependentArbitrationRequiredActionV1 {
  readonly kind: RoomIndependentArbitrationRequiredActionKindV1;
  readonly candidateId: string | null;
  readonly dissentId: string | null;
  readonly ownerId: string | null;
  readonly minimumIndependentReviews: number | null;
  readonly message: string;
}

export type RoomIndependentArbitrationDecisionKindV1 = "promoted" | "rejected" | "escalated";

/**
 * The Engine owns this envelope so a later adapter can map it to Core's
 * immutable promotion ledger without allowing callers to inject a durable row.
 */
export interface RoomIndependentArbitrationDecisionV1 {
  readonly contractVersion: typeof ROOM_INDEPENDENT_ARBITRATION_COORDINATOR_CONTRACT_VERSION;
  readonly id: string;
  readonly scope: RoomEvidenceLedgerScope;
  readonly nodeId: string;
  readonly decision: RoomIndependentArbitrationDecisionKindV1;
  readonly selectedCandidateId: string | null;
  readonly decisionActorType: "independent_arbiter";
  readonly decisionActorId: string;
  readonly candidateIds: readonly string[];
  readonly reviewIds: readonly string[];
  readonly hardGateResultIds: readonly string[];
  readonly unresolvedDissentIds: readonly string[];
  readonly requiredActions: readonly RoomIndependentArbitrationRequiredActionV1[];
  readonly rationale: string;
  readonly decidedAt: string;
}

export interface AppendRoomIndependentArbitrationDecisionInputV1 {
  readonly command: RoomIndependentArbitrationCommandIdentityV1;
  readonly decision: RoomIndependentArbitrationDecisionV1;
}

export interface RoomIndependentArbitrationDecisionLedgerRecordV1 {
  readonly recordId: string;
  readonly replayed: boolean;
}

/** This narrow port must be backed by a durable evidence/decision ledger. */
export interface RoomIndependentArbitrationDecisionLedgerPortV1 {
  appendDecision(
    input: AppendRoomIndependentArbitrationDecisionInputV1,
  ): Promise<RoomIndependentArbitrationDecisionLedgerRecordV1>;
}

export interface RoomIndependentArbitrationCoordinatorDependenciesV1 {
  readonly ledger: RoomIndependentArbitrationDecisionLedgerPortV1;
}

export type RoomIndependentArbitrationWithheldCodeV1 =
  | "invalid_request"
  | "ledger_port_invalid"
  | "arbiter_is_candidate_producer"
  | "arbiter_is_only_reviewer"
  | "review_not_independent"
  | "hard_gate_evidence_incomplete"
  | "hard_gate_not_passed";

export interface RoomIndependentArbitrationWithheldResultV1 {
  readonly status: "withheld";
  readonly reason: {
    readonly code: RoomIndependentArbitrationWithheldCodeV1;
    readonly message: string;
  };
  readonly modelOrArbiterMayOverrideHardGates: false;
}

export interface RoomIndependentArbitrationDecidedResultV1 {
  readonly status: "decided";
  readonly decision: RoomIndependentArbitrationDecisionV1;
  readonly record: RoomIndependentArbitrationDecisionLedgerRecordV1;
}

export interface RoomIndependentArbitrationAppendFailedResultV1 {
  readonly status: "append_failed";
  readonly reason: {
    readonly code: "ledger_write_failed" | "ledger_write_invalid";
    readonly message: string;
  };
  readonly decision: RoomIndependentArbitrationDecisionV1;
}

export type RoomIndependentArbitrationResultV1 =
  | RoomIndependentArbitrationWithheldResultV1
  | RoomIndependentArbitrationDecidedResultV1
  | RoomIndependentArbitrationAppendFailedResultV1;

type CandidateReviewDisposition = "accepted" | "rejected" | "conflicted";

/**
 * FNXC:RoomIndependentArbitration 2026-07-19-12:12:
 * Arbitration is a fail-closed, dependency-injected boundary: it never calls a
 * provider or network service, never lets votes override a hard gate, and only
 * writes a durable decision after every candidate has deterministic gate proof.
 * High-risk ties and material dissent remain explicit escalations with named
 * independent-review or operator actions instead of silent auto-acceptance.
 */
export class RoomIndependentArbitrationCoordinator {
  public constructor(
    private readonly dependencies: RoomIndependentArbitrationCoordinatorDependenciesV1,
  ) {}

  public async arbitrate(input: RequestRoomIndependentArbitrationV1): Promise<RoomIndependentArbitrationResultV1> {
    const invalid = validateRequest(input);
    if (invalid !== null) return withheld("invalid_request", invalid);
    if (!isLedgerPort(this.dependencies?.ledger)) {
      return withheld("ledger_port_invalid", "Independent-arbitration decision ledger is unavailable.");
    }

    const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    if (input.candidates.some((candidate) => candidate.producerBindingIds.includes(input.arbiter.bindingId))) {
      return withheld(
        "arbiter_is_candidate_producer",
        "An independent arbiter must not be a producer of any candidate in this decision.",
      );
    }

    const nonIndependentReview = input.reviews.find((review) => {
      const candidate = candidateById.get(review.candidateId)!;
      return !review.independentFromProducer || candidate.producerBindingIds.includes(review.reviewerBindingId);
    });
    if (nonIndependentReview) {
      return withheld(
        "review_not_independent",
        `Review ${nonIndependentReview.id} is not independent from its candidate producer.`,
      );
    }

    const reviewerIds = new Set(input.reviews.map((review) => review.reviewerBindingId));
    if (reviewerIds.size === 1 && reviewerIds.has(input.arbiter.bindingId)) {
      return withheld(
        "arbiter_is_only_reviewer",
        "An arbiter cannot be the only independent reviewer for the decision set.",
      );
    }

    const missingHardGateCandidate = input.candidates.find((candidate) =>
      !input.hardGateResults.some((gate) => gate.candidateId === candidate.id),
    );
    if (missingHardGateCandidate) {
      return withheld(
        "hard_gate_evidence_incomplete",
        `Candidate ${missingHardGateCandidate.id} has no deterministic hard-gate result.`,
      );
    }
    const nonPassingHardGate = input.hardGateResults.find((gate) => gate.status !== "passed");
    if (nonPassingHardGate) {
      return withheld(
        "hard_gate_not_passed",
        `Hard gate ${nonPassingHardGate.id} is ${nonPassingHardGate.status}; no vote or arbiter output can override it.`,
      );
    }

    const dissentActions = collectDissentActions(input);
    if (dissentActions.length > 0) {
      return this.recordDecision(input, "escalated", null, dissentActions, "Material dissent requires its assigned independent resolution or operator action.");
    }

    const reviewsByCandidate = groupReviewsByCandidate(input);
    const reviewShortfallActions = input.candidates.flatMap((candidate) => {
      const current = reviewsByCandidate.get(candidate.id) ?? [];
      if (current.length >= input.riskPolicy.minimumIndependentReviewsPerCandidate) return [];
      return [independentReviewAction(candidate.id, input.riskPolicy.minimumIndependentReviewsPerCandidate, current.length)];
    });
    if (reviewShortfallActions.length > 0) {
      return this.recordDecision(input, "escalated", null, reviewShortfallActions, "The candidate set lacks the required number of independent reviews.");
    }

    const dispositions = new Map<string, CandidateReviewDisposition>();
    for (const candidate of input.candidates) {
      dispositions.set(candidate.id, reviewDisposition(reviewsByCandidate.get(candidate.id) ?? []));
    }
    const conflictedCandidates = input.candidates.filter((candidate) => dispositions.get(candidate.id) === "conflicted");
    if (conflictedCandidates.length > 0) {
      const actions = conflictedCandidates.map((candidate) => independentReviewAction(
        candidate.id,
        input.riskPolicy.minimumIndependentReviewsPerCandidate + 1,
        reviewsByCandidate.get(candidate.id)?.length ?? 0,
      ));
      return this.recordDecision(input, "escalated", null, actions, "Conflicting or inconclusive independent reviews require additional independent evidence.");
    }

    const acceptedCandidates = input.candidates.filter((candidate) => dispositions.get(candidate.id) === "accepted");
    if (acceptedCandidates.length === 0) {
      return this.recordDecision(input, "rejected", null, [], "Every independently reviewed candidate was rejected after deterministic gates passed.");
    }
    if (acceptedCandidates.length === 1) {
      const selected = acceptedCandidates[0]!;
      if (input.arbiter.selectedCandidateId !== null && input.arbiter.selectedCandidateId !== selected.id) {
        return this.recordDecision(
          input,
          "escalated",
          null,
          [arbiterSelectionAction(selected.id)],
          "The arbiter selection conflicts with the sole independently accepted candidate.",
        );
      }
      return this.recordDecision(input, "promoted", selected.id, [], "One candidate is independently accepted and all deterministic hard gates passed.");
    }

    if (input.riskPolicy.tieRisk === "high" || input.riskPolicy.tieRisk === "critical") {
      return this.recordDecision(
        input,
        "escalated",
        null,
        [
          ...acceptedCandidates.map((candidate) => independentReviewAction(
            candidate.id,
            input.riskPolicy.minimumIndependentReviewsPerCandidate + 1,
            reviewsByCandidate.get(candidate.id)?.length ?? 0,
          )),
          highRiskTieAction(),
        ],
        "A high-risk tie cannot be resolved by arbiter preference alone.",
      );
    }

    const selected = input.arbiter.selectedCandidateId;
    if (selected === null || !acceptedCandidates.some((candidate) => candidate.id === selected)) {
      return this.recordDecision(
        input,
        "escalated",
        null,
        [arbiterSelectionAction(null)],
        "A lower-risk tie still requires a recorded independent-arbiter selection from the accepted candidates.",
      );
    }
    return this.recordDecision(input, "promoted", selected, [], "A lower-risk tie was resolved by an eligible independent arbiter after deterministic gates passed.");
  }

  private async recordDecision(
    input: RequestRoomIndependentArbitrationV1,
    kind: RoomIndependentArbitrationDecisionKindV1,
    selectedCandidateId: string | null,
    requiredActions: readonly RoomIndependentArbitrationRequiredActionV1[],
    rationale: string,
  ): Promise<RoomIndependentArbitrationDecidedResultV1 | RoomIndependentArbitrationAppendFailedResultV1> {
    const decision = createDecision(input, kind, selectedCandidateId, requiredActions, rationale);
    try {
      const record = await this.dependencies.ledger.appendDecision({
        command: copyCommand(input.command),
        decision,
      });
      if (!isLedgerRecord(record)) {
        return {
          status: "append_failed",
          reason: { code: "ledger_write_invalid", message: "Decision ledger returned an invalid durable record." },
          decision,
        };
      }
      return {
        status: "decided",
        decision,
        record: freeze({ recordId: record.recordId, replayed: record.replayed }),
      };
    } catch {
      return {
        status: "append_failed",
        reason: { code: "ledger_write_failed", message: "Independent-arbitration decision was not durably recorded." },
        decision,
      };
    }
  }
}

function createDecision(
  input: RequestRoomIndependentArbitrationV1,
  kind: RoomIndependentArbitrationDecisionKindV1,
  selectedCandidateId: string | null,
  requiredActions: readonly RoomIndependentArbitrationRequiredActionV1[],
  rationale: string,
): RoomIndependentArbitrationDecisionV1 {
  return freeze({
    contractVersion: 1,
    id: input.decisionId,
    scope: copyScope(input.scope),
    nodeId: input.nodeId,
    decision: kind,
    selectedCandidateId,
    decisionActorType: "independent_arbiter",
    decisionActorId: input.arbiter.bindingId,
    candidateIds: freeze(sortedIds(input.candidates.map((candidate) => candidate.id))),
    reviewIds: freeze(sortedIds(input.reviews.map((review) => review.id))),
    hardGateResultIds: freeze(sortedIds(input.hardGateResults.map((gate) => gate.id))),
    unresolvedDissentIds: freeze(sortedIds(input.dissents
      .filter((dissent) => dissent.state !== "resolved")
      .map((dissent) => dissent.id))),
    requiredActions: freeze(sortedActions(requiredActions)),
    rationale,
    decidedAt: input.decidedAt,
  });
}

function collectDissentActions(input: RequestRoomIndependentArbitrationV1): readonly RoomIndependentArbitrationRequiredActionV1[] {
  const actions: RoomIndependentArbitrationRequiredActionV1[] = [];
  for (const dissent of input.dissents) {
    const materialUnresolved = (dissent.severity === "major" || dissent.severity === "critical")
      && (dissent.state === "open" || dissent.state === "investigating");
    if (materialUnresolved) {
      actions.push(freeze({
        kind: "operator_resolve_dissent" as const,
        candidateId: dissent.candidateId,
        dissentId: dissent.id,
        ownerId: dissent.ownerId,
        minimumIndependentReviews: null,
        message: `${dissent.severity} dissent ${dissent.id} must be resolved by its owner or an operator before arbitration can continue.`,
      }));
      continue;
    }
    const residualDisallowed = dissent.state === "accepted_residual"
      && !input.riskPolicy.allowedResidualDissentSeverities.includes(dissent.severity);
    if (residualDisallowed) {
      actions.push(freeze({
        kind: "operator_accept_residual_risk" as const,
        candidateId: dissent.candidateId,
        dissentId: dissent.id,
        ownerId: dissent.ownerId,
        minimumIndependentReviews: null,
        message: `Residual ${dissent.severity} dissent ${dissent.id} requires an explicit operator risk decision.`,
      }));
    }
  }
  return sortedActions(actions);
}

function groupReviewsByCandidate(input: RequestRoomIndependentArbitrationV1): ReadonlyMap<string, readonly RoomIndependentArbitrationReviewV1[]> {
  const grouped = new Map<string, RoomIndependentArbitrationReviewV1[]>();
  for (const review of input.reviews) {
    const current = grouped.get(review.candidateId) ?? [];
    current.push(review);
    grouped.set(review.candidateId, current);
  }
  return grouped;
}

function reviewDisposition(reviews: readonly RoomIndependentArbitrationReviewV1[]): CandidateReviewDisposition {
  if (reviews.every((review) => review.verdict === "accept")) return "accepted";
  if (reviews.every((review) => review.verdict === "reject")) return "rejected";
  return "conflicted";
}

function independentReviewAction(
  candidateId: string,
  minimumIndependentReviews: number,
  observedReviews: number,
): RoomIndependentArbitrationRequiredActionV1 {
  return freeze({
    kind: "obtain_independent_review",
    candidateId,
    dissentId: null,
    ownerId: null,
    minimumIndependentReviews,
    message: `Candidate ${candidateId} has ${observedReviews} independent review(s); obtain at least ${minimumIndependentReviews}.`,
  });
}

function highRiskTieAction(): RoomIndependentArbitrationRequiredActionV1 {
  return freeze({
    kind: "operator_resolve_high_risk_tie",
    candidateId: null,
    dissentId: null,
    ownerId: null,
    minimumIndependentReviews: null,
    message: "An operator must resolve the high-risk tie after the additional independent reviews are recorded.",
  });
}

function arbiterSelectionAction(candidateId: string | null): RoomIndependentArbitrationRequiredActionV1 {
  return freeze({
    kind: "record_arbiter_selection",
    candidateId,
    dissentId: null,
    ownerId: null,
    minimumIndependentReviews: null,
    message: candidateId === null
      ? "Record an eligible independent-arbiter selection from the independently accepted candidates."
      : `Record an eligible independent-arbiter selection for ${candidateId}.`,
  });
}

function validateRequest(input: unknown): string | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    "contractVersion",
    "scope",
    "nodeId",
    "candidates",
    "reviews",
    "hardGateResults",
    "dissents",
    "riskPolicy",
    "arbiter",
    "command",
    "decisionId",
    "decidedAt",
  ])) return "Arbitration request has an invalid contract shape.";
  if (input.contractVersion !== 1) return "Arbitration request contract version is unsupported.";
  if (!isScope(input.scope)) return "Arbitration request scope is invalid.";
  if (!isIdentifier(input.nodeId)) return "Arbitration request node identifier is invalid.";
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.some((candidate) => !isCandidate(candidate))) {
    return "Arbitration candidates are invalid.";
  }
  if (!Array.isArray(input.reviews) || input.reviews.some((review) => !isReview(review))) {
    return "Arbitration reviews are invalid.";
  }
  if (!Array.isArray(input.hardGateResults) || input.hardGateResults.some((gate) => !isHardGate(gate))) {
    return "Arbitration hard-gate results are invalid.";
  }
  if (!Array.isArray(input.dissents) || input.dissents.some((dissent) => !isDissent(dissent))) {
    return "Arbitration dissent records are invalid.";
  }
  if (!isRiskPolicy(input.riskPolicy)) return "Arbitration risk policy is invalid.";
  if (!isArbiter(input.arbiter)) return "Arbitration arbiter record is invalid.";
  if (!isCommand(input.command)) return "Arbitration command identity is invalid.";
  if (!isIdentifier(input.decisionId)) return "Arbitration decision identifier is invalid.";
  if (!isTimestamp(input.decidedAt)) return "Arbitration decision timestamp is invalid.";

  const candidates = input.candidates as readonly RoomIndependentArbitrationCandidateV1[];
  const reviews = input.reviews as readonly RoomIndependentArbitrationReviewV1[];
  const gates = input.hardGateResults as readonly RoomIndependentArbitrationHardGateResultV1[];
  const dissents = input.dissents as readonly RoomIndependentArbitrationDissentV1[];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== candidates.length) return "Candidate identifiers must be unique.";
  if (reviews.some((review) => !candidateIds.has(review.candidateId))
    || gates.some((gate) => !candidateIds.has(gate.candidateId))
    || dissents.some((dissent) => !candidateIds.has(dissent.candidateId))) return "Evidence references an unknown candidate.";
  if (!hasUniqueIds(reviews) || !hasUniqueIds(gates) || !hasUniqueIds(dissents)) return "Evidence record identifiers must be unique.";

  const reviewIdentityKeys = reviews.map((review) => `${review.candidateId}\u0000${review.reviewerBindingId}`);
  if (new Set(reviewIdentityKeys).size !== reviewIdentityKeys.length) return "Each reviewer may record at most one review per candidate.";
  if (input.arbiter.selectedCandidateId !== null && !candidateIds.has(input.arbiter.selectedCandidateId)) {
    return "Arbiter selection must reference a submitted candidate.";
  }
  return null;
}

function isCandidate(value: unknown): value is RoomIndependentArbitrationCandidateV1 {
  return isRecord(value) && hasExactKeys(value, ["id", "producerBindingIds"])
    && isIdentifier(value.id) && isIdentifierList(value.producerBindingIds) && value.producerBindingIds.length > 0;
}

function isReview(value: unknown): value is RoomIndependentArbitrationReviewV1 {
  return isRecord(value) && hasExactKeys(value, ["id", "candidateId", "reviewerBindingId", "independentFromProducer", "evidenceIds", "verdict"])
    && isIdentifier(value.id) && isIdentifier(value.candidateId) && isIdentifier(value.reviewerBindingId)
    && typeof value.independentFromProducer === "boolean" && isIdentifierList(value.evidenceIds) && value.evidenceIds.length > 0
    && (value.verdict === "accept" || value.verdict === "repair_required" || value.verdict === "reject" || value.verdict === "abstain");
}

function isHardGate(value: unknown): value is RoomIndependentArbitrationHardGateResultV1 {
  return isRecord(value) && hasExactKeys(value, ["id", "candidateId", "hard", "status", "evidenceIds"])
    && isIdentifier(value.id) && isIdentifier(value.candidateId) && value.hard === true
    && isIdentifierList(value.evidenceIds) && value.evidenceIds.length > 0
    && (value.status === "passed" || value.status === "failed" || value.status === "error" || value.status === "not_run");
}

function isDissent(value: unknown): value is RoomIndependentArbitrationDissentV1 {
  return isRecord(value) && hasExactKeys(value, ["id", "candidateId", "severity", "state", "ownerId", "evidenceIds"])
    && isIdentifier(value.id) && isIdentifier(value.candidateId) && isIdentifier(value.ownerId)
    && isIdentifierList(value.evidenceIds) && value.evidenceIds.length > 0
    && isSeverity(value.severity) && isDissentState(value.state);
}

function isRiskPolicy(value: unknown): value is RoomIndependentArbitrationRiskPolicyV1 {
  const minimumIndependentReviewsPerCandidate = isRecord(value)
    ? value.minimumIndependentReviewsPerCandidate
    : null;
  return isRecord(value) && hasExactKeys(value, ["minimumIndependentReviewsPerCandidate", "tieRisk", "allowedResidualDissentSeverities"])
    && typeof minimumIndependentReviewsPerCandidate === "number"
    && Number.isInteger(minimumIndependentReviewsPerCandidate) && minimumIndependentReviewsPerCandidate >= 1
    && isRiskSeverity(value.tieRisk) && isSeverityList(value.allowedResidualDissentSeverities);
}

function isArbiter(value: unknown): value is RoomIndependentArbitrationArbiterV1 {
  return isRecord(value) && hasExactKeys(value, ["bindingId", "selectedCandidateId", "rationale"])
    && isIdentifier(value.bindingId) && (value.selectedCandidateId === null || isIdentifier(value.selectedCandidateId)) && isText(value.rationale);
}

function isCommand(value: unknown): value is RoomIndependentArbitrationCommandIdentityV1 {
  return isRecord(value) && hasExactKeys(value, ["commandId", "idempotencyKey", "correlationId", "causationId"])
    && isIdentifier(value.commandId) && isIdentifier(value.idempotencyKey) && isIdentifier(value.correlationId)
    && (value.causationId === null || isIdentifier(value.causationId));
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value) && hasExactKeys(value, ["projectId", "roomId"])
    && isIdentifier(value.projectId) && isIdentifier(value.roomId);
}

function isLedgerPort(value: unknown): value is RoomIndependentArbitrationDecisionLedgerPortV1 {
  return isRecord(value) && typeof value.appendDecision === "function";
}

function isLedgerRecord(value: unknown): value is RoomIndependentArbitrationDecisionLedgerRecordV1 {
  return isRecord(value) && hasExactKeys(value, ["recordId", "replayed"])
    && isIdentifier(value.recordId) && typeof value.replayed === "boolean";
}

function isIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isIdentifier) && new Set(value).size === value.length;
}

function isSeverityList(value: unknown): value is readonly DissentSeverity[] {
  return Array.isArray(value) && value.every(isSeverity) && new Set(value).size === value.length;
}

function isSeverity(value: unknown): value is DissentSeverity {
  return value === "info" || value === "minor" || value === "major" || value === "critical";
}

function isRiskSeverity(value: unknown): value is RiskSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isDissentState(value: unknown): value is DissentState {
  return value === "open" || value === "investigating" || value === "resolved" || value === "accepted_residual";
}

function hasUniqueIds(value: readonly { readonly id: string }[]): boolean {
  return new Set(value.map((entry) => entry.id)).size === value.length;
}

function withheld(
  code: RoomIndependentArbitrationWithheldCodeV1,
  message: string,
): RoomIndependentArbitrationWithheldResultV1 {
  return freeze({
    status: "withheld",
    reason: freeze({ code, message }),
    modelOrArbiterMayOverrideHardGates: false,
  });
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function copyCommand(command: RoomIndependentArbitrationCommandIdentityV1): RoomIndependentArbitrationCommandIdentityV1 {
  return freeze({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    causationId: command.causationId,
  });
}

function sortedIds(values: readonly string[]): string[] {
  return [...values].sort(compareRoomText);
}

function sortedActions(values: readonly RoomIndependentArbitrationRequiredActionV1[]): RoomIndependentArbitrationRequiredActionV1[] {
  return values.map((action) => freeze({ ...action })).sort((left, right) => compareRoomText(
    `${left.kind}:${left.candidateId ?? ""}:${left.dissentId ?? ""}:${left.ownerId ?? ""}`,
    `${right.kind}:${right.candidateId ?? ""}:${right.dissentId ?? ""}:${right.ownerId ?? ""}`,
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => key in value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
