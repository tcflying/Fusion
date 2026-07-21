import { hashRoomValue } from "./room-integrity.js";
import {
  evaluateRoomTerminalization,
  type EvaluateRoomTerminalizationInputV1,
  type RoomTerminalizationDecisionV1,
  type RoomTerminalizationOutcomeV1,
  type RoomTerminalizationRiskSeverityV1,
} from "./room-terminalization.js";

export const ROOM_TERMINALIZATION_CONTRACT_VERSION = 1 as const;

export interface RoomTerminalizationRiskEvidenceRefV1 {
  readonly ref: string;
  readonly severity: RoomTerminalizationRiskSeverityV1;
  readonly acceptedByActorId: string | null;
}

/** Immutable controller-recorded proof snapshot; it never doubles as a model assertion. */
export interface RoomTerminalizationContractRecordV1 {
  readonly contractVersion: typeof ROOM_TERMINALIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  /** Aggregate version produced by the contract-recorded event. */
  readonly aggregateVersion: number;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
  readonly completionContractRef: string;
  readonly gateEvidenceSetId: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskEvidence: readonly RoomTerminalizationRiskEvidenceRefV1[];
  readonly cancellationReason: string | null;
  readonly terminalization: EvaluateRoomTerminalizationInputV1;
  readonly decision: RoomTerminalizationDecisionV1;
  readonly recordEventId: string;
  readonly recordedAt: string;
  readonly contractHash: string;
}

/** Mutable projection metadata; the contract above remains hash-bound and immutable. */
export interface RoomTerminalizationMarkerV1 {
  readonly contractId: string;
  readonly contractHash: string;
  readonly outcome: RoomTerminalizationOutcomeV1;
  readonly eventId: string;
  readonly aggregateVersion: number;
  readonly terminalizedAt: string;
}

export interface RoomTerminalizationContractProjectionV1 {
  readonly contractVersion: typeof ROOM_TERMINALIZATION_CONTRACT_VERSION;
  readonly contract: RoomTerminalizationContractRecordV1;
  readonly state: "recorded" | "terminalized";
  readonly terminalization: RoomTerminalizationMarkerV1 | null;
}

export interface CreateRoomTerminalizationContractInputV1 {
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly completionContractRef: string;
  readonly gateEvidenceSetId: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskEvidence: readonly RoomTerminalizationRiskEvidenceRefV1[];
  readonly cancellationReason: string | null;
  readonly terminalization: EvaluateRoomTerminalizationInputV1;
  readonly recordEventId: string;
  readonly recordedAt: string;
}

export class RoomTerminalizationContractError extends Error {
  constructor(
    readonly code: "invalid_terminalization_contract" | "terminalization_contract_hash_conflict",
    message: string,
  ) {
    super(message);
    this.name = "RoomTerminalizationContractError";
  }
}

/**
 * FNXC:RoomTerminalizationContract 2026-07-18-11:08:
 * A terminal decision must bind the controller's accepted contract, immutable
 * gate evidence, independent verification, risk disposition, and exact Room
 * version before it can change lifecycle state. The decision is recomputed from
 * the stored authoritative input; model consensus alone is never accepted.
 */
export function createRoomTerminalizationContract(
  input: CreateRoomTerminalizationContractInputV1,
): RoomTerminalizationContractRecordV1 {
  assertNonEmpty(input.id, "terminal contract id");
  assertNonEmpty(input.projectId, "terminal contract project id");
  assertNonEmpty(input.roomId, "terminal contract Room id");
  assertPositiveInteger(input.aggregateVersion, "terminal contract aggregate version");
  assertNonEmpty(input.protocolId, "terminal contract protocol id");
  assertPositiveInteger(input.protocolVersion, "terminal contract protocol version");
  assertNonEmpty(input.completionContractRef, "completion contract reference");
  assertNonEmpty(input.gateEvidenceSetId, "gate evidence set id");
  assertNonEmpty(input.recordEventId, "terminal contract record event id");
  assertCanonicalTimestamp(input.recordedAt, "terminal contract recordedAt");
  assertDistinctReferences(input.independentVerificationRefs, "independent verification references");
  assertRiskEvidence(input.unresolvedRiskEvidence);
  if (input.cancellationReason !== null) assertNonEmpty(input.cancellationReason, "cancellation reason");

  const decision = evaluateRoomTerminalization(input.terminalization);
  if (decision.canTerminalize && decision.outcome !== input.terminalization.requestedOutcome) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "A terminalizable decision outcome must exactly match its requested outcome",
    );
  }
  if (input.terminalization.protocol.id !== input.protocolId
    || input.terminalization.protocol.version !== input.protocolVersion) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Terminalization protocol must exactly match the controller-recorded protocol identity",
    );
  }
  /*
  FNXC:RoomTerminalizationContract 2026-07-18-11:58:
  The human-readable ledger reference and the policy-evaluated evidence must
  name the same immutable gate set. Otherwise a controller could bind a green
  decision to unrelated evidence after a retry or concurrent review.
  */
  if (input.terminalization.evidence.evidenceSetId !== input.gateEvidenceSetId) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Terminalization gate evidence must exactly match the controller-recorded gate evidence set",
    );
  }
  if (input.terminalization.requestedOutcome === "cancelled" && input.cancellationReason === null) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Cancelled terminalization requires a durable cancellation reason",
    );
  }
  const draft = {
    contractVersion: ROOM_TERMINALIZATION_CONTRACT_VERSION,
    id: input.id,
    projectId: input.projectId,
    roomId: input.roomId,
    aggregateVersion: input.aggregateVersion,
    protocolId: input.protocolId,
    protocolVersion: input.protocolVersion,
    requestedOutcome: input.terminalization.requestedOutcome,
    completionContractRef: input.completionContractRef,
    gateEvidenceSetId: input.gateEvidenceSetId,
    independentVerificationRefs: [...input.independentVerificationRefs].sort(),
    unresolvedRiskEvidence: canonicalizeRiskEvidence(input.unresolvedRiskEvidence),
    cancellationReason: input.cancellationReason,
    terminalization: structuredClone(input.terminalization),
    decision: structuredClone(decision),
    recordEventId: input.recordEventId,
    recordedAt: input.recordedAt,
  } satisfies Omit<RoomTerminalizationContractRecordV1, "contractHash">;
  return Object.freeze({
    ...draft,
    contractHash: hashRoomValue(draft),
  });
}

