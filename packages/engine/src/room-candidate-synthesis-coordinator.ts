import type { RoomCandidateRecordV1, RoomEvidenceLedgerScope } from "@fusion/core";

export const ROOM_CANDIDATE_SYNTHESIS_COORDINATOR_CONTRACT_VERSION = 1 as const;

export interface RoomCandidateSynthesisCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * A candidate-comparison adapter may return this only after it has read a
 * committed comparison record from the durable evidence ledger.
 */
export interface RoomCandidateSynthesisPersistedComparisonV1 {
  readonly persistence: "committed";
  readonly id: string;
  readonly scope: RoomEvidenceLedgerScope;
  readonly nodeId: string;
  readonly parentCandidateIds: readonly string[];
  readonly conclusion: string;
  readonly concludedAt: string;
}

/** A parent is never supplied as an unverified caller-owned candidate draft. */
export interface RoomCandidateSynthesisPersistedParentV1 {
  readonly persistence: "committed";
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomCandidateRecordV1;
}

export interface RoomCandidateSynthesisChildDraftV1 {
  readonly contractVersion: RoomCandidateRecordV1["contractVersion"];
  readonly id: string;
  readonly producingBindingId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly providerId: string;
  readonly modelRef: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly contextVersion: string;
  readonly inputVersion: string;
  readonly configVersion: string;
  readonly contentHash: string;
  readonly artifactIds: readonly string[];
  /** Must be empty because parent gate results are never inherited by a child. */
  readonly gateResultIds: readonly string[];
  /** Must be empty because parent reviews are never inherited by a child. */
  readonly reviewIds: readonly string[];
  /** Must remain pending until the child completes fresh validation. */
  readonly promotionState: RoomCandidateRecordV1["promotionState"];
  readonly createdAt: string;
}

export interface RequestRoomCandidateSynthesisV1 {
  readonly contractVersion: typeof ROOM_CANDIDATE_SYNTHESIS_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly nodeId: string;
  readonly comparisonId: string;
  readonly parentCandidateIds: readonly string[];
  readonly command: RoomCandidateSynthesisCommandIdentityV1;
  readonly child: RoomCandidateSynthesisChildDraftV1;
}

export interface RoomCandidateSynthesisRevalidationV1 {
  readonly contractVersion: typeof ROOM_CANDIDATE_SYNTHESIS_COORDINATOR_CONTRACT_VERSION;
  readonly status: "required";
  readonly required: true;
  readonly hardGates: true;
  readonly independentReview: true;
  readonly promotion: true;
  readonly inheritedVerdictsIgnored: true;
  readonly parentCandidateIds: readonly string[];
  readonly reason: "synthesized_child_requires_fresh_validation";
}

export interface AppendRoomCandidateSynthesisInputV1 {
  readonly command: RoomCandidateSynthesisCommandIdentityV1;
  readonly comparison: RoomCandidateSynthesisPersistedComparisonV1;
  readonly child: RoomCandidateRecordV1;
  readonly revalidation: RoomCandidateSynthesisRevalidationV1;
}

export interface RoomCandidateSynthesisAppendRecordV1 {
  readonly recordId: string;
  readonly candidateId: string;
  readonly revalidationRecorded: true;
  readonly replayed: boolean;
}

/**
 * FNXC:RoomCandidateSynthesis 2026-07-19-12:18:
 * OpenSpec 7.5 requires a synthesized result to be a distinct immutable child,
 * not an overwrite or inherited acceptance. The eventual adapter must atomically
 * persist this child and its fresh-validation obligation before Engine exposes it.
 */
export interface RoomCandidateSynthesisAppendPortV1 {
  appendSynthesis(input: AppendRoomCandidateSynthesisInputV1): Promise<RoomCandidateSynthesisAppendRecordV1>;
}

/**
 * FNXC:RoomCandidateSynthesis 2026-07-19-12:18:
 * Synthesis accepts only ledger-read parent candidates and a committed explicit
 * comparison conclusion. This boundary deliberately has no model or network API.
 */
export interface RoomCandidateSynthesisSourcePortV1 {
  loadPersistedComparison(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly nodeId: string;
    readonly comparisonId: string;
  }): Promise<RoomCandidateSynthesisPersistedComparisonV1 | null>;
  loadPersistedParents(input: {
    readonly candidateIds: readonly string[];
  }): Promise<readonly RoomCandidateSynthesisPersistedParentV1[]>;
  findPersistedCandidateById(input: {
    readonly candidateId: string;
  }): Promise<RoomCandidateSynthesisPersistedParentV1 | null>;
}

