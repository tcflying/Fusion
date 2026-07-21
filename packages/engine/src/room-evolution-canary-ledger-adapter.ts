import {
  allocateRoomEvolutionCanary,
  hashRoomValue,
  type AllocateRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCanaryInputV1,
  type AsyncRoomEvolutionLedger,
  type RoomEvolutionCanaryAllocationV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionLedgerScope,
} from "@fusion/core";

export const ROOM_EVOLUTION_CANARY_LEDGER_ADAPTER_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionCanaryLedgerContextSnapshotV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_LEDGER_ADAPTER_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly candidateHash: string;
  readonly candidateProducerActorId: string;
  readonly canaryControllerActorId: string;
  readonly rollbackTargetCandidateVersionId: string;
  readonly allocationVersion: number;
  readonly hardGateResultIds: readonly string[];
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
}

export interface RoomEvolutionCanaryLedgerContextReaderV1 {
  readCanaryContext(input: {
    readonly allocationInput: AllocateRoomEvolutionCanaryInputV1;
    readonly allocation: RoomEvolutionCanaryAllocationV1;
  }): Promise<RoomEvolutionCanaryLedgerContextSnapshotV1 | null>;
}

export type RoomEvolutionCanaryLedgerV1 = Pick<AsyncRoomEvolutionLedger, "appendCanary">;

export interface RoomEvolutionCanaryLedgerAdapterDependenciesV1 {
  readonly contextReader: RoomEvolutionCanaryLedgerContextReaderV1;
  readonly ledger: RoomEvolutionCanaryLedgerV1;
}

export interface AppendRoomEvolutionCanaryPlanInputV1 {
  readonly allocationInput: AllocateRoomEvolutionCanaryInputV1;
  readonly allocation: RoomEvolutionCanaryAllocationV1;
}

export type RoomEvolutionCanaryLedgerAdapterErrorCodeV1 =
  | "invalid_input"
  | "controller_result_invalid"
  | "context_snapshot_unavailable"
  | "context_snapshot_invalid"
  | "self_acceptance_forbidden"
  | "ledger_response_invalid";

export class RoomEvolutionCanaryLedgerAdapterError extends Error {
  public constructor(
    readonly code: RoomEvolutionCanaryLedgerAdapterErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionCanaryLedgerAdapterError";
  }
}

export class RoomEvolutionCanaryLedgerAdapter {
  public constructor(
    private readonly dependencies: RoomEvolutionCanaryLedgerAdapterDependenciesV1,
  ) {}

  public async appendPlan(
    input: AppendRoomEvolutionCanaryPlanInputV1,
  ): Promise<{ readonly canaryId: string; readonly recordId: string; readonly replayed: false }> {
    const approved = requireApprovedAllocation(input);
    const context = await this.requireContextReader().readCanaryContext(freeze({
      allocationInput: clone(input.allocationInput),
      allocation: clone(approved),
    }));
    const appendInput = deriveCanaryAppendInput(input.allocationInput, approved, context);
    const appended = await this.requireLedger().appendCanary(appendInput);
    assertCanaryAppendResult(appended, appendInput);
    return freeze({ canaryId: appendInput.id, recordId: appendInput.id, replayed: false as const });
  }

  private requireContextReader(): RoomEvolutionCanaryLedgerContextReaderV1 {
    const reader = this.dependencies?.contextReader;
    if (reader === undefined || typeof reader.readCanaryContext !== "function") {
      throw new RoomEvolutionCanaryLedgerAdapterError(
        "invalid_input",
        "Canary ledger adapter requires an immutable canary plan context reader.",
      );
    }
    return reader;
  }

  private requireLedger(): RoomEvolutionCanaryLedgerV1 {
    const ledger = this.dependencies?.ledger;
    if (ledger === undefined || typeof ledger.appendCanary !== "function") {
      throw new RoomEvolutionCanaryLedgerAdapterError(
        "invalid_input",
        "Canary ledger adapter requires an immutable canary append port.",
      );
    }
    return ledger;
  }
}

