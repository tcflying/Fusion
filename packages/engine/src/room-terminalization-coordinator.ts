import {
  evaluateRoomTerminalization,
  ROOM_TERMINALIZATION_OUTCOMES,
  type EvaluateRoomTerminalizationInputV1,
  type RoomTerminalizationDecisionV1,
  type RoomTerminalizationOutcomeV1,
} from "@fusion/core";

export interface ReadRoomTerminalizationContractInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
}

export interface RoomTerminalRiskEvidenceRefV1 {
  readonly riskId: string;
  readonly evidenceRef: string;
}

/**
 * The Engine reads this immutable contract record from a trusted Room-ledger
 * adapter. It deliberately cannot be supplied as a caller assertion.
 */
export interface RoomTerminalizationContractEvidenceV1 {
  readonly source: "room_terminal_contract_ledger";
  readonly recordId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
  readonly completionContractRef: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly gateEvidenceSetId: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskEvidence: readonly RoomTerminalRiskEvidenceRefV1[];
  /**
   * Cancellation remains a terminal contract outcome, but it must retain the
   * durable reason that the controller will submit to its cancellation command.
   */
  readonly cancellationReason: string | null;
  readonly terminalization: EvaluateRoomTerminalizationInputV1;
}

export interface RoomTerminalizationContractEvidenceReader {
  readTerminalizationContract(
    input: ReadRoomTerminalizationContractInputV1,
  ): Promise<RoomTerminalizationContractEvidenceV1 | null>;
}

export type RoomCompletionTerminalizationOutcomeV1 = Exclude<
  RoomTerminalizationOutcomeV1,
  "cancelled"
>;

export type RoomTerminalTransitionCommandV1 =
  | {
      readonly type: "complete_room";
      readonly outcome: RoomCompletionTerminalizationOutcomeV1;
      readonly completionContractRef: string;
      readonly independentVerificationRefs: readonly string[];
      readonly unresolvedRiskRefs: readonly string[];
    }
  | {
      readonly type: "cancel_room";
      readonly outcome: "cancelled";
      readonly reason: string;
    };

/**
 * This is an Engine-to-controller request, not a confirmation that Core has
 * committed the lifecycle transition. The adapter is the only component that
 * may connect it to a future RoomController command path.
 */
export interface RoomTerminalTransitionRequestV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly terminalContractRecordId: string;
  readonly terminalContractRef: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskRefs: readonly string[];
  readonly command: RoomTerminalTransitionCommandV1;
}

export interface RoomTerminalTransitionRequester {
  requestTerminalTransition(input: RoomTerminalTransitionRequestV1): Promise<void>;
}

export interface RequestRoomTerminalizationInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export type RoomTerminalizationCoordinatorBlockerCodeV1 =
  | "invalid_terminalization_request"
  | "terminal_contract_evidence_unavailable"
  | "invalid_terminal_contract_evidence"
  | "terminal_contract_project_mismatch"
  | "terminal_contract_room_mismatch"
  | "terminal_contract_aggregate_version_mismatch"
  | "terminal_contract_outcome_mismatch"
  | "terminal_contract_protocol_mismatch"
  | "terminal_contract_gate_evidence_set_mismatch"
  | "terminal_contract_unresolved_risk_mismatch"
  | "cancelled_terminal_contract_reason_missing"
  | "independent_verification_required"
  | "independent_verification_ref_unproven"
  | "core_terminalization_rejected";

export interface RoomTerminalizationCoordinatorBlockerV1 {
  readonly code: RoomTerminalizationCoordinatorBlockerCodeV1;
  readonly message: string;
}

export type RoomTerminalizationCoordinationResultV1 =
  | {
      readonly status: "withheld";
      readonly requestedOutcome: RoomTerminalizationOutcomeV1 | null;
      readonly terminalizationDecision: RoomTerminalizationDecisionV1 | null;
      readonly blockers: readonly RoomTerminalizationCoordinatorBlockerV1[];
    }
  | {
      readonly status: "transition_requested";
      readonly requestedOutcome: RoomTerminalizationOutcomeV1;
      readonly terminalizationDecision: RoomTerminalizationDecisionV1;
      readonly transitionRequest: RoomTerminalTransitionRequestV1;
    };