export interface RoomCandidateSynthesisCoordinatorDependenciesV1 {
  readonly source: RoomCandidateSynthesisSourcePortV1;
  readonly append: RoomCandidateSynthesisAppendPortV1;
}

export type RoomCandidateSynthesisWithheldCodeV1 =
  | "invalid_request"
  | "source_port_invalid"
  | "append_port_invalid"
  | "duplicate_parent_reference"
  | "parent_reference_count_invalid"
  | "child_id_conflicts_parent"
  | "child_id_already_exists"
  | "comparison_not_found"
  | "comparison_invalid"
  | "comparison_scope_mismatch"
  | "comparison_parent_mismatch"
  | "parent_source_invalid"
  | "parent_not_found"
  | "parent_scope_mismatch"
  | "child_inherits_gate_results"
  | "child_inherits_reviews"
  | "child_inherits_promotion";

export interface RoomCandidateSynthesisWithheldResultV1 {
  readonly status: "withheld";
  readonly reason: {
    readonly code: RoomCandidateSynthesisWithheldCodeV1;
    readonly message: string;
  };
}

export interface RoomCandidateSynthesisCreatedResultV1 {
  readonly status: "created";
  readonly comparison: RoomCandidateSynthesisPersistedComparisonV1;
  readonly child: RoomCandidateRecordV1;
  readonly revalidation: RoomCandidateSynthesisRevalidationV1;
  readonly record: RoomCandidateSynthesisAppendRecordV1;
}

export interface RoomCandidateSynthesisAppendFailedResultV1 {
  readonly status: "append_failed";
  readonly reason: {
    readonly code: "append_failed" | "append_response_invalid";
    readonly message: string;
  };
  readonly child: RoomCandidateRecordV1;
  readonly revalidation: RoomCandidateSynthesisRevalidationV1;
}

export type RoomCandidateSynthesisResultV1 =
  | RoomCandidateSynthesisWithheldResultV1
  | RoomCandidateSynthesisCreatedResultV1
  | RoomCandidateSynthesisAppendFailedResultV1;

/**
 * FNXC:RoomCandidateSynthesis 2026-07-19-12:18:
 * The Engine synthesis boundary is intentionally pure DI. It has no provider,
 * model, or network call; a durable source proves parentage and a typed append
 * port records the new pending child before a successful result is observable.
 */
export class RoomCandidateSynthesisCoordinator {
  public constructor(
    private readonly dependencies: RoomCandidateSynthesisCoordinatorDependenciesV1,
  ) {}

