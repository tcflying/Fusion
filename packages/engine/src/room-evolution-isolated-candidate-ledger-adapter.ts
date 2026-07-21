import {
  hashRoomValue,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AsyncRoomEvolutionLedger,
  type RoomEvolutionCandidateKindV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionLedgerScope,
} from "@fusion/core";

import {
  RoomEvolutionIsolatedCandidateCoordinator,
  type RequestRoomEvolutionIsolatedCandidateV1,
  type RoomEvolutionCandidateMechanismV1,
  type RoomEvolutionIsolatedCandidateGitWorktreePortV1,
  type RoomEvolutionIsolatedCandidateRecordReceiptV1,
  type RoomEvolutionIsolatedCandidateRecordV1,
  type RoomEvolutionIsolatedCandidateResultV1,
} from "./room-evolution-isolated-candidate-coordinator.js";

export const ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionIsolatedCandidateVersionBindingV1 {
  readonly id: string;
  readonly hypothesisId: string;
  readonly candidateHash: string;
  readonly versionNumber: number;
  readonly baseCandidateVersionId: string | null;
  readonly rollbackTargetCandidateVersionId: string | null;
}

export interface RequestRoomEvolutionIsolatedCandidateLedgerV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION;
  readonly request: RequestRoomEvolutionIsolatedCandidateV1;
  readonly candidateVersion: RoomEvolutionIsolatedCandidateVersionBindingV1;
}

export interface RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly candidateId: string;
  readonly hypothesisId: string;
  readonly candidateHash: string;
  readonly versionNumber: number;
  readonly baseCandidateVersionId: string | null;
  readonly rollbackTargetCandidateVersionId: string | null;
  readonly producedByActorId: string;
  readonly createdAt: string;
}

export interface RoomEvolutionIsolatedCandidateLedgerContextReaderV1 {
  readIsolatedCandidateContext(input: {
    readonly command: RequestRoomEvolutionIsolatedCandidateV1["command"];
    readonly request: RequestRoomEvolutionIsolatedCandidateV1;
    readonly candidateVersion: RoomEvolutionIsolatedCandidateVersionBindingV1;
  }): Promise<RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 | null>;
}

export type RoomEvolutionIsolatedCandidateVersionLedgerV1 = Pick<AsyncRoomEvolutionLedger, "appendCandidateVersion">;

export interface RoomEvolutionIsolatedCandidateLedgerAdapterDependenciesV1 {
  readonly git: RoomEvolutionIsolatedCandidateGitWorktreePortV1;
  readonly contextReader: RoomEvolutionIsolatedCandidateLedgerContextReaderV1;
  readonly ledger: RoomEvolutionIsolatedCandidateVersionLedgerV1;
}

export type RoomEvolutionIsolatedCandidateLedgerAdapterErrorCodeV1 =
  | "invalid_input"
  | "candidate_hash_mismatch"
  | "context_snapshot_unavailable"
  | "context_snapshot_invalid"
  | "ledger_response_invalid";

export class RoomEvolutionIsolatedCandidateLedgerAdapterError extends Error {
  public constructor(
    readonly code: RoomEvolutionIsolatedCandidateLedgerAdapterErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionIsolatedCandidateLedgerAdapterError";
  }
}

/**
 * FNXC:RoomEvolutionCandidateLedger 2026-07-19-15:36:
 * Candidate-version persistence must be derived from authorized context and
 * isolated Coordinator records; caller input cannot choose identity, hash,
 * version, base, or rollback lineage.
 */
export class RoomEvolutionIsolatedCandidateLedgerAdapter {
  public constructor(
    private readonly dependencies: RoomEvolutionIsolatedCandidateLedgerAdapterDependenciesV1,
  ) {}

  public async create(rawInput: RequestRoomEvolutionIsolatedCandidateLedgerV1): Promise<RoomEvolutionIsolatedCandidateResultV1> {
    const input = normalizeInput(rawInput);
    const requestHash = calculateCanonicalHash(input.request);
    if (input.candidateVersion.candidateHash !== requestHash) {
      throw new RoomEvolutionIsolatedCandidateLedgerAdapterError(
        "candidate_hash_mismatch",
        "Candidate-version binding must carry the canonical hash of the exact isolated-candidate request.",
      );
    }

    const context = await this.requireContextReader().readIsolatedCandidateContext(freeze({
      command: clone(input.request.command),
      request: clone(input.request),
      candidateVersion: clone(input.candidateVersion),
    }));
    assertAuthorizedContext(context, input, requestHash);

    const coordinator = new RoomEvolutionIsolatedCandidateCoordinator({
      git: this.requireGit(),
      records: {
        appendCreatedCandidate: (record) => this.appendCreatedCandidate(record, input, context),
      },
    });
    return coordinator.create(clone(input.request));
  }

