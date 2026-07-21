import type { RoomEvidenceLedgerScope } from "@fusion/core";

export const ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionCandidateKindV1 = "policy" | "source";
export type RoomEvolutionCandidateRiskClassV1 = "low" | "moderate" | "high" | "critical";
export type RoomEvolutionCandidateMechanismV1 =
  | "prompt"
  | "policy"
  | "protocol"
  | "routing"
  | "adapter"
  | "source_code";

export interface RoomEvolutionIsolatedCandidateCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RoomEvolutionRollbackTargetV1 {
  readonly candidateVersionId: string;
  readonly revision: string;
  readonly candidateRef: string;
}

export interface RoomEvolutionIsolatedCandidateDraftV1 {
  readonly id: string;
  readonly hypothesisId: string;
  readonly kind: RoomEvolutionCandidateKindV1;
  readonly riskClass: RoomEvolutionCandidateRiskClassV1;
  readonly mechanism: RoomEvolutionCandidateMechanismV1;
  readonly declaredScope: readonly string[];
  readonly repositoryRootPath: string;
  readonly baseRevision: string;
  readonly rollbackTarget: RoomEvolutionRollbackTargetV1;
  readonly createdByActorId: string;
}

export interface RoomEvolutionIsolatedCandidateHumanApprovalV1 {
  readonly id: string;
  readonly status: "approved";
  readonly candidateId: string;
  readonly scope: RoomEvidenceLedgerScope;
  readonly riskClass: "high" | "critical";
  readonly approvedByActorId: string;
  readonly approvedAt: string;
}

export interface RequestRoomEvolutionIsolatedCandidateV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION;
  readonly command: RoomEvolutionIsolatedCandidateCommandIdentityV1;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomEvolutionIsolatedCandidateDraftV1;
  readonly approval: RoomEvolutionIsolatedCandidateHumanApprovalV1 | null;
}

export interface RoomEvolutionIsolatedCandidateGitWorktreeRequestV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION;
  readonly command: RoomEvolutionIsolatedCandidateCommandIdentityV1;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: string;
  readonly hypothesisId: string;
  readonly candidateKind: RoomEvolutionCandidateKindV1;
  readonly riskClass: RoomEvolutionCandidateRiskClassV1;
  readonly mechanism: RoomEvolutionCandidateMechanismV1;
  readonly declaredScope: readonly string[];
  readonly repositoryRootPath: string;
  readonly baseRevision: string;
  readonly rollbackTarget: RoomEvolutionRollbackTargetV1;
  readonly branchRef: string;
  readonly worktreeName: string;
  readonly approval: RoomEvolutionIsolatedCandidateHumanApprovalV1 | null;
}

export interface RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION;
  readonly candidateId: string;
  readonly scope: RoomEvidenceLedgerScope;
  readonly repositoryRootPath: string;
  readonly branchRef: string;
  readonly worktreeName: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly rollbackTarget: RoomEvolutionRollbackTargetV1;
  readonly checkout: {
    readonly kind: "linked_worktree" | "unknown";
    readonly cleanliness: "clean" | "dirty" | "unknown";
    readonly occupancy: "dedicated" | "shared" | "base" | "unknown";
    readonly mutationTarget: "candidate_worktree" | "base_worktree" | "shared_worktree" | "unknown";
  };
}

export interface RoomEvolutionIsolatedCandidateGitWorktreePortV1 {
  createDedicatedCandidate(
    input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  ): Promise<RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1>;
}

export interface RoomEvolutionIsolatedCandidateRollbackLineageV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION;
  readonly fromCandidateId: string;
  readonly toCandidateVersionId: string;
  readonly targetRevision: string;
  readonly targetRef: string;
  readonly execution: "not_requested";
}

export interface RoomEvolutionIsolatedCandidateRecordV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomEvolutionIsolatedCandidateDraftV1;
  readonly isolation: RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1;
  readonly rollbackLineage: RoomEvolutionIsolatedCandidateRollbackLineageV1;
}

export interface RoomEvolutionIsolatedCandidateRecordReceiptV1 {
  readonly candidateId: string;
  readonly scope: RoomEvidenceLedgerScope;
  readonly rollbackLineageRecorded: true;
}