export function createRoomTerminalizationProjection(
  contract: RoomTerminalizationContractRecordV1,
): RoomTerminalizationContractProjectionV1 {
  assertRoomTerminalizationContract(contract);
  return Object.freeze({
    contractVersion: ROOM_TERMINALIZATION_CONTRACT_VERSION,
    contract: structuredClone(contract),
    state: "recorded",
    terminalization: null,
  });
}

export function terminalizeRoomTerminalizationProjection(
  projection: RoomTerminalizationContractProjectionV1,
  marker: RoomTerminalizationMarkerV1,
): RoomTerminalizationContractProjectionV1 {
  assertRoomTerminalizationProjection(projection);
  assertTerminalizationMarker(marker, projection.contract);
  if (projection.state === "terminalized") {
    if (hashRoomValue(projection.terminalization) !== hashRoomValue(marker)) {
      throw new RoomTerminalizationContractError(
        "invalid_terminalization_contract",
        `Terminalization contract ${projection.contract.id} was already terminalized differently`,
      );
    }
    return projection;
  }
  return Object.freeze({
    contractVersion: ROOM_TERMINALIZATION_CONTRACT_VERSION,
    contract: structuredClone(projection.contract),
    state: "terminalized",
    terminalization: structuredClone(marker),
  });
}

export function parseRoomTerminalizationProjection(
  value: unknown,
): RoomTerminalizationContractProjectionV1 | null {
  if (value === null || value === undefined || (isRecord(value) && Object.keys(value).length === 0)) return null;
  if (!isRecord(value)) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Room completion contract projection must be an object",
    );
  }
  const projection = value as unknown as RoomTerminalizationContractProjectionV1;
  assertRoomTerminalizationProjection(projection);
  return Object.freeze({
    contractVersion: projection.contractVersion,
    contract: structuredClone(projection.contract),
    state: projection.state,
    terminalization: projection.terminalization ? structuredClone(projection.terminalization) : null,
  });
}

export function assertRoomTerminalizationContract(
  value: unknown,
): asserts value is RoomTerminalizationContractRecordV1 {
  if (!isRecord(value)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization contract must be an object");
  }
  const contract = value as unknown as RoomTerminalizationContractRecordV1;
  if (contract.contractVersion !== ROOM_TERMINALIZATION_CONTRACT_VERSION) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Unsupported terminalization contract version");
  }
  assertNonEmpty(contract.id, "terminal contract id");
  assertNonEmpty(contract.projectId, "terminal contract project id");
  assertNonEmpty(contract.roomId, "terminal contract Room id");
  assertPositiveInteger(contract.aggregateVersion, "terminal contract aggregate version");
  assertNonEmpty(contract.protocolId, "terminal contract protocol id");
  assertPositiveInteger(contract.protocolVersion, "terminal contract protocol version");
  assertTerminalOutcome(contract.requestedOutcome, "terminal contract requested outcome");
  assertNonEmpty(contract.completionContractRef, "completion contract reference");
  assertNonEmpty(contract.gateEvidenceSetId, "gate evidence set id");
  assertDistinctReferences(contract.independentVerificationRefs, "independent verification references");
  assertRiskEvidence(contract.unresolvedRiskEvidence);
  if (contract.cancellationReason !== null) assertNonEmpty(contract.cancellationReason, "cancellation reason");
  assertNonEmpty(contract.recordEventId, "terminal contract record event id");
  assertCanonicalTimestamp(contract.recordedAt, "terminal contract recordedAt");
  if (!isRecord(contract.terminalization) || !isRecord(contract.decision)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization input and decision must be objects");
  }
  const recomputed = evaluateRoomTerminalization(contract.terminalization);
  if (
    (recomputed.canTerminalize && recomputed.outcome !== contract.requestedOutcome)
    || (!recomputed.canTerminalize && recomputed.outcome !== null)
    || hashRoomValue(recomputed) !== hashRoomValue(contract.decision)
  ) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Terminalization decision does not reproduce from its authoritative evidence input",
    );
  }
  if (contract.terminalization.protocol.id !== contract.protocolId
    || contract.terminalization.protocol.version !== contract.protocolVersion
    || contract.terminalization.requestedOutcome !== contract.requestedOutcome) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Terminalization input does not match its persisted protocol or requested outcome",
    );
  }
  if (contract.terminalization.evidence.evidenceSetId !== contract.gateEvidenceSetId) {
    throw new RoomTerminalizationContractError(
      "invalid_terminalization_contract",
      "Terminalization input does not match its persisted gate evidence set",
    );
  }
  if (contract.requestedOutcome === "cancelled" && contract.cancellationReason === null) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Cancelled contract has no cancellation reason");
  }
  assertNonEmpty(contract.contractHash, "terminal contract hash");
  const { contractHash: ignoredHash, ...unsigned } = contract;
  if (ignoredHash !== hashRoomValue(unsigned)) {
    throw new RoomTerminalizationContractError(
      "terminalization_contract_hash_conflict",
      `Terminalization contract ${contract.id} integrity hash does not match`,
    );
  }
}