  private async appendCreatedCandidate(
    record: RoomEvolutionIsolatedCandidateRecordV1,
    input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
    context: RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1,
  ): Promise<RoomEvolutionIsolatedCandidateRecordReceiptV1> {
    const appendInput = deriveAppendInput(record, input, context);
    const appended = await this.requireLedger().appendCandidateVersion(appendInput);
    assertAppendResult(appended, appendInput);
    return freeze({
      candidateId: appendInput.id,
      scope: freeze({ projectId: record.scope.projectId, roomId: record.scope.roomId }),
      rollbackLineageRecorded: true as const,
    });
  }

  private requireGit(): RoomEvolutionIsolatedCandidateGitWorktreePortV1 {
    const git = this.dependencies?.git;
    if (git === undefined || typeof git.createDedicatedCandidate !== "function") {
      throw invalidInput("Isolated-candidate ledger adapter requires a dedicated Git worktree port.");
    }
    return git;
  }

  private requireContextReader(): RoomEvolutionIsolatedCandidateLedgerContextReaderV1 {
    const reader = this.dependencies?.contextReader;
    if (reader === undefined || typeof reader.readIsolatedCandidateContext !== "function") {
      throw invalidInput("Isolated-candidate ledger adapter requires an authorized candidate context reader.");
    }
    return reader;
  }

  private requireLedger(): RoomEvolutionIsolatedCandidateVersionLedgerV1 {
    const ledger = this.dependencies?.ledger;
    if (ledger === undefined || typeof ledger.appendCandidateVersion !== "function") {
      throw invalidInput("Isolated-candidate ledger adapter requires a Core candidate-version ledger.");
    }
    return ledger;
  }
}

function normalizeInput(rawInput: unknown): RequestRoomEvolutionIsolatedCandidateLedgerV1 {
  if (
    !isRecord(rawInput)
    || !hasExactKeys(rawInput, ["contractVersion", "request", "candidateVersion"])
    || rawInput.contractVersion !== ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION
    || !isIsolatedCandidateRequest(rawInput.request)
    || !isCandidateVersionBinding(rawInput.candidateVersion)
  ) {
    throw invalidInput("Isolated-candidate ledger creation requires an exact request and candidate-version binding.");
  }
  const input = clone(rawInput as unknown as RequestRoomEvolutionIsolatedCandidateLedgerV1);
  if (
    input.candidateVersion.id !== input.request.candidate.id
    || input.candidateVersion.hypothesisId !== input.request.candidate.hypothesisId
    || input.candidateVersion.rollbackTargetCandidateVersionId !== input.request.candidate.rollbackTarget.candidateVersionId
  ) {
    throw invalidContext("Caller-supplied candidate version does not bind the requested candidate, hypothesis, and rollback target.");
  }
  return input;
}

function assertAuthorizedContext(
  context: RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 | null,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  requestHash: string,
): asserts context is RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 {
  if (context === null) {
    throw new RoomEvolutionIsolatedCandidateLedgerAdapterError(
      "context_snapshot_unavailable",
      `No authorized candidate context was available for ${input.candidateVersion.id}.`,
    );
  }
  if (
    !isRecord(context)
    || !hasExactKeys(context, [
      "contractVersion", "scope", "candidateId", "hypothesisId", "candidateHash", "versionNumber",
      "baseCandidateVersionId", "rollbackTargetCandidateVersionId", "producedByActorId", "createdAt",
    ])
    || context.contractVersion !== ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION
    || !isRoomScope(context.scope)
    || !isIdentifier(context.candidateId)
    || !isIdentifier(context.hypothesisId)
    || !isCanonicalCoreHash(context.candidateHash)
    || !isPositiveInteger(context.versionNumber)
    || !isNullableIdentifier(context.baseCandidateVersionId)
    || !isNullableIdentifier(context.rollbackTargetCandidateVersionId)
    || !isIdentifier(context.producedByActorId)
    || !isTimestamp(context.createdAt)
    || context.scope.projectId !== input.request.scope.projectId
    || context.scope.roomId !== input.request.scope.roomId
    || context.candidateId !== input.candidateVersion.id
    || context.hypothesisId !== input.candidateVersion.hypothesisId
    || context.candidateHash !== requestHash
    || context.candidateHash !== input.candidateVersion.candidateHash
    || context.versionNumber !== input.candidateVersion.versionNumber
    || context.baseCandidateVersionId !== input.candidateVersion.baseCandidateVersionId
    || context.rollbackTargetCandidateVersionId !== input.candidateVersion.rollbackTargetCandidateVersionId
    || context.producedByActorId !== input.request.candidate.createdByActorId
  ) {
    throw invalidContext("Authorized candidate context must exactly bind the project, Room, hypothesis, hash, version, baseline, rollback, and producer.");
  }
  if (context.versionNumber === 1 && context.baseCandidateVersionId !== null) {
    throw invalidContext("Initial candidate versions cannot name a baseline candidate version.");
  }
  if (context.versionNumber > 1 && context.baseCandidateVersionId === null) {
    throw invalidContext("Candidate versions after v1 require an authorized baseline candidate version.");
  }
}