export interface RoomEvolutionIsolatedCandidateRecordPortV1 {
  appendCreatedCandidate(
    input: RoomEvolutionIsolatedCandidateRecordV1,
  ): Promise<RoomEvolutionIsolatedCandidateRecordReceiptV1>;
}

export interface RoomEvolutionIsolatedCandidateCoordinatorDependenciesV1 {
  readonly git: RoomEvolutionIsolatedCandidateGitWorktreePortV1;
  readonly records: RoomEvolutionIsolatedCandidateRecordPortV1;
}

export type RoomEvolutionIsolatedCandidateWithheldCodeV1 =
  | "invalid_request"
  | "git_port_invalid"
  | "record_port_invalid"
  | "high_risk_approval_required";

export type RoomEvolutionIsolatedCandidateIsolationRejectedCodeV1 =
  | "receipt_invalid"
  | "candidate_identity_mismatch"
  | "scope_mismatch"
  | "repository_root_mismatch"
  | "branch_mismatch"
  | "worktree_name_mismatch"
  | "base_revision_mismatch"
  | "rollback_target_mismatch"
  | "base_worktree_returned"
  | "worktree_not_linked"
  | "dirty_worktree_returned"
  | "shared_worktree_returned"
  | "base_mutation_requested"
  | "checkout_state_unknown";

export interface RoomEvolutionIsolatedCandidateWithheldResultV1 {
  readonly status: "withheld";
  readonly reason: {
    readonly code: RoomEvolutionIsolatedCandidateWithheldCodeV1;
    readonly message: string;
  };
}

export interface RoomEvolutionIsolatedCandidateRequestFailedResultV1 {
  readonly status: "request_failed";
  readonly candidate: RoomEvolutionIsolatedCandidateDraftV1;
  readonly requestedIsolation: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1;
  readonly reason: {
    readonly code: "git_request_failed";
    readonly message: string;
  };
}

export interface RoomEvolutionIsolatedCandidateIsolationRejectedResultV1 {
  readonly status: "isolation_rejected";
  readonly candidate: RoomEvolutionIsolatedCandidateDraftV1;
  readonly requestedIsolation: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1;
  readonly reason: {
    readonly code: RoomEvolutionIsolatedCandidateIsolationRejectedCodeV1;
    readonly message: string;
  };
}

export interface RoomEvolutionIsolatedCandidateCreatedResultV1 {
  readonly status: "created";
  readonly candidate: RoomEvolutionIsolatedCandidateDraftV1;
  readonly isolation: RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1;
  readonly rollbackLineage: RoomEvolutionIsolatedCandidateRollbackLineageV1;
}

export interface RoomEvolutionIsolatedCandidateRecordFailedResultV1 {
  readonly status: "record_failed";
  readonly record: RoomEvolutionIsolatedCandidateRecordV1;
  readonly reason: {
    readonly code: "record_append_failed" | "record_response_invalid";
    readonly message: string;
  };
}

export type RoomEvolutionIsolatedCandidateResultV1 =
  | RoomEvolutionIsolatedCandidateWithheldResultV1
  | RoomEvolutionIsolatedCandidateRequestFailedResultV1
  | RoomEvolutionIsolatedCandidateIsolationRejectedResultV1
  | RoomEvolutionIsolatedCandidateRecordFailedResultV1
  | RoomEvolutionIsolatedCandidateCreatedResultV1;

export class RoomEvolutionIsolatedCandidateCoordinator {
  public constructor(
    private readonly dependencies: RoomEvolutionIsolatedCandidateCoordinatorDependenciesV1,
  ) {}