  public async synthesize(rawInput: RequestRoomCandidateSynthesisV1): Promise<RoomCandidateSynthesisResultV1> {
    const requestIssue = validateRequest(rawInput);
    if (requestIssue !== null) return withheld(requestIssue.code, requestIssue.message);
    const input = rawInput;

    const source = this.dependencies?.source;
    if (!isSourcePort(source)) {
      return withheld("source_port_invalid", "Persisted candidate and comparison source is unavailable.");
    }
    const append = this.dependencies?.append;
    if (!isAppendPort(append)) {
      return withheld("append_port_invalid", "Candidate-synthesis append port is unavailable.");
    }

    const parentIds = [...input.parentCandidateIds];
    if (new Set(parentIds).size !== parentIds.length) {
      return withheld("duplicate_parent_reference", "A synthesized child must reference each parent exactly once.");
    }
    if (parentIds.length < 2) {
      return withheld("parent_reference_count_invalid", "A synthesis requires at least two distinct persisted parents.");
    }
    if (parentIds.includes(input.child.id)) {
      return withheld("child_id_conflicts_parent", "A synthesized child ID cannot equal one of its parent IDs.");
    }
    if (input.child.gateResultIds.length > 0) {
      return withheld("child_inherits_gate_results", "A synthesized child must not inherit parent gate results.");
    }
    if (input.child.reviewIds.length > 0) {
      return withheld("child_inherits_reviews", "A synthesized child must not inherit parent reviews.");
    }
    if (input.child.promotionState !== "pending") {
      return withheld("child_inherits_promotion", "A synthesized child must begin pending and cannot inherit promotion state.");
    }

    let existing: RoomCandidateSynthesisPersistedParentV1 | null;
    try {
      existing = await source.findPersistedCandidateById({ candidateId: input.child.id });
    } catch (error) {
      return withheld("source_port_invalid", `Could not verify child candidate uniqueness: ${messageOf(error)}`);
    }
    if (existing !== null) {
      return withheld("child_id_already_exists", "A candidate with the requested child ID is already committed.");
    }

    let comparison: RoomCandidateSynthesisPersistedComparisonV1 | null;
    try {
      comparison = await source.loadPersistedComparison({
        scope: copyScope(input.scope),
        nodeId: input.nodeId,
        comparisonId: input.comparisonId,
      });
    } catch (error) {
      return withheld("comparison_not_found", `Could not read the committed comparison conclusion: ${messageOf(error)}`);
    }
    if (comparison === null) {
      return withheld("comparison_not_found", "No committed comparison conclusion exists for this synthesis request.");
    }
    if (!isPersistedComparison(comparison)) {
      return withheld("comparison_invalid", "The comparison source did not return a committed explicit conclusion.");
    }
    if (!sameScope(comparison.scope, input.scope) || comparison.nodeId !== input.nodeId) {
      return withheld("comparison_scope_mismatch", "The committed comparison does not belong to the requested project, Room, and node.");
    }
    if (!sameTextSet(comparison.parentCandidateIds, parentIds)) {
      return withheld("comparison_parent_mismatch", "The committed comparison did not conclude over exactly the requested parents.");
    }

    let parents: readonly RoomCandidateSynthesisPersistedParentV1[];
    try {
      parents = await source.loadPersistedParents({ candidateIds: freezeStrings(parentIds) });
    } catch (error) {
      return withheld("parent_source_invalid", `Could not read persisted parent candidates: ${messageOf(error)}`);
    }
    const parentIssue = validateParents(parents, parentIds, input.scope, input.nodeId);
    if (parentIssue !== null) return withheld(parentIssue.code, parentIssue.message);

    const child = freezeCandidate({
      contractVersion: input.child.contractVersion,
      id: input.child.id,
      roomId: input.scope.roomId,
      nodeId: input.nodeId,
      producingBindingId: input.child.producingBindingId,
      nativeSessionId: input.child.nativeSessionId,
      happierSessionId: input.child.happierSessionId,
      providerId: input.child.providerId,
      modelRef: input.child.modelRef,
      protocolId: input.child.protocolId,
      protocolVersion: input.child.protocolVersion,
      contextVersion: input.child.contextVersion,
      inputVersion: input.child.inputVersion,
      configVersion: input.child.configVersion,
      contentHash: input.child.contentHash,
      artifactIds: input.child.artifactIds,
      parentCandidateIds: parentIds,
      gateResultIds: [],
      reviewIds: [],
      promotionState: "pending",
      createdAt: input.child.createdAt,
    });
    const revalidation = freezeRevalidation(parentIds);
    const appendInput = freezeAppendInput({
      command: freezeCommand(input.command),
      comparison: freezeComparison(comparison),
      child,
      revalidation,
    });

    try {
      const record = await append.appendSynthesis(appendInput);
      if (!isAppendRecord(record, child.id)) {
        return appendFailed("append_response_invalid", "The append port did not confirm the requested child and revalidation obligation.", child, revalidation);
      }
      return freeze({
        status: "created" as const,
        comparison: appendInput.comparison,
        child,
        revalidation,
        record: freeze({ ...record }),
      });
    } catch (error) {
      return appendFailed("append_failed", `The child was not reported created because durable append failed: ${messageOf(error)}`, child, revalidation);
    }
  }
}

function validateRequest(input: unknown): { readonly code: "invalid_request"; readonly message: string } | null {
  if (!isRecord(input) || input.contractVersion !== ROOM_CANDIDATE_SYNTHESIS_COORDINATOR_CONTRACT_VERSION) {
    return { code: "invalid_request", message: "Candidate-synthesis request has an unsupported contract version." };
  }
  if (!isScope(input.scope) || !isNonBlank(input.nodeId) || !isNonBlank(input.comparisonId)) {
    return { code: "invalid_request", message: "Candidate-synthesis request must provide a project, Room, node, and comparison identity." };
  }
  if (!Array.isArray(input.parentCandidateIds) || input.parentCandidateIds.some((id) => !isNonBlank(id))) {
    return { code: "invalid_request", message: "Candidate-synthesis parent references must be nonblank identifiers." };
  }
  if (!isCommand(input.command) || !isChildDraft(input.child)) {
    return { code: "invalid_request", message: "Candidate-synthesis request contains an invalid command identity or child draft." };
  }
  return null;
}