function deriveAppendInput(
  record: RoomEvolutionIsolatedCandidateRecordV1,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  context: RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1,
): AppendRoomEvolutionCandidateVersionInputV1 {
  assertCreatedRecord(record, input, context);
  const immutableInput = freeze({
    contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_LEDGER_ADAPTER_CONTRACT_VERSION,
    request: clone(input.request),
    candidateVersion: clone(input.candidateVersion),
    authorizedContext: clone(context),
    isolation: clone(record.isolation),
    rollbackLineage: clone(record.rollbackLineage),
  });
  return freeze({
    scope: clone(context.scope),
    id: record.candidate.id,
    hypothesisId: record.candidate.hypothesisId,
    versionNumber: context.versionNumber,
    candidateKind: mapCandidateKind(record.candidate.kind, record.candidate.mechanism),
    baseRevision: record.isolation.baseRevision,
    candidateRef: record.isolation.branchRef,
    isolationKind: "worktree" as const,
    isolationRef: record.isolation.worktreePath,
    immutableInput,
    inputHash: calculateCanonicalHash(immutableInput),
    producedByActorId: record.candidate.createdByActorId,
    baseCandidateVersionId: context.baseCandidateVersionId,
    rollbackTargetCandidateVersionId: context.rollbackTargetCandidateVersionId,
    createdAt: context.createdAt,
  });
}

function assertCreatedRecord(
  record: unknown,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  context: RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1,
): asserts record is RoomEvolutionIsolatedCandidateRecordV1 {
  if (
    !isRecord(record)
    || !hasExactKeys(record, ["contractVersion", "scope", "candidate", "isolation", "rollbackLineage"])
    || record.contractVersion !== 1
    || !sameEvidenceScopeToCore(record.scope, context.scope)
    || !sameValue(record.candidate, input.request.candidate)
    || !isRecord(record.isolation)
    || record.isolation.contractVersion !== 1
    || record.isolation.candidateId !== context.candidateId
    || !sameRoomScope(record.isolation.scope, input.request.scope)
    || record.isolation.repositoryRootPath !== input.request.candidate.repositoryRootPath
    || record.isolation.branchRef !== `fusion/evolution/${context.candidateId}`
    || record.isolation.worktreeName !== `evolution-${context.candidateId}`
    || !isNonBlank(record.isolation.worktreePath)
    || record.isolation.baseRevision !== input.request.candidate.baseRevision
    || !sameValue(record.isolation.rollbackTarget, input.request.candidate.rollbackTarget)
    || !isRecord(record.isolation.checkout)
    || record.isolation.checkout.kind !== "linked_worktree"
    || record.isolation.checkout.cleanliness !== "clean"
    || record.isolation.checkout.occupancy !== "dedicated"
    || record.isolation.checkout.mutationTarget !== "candidate_worktree"
    || !isRecord(record.rollbackLineage)
    || record.rollbackLineage.contractVersion !== 1
    || record.rollbackLineage.fromCandidateId !== context.candidateId
    || record.rollbackLineage.toCandidateVersionId !== context.rollbackTargetCandidateVersionId
    || record.rollbackLineage.targetRevision !== input.request.candidate.rollbackTarget.revision
    || record.rollbackLineage.targetRef !== input.request.candidate.rollbackTarget.candidateRef
    || record.rollbackLineage.execution !== "not_requested"
  ) {
    throw invalidContext("Coordinator record did not preserve the authorized candidate identity, isolation, and rollback lineage.");
  }
}