  public async create(rawInput: RequestRoomEvolutionIsolatedCandidateV1): Promise<RoomEvolutionIsolatedCandidateResultV1> {
    const requestIssue = validateRequest(rawInput);
    if (requestIssue) return withheld(requestIssue.code, requestIssue.message);

    const input = rawInput;
    if (!isGitPort(this.dependencies?.git)) {
      return withheld("git_port_invalid", "Isolated-candidate creation requires a dedicated Git worktree port.");
    }
    if (!isRecordPort(this.dependencies?.records)) {
      return withheld("record_port_invalid", "Isolated-candidate creation requires an immutable candidate-record port.");
    }
    if (requiresHumanApproval(input.candidate.riskClass) && !isBoundHumanApproval(input.approval, input.scope, input.candidate)) {
      return withheld("high_risk_approval_required", "High-risk and critical candidates require a matching approved human authorization before Git is requested.");
    }

    const requestedIsolation = buildGitRequest(input);
    let rawReceipt: RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1;
    try {
      rawReceipt = await this.dependencies.git.createDedicatedCandidate(requestedIsolation);
    } catch (error) {
      return requestFailed(input.candidate, requestedIsolation, `The dedicated Git worktree request failed: ${messageOf(error)}`);
    }

    const receiptIssue = validateReceipt(rawReceipt, requestedIsolation);
    if (receiptIssue) {
      return isolationRejected(input.candidate, requestedIsolation, receiptIssue.code, receiptIssue.message);
    }

    const record = buildRecord(input.scope, input.candidate, rawReceipt);
    try {
      const receipt = await this.dependencies.records.appendCreatedCandidate(record);
      if (!isRecordReceipt(receipt, record)) {
        return recordFailed(record, "record_response_invalid", "The candidate-record port did not confirm the exact candidate scope and rollback lineage.");
      }
    } catch (error) {
      return recordFailed(record, "record_append_failed", `The isolated candidate was not exposed because immutable recording failed: ${messageOf(error)}`);
    }

    return created(record);
  }
}

function validateRequest(input: unknown): { readonly code: "invalid_request"; readonly message: string } | null {
  if (!isRecord(input) || input.contractVersion !== ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION) {
    return { code: "invalid_request", message: "Isolated-candidate request has an unsupported contract version." };
  }
  if (!isCommand(input.command) || !isScope(input.scope)) {
    return { code: "invalid_request", message: "Isolated-candidate request must bind a command identity to one project and Room scope." };
  }
  if (!isCandidateDraft(input.candidate)) {
    return { code: "invalid_request", message: "Isolated-candidate request has an invalid candidate identity, scope, mechanism, revision, or rollback target." };
  }
  if (input.approval !== null && (!isApproval(input.approval) || !requiresHumanApproval(input.candidate.riskClass) || !isBoundHumanApproval(input.approval, input.scope, input.candidate))) {
    return { code: "invalid_request", message: "Isolated-candidate approval must bind the exact high-risk candidate and its project and Room scope." };
  }
  return null;
}

function isCandidateDraft(value: unknown): value is RoomEvolutionIsolatedCandidateDraftV1 {
  if (!isRecord(value)) return false;
  if (!isCanonicalId(value.id) || !isCanonicalId(value.hypothesisId) || !isCandidateKind(value.kind) || !isRiskClass(value.riskClass)) {
    return false;
  }
  if (!isMechanism(value.mechanism) || !isMechanismAllowedForKind(value.kind, value.mechanism)) return false;
  if (!isDeclaredScope(value.declaredScope) || !isAbsoluteSafePath(value.repositoryRootPath) || !isImmutableRevision(value.baseRevision)) {
    return false;
  }
  if (!isRollbackTarget(value.rollbackTarget) || value.rollbackTarget.candidateVersionId === value.id || !isNonBlank(value.createdByActorId)) {
    return false;
  }
  return true;
}

function isCommand(value: unknown): value is RoomEvolutionIsolatedCandidateCommandIdentityV1 {
  return isRecord(value)
    && isNonBlank(value.commandId)
    && isNonBlank(value.idempotencyKey)
    && isNonBlank(value.correlationId)
    && (value.causationId === null || isNonBlank(value.causationId));
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value) && isNonBlank(value.projectId) && isNonBlank(value.roomId);
}

function isApproval(value: unknown): value is RoomEvolutionIsolatedCandidateHumanApprovalV1 {
  return isRecord(value)
    && isCanonicalId(value.id)
    && value.status === "approved"
    && isCanonicalId(value.candidateId)
    && isScope(value.scope)
    && (value.riskClass === "high" || value.riskClass === "critical")
    && isNonBlank(value.approvedByActorId)
    && isUtcTimestamp(value.approvedAt);
}

function isBoundHumanApproval(
  approval: RoomEvolutionIsolatedCandidateHumanApprovalV1 | null,
  scope: RoomEvidenceLedgerScope,
  candidate: RoomEvolutionIsolatedCandidateDraftV1,
): approval is RoomEvolutionIsolatedCandidateHumanApprovalV1 {
  return approval !== null
    && approval.status === "approved"
    && approval.candidateId === candidate.id
    && approval.riskClass === candidate.riskClass
    && sameScope(approval.scope, scope);
}

