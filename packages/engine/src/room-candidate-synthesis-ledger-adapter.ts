import type {
  AppendRoomCandidateInputV1,
  RoomCandidateRecordV1,
  RoomEvidenceLedgerAppendResult,
  RoomEvidenceLedgerScope,
} from "@fusion/core";

import type {
  AppendRoomCandidateSynthesisInputV1,
  RoomCandidateSynthesisAppendPortV1,
  RoomCandidateSynthesisAppendRecordV1,
} from "./room-candidate-synthesis-coordinator.js";

export interface RoomCandidateSynthesisCandidateLedgerPortV1 {
  appendCandidate(
    input: AppendRoomCandidateInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_candidates", RoomCandidateRecordV1>>;
}

export interface RoomCandidateSynthesisLedgerAdapterDependenciesV1 {
  readonly candidateLedger: RoomCandidateSynthesisCandidateLedgerPortV1;
}

export class RoomCandidateSynthesisLedgerAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoomCandidateSynthesisLedgerAdapterError";
  }
}

export class RoomCandidateSynthesisLedgerAdapter implements RoomCandidateSynthesisAppendPortV1 {
  public constructor(
    private readonly dependencies: RoomCandidateSynthesisLedgerAdapterDependenciesV1,
  ) {}

  public async appendSynthesis(
    input: AppendRoomCandidateSynthesisInputV1,
  ): Promise<RoomCandidateSynthesisAppendRecordV1> {
    const appendInput = buildAppendInput(input);
    const appendResult = await this.requireLedger().appendCandidate(appendInput);
    assertAppendedChild(appendResult, appendInput);
    return freeze({
      recordId: appendResult.record.id,
      candidateId: appendInput.id,
      revalidationRecorded: true as const,
      replayed: false,
    });
  }

  private requireLedger(): RoomCandidateSynthesisCandidateLedgerPortV1 {
    const ledger = this.dependencies?.candidateLedger;
    if (!isCandidateLedgerPort(ledger)) {
      throw new RoomCandidateSynthesisLedgerAdapterError(
        "Candidate-synthesis ledger adapter requires an appendCandidate ledger port.",
      );
    }
    return ledger;
  }
}

function buildAppendInput(input: AppendRoomCandidateSynthesisInputV1): AppendRoomCandidateInputV1 {
  if (!isRecord(input)) {
    throw new RoomCandidateSynthesisLedgerAdapterError("Candidate-synthesis append input must be a record.");
  }
  const scope = copyScope(input.comparison?.scope);
  const child = input.child;
  if (!isCandidate(child)) {
    throw new RoomCandidateSynthesisLedgerAdapterError("Candidate-synthesis child must be a complete candidate record.");
  }
  if (child.roomId !== scope.roomId || child.nodeId !== input.comparison.nodeId) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child must remain in the committed comparison Room and node scope.",
    );
  }
  const parentCandidateIds = copyLineage(child.parentCandidateIds, "child parent candidate IDs");
  if (parentCandidateIds.length < 2) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child must retain at least two distinct parent candidates.",
    );
  }
  if (parentCandidateIds.includes(child.id)) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child must be distinct from every parent candidate.",
    );
  }
  if (!sameSet(parentCandidateIds, input.comparison.parentCandidateIds)) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child parent lineage must match the committed comparison exactly.",
    );
  }
  assertFreshValidationBoundary(child, input.revalidation, parentCandidateIds);
  return freeze({
    scope,
    id: child.id,
    nodeId: child.nodeId,
    producingBindingId: child.producingBindingId,
    nativeSessionId: child.nativeSessionId,
    happierSessionId: child.happierSessionId,
    providerId: child.providerId,
    modelRef: child.modelRef,
    protocolId: child.protocolId,
    protocolVersion: child.protocolVersion,
    contextVersion: child.contextVersion,
    inputVersion: child.inputVersion,
    configVersion: child.configVersion,
    contentHash: child.contentHash,
    artifactIds: freezeStrings(child.artifactIds),
    parentCandidateIds,
    gateResultIds: freezeStrings([]),
    reviewIds: freezeStrings([]),
    createdAt: child.createdAt,
  });
}

function assertFreshValidationBoundary(
  child: RoomCandidateRecordV1,
  revalidation: AppendRoomCandidateSynthesisInputV1["revalidation"],
  parentCandidateIds: readonly string[],
): void {
  if (
    child.gateResultIds.length !== 0
    || child.reviewIds.length !== 0
    || child.promotionState !== "pending"
  ) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child must preserve fresh validation by starting pending with no inherited gates or reviews.",
    );
  }
  if (!isRecord(revalidation) || !sameLineage(revalidation.parentCandidateIds, parentCandidateIds)) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child revalidation obligation must retain the complete parent lineage.",
    );
  }
  if (
    revalidation.contractVersion !== 1
    || revalidation.status !== "required"
    || revalidation.required !== true
    || revalidation.hardGates !== true
    || revalidation.independentReview !== true
    || revalidation.promotion !== true
    || revalidation.inheritedVerdictsIgnored !== true
    || revalidation.reason !== "synthesized_child_requires_fresh_validation"
  ) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Synthesized child must retain the mandatory independent fresh-validation obligation.",
    );
  }
}