function assertAppendResult(
  appended: RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1>,
  expected: AppendRoomEvolutionCandidateVersionInputV1,
): void {
  if (
    !isRecord(appended)
    || appended.table !== "room_evolution_candidate_versions"
    || !isRecord(appended.record)
    || appended.record.contractVersion !== 1
    || appended.record.id !== expected.id
    || appended.record.projectId !== expected.scope.projectId
    || appended.record.roomId !== expected.scope.roomId
    || appended.record.scopeKind !== expected.scope.scopeKind
    || appended.record.scopeKey !== expected.scope.scopeKey
    || appended.record.hypothesisId !== expected.hypothesisId
    || appended.record.versionNumber !== expected.versionNumber
    || appended.record.candidateKind !== expected.candidateKind
    || appended.record.baseRevision !== expected.baseRevision
    || appended.record.candidateRef !== expected.candidateRef
    || appended.record.isolationKind !== expected.isolationKind
    || appended.record.isolationRef !== expected.isolationRef
    || appended.record.inputHash !== expected.inputHash
    || appended.record.producedByActorId !== expected.producedByActorId
    || appended.record.baseCandidateVersionId !== expected.baseCandidateVersionId
    || appended.record.rollbackTargetCandidateVersionId !== expected.rollbackTargetCandidateVersionId
    || appended.record.createdAt !== expected.createdAt
    || !sameValue(appended.record.immutableInput, expected.immutableInput)
  ) {
    throw new RoomEvolutionIsolatedCandidateLedgerAdapterError(
      "ledger_response_invalid",
      "Core candidate-version ledger did not acknowledge the exact immutable candidate record.",
    );
  }
}

function mapCandidateKind(
  kind: RequestRoomEvolutionIsolatedCandidateV1["candidate"]["kind"],
  mechanism: RoomEvolutionCandidateMechanismV1,
): RoomEvolutionCandidateKindV1 {
  if (kind === "source") {
    if (mechanism === "adapter") return "connector_adapter";
    if (mechanism === "source_code") return "source_code";
  }
  if (kind === "policy") {
    if (mechanism === "prompt") return "prompt";
    if (mechanism === "policy") return "context";
    if (mechanism === "protocol") return "protocol";
    if (mechanism === "routing") return "model_routing";
  }
  throw invalidContext("Coordinator candidate kind and mechanism cannot map to a Core evolution candidate kind.");
}

function isIsolatedCandidateRequest(value: unknown): value is RequestRoomEvolutionIsolatedCandidateV1 {
  return isRecord(value)
    && hasExactKeys(value, ["contractVersion", "command", "scope", "candidate", "approval"])
    && value.contractVersion === 1
    && isRecord(value.command)
    && isRecord(value.scope)
    && isRecord(value.candidate)
    && (value.approval === null || isRecord(value.approval));
}

function isCandidateVersionBinding(value: unknown): value is RoomEvolutionIsolatedCandidateVersionBindingV1 {
  return isRecord(value)
    && hasExactKeys(value, [
      "id", "hypothesisId", "candidateHash", "versionNumber", "baseCandidateVersionId", "rollbackTargetCandidateVersionId",
    ])
    && isIdentifier(value.id)
    && isIdentifier(value.hypothesisId)
    && isCanonicalCoreHash(value.candidateHash)
    && isPositiveInteger(value.versionNumber)
    && isNullableIdentifier(value.baseCandidateVersionId)
    && isNullableIdentifier(value.rollbackTargetCandidateVersionId);
}

function isRoomScope(value: unknown): value is RoomEvolutionLedgerScope {
  return isRecord(value)
    && hasExactKeys(value, ["projectId", "roomId", "scopeKind", "scopeKey"])
    && isIdentifier(value.projectId)
    && isIdentifier(value.roomId)
    && value.scopeKind === "room"
    && value.scopeKey === `room:${value.roomId}`;
}

function sameEvidenceScopeToCore(left: unknown, right: RoomEvolutionLedgerScope): boolean {
  return isRecord(left) && left.projectId === right.projectId && left.roomId === right.roomId;
}

function sameRoomScope(left: unknown, right: RequestRoomEvolutionIsolatedCandidateV1["scope"]): boolean {
  return isRecord(left) && left.projectId === right.projectId && left.roomId === right.roomId;
}

function isCanonicalCoreHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function calculateCanonicalHash(value: unknown): string {
  const hash = hashRoomValue(value);
  if (!isCanonicalCoreHash(hash)) {
    throw invalidInput("Core hash implementation did not return a canonical sha256 value.");
  }
  return hash;
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return calculateCanonicalHash(left) === calculateCanonicalHash(right);
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
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
  return freeze(structuredClone(value));
}

function freeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function invalidInput(message: string): RoomEvolutionIsolatedCandidateLedgerAdapterError {
  return new RoomEvolutionIsolatedCandidateLedgerAdapterError("invalid_input", message);
}

function invalidContext(message: string): RoomEvolutionIsolatedCandidateLedgerAdapterError {
  return new RoomEvolutionIsolatedCandidateLedgerAdapterError("context_snapshot_invalid", message);
}