export interface RoomTerminalizationCoordinatorOptions {
  readonly projectId: string;
  readonly evidenceReader: RoomTerminalizationContractEvidenceReader;
  readonly transitionRequester: RoomTerminalTransitionRequester;
}

const TERMINAL_OUTCOME_SET = new Set<string>(ROOM_TERMINALIZATION_OUTCOMES);

/*
FNXC:RoomTerminalizationCoordinator 2026-07-19-10:10:
OpenSpec task 5.10 requires the Engine to request a Room terminal transition
only after a recorded terminal contract, authoritative gate evidence, and an
independent verifier prove the requested outcome. This coordinator never
mutates AsyncRoomStore directly and never treats a model, caller, or provider
response as proof of a committed terminal state.

FNXC:RoomTerminalizationCoordinator 2026-07-19-10:10:
The six outcomes remain distinct at the controller seam. "cancelled" becomes
the dedicated cancellation command with a durable reason; all other outcomes
retain the complete-room evidence references without asserting external or
provider E2E.
*/
export class RoomTerminalizationCoordinator {
  constructor(private readonly options: RoomTerminalizationCoordinatorOptions) {
    if (!isNonBlankString(options?.projectId)) {
      throw new TypeError("RoomTerminalizationCoordinator requires a non-empty projectId");
    }
    if (typeof options?.evidenceReader?.readTerminalizationContract !== "function") {
      throw new TypeError("RoomTerminalizationCoordinator requires an evidenceReader");
    }
    if (typeof options?.transitionRequester?.requestTerminalTransition !== "function") {
      throw new TypeError("RoomTerminalizationCoordinator requires a transitionRequester");
    }
  }

  async requestTerminalization(
    input: RequestRoomTerminalizationInputV1,
  ): Promise<RoomTerminalizationCoordinationResultV1> {
    const requestBlockers = validateTerminalizationRequest(input);
    const requestedOutcome = requestedOutcomeFrom(input);
    if (requestBlockers.length > 0) {
      return withheld(requestedOutcome, null, requestBlockers);
    }

    let contract: RoomTerminalizationContractEvidenceV1 | null;
    try {
      contract = await this.options.evidenceReader.readTerminalizationContract({
        projectId: this.options.projectId,
        roomId: input.roomId,
        expectedAggregateVersion: input.expectedAggregateVersion,
        requestedOutcome: input.requestedOutcome,
      });
    } catch {
      return withheld(input.requestedOutcome, null, [{
        code: "terminal_contract_evidence_unavailable",
        message: "Terminalization was withheld because the authoritative terminal contract could not be read",
      }]);
    }

    if (!contract) {
      return withheld(input.requestedOutcome, null, [{
        code: "terminal_contract_evidence_unavailable",
        message: "Terminalization requires an authoritative terminal contract record",
      }]);
    }

    const rawContract = contract as unknown;
    const terminalization = isRecord(rawContract) ? rawContract.terminalization : undefined;
    const decision = evaluateRoomTerminalization(
      terminalization as EvaluateRoomTerminalizationInputV1,
    );
    const contractBlockers = validateTerminalizationContract({
      projectId: this.options.projectId,
      request: input,
      contract: rawContract,
      decision,
    });
    if (contractBlockers.length > 0) {
      return withheld(input.requestedOutcome, decision, contractBlockers);
    }

    const transitionRequest = toTerminalTransitionRequest({
      projectId: this.options.projectId,
      request: input,
      contract,
    });
    await this.options.transitionRequester.requestTerminalTransition(transitionRequest);
    return Object.freeze({
      status: "transition_requested" as const,
      requestedOutcome: input.requestedOutcome,
      terminalizationDecision: decision,
      transitionRequest,
    });
  }
}