function buildGitRequest(input: RequestRoomEvolutionIsolatedCandidateV1): RoomEvolutionIsolatedCandidateGitWorktreeRequestV1 {
  const { candidate } = input;
  return freeze({
    contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
    command: cloneCommand(input.command),
    scope: cloneScope(input.scope),
    candidateId: candidate.id,
    hypothesisId: candidate.hypothesisId,
    candidateKind: candidate.kind,
    riskClass: candidate.riskClass,
    mechanism: candidate.mechanism,
    declaredScope: freeze([...candidate.declaredScope]),
    repositoryRootPath: candidate.repositoryRootPath,
    baseRevision: candidate.baseRevision,
    rollbackTarget: cloneRollbackTarget(candidate.rollbackTarget),
    branchRef: `fusion/evolution/${candidate.id}`,
    worktreeName: `evolution-${candidate.id}`,
    approval: cloneApproval(input.approval),
  });
}

function validateReceipt(
  value: unknown,
  expected: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
): { readonly code: RoomEvolutionIsolatedCandidateIsolationRejectedCodeV1; readonly message: string } | null {
  if (!isReceipt(value)) return { code: "receipt_invalid", message: "The Git worktree port returned an invalid isolation receipt." };
  if (value.candidateId !== expected.candidateId) {
    return { code: "candidate_identity_mismatch", message: "The Git worktree receipt did not bind the requested candidate identity." };
  }
  if (!sameScope(value.scope, expected.scope)) {
    return { code: "scope_mismatch", message: "The Git worktree receipt did not preserve the requested project and Room scope." };
  }
  if (!samePath(value.repositoryRootPath, expected.repositoryRootPath)) {
    return { code: "repository_root_mismatch", message: "The Git worktree receipt changed the repository root." };
  }
  if (value.branchRef !== expected.branchRef) {
    return { code: "branch_mismatch", message: "The Git worktree receipt did not return the dedicated candidate branch." };
  }
  if (value.worktreeName !== expected.worktreeName) {
    return { code: "worktree_name_mismatch", message: "The Git worktree receipt did not return the requested dedicated worktree name." };
  }
  if (value.baseRevision !== expected.baseRevision) {
    return { code: "base_revision_mismatch", message: "The Git worktree receipt did not preserve the immutable base revision." };
  }
  if (!sameRollbackTarget(value.rollbackTarget, expected.rollbackTarget)) {
    return { code: "rollback_target_mismatch", message: "The Git worktree receipt did not preserve the requested rollback target." };
  }
  if (samePath(value.worktreePath, expected.repositoryRootPath)) {
    return { code: "base_worktree_returned", message: "The Git worktree port returned the repository root instead of a dedicated candidate worktree." };
  }
  if (value.checkout.kind !== "linked_worktree") {
    return { code: "worktree_not_linked", message: "The Git worktree receipt did not prove a linked candidate worktree." };
  }
  if (value.checkout.cleanliness === "dirty") {
    return { code: "dirty_worktree_returned", message: "The Git worktree receipt reported a dirty candidate worktree." };
  }
  if (value.checkout.occupancy === "shared" || value.checkout.occupancy === "base") {
    return { code: "shared_worktree_returned", message: "The Git worktree receipt reported a shared or base checkout." };
  }
  if (value.checkout.mutationTarget === "base_worktree" || value.checkout.mutationTarget === "shared_worktree") {
    return { code: "base_mutation_requested", message: "The Git worktree receipt targeted a base or shared checkout for mutation." };
  }
  if (value.checkout.cleanliness !== "clean" || value.checkout.occupancy !== "dedicated" || value.checkout.mutationTarget !== "candidate_worktree") {
    return { code: "checkout_state_unknown", message: "The Git worktree receipt did not prove a clean, dedicated candidate mutation target." };
  }
  return null;
}