function validateParents(
  parents: unknown,
  requestedIds: readonly string[],
  scope: RoomEvidenceLedgerScope,
  nodeId: string,
): { readonly code: "parent_source_invalid" | "parent_not_found" | "parent_scope_mismatch"; readonly message: string } | null {
  if (!Array.isArray(parents)) {
    return { code: "parent_source_invalid", message: "Persisted-parent source must return an array." };
  }
  const byId = new Map<string, RoomCandidateSynthesisPersistedParentV1>();
  for (const parent of parents) {
    if (!isPersistedParent(parent) || byId.has(parent.candidate.id)) {
      return { code: "parent_source_invalid", message: "Persisted-parent source returned an invalid or duplicate parent record." };
    }
    byId.set(parent.candidate.id, parent);
  }
  if ([...byId.keys()].some((id) => !requestedIds.includes(id))) {
    return { code: "parent_source_invalid", message: "Persisted-parent source returned a parent that was not requested." };
  }
  for (const id of requestedIds) {
    const parent = byId.get(id);
    if (!parent) {
      return { code: "parent_not_found", message: `Parent candidate ${id} was not found in the durable source.` };
    }
    if (
      !sameScope(parent.scope, scope)
      || parent.candidate.roomId !== scope.roomId
      || parent.candidate.nodeId !== nodeId
    ) {
      return { code: "parent_scope_mismatch", message: `Parent candidate ${id} is outside the requested project, Room, or node scope.` };
    }
  }
  return null;
}

function isPersistedComparison(value: unknown): value is RoomCandidateSynthesisPersistedComparisonV1 {
  return isRecord(value)
    && value.persistence === "committed"
    && isNonBlank(value.id)
    && isScope(value.scope)
    && isNonBlank(value.nodeId)
    && Array.isArray(value.parentCandidateIds)
    && value.parentCandidateIds.every(isNonBlank)
    && isNonBlank(value.conclusion)
    && isTimestamp(value.concludedAt);
}

function isPersistedParent(value: unknown): value is RoomCandidateSynthesisPersistedParentV1 {
  return isRecord(value)
    && value.persistence === "committed"
    && isScope(value.scope)
    && isCandidate(value.candidate);
}

function isCandidate(value: unknown): value is RoomCandidateRecordV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isNonBlank(value.id)
    && isNonBlank(value.roomId)
    && isNonBlank(value.nodeId)
    && isNonBlank(value.producingBindingId)
    && isNonBlank(value.nativeSessionId)
    && isNonBlank(value.happierSessionId)
    && isNonBlank(value.providerId)
    && isNonBlank(value.modelRef)
    && isNonBlank(value.protocolId)
    && isPositiveInteger(value.protocolVersion)
    && isNonBlank(value.contextVersion)
    && isNonBlank(value.inputVersion)
    && isNonBlank(value.configVersion)
    && isNonBlank(value.contentHash)
    && stringArray(value.artifactIds)
    && stringArray(value.parentCandidateIds)
    && stringArray(value.gateResultIds)
    && stringArray(value.reviewIds)
    && isPromotionState(value.promotionState)
    && isTimestamp(value.createdAt);
}

function isChildDraft(value: unknown): value is RoomCandidateSynthesisChildDraftV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isNonBlank(value.id)
    && isNonBlank(value.producingBindingId)
    && isNonBlank(value.nativeSessionId)
    && isNonBlank(value.happierSessionId)
    && isNonBlank(value.providerId)
    && isNonBlank(value.modelRef)
    && isNonBlank(value.protocolId)
    && isPositiveInteger(value.protocolVersion)
    && isNonBlank(value.contextVersion)
    && isNonBlank(value.inputVersion)
    && isNonBlank(value.configVersion)
    && isNonBlank(value.contentHash)
    && stringArray(value.artifactIds)
    && stringArray(value.gateResultIds)
    && stringArray(value.reviewIds)
    && isPromotionState(value.promotionState)
    && isTimestamp(value.createdAt);
}