function validateTerminalizationRequest(
  input: RequestRoomTerminalizationInputV1,
): readonly RoomTerminalizationCoordinatorBlockerV1[] {
  const raw = input as unknown;
  if (!isRecord(raw)) {
    return [{
      code: "invalid_terminalization_request",
      message: "A terminalization request must be an object",
    }];
  }

  const blockers: RoomTerminalizationCoordinatorBlockerV1[] = [];
  if (!isNonBlankString(raw.roomId)) {
    addBlocker(blockers, "invalid_terminalization_request", "Terminalization requires a non-empty roomId");
  }
  if (!isNonNegativeSafeInteger(raw.expectedAggregateVersion)) {
    addBlocker(
      blockers,
      "invalid_terminalization_request",
      "Terminalization requires a non-negative expected aggregate version",
    );
  }
  if (!isTerminalOutcome(raw.requestedOutcome)) {
    addBlocker(
      blockers,
      "invalid_terminalization_request",
      "Terminalization requires one supported requested outcome",
    );
  }
  if (!isNonBlankString(raw.idempotencyKey) || !isNonBlankString(raw.correlationId)) {
    addBlocker(
      blockers,
      "invalid_terminalization_request",
      "Terminalization requires non-empty idempotency and correlation identifiers",
    );
  }
  return Object.freeze(blockers);
}

function validateTerminalizationContract(input: {
  readonly projectId: string;
  readonly request: RequestRoomTerminalizationInputV1;
  readonly contract: unknown;
  readonly decision: RoomTerminalizationDecisionV1;
}): readonly RoomTerminalizationCoordinatorBlockerV1[] {
  const blockers: RoomTerminalizationCoordinatorBlockerV1[] = [];
  if (!isRecord(input.contract)) {
    addBlocker(
      blockers,
      "invalid_terminal_contract_evidence",
      "Terminalization contract evidence must be a structured record",
    );
    return Object.freeze(blockers);
  }

  const contract = input.contract;
  if (
    contract.source !== "room_terminal_contract_ledger"
    || !isNonBlankString(contract.recordId)
    || !isNonBlankString(contract.completionContractRef)
  ) {
    addBlocker(
      blockers,
      "invalid_terminal_contract_evidence",
      "Terminalization requires a referenced record from the authoritative terminal-contract ledger",
    );
  }
  if (contract.projectId !== input.projectId) {
    addBlocker(
      blockers,
      "terminal_contract_project_mismatch",
      "Terminalization contract evidence belongs to a different project",
    );
  }
  if (contract.roomId !== input.request.roomId) {
    addBlocker(
      blockers,
      "terminal_contract_room_mismatch",
      "Terminalization contract evidence belongs to a different Room",
    );
  }
  if (contract.aggregateVersion !== input.request.expectedAggregateVersion) {
    addBlocker(
      blockers,
      "terminal_contract_aggregate_version_mismatch",
      "Terminalization contract evidence does not match the expected Room aggregate version",
    );
  }
  if (contract.requestedOutcome !== input.request.requestedOutcome) {
    addBlocker(
      blockers,
      "terminal_contract_outcome_mismatch",
      "Terminalization contract evidence does not match the requested outcome",
    );
  }

  const terminalization = isRecord(contract.terminalization) ? contract.terminalization : null;
  const protocol = terminalization && isRecord(terminalization.protocol)
    ? terminalization.protocol
    : null;
  const gateEvidence = terminalization && isRecord(terminalization.evidence)
    ? terminalization.evidence
    : null;
  if (
    !protocol
    || contract.protocolId !== protocol.id
    || contract.protocolVersion !== protocol.version
  ) {
    addBlocker(
      blockers,
      "terminal_contract_protocol_mismatch",
      "Terminalization contract evidence must bind the exact evaluated protocol",
    );
  }
  if (!gateEvidence || contract.gateEvidenceSetId !== gateEvidence.evidenceSetId) {
    addBlocker(
      blockers,
      "terminal_contract_gate_evidence_set_mismatch",
      "Terminalization contract evidence must bind the exact authoritative gate evidence set",
    );
  }

  validateIndependentVerification(blockers, contract, terminalization);
  validateUnresolvedRiskEvidence(blockers, contract, terminalization);
  if (
    input.request.requestedOutcome === "cancelled"
    && !isNonBlankString(contract.cancellationReason)
  ) {
    addBlocker(
      blockers,
      "cancelled_terminal_contract_reason_missing",
      "Cancelled terminalization requires a durable cancellation reason",
    );
  }
  if (!input.decision.canTerminalize) {
    addBlocker(
      blockers,
      "core_terminalization_rejected",
      "Core terminalization policy rejected the declared protocol or authoritative gate evidence",
    );
  }
  return Object.freeze(blockers);
}