function isReceipt(value: unknown): value is RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION) return false;
  if (!isCanonicalId(value.candidateId) || !isScope(value.scope) || !isAbsoluteSafePath(value.repositoryRootPath) || !isNonBlank(value.branchRef)) return false;
  if (!isCanonicalWorktreeName(value.worktreeName) || !isAbsoluteSafePath(value.worktreePath) || !isImmutableRevision(value.baseRevision)) return false;
  if (!isRollbackTarget(value.rollbackTarget) || !isRecord(value.checkout)) return false;
  return (value.checkout.kind === "linked_worktree" || value.checkout.kind === "unknown")
    && (value.checkout.cleanliness === "clean" || value.checkout.cleanliness === "dirty" || value.checkout.cleanliness === "unknown")
    && (value.checkout.occupancy === "dedicated" || value.checkout.occupancy === "shared" || value.checkout.occupancy === "base" || value.checkout.occupancy === "unknown")
    && (value.checkout.mutationTarget === "candidate_worktree" || value.checkout.mutationTarget === "base_worktree" || value.checkout.mutationTarget === "shared_worktree" || value.checkout.mutationTarget === "unknown");
}

function isGitPort(value: unknown): value is RoomEvolutionIsolatedCandidateGitWorktreePortV1 {
  return isRecord(value) && typeof value.createDedicatedCandidate === "function";
}

function isRecordPort(value: unknown): value is RoomEvolutionIsolatedCandidateRecordPortV1 {
  return isRecord(value) && typeof value.appendCreatedCandidate === "function";
}

function isRecordReceipt(
  value: unknown,
  record: RoomEvolutionIsolatedCandidateRecordV1,
): value is RoomEvolutionIsolatedCandidateRecordReceiptV1 {
  return isRecord(value)
    && value.candidateId === record.candidate.id
    && isScope(value.scope)
    && sameScope(value.scope, record.scope)
    && value.rollbackLineageRecorded === true;
}

function isCandidateKind(value: unknown): value is RoomEvolutionCandidateKindV1 {
  return value === "policy" || value === "source";
}

function isRiskClass(value: unknown): value is RoomEvolutionCandidateRiskClassV1 {
  return value === "low" || value === "moderate" || value === "high" || value === "critical";
}

function isMechanism(value: unknown): value is RoomEvolutionCandidateMechanismV1 {
  return value === "prompt" || value === "policy" || value === "protocol" || value === "routing" || value === "adapter" || value === "source_code";
}

function isMechanismAllowedForKind(kind: RoomEvolutionCandidateKindV1, mechanism: RoomEvolutionCandidateMechanismV1): boolean {
  return kind === "policy"
    ? mechanism === "prompt" || mechanism === "policy" || mechanism === "protocol" || mechanism === "routing"
    : mechanism === "adapter" || mechanism === "source_code";
}

function isDeclaredScope(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(entry) && !entry.includes(".."));
}

function isRollbackTarget(value: unknown): value is RoomEvolutionRollbackTargetV1 {
  return isRecord(value)
    && isCanonicalId(value.candidateVersionId)
    && isImmutableRevision(value.revision)
    && isGitRef(value.candidateRef);
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,127}$/.test(value);
}

function isCanonicalWorktreeName(value: unknown): value is string {
  return typeof value === "string" && /^evolution-[a-z0-9][a-z0-9._-]{2,127}$/.test(value);
}

function isImmutableRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isGitRef(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("refs/")
    && value.length <= 255
    && !/\s/.test(value)
    && !["~", "^", ":", "?", "*", "\\", "["].some((character) => value.includes(character))
    && !hasAsciiControlCharacter(value)
    && !value.includes("..")
    && !value.includes("@{")
    && !value.endsWith(".")
    && !value.endsWith("/");
}

function isAbsoluteSafePath(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 1
    && (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value))
    && !value.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  return Number.isFinite(Date.parse(value));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresHumanApproval(riskClass: RoomEvolutionCandidateRiskClassV1): boolean {
  return riskClass === "high" || riskClass === "critical";
}

function sameScope(left: RoomEvidenceLedgerScope, right: RoomEvidenceLedgerScope): boolean {
  return left.projectId === right.projectId && left.roomId === right.roomId;
}