function requireApprovedAllocation(input: unknown): RoomEvolutionCanaryAllocationV1 {
  if (!isRecord(input) || !isRecord(input.allocationInput) || !isRecord(input.allocation)) {
    throw invalidInput("Canary plan input must include an allocation request and allocation result.");
  }
  const approved = allocateRoomEvolutionCanary(input.allocationInput as unknown as AllocateRoomEvolutionCanaryInputV1);
  if (!approved.ok || approved.status !== "allocated" || !sameValue(approved.allocation, input.allocation)) {
    throw new RoomEvolutionCanaryLedgerAdapterError(
      "controller_result_invalid",
      "Canary allocation must exactly equal the bounded allocation approved by the Core canary controller.",
    );
  }
  return clone(approved.allocation);
}

function deriveCanaryAppendInput(
  allocationInput: AllocateRoomEvolutionCanaryInputV1,
  allocation: RoomEvolutionCanaryAllocationV1,
  context: RoomEvolutionCanaryLedgerContextSnapshotV1 | null,
): AppendRoomEvolutionCanaryInputV1 {
  assertPlanContext(context, allocationInput, allocation);
  const evidence = clone(context.evidence);
  return freeze({
    scope: clone(context.scope),
    id: allocation.id,
    experimentId: context.experimentId,
    candidateVersionId: allocation.candidateVersionId,
    allocationVersion: context.allocationVersion,
    allocation: freeze({
      ...clone(allocation),
      controllerRequestHash: hashRoomValue(allocationInput),
      controllerAllocationHash: hashRoomValue(allocation),
      independentAuthorization: clone(allocationInput.authorization),
      candidateProducerActorId: context.candidateProducerActorId,
      canaryControllerActorId: context.canaryControllerActorId,
      evidence,
      evidenceHash: hashRoomValue({ allocationId: allocation.id, evidence }),
    }),
    successCriteria: freeze({
      allocationId: allocation.id,
      baselineSnapshotId: allocation.baselineSnapshotId,
      minimumSamplesPerRoom: allocation.policy.minimumSamplesPerRoom,
      objectives: clone(allocation.policy.objectives),
      hardGateResultIds: canonicalIdentifierList(context.hardGateResultIds),
      requiredOutcome: "eligible_for_independent_promotion",
      modelSelfAcceptanceExcluded: true,
    }),
    failureCriteria: freeze({
      allocationId: allocation.id,
      rollbackTargetVersionId: allocation.rollbackTargetVersionId,
      objectives: clone(allocation.policy.objectives),
      requiredOutcome: "rollback_required",
    }),
    state: "planned" as const,
    rollbackTargetCandidateVersionId: context.rollbackTargetCandidateVersionId,
    createdAt: allocation.allocatedAt,
  });
}

function assertPlanContext(
  context: RoomEvolutionCanaryLedgerContextSnapshotV1 | null,
  allocationInput: AllocateRoomEvolutionCanaryInputV1,
  allocation: RoomEvolutionCanaryAllocationV1,
): asserts context is RoomEvolutionCanaryLedgerContextSnapshotV1 {
  if (context === null) {
    throw new RoomEvolutionCanaryLedgerAdapterError(
      "context_snapshot_unavailable",
      `No immutable canary plan context was available for ${allocation.id}.`,
    );
  }
  if (
    !isRecord(context)
    || !hasExactKeys(context, [
      "contractVersion", "scope", "experimentId", "candidateVersionId", "candidateHash",
      "candidateProducerActorId", "canaryControllerActorId", "rollbackTargetCandidateVersionId",
      "allocationVersion", "hardGateResultIds", "evidence",
    ])
    || context.contractVersion !== ROOM_EVOLUTION_CANARY_LEDGER_ADAPTER_CONTRACT_VERSION
    || !isScope(context.scope)
    || !isIdentifier(context.experimentId)
    || !isIdentifier(context.candidateVersionId)
    || !isHash(context.candidateHash)
    || !isIdentifier(context.candidateProducerActorId)
    || !isIdentifier(context.canaryControllerActorId)
    || !isIdentifier(context.rollbackTargetCandidateVersionId)
    || !isPositiveInteger(context.allocationVersion)
    || !isIdentifierList(context.hardGateResultIds)
    || !isEvidence(context.evidence)
    || context.scope.projectId !== allocation.projectId
    || (context.scope.roomId !== null && !allocation.roomIds.includes(context.scope.roomId))
    || context.candidateVersionId !== allocation.candidateVersionId
    || context.candidateHash !== allocation.candidateHash
    || context.rollbackTargetCandidateVersionId !== allocation.rollbackTargetVersionId
    || !sameIdentifierSet(context.hardGateResultIds, allocationInput.authorization.gateResultIds)
  ) {
    throw new RoomEvolutionCanaryLedgerAdapterError(
      "context_snapshot_invalid",
      "Canary plan context must bind the exact approved project, candidate, rollback lineage, and immutable evidence.",
    );
  }
  if (context.canaryControllerActorId === context.candidateProducerActorId) {
    throw new RoomEvolutionCanaryLedgerAdapterError(
      "self_acceptance_forbidden",
      "Candidate producer cannot approve or persist its own canary plan.",
    );
  }
}