function validateIndependentVerification(
  blockers: RoomTerminalizationCoordinatorBlockerV1[],
  contract: Record<string, unknown>,
  terminalization: Record<string, unknown> | null,
): void {
  if (!hasNonBlankUniqueStrings(contract.independentVerificationRefs)) {
    addBlocker(
      blockers,
      "independent_verification_required",
      "Terminalization requires at least one distinct independent verification reference",
    );
    return;
  }

  const provenRefs = independentRequiredGateEvidenceRefs(terminalization);
  if (provenRefs.size === 0) {
    addBlocker(
      blockers,
      "independent_verification_required",
      "Terminalization requires a passing required gate evaluated by a non-producer binding",
    );
    return;
  }
  for (const evidenceRef of contract.independentVerificationRefs) {
    if (!provenRefs.has(evidenceRef)) {
      addBlocker(
        blockers,
        "independent_verification_ref_unproven",
        "Every independent verification reference must identify a passing required gate from a non-producer binding",
      );
      return;
    }
  }
}

function validateUnresolvedRiskEvidence(
  blockers: RoomTerminalizationCoordinatorBlockerV1[],
  contract: Record<string, unknown>,
  terminalization: Record<string, unknown> | null,
): void {
  const expectedRiskIds = unresolvedRiskIds(terminalization);
  const riskEvidence = contract.unresolvedRiskEvidence;
  if (!Array.isArray(riskEvidence)) {
    addBlocker(
      blockers,
      "terminal_contract_unresolved_risk_mismatch",
      "Terminalization contract evidence must provide unresolved-risk evidence as an array",
    );
    return;
  }

  const refsByRiskId = new Map<string, string>();
  for (const risk of riskEvidence) {
    if (
      !isRecord(risk)
      || !isNonBlankString(risk.riskId)
      || !isNonBlankString(risk.evidenceRef)
      || refsByRiskId.has(risk.riskId)
    ) {
      addBlocker(
        blockers,
        "terminal_contract_unresolved_risk_mismatch",
        "Every unresolved risk requires one distinct risk identity and evidence reference",
      );
      return;
    }
    refsByRiskId.set(risk.riskId, risk.evidenceRef);
  }

  if (
    refsByRiskId.size !== expectedRiskIds.size
    || [...expectedRiskIds].some((riskId) => !refsByRiskId.has(riskId))
  ) {
    addBlocker(
      blockers,
      "terminal_contract_unresolved_risk_mismatch",
      "Terminalization contract risk evidence must exactly cover the unresolved risks in the gate ledger",
    );
  }
}

function independentRequiredGateEvidenceRefs(
  terminalization: Record<string, unknown> | null,
): ReadonlySet<string> {
  if (!terminalization) return new Set<string>();
  const protocol = isRecord(terminalization.protocol) ? terminalization.protocol : null;
  const evidence = isRecord(terminalization.evidence) ? terminalization.evidence : null;
  if (!protocol || !evidence || !Array.isArray(protocol.exitConditions)) {
    return new Set<string>();
  }

  const outcome = terminalization.requestedOutcome;
  const exitCondition = protocol.exitConditions.find(
    (candidate) => isRecord(candidate) && candidate.outcome === outcome,
  );
  if (!isRecord(exitCondition) || !hasNonBlankUniqueStrings(exitCondition.requiredGateIds)) {
    return new Set<string>();
  }
  if (!hasNonBlankUniqueStrings(evidence.producerBindingIds) || !Array.isArray(evidence.gateResults)) {
    return new Set<string>();
  }

  const requiredGateIds = new Set(exitCondition.requiredGateIds);
  const producerBindingIds = new Set(evidence.producerBindingIds);
  const provenRefs = new Set<string>();
  for (const gateResult of evidence.gateResults) {
    if (
      !isRecord(gateResult)
      || !requiredGateIds.has(String(gateResult.gateId))
      || gateResult.status !== "passed"
      || !isNonBlankString(gateResult.evidenceRef)
      || !hasNonBlankUniqueStrings(gateResult.evaluatorBindingIds)
    ) {
      continue;
    }
    if (gateResult.evaluatorBindingIds.some((bindingId) => !producerBindingIds.has(bindingId))) {
      provenRefs.add(gateResult.evidenceRef);
    }
  }
  return provenRefs;
}