function sameRollbackTarget(left: RoomEvolutionRollbackTargetV1, right: RoomEvolutionRollbackTargetV1): boolean {
  return left.candidateVersionId === right.candidateVersionId && left.revision === right.revision && left.candidateRef === right.candidateRef;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function cloneCommand(value: RoomEvolutionIsolatedCandidateCommandIdentityV1): RoomEvolutionIsolatedCandidateCommandIdentityV1 {
  return freeze({ ...value });
}

function cloneScope(value: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return freeze({ projectId: value.projectId, roomId: value.roomId });
}

function cloneRollbackTarget(value: RoomEvolutionRollbackTargetV1): RoomEvolutionRollbackTargetV1 {
  return freeze({ ...value });
}

function cloneApproval(value: RoomEvolutionIsolatedCandidateHumanApprovalV1 | null): RoomEvolutionIsolatedCandidateHumanApprovalV1 | null {
  return value === null
    ? null
    : freeze({
        id: value.id,
        status: value.status,
        candidateId: value.candidateId,
        scope: cloneScope(value.scope),
        riskClass: value.riskClass,
        approvedByActorId: value.approvedByActorId,
        approvedAt: value.approvedAt,
      });
}

function cloneCandidate(value: RoomEvolutionIsolatedCandidateDraftV1): RoomEvolutionIsolatedCandidateDraftV1 {
  return freeze({
    id: value.id,
    hypothesisId: value.hypothesisId,
    kind: value.kind,
    riskClass: value.riskClass,
    mechanism: value.mechanism,
    declaredScope: freeze([...value.declaredScope]),
    repositoryRootPath: value.repositoryRootPath,
    baseRevision: value.baseRevision,
    rollbackTarget: cloneRollbackTarget(value.rollbackTarget),
    createdByActorId: value.createdByActorId,
  });
}

function cloneReceipt(value: RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1): RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  return freeze({
    contractVersion: value.contractVersion,
    candidateId: value.candidateId,
    scope: cloneScope(value.scope),
    repositoryRootPath: value.repositoryRootPath,
    branchRef: value.branchRef,
    worktreeName: value.worktreeName,
    worktreePath: value.worktreePath,
    baseRevision: value.baseRevision,
    rollbackTarget: cloneRollbackTarget(value.rollbackTarget),
    checkout: freeze({ ...value.checkout }),
  });
}

function buildRecord(
  scope: RoomEvidenceLedgerScope,
  candidate: RoomEvolutionIsolatedCandidateDraftV1,
  isolation: RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1,
): RoomEvolutionIsolatedCandidateRecordV1 {
  const candidateRecord = cloneCandidate(candidate);
  return freeze({
    contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
    scope: cloneScope(scope),
    candidate: candidateRecord,
    isolation: cloneReceipt(isolation),
    rollbackLineage: freeze({
      contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
      fromCandidateId: candidateRecord.id,
      toCandidateVersionId: candidateRecord.rollbackTarget.candidateVersionId,
      targetRevision: candidateRecord.rollbackTarget.revision,
      targetRef: candidateRecord.rollbackTarget.candidateRef,
      execution: "not_requested" as const,
    }),
  });
}

function withheld(code: RoomEvolutionIsolatedCandidateWithheldCodeV1, message: string): RoomEvolutionIsolatedCandidateWithheldResultV1 {
  return freeze({ status: "withheld" as const, reason: freeze({ code, message }) });
}

function requestFailed(
  candidate: RoomEvolutionIsolatedCandidateDraftV1,
  requestedIsolation: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  message: string,
): RoomEvolutionIsolatedCandidateRequestFailedResultV1 {
  return freeze({
    status: "request_failed" as const,
    candidate: cloneCandidate(candidate),
    requestedIsolation,
    reason: freeze({ code: "git_request_failed" as const, message }),
  });
}

function isolationRejected(
  candidate: RoomEvolutionIsolatedCandidateDraftV1,
  requestedIsolation: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  code: RoomEvolutionIsolatedCandidateIsolationRejectedCodeV1,
  message: string,
): RoomEvolutionIsolatedCandidateIsolationRejectedResultV1 {
  return freeze({
    status: "isolation_rejected" as const,
    candidate: cloneCandidate(candidate),
    requestedIsolation,
    reason: freeze({ code, message }),
  });
}

function recordFailed(
  record: RoomEvolutionIsolatedCandidateRecordV1,
  code: "record_append_failed" | "record_response_invalid",
  message: string,
): RoomEvolutionIsolatedCandidateRecordFailedResultV1 {
  return freeze({
    status: "record_failed" as const,
    record,
    reason: freeze({ code, message }),
  });
}

function created(record: RoomEvolutionIsolatedCandidateRecordV1): RoomEvolutionIsolatedCandidateCreatedResultV1 {
  return freeze({
    status: "created" as const,
    candidate: record.candidate,
    isolation: record.isolation,
    rollbackLineage: record.rollbackLineage,
  });
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