export function assertRoomTerminalizationProjection(
  value: unknown,
): asserts value is RoomTerminalizationContractProjectionV1 {
  if (!isRecord(value)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization projection must be an object");
  }
  const projection = value as unknown as RoomTerminalizationContractProjectionV1;
  if (projection.contractVersion !== ROOM_TERMINALIZATION_CONTRACT_VERSION) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Unsupported terminalization projection version");
  }
  assertRoomTerminalizationContract(projection.contract);
  if (projection.state !== "recorded" && projection.state !== "terminalized") {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization projection state is invalid");
  }
  if (projection.state === "recorded" && projection.terminalization !== null) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Recorded contract cannot contain a terminalization marker");
  }
  if (projection.state === "terminalized") {
    assertTerminalizationMarker(projection.terminalization, projection.contract);
  }
}

function assertTerminalizationMarker(
  value: unknown,
  contract: RoomTerminalizationContractRecordV1,
): asserts value is RoomTerminalizationMarkerV1 {
  if (!isRecord(value)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization marker must be an object");
  }
  const marker = value as unknown as RoomTerminalizationMarkerV1;
  if (marker.contractId !== contract.id || marker.contractHash !== contract.contractHash) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization marker does not bind the recorded contract");
  }
  assertTerminalOutcome(marker.outcome, "terminalization marker outcome");
  if (marker.outcome !== contract.requestedOutcome) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization marker outcome differs from contract");
  }
  assertNonEmpty(marker.eventId, "terminalization marker event id");
  assertPositiveInteger(marker.aggregateVersion, "terminalization marker aggregate version");
  if (marker.aggregateVersion !== contract.aggregateVersion + 1) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Terminalization marker must immediately follow contract aggregate version");
  }
  assertCanonicalTimestamp(marker.terminalizedAt, "terminalization marker timestamp");
}

function canonicalizeRiskEvidence(
  value: readonly RoomTerminalizationRiskEvidenceRefV1[],
): readonly RoomTerminalizationRiskEvidenceRefV1[] {
  return [...value]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function assertRiskEvidence(value: unknown): asserts value is readonly RoomTerminalizationRiskEvidenceRefV1[] {
  if (!Array.isArray(value)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Unresolved risk evidence must be an array");
  }
  const refs = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Risk evidence entry must be an object");
    }
    assertNonEmpty(entry.ref, "risk evidence reference");
    if (refs.has(entry.ref)) {
      throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Risk evidence references must be unique");
    }
    refs.add(entry.ref);
    if (entry.severity !== "low" && entry.severity !== "medium" && entry.severity !== "high" && entry.severity !== "critical") {
      throw new RoomTerminalizationContractError("invalid_terminalization_contract", "Risk evidence severity is invalid");
    }
    if (entry.acceptedByActorId !== null) assertNonEmpty(entry.acceptedByActorId, "risk acceptance actor");
  }
}

function assertTerminalOutcome(value: unknown, label: string): asserts value is RoomTerminalizationOutcomeV1 {
  if (!["completed", "completed_with_risks", "partial", "blocked", "cancelled", "failed"].includes(value as string)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} is invalid`);
  }
}

function assertDistinctReferences(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} must be an array`);
  }
  const refs = new Set<string>();
  for (const ref of value) {
    assertNonEmpty(ref, label);
    if (refs.has(ref)) {
      throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} must be unique`);
    }
    refs.add(ref);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} must be a positive safe integer`);
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} must be canonical UTC`);
  }
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new RoomTerminalizationContractError("invalid_terminalization_contract", `${label} must be a canonical non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