function unresolvedRiskIds(terminalization: Record<string, unknown> | null): ReadonlySet<string> {
  if (!terminalization || !isRecord(terminalization.evidence)) return new Set<string>();
  const risks = terminalization.evidence.unresolvedRisks;
  if (!Array.isArray(risks)) return new Set<string>();
  const ids = new Set<string>();
  for (const risk of risks) {
    if (isRecord(risk) && isNonBlankString(risk.id)) ids.add(risk.id);
  }
  return ids;
}

function toTerminalTransitionRequest(input: {
  readonly projectId: string;
  readonly request: RequestRoomTerminalizationInputV1;
  readonly contract: RoomTerminalizationContractEvidenceV1;
}): RoomTerminalTransitionRequestV1 {
  const independentVerificationRefs = Object.freeze([...input.contract.independentVerificationRefs]);
  const unresolvedRiskRefs = Object.freeze(
    [...input.contract.unresolvedRiskEvidence]
      .sort((left, right) => compareText(left.riskId, right.riskId))
      .map((risk) => risk.evidenceRef),
  );
  const command: RoomTerminalTransitionCommandV1 = input.request.requestedOutcome === "cancelled"
    ? {
        type: "cancel_room",
        outcome: "cancelled",
        reason: input.contract.cancellationReason as string,
      }
    : {
        type: "complete_room",
        outcome: input.request.requestedOutcome,
        completionContractRef: input.contract.completionContractRef,
        independentVerificationRefs,
        unresolvedRiskRefs,
      };

  return Object.freeze({
    projectId: input.projectId,
    roomId: input.request.roomId,
    expectedAggregateVersion: input.request.expectedAggregateVersion,
    idempotencyKey: input.request.idempotencyKey,
    correlationId: input.request.correlationId,
    terminalContractRecordId: input.contract.recordId,
    terminalContractRef: input.contract.completionContractRef,
    independentVerificationRefs,
    unresolvedRiskRefs,
    command,
  });
}

function withheld(
  requestedOutcome: RoomTerminalizationOutcomeV1 | null,
  terminalizationDecision: RoomTerminalizationDecisionV1 | null,
  blockers: readonly RoomTerminalizationCoordinatorBlockerV1[],
): RoomTerminalizationCoordinationResultV1 {
  return Object.freeze({
    status: "withheld" as const,
    requestedOutcome,
    terminalizationDecision,
    blockers: Object.freeze([...blockers]),
  });
}

function requestedOutcomeFrom(
  input: RequestRoomTerminalizationInputV1,
): RoomTerminalizationOutcomeV1 | null {
  const raw = input as unknown;
  return isRecord(raw) && isTerminalOutcome(raw.requestedOutcome)
    ? raw.requestedOutcome
    : null;
}

function isTerminalOutcome(value: unknown): value is RoomTerminalizationOutcomeV1 {
  return typeof value === "string" && TERMINAL_OUTCOME_SET.has(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasNonBlankUniqueStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isNonBlankString)
    && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addBlocker(
  blockers: RoomTerminalizationCoordinatorBlockerV1[],
  code: RoomTerminalizationCoordinatorBlockerCodeV1,
  message: string,
): void {
  blockers.push({ code, message });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