function assertAppendedChild(
  result: RoomEvidenceLedgerAppendResult<"room_candidates", RoomCandidateRecordV1>,
  expected: AppendRoomCandidateInputV1,
): void {
  if (!isRecord(result) || result.table !== "room_candidates" || !isCandidate(result.record)) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Candidate ledger did not confirm a complete immutable synthesized child.",
    );
  }
  const record = result.record;
  const preserved = record.id === expected.id
    && record.roomId === expected.scope.roomId
    && record.nodeId === expected.nodeId
    && record.producingBindingId === expected.producingBindingId
    && record.nativeSessionId === expected.nativeSessionId
    && record.happierSessionId === expected.happierSessionId
    && record.providerId === expected.providerId
    && record.modelRef === expected.modelRef
    && record.protocolId === expected.protocolId
    && record.protocolVersion === expected.protocolVersion
    && record.contextVersion === expected.contextVersion
    && record.inputVersion === expected.inputVersion
    && record.configVersion === expected.configVersion
    && record.contentHash === expected.contentHash
    && sameLineage(record.artifactIds, expected.artifactIds)
    && sameLineage(record.parentCandidateIds, expected.parentCandidateIds)
    && record.gateResultIds.length === 0
    && record.reviewIds.length === 0
    && record.promotionState === "pending"
    && record.createdAt === expected.createdAt;
  if (!preserved) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Candidate ledger response does not match the immutable synthesized child and fresh-validation boundary.",
    );
  }
}

function copyScope(value: unknown): RoomEvidenceLedgerScope {
  if (!isRecord(value) || !isNonBlank(value.projectId) || !isNonBlank(value.roomId)) {
    throw new RoomCandidateSynthesisLedgerAdapterError(
      "Candidate-synthesis append requires a committed project and Room scope.",
    );
  }
  return freeze({ projectId: value.projectId, roomId: value.roomId });
}

function copyLineage(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonBlank(entry))) {
    throw new RoomCandidateSynthesisLedgerAdapterError(`${label} must contain only nonblank candidate IDs.`);
  }
  if (new Set(value).size !== value.length) {
    throw new RoomCandidateSynthesisLedgerAdapterError(`${label} must not contain duplicate candidate IDs.`);
  }
  return freezeStrings(value);
}

function sameSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftValues = new Set(left);
  return leftValues.size === left.length && right.every((value) => leftValues.has(value));
}

function sameLineage(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCandidateLedgerPort(value: unknown): value is RoomCandidateSynthesisCandidateLedgerPortV1 {
  return isRecord(value) && typeof value.appendCandidate === "function";
}

function isCandidate(value: unknown): value is RoomCandidateRecordV1 {
  if (!isRecord(value)) return false;
  return value.contractVersion === 1
    && isNonBlank(value.id)
    && isNonBlank(value.roomId)
    && isNonBlank(value.nodeId)
    && isNonBlank(value.producingBindingId)
    && isNonBlank(value.nativeSessionId)
    && isNonBlank(value.happierSessionId)
    && isNonBlank(value.providerId)
    && isNonBlank(value.modelRef)
    && isNonBlank(value.protocolId)
    && typeof value.protocolVersion === "number"
    && Number.isSafeInteger(value.protocolVersion)
    && value.protocolVersion > 0
    && isNonBlank(value.contextVersion)
    && isNonBlank(value.inputVersion)
    && isNonBlank(value.configVersion)
    && isNonBlank(value.contentHash)
    && Array.isArray(value.artifactIds)
    && value.artifactIds.every(isNonBlank)
    && Array.isArray(value.parentCandidateIds)
    && value.parentCandidateIds.every(isNonBlank)
    && Array.isArray(value.gateResultIds)
    && value.gateResultIds.every(isNonBlank)
    && Array.isArray(value.reviewIds)
    && value.reviewIds.every(isNonBlank)
    && isPromotionState(value.promotionState)
    && isNonBlank(value.createdAt);
}

function isPromotionState(value: unknown): value is RoomCandidateRecordV1["promotionState"] {
  return value === "pending"
    || value === "eligible"
    || value === "promoted"
    || value === "rejected"
    || value === "superseded";
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return freeze([...values]);
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