function canonicalIdentifierList(value: readonly string[]): readonly string[] {
  return Object.freeze([...value].sort());
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = canonicalIdentifierList(left);
  const sortedRight = canonicalIdentifierList(right);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertCanaryAppendResult(
  appended: RoomEvolutionLedgerAppendResult<"room_evolution_canaries", RoomEvolutionCanaryRecordV1>,
  expected: AppendRoomEvolutionCanaryInputV1,
): void {
  if (
    !isRecord(appended)
    || appended.table !== "room_evolution_canaries"
    || !isRecord(appended.record)
    || appended.record.contractVersion !== 1
    || appended.record.id !== expected.id
    || appended.record.projectId !== expected.scope.projectId
    || appended.record.roomId !== expected.scope.roomId
    || appended.record.scopeKind !== expected.scope.scopeKind
    || appended.record.scopeKey !== expected.scope.scopeKey
    || appended.record.experimentId !== expected.experimentId
    || appended.record.candidateVersionId !== expected.candidateVersionId
    || appended.record.allocationVersion !== expected.allocationVersion
    || appended.record.state !== expected.state
    || appended.record.rollbackTargetCandidateVersionId !== expected.rollbackTargetCandidateVersionId
    || appended.record.createdAt !== expected.createdAt
    || !sameValue(appended.record.allocation, expected.allocation)
    || !sameValue(appended.record.successCriteria, expected.successCriteria)
    || !sameValue(appended.record.failureCriteria, expected.failureCriteria)
  ) {
    throw new RoomEvolutionCanaryLedgerAdapterError(
      "ledger_response_invalid",
      "Core canary ledger did not acknowledge the exact immutable canary plan.",
    );
  }
}

function invalidInput(message: string): RoomEvolutionCanaryLedgerAdapterError {
  return new RoomEvolutionCanaryLedgerAdapterError("invalid_input", message);
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return hashRoomValue(left) === hashRoomValue(right);
  } catch {
    return false;
  }
}

function isScope(value: unknown): value is RoomEvolutionLedgerScope {
  if (!isRecord(value) || !hasExactKeys(value, ["projectId", "roomId", "scopeKind", "scopeKey"]) || !isIdentifier(value.projectId)) return false;
  if (value.scopeKind === "project") {
    return value.roomId === null && value.scopeKey === `project:${value.projectId}`;
  }
  return value.scopeKind === "room"
    && isIdentifier(value.roomId)
    && value.scopeKey === `room:${value.roomId}`;
}

function isEvidence(value: unknown): value is readonly RoomEvolutionEvidenceRefV1[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["id", "source", "sourceRef", "evidenceHash", "observedAt"])) return false;
    const { id, source, sourceRef, evidenceHash, observedAt } = entry;
    if (
      !isIdentifier(id)
      || typeof source !== "string"
      || !EVIDENCE_SOURCES.has(source)
      || !isIdentifier(sourceRef)
      || !isHash(evidenceHash)
      || !isTimestamp(observedAt)
      || ids.has(id)
    ) return false;
    ids.add(id);
    return true;
  });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isIdentifier) && new Set(value).size === value.length;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function clone<TValue>(value: TValue): TValue {
  return deepFreeze(structuredClone(value));
}

function freeze<TValue>(value: TValue): TValue {
  return deepFreeze(value);
}

function deepFreeze<TValue>(value: TValue, seen = new WeakSet<object>()): TValue {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const EVIDENCE_SOURCES = new Set([
  "deterministic_gate",
  "human_correction",
  "durable_room_ledger",
  "independent_review",
  "authorized_observed_outcome",
  "room_metric",
]);