function isAppendPort(value: unknown): value is RoomCandidateSynthesisAppendPortV1 {
  return isRecord(value) && typeof value.appendSynthesis === "function";
}

function isSourcePort(value: unknown): value is RoomCandidateSynthesisSourcePortV1 {
  return isRecord(value)
    && typeof value.loadPersistedComparison === "function"
    && typeof value.loadPersistedParents === "function"
    && typeof value.findPersistedCandidateById === "function";
}

function isAppendRecord(value: unknown, childId: string): value is RoomCandidateSynthesisAppendRecordV1 {
  return isRecord(value)
    && isNonBlank(value.recordId)
    && value.candidateId === childId
    && value.revalidationRecorded === true
    && typeof value.replayed === "boolean";
}

function isCommand(value: unknown): value is RoomCandidateSynthesisCommandIdentityV1 {
  return isRecord(value)
    && isNonBlank(value.commandId)
    && isNonBlank(value.idempotencyKey)
    && isNonBlank(value.correlationId)
    && (value.causationId === null || isNonBlank(value.causationId));
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value) && isNonBlank(value.projectId) && isNonBlank(value.roomId);
}

function isPromotionState(value: unknown): value is RoomCandidateRecordV1["promotionState"] {
  return value === "pending" || value === "eligible" || value === "promoted" || value === "rejected" || value === "superseded";
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonBlank);
}

function isTimestamp(value: unknown): value is string {
  return isNonBlank(value) && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameScope(left: RoomEvidenceLedgerScope, right: RoomEvidenceLedgerScope): boolean {
  return left.projectId === right.projectId && left.roomId === right.roomId;
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function freezeCandidate(candidate: RoomCandidateRecordV1): RoomCandidateRecordV1 {
  return freeze({
    ...candidate,
    artifactIds: freezeStrings(candidate.artifactIds),
    parentCandidateIds: freezeStrings(candidate.parentCandidateIds),
    gateResultIds: freezeStrings(candidate.gateResultIds),
    reviewIds: freezeStrings(candidate.reviewIds),
  });
}

function freezeRevalidation(parentCandidateIds: readonly string[]): RoomCandidateSynthesisRevalidationV1 {
  return freeze({
    contractVersion: ROOM_CANDIDATE_SYNTHESIS_COORDINATOR_CONTRACT_VERSION,
    status: "required" as const,
    required: true as const,
    hardGates: true as const,
    independentReview: true as const,
    promotion: true as const,
    inheritedVerdictsIgnored: true as const,
    parentCandidateIds: freezeStrings(parentCandidateIds),
    reason: "synthesized_child_requires_fresh_validation" as const,
  });
}

function freezeComparison(comparison: RoomCandidateSynthesisPersistedComparisonV1): RoomCandidateSynthesisPersistedComparisonV1 {
  return freeze({
    persistence: "committed" as const,
    id: comparison.id,
    scope: copyScope(comparison.scope),
    nodeId: comparison.nodeId,
    parentCandidateIds: freezeStrings(comparison.parentCandidateIds),
    conclusion: comparison.conclusion,
    concludedAt: comparison.concludedAt,
  });
}

function freezeCommand(command: RoomCandidateSynthesisCommandIdentityV1): RoomCandidateSynthesisCommandIdentityV1 {
  return freeze({ ...command });
}

function freezeAppendInput(input: AppendRoomCandidateSynthesisInputV1): AppendRoomCandidateSynthesisInputV1 {
  return freeze({ ...input });
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return freeze([...values]);
}

function withheld(
  code: RoomCandidateSynthesisWithheldCodeV1,
  message: string,
): RoomCandidateSynthesisWithheldResultV1 {
  return freeze({ status: "withheld" as const, reason: freeze({ code, message }) });
}

function appendFailed(
  code: RoomCandidateSynthesisAppendFailedResultV1["reason"]["code"],
  message: string,
  child: RoomCandidateRecordV1,
  revalidation: RoomCandidateSynthesisRevalidationV1,
): RoomCandidateSynthesisAppendFailedResultV1 {
  return freeze({
    status: "append_failed" as const,
    reason: freeze({ code, message }),
    child,
    revalidation,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error && isNonBlank(error.message) ? error.message : "unknown durable-source failure";
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
