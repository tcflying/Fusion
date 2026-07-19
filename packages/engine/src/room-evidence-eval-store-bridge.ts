import {
  hashRoomValue,
  type EvalEvidenceReference,
  type EvalRun,
  type EvalTaskResult,
  type EvalTaskResultCreateInput,
  type RoomEvidenceLedgerScope,
} from "@fusion/core";

import type {
  AppendRoomEvalEvidenceInputV1,
  RoomEvalTaskEvidenceCollectorInputV1,
} from "./room-eval-evidence-adapter.js";

export const ROOM_EVIDENCE_EVAL_STORE_BRIDGE_CONTRACT_VERSION = 1 as const;
export const ROOM_EVIDENCE_EVAL_STORE_BRIDGE_REFERENCE_LIMIT = 24 as const;

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const EVAL_REFERENCE_TYPES = new Set<EvalEvidenceReference["type"]>([
  "task_log",
  "task_document",
  "file",
  "command",
  "test",
  "other",
]);

export type RoomEvidenceEvalStoreBridgeErrorCodeV1 =
  | "invalid_input"
  | "mutable_payload"
  | "cross_scope"
  | "identity_mismatch"
  | "content_hash_mismatch"
  | "self_evaluation_forbidden"
  | "untrusted_reference"
  | "source_reference_limit"
  | "authorization_denied"
  | "authorization_mismatch"
  | "receipt_claim_invalid"
  | "receipt_claim_mismatch";

export class RoomEvidenceEvalStoreBridgeError extends Error {
  public constructor(
    public readonly code: RoomEvidenceEvalStoreBridgeErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvidenceEvalStoreBridgeError";
  }
}

export interface RoomEvidenceEvalStoreCandidateV1 {
  readonly id: string;
  readonly roomId: string;
  readonly contentHash: string;
  readonly producingBindingId: string;
}

export interface RoomEvidenceEvalStoreSourceReceiptV1 {
  readonly id: string;
  readonly contentHash: string;
  readonly issuedAt: string;
}

export interface RoomEvidenceEvalStoreAuthorizedRecordV1 {
  readonly contractVersion: 1;
  readonly immutable: true;
  readonly authorizationRef: string;
  readonly authorizationHash: string;
  readonly sourceReceipt: RoomEvidenceEvalStoreSourceReceiptV1;
  readonly evaluatorBindingId: string;
  readonly run: EvalRun;
  readonly result: EvalTaskResult;
  readonly evaluationContentHash: string;
}

export interface RoomEvidenceEvalStoreAuthorizationVerifyInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomEvidenceEvalStoreCandidateV1;
  readonly record: RoomEvidenceEvalStoreAuthorizedRecordV1;
}

export interface RoomEvidenceEvalStoreAuthorizationVerifierPortV1 {
  verify(input: RoomEvidenceEvalStoreAuthorizationVerifyInputV1): unknown | Promise<unknown>;
}

export interface RoomEvidenceEvalStoreReceiptClaimInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: string;
  readonly sourceReceiptId: string;
  readonly sourceReceiptHash: string;
  readonly evaluationContentHash: string;
  readonly evaluatorBindingId: string;
}

export interface RoomEvidenceEvalStoreReceiptLedgerPortV1 {
  claim(input: RoomEvidenceEvalStoreReceiptClaimInputV1): unknown | Promise<unknown>;
}

export interface RoomEvidenceEvalStoreBridgeDependenciesV1 {
  readonly authorizationVerifier: RoomEvidenceEvalStoreAuthorizationVerifierPortV1;
  readonly receiptLedger: RoomEvidenceEvalStoreReceiptLedgerPortV1;
}

export interface RoomEvidenceEvalStoreBridgeInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomEvidenceEvalStoreCandidateV1;
  readonly record: RoomEvidenceEvalStoreAuthorizedRecordV1;
  readonly collectorInput: Omit<RoomEvalTaskEvidenceCollectorInputV1, "runId">;
}

export interface RoomEvidenceEvalStoreBridgeReadyResultV1 {
  readonly status: "ready";
  readonly workflowInput: Readonly<AppendRoomEvalEvidenceInputV1>;
  readonly sourceReceiptId: string;
  readonly sourceReceiptHash: string;
  readonly evaluationContentHash: string;
  readonly evaluatorBindingId: string;
}

export interface RoomEvidenceEvalStoreBridgeDuplicateResultV1 {
  readonly status: "duplicate";
  readonly sourceReceiptId: string;
  readonly sourceReceiptHash: string;
  readonly evaluationContentHash: string;
}

export type RoomEvidenceEvalStoreBridgeResultV1 =
  | RoomEvidenceEvalStoreBridgeReadyResultV1
  | RoomEvidenceEvalStoreBridgeDuplicateResultV1;

interface NormalizedBridgeInput {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomEvidenceEvalStoreCandidateV1;
  readonly record: RoomEvidenceEvalStoreAuthorizedRecordV1;
  readonly collectorInput: Omit<RoomEvalTaskEvidenceCollectorInputV1, "runId">;
}

interface ValidatedRecord {
  readonly record: RoomEvidenceEvalStoreAuthorizedRecordV1;
  readonly evaluationReferenceCount: number;
}

/**
 * FNXC:RoomEvidenceEvalStoreBridge 2026-07-19-16:15:
 * EvalStore task results can be replaced by their native lifecycle, so this boundary accepts only an independently authorized frozen receipt, binds its hashes and evaluator to one Room candidate, and emits a bounded input for the existing deterministic Room evidence workflow.
 */
export class RoomEvidenceEvalStoreBridge {
  public constructor(
    private readonly dependencies: RoomEvidenceEvalStoreBridgeDependenciesV1,
  ) {}

  public async prepare(
    input: RoomEvidenceEvalStoreBridgeInputV1,
  ): Promise<RoomEvidenceEvalStoreBridgeResultV1> {
    const normalized = normalizeInput(input);
    const validated = validateRecord(normalized);
    const verifier = requireVerifier(this.dependencies?.authorizationVerifier);
    const authorization = await verifier.verify({
      scope: normalized.scope,
      candidate: normalized.candidate,
      record: validated.record,
    });
    assertAuthorization(authorization, normalized);

    const receiptLedger = requireReceiptLedger(this.dependencies?.receiptLedger);
    const claimInput = freeze({
      scope: copyScope(normalized.scope),
      candidateId: normalized.candidate.id,
      sourceReceiptId: validated.record.sourceReceipt.id,
      sourceReceiptHash: validated.record.sourceReceipt.contentHash,
      evaluationContentHash: validated.record.evaluationContentHash,
      evaluatorBindingId: validated.record.evaluatorBindingId,
    });
    const claim = await receiptLedger.claim(claimInput);
    const claimStatus = assertReceiptClaim(claim, claimInput);
    if (claimStatus === "duplicate") {
      return freeze({
        status: "duplicate" as const,
        sourceReceiptId: claimInput.sourceReceiptId,
        sourceReceiptHash: claimInput.sourceReceiptHash,
        evaluationContentHash: claimInput.evaluationContentHash,
      });
    }

    return freeze({
      status: "ready" as const,
      workflowInput: buildWorkflowInput(normalized, validated),
      sourceReceiptId: claimInput.sourceReceiptId,
      sourceReceiptHash: claimInput.sourceReceiptHash,
      evaluationContentHash: claimInput.evaluationContentHash,
      evaluatorBindingId: claimInput.evaluatorBindingId,
    });
  }
}

function normalizeInput(input: RoomEvidenceEvalStoreBridgeInputV1): NormalizedBridgeInput {
  if (!isRecord(input)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore evidence bridge input must be a record.");
  }
  const scope = normalizeScope(input.scope);
  const candidate = normalizeCandidate(input.candidate, scope);
  if (!isRecord(input.collectorInput) || input.collectorInput.store === undefined || !isRecord(input.collectorInput.task)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "A complete existing evidence-collector input is required.");
  }
  if (!isReference(input.collectorInput.task.id) || !isNonBlank(input.collectorInput.cwd)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "Collector task identity and cwd must be canonical nonblank values.");
  }
  if (!isRecord(input.record)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "Authorized EvalStore record must be a record.");
  }
  return freeze({
    scope,
    candidate,
    record: input.record,
    collectorInput: freeze({
      store: input.collectorInput.store,
      task: input.collectorInput.task,
      cwd: input.collectorInput.cwd,
    }),
  });
}

function validateRecord(input: NormalizedBridgeInput): ValidatedRecord {
  const record = input.record;
  if (!isDeepFrozenJson(record)) {
    throw new RoomEvidenceEvalStoreBridgeError(
      "mutable_payload",
      "EvalStore evidence must arrive as a recursively frozen immutable authorization snapshot.",
    );
  }
  if (record.contractVersion !== ROOM_EVIDENCE_EVAL_STORE_BRIDGE_CONTRACT_VERSION || record.immutable !== true) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore evidence record must declare immutable contract version 1.");
  }
  assertReference(record.authorizationRef, "authorization reference");
  assertHash(record.authorizationHash, "authorization hash");
  assertReference(record.evaluatorBindingId, "evaluator binding ID");
  assertSourceReceipt(record.sourceReceipt);
  assertEvalRun(record.run);
  assertEvalResult(record.result);
  assertHash(record.evaluationContentHash, "evaluation content hash");
  if (record.run.projectId !== input.scope.projectId || record.result.runId !== record.run.id) {
    throw new RoomEvidenceEvalStoreBridgeError("cross_scope", "EvalStore run does not belong to the requested Room project or result run.");
  }
  if (record.result.taskId !== input.collectorInput.task.id || record.result.taskSnapshot.taskId !== record.result.taskId) {
    throw new RoomEvidenceEvalStoreBridgeError("identity_mismatch", "EvalStore task result does not match the existing evidence collector task.");
  }
  if (record.evaluatorBindingId === input.candidate.producingBindingId) {
    throw new RoomEvidenceEvalStoreBridgeError("self_evaluation_forbidden", "A candidate producer cannot supply its own sole EvalStore evidence receipt.");
  }
  const actualHash = hashRoomValue({
    contractVersion: ROOM_EVIDENCE_EVAL_STORE_BRIDGE_CONTRACT_VERSION,
    immutable: true,
    authorizationRef: record.authorizationRef,
    authorizationHash: record.authorizationHash,
    sourceReceipt: record.sourceReceipt,
    evaluatorBindingId: record.evaluatorBindingId,
    run: record.run,
    result: record.result,
  });
  if (actualHash !== record.evaluationContentHash) {
    throw new RoomEvidenceEvalStoreBridgeError("content_hash_mismatch", "EvalStore evidence content hash does not bind the immutable evaluation snapshot.");
  }
  const evaluationReferenceCount = validateEvaluationReferences(record.result);
  return freeze({ record, evaluationReferenceCount });
}

function buildWorkflowInput(
  input: NormalizedBridgeInput,
  validated: ValidatedRecord,
): Readonly<AppendRoomEvalEvidenceInputV1> {
  const record = validated.record;
  const result = record.result;
  const metadata = cloneMetadata(result.metadata);
  const sourceEvidenceBundleHash = result.evidenceBundle === undefined ? null : hashRoomValue(result.evidenceBundle);
  const evaluation = freeze({
    taskId: result.taskId,
    taskSnapshot: cloneImmutable(result.taskSnapshot),
    status: result.status,
    ...(result.overallScore === undefined ? {} : { overallScore: result.overallScore }),
    ...(result.maxScore === undefined ? {} : { maxScore: result.maxScore }),
    categoryScores: cloneImmutable(result.categoryScores),
    ...(result.rationale === undefined ? {} : { rationale: result.rationale }),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    evidence: cloneImmutable(result.evidence),
    deterministicSignals: cloneImmutable(result.deterministicSignals),
    ...(result.aiSignals === undefined ? {} : { aiSignals: cloneImmutable(result.aiSignals) }),
    followUps: cloneImmutable(result.followUps),
    ...(result.provenance === undefined ? {} : { provenance: cloneImmutable(result.provenance) }),
    metadata: freeze({
      ...metadata,
      roomEvidenceEvalStoreBridge: freeze({
        contractVersion: ROOM_EVIDENCE_EVAL_STORE_BRIDGE_CONTRACT_VERSION,
        authorizationRef: record.authorizationRef,
        authorizationHash: record.authorizationHash,
        sourceReceiptId: record.sourceReceipt.id,
        sourceReceiptHash: record.sourceReceipt.contentHash,
        sourceReceiptIssuedAt: record.sourceReceipt.issuedAt,
        evaluationContentHash: record.evaluationContentHash,
        candidateId: input.candidate.id,
        candidateContentHash: input.candidate.contentHash,
        evaluatorBindingId: record.evaluatorBindingId,
        evaluatorRunProvenance: cloneImmutable(record.run.provenance ?? null),
        evaluatorResultProvenance: cloneImmutable(record.result.provenance ?? null),
        sourceEvidenceBundleHash,
        sourceEvaluationReferenceCount: validated.evaluationReferenceCount,
      }),
    }),
  } satisfies EvalTaskResultCreateInput);
  return freeze({
    scope: copyScope(input.scope),
    candidateId: input.candidate.id,
    runId: record.run.id,
    collectorInput: input.collectorInput,
    evaluation,
  });
}

function assertAuthorization(value: unknown, input: NormalizedBridgeInput): void {
  if (!isRecord(value) || value.status === "denied") {
    throw new RoomEvidenceEvalStoreBridgeError("authorization_denied", "EvalStore evidence authorization was denied.");
  }
  if (
    value.status !== "authorized"
    || !isReference(value.authorizationRef)
    || !isHash(value.authorizationHash)
    || !isScope(value.scope)
    || !isReference(value.candidateId)
    || !isHash(value.candidateContentHash)
    || !isReference(value.evaluatorBindingId)
    || !isReference(value.sourceReceiptId)
    || !isHash(value.sourceReceiptHash)
    || !isHash(value.evaluationContentHash)
  ) {
    throw new RoomEvidenceEvalStoreBridgeError("authorization_denied", "EvalStore evidence verifier returned an invalid authorization decision.");
  }
  const { record } = input;
  if (
    value.authorizationRef !== record.authorizationRef
    || value.authorizationHash !== record.authorizationHash
    || value.scope.projectId !== input.scope.projectId
    || value.scope.roomId !== input.scope.roomId
    || value.candidateId !== input.candidate.id
    || value.candidateContentHash !== input.candidate.contentHash
    || value.evaluatorBindingId !== record.evaluatorBindingId
    || value.sourceReceiptId !== record.sourceReceipt.id
    || value.sourceReceiptHash !== record.sourceReceipt.contentHash
    || value.evaluationContentHash !== record.evaluationContentHash
  ) {
    throw new RoomEvidenceEvalStoreBridgeError("authorization_mismatch", "EvalStore verifier acknowledgement does not bind the requested Room evidence receipt.");
  }
}

function assertReceiptClaim(value: unknown, input: RoomEvidenceEvalStoreReceiptClaimInputV1): "claimed" | "duplicate" {
  if (!isRecord(value) || (value.status !== "claimed" && value.status !== "duplicate")) {
    throw new RoomEvidenceEvalStoreBridgeError("receipt_claim_invalid", "Source receipt ledger returned an invalid claim acknowledgement.");
  }
  if (
    !isScope(value.scope)
    || !isReference(value.candidateId)
    || !isReference(value.sourceReceiptId)
    || !isHash(value.sourceReceiptHash)
    || !isHash(value.evaluationContentHash)
    || value.scope.projectId !== input.scope.projectId
    || value.scope.roomId !== input.scope.roomId
    || value.candidateId !== input.candidateId
    || value.sourceReceiptId !== input.sourceReceiptId
    || value.sourceReceiptHash !== input.sourceReceiptHash
    || value.evaluationContentHash !== input.evaluationContentHash
  ) {
    throw new RoomEvidenceEvalStoreBridgeError("receipt_claim_mismatch", "Source receipt ledger acknowledgement does not match the immutable evaluation receipt.");
  }
  return value.status;
}

function validateEvaluationReferences(result: EvalTaskResult): number {
  const references: unknown[] = [...result.evidence];
  for (const score of result.categoryScores) {
    if (!isRecord(score) || !Array.isArray(score.evidence)) {
      throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "Eval category scores must retain typed bounded evidence arrays.");
    }
    references.push(...score.evidence);
  }
  if (references.length > ROOM_EVIDENCE_EVAL_STORE_BRIDGE_REFERENCE_LIMIT) {
    throw new RoomEvidenceEvalStoreBridgeError(
      "source_reference_limit",
      `EvalStore record contains ${references.length} source references; limit is ${ROOM_EVIDENCE_EVAL_STORE_BRIDGE_REFERENCE_LIMIT}.`,
    );
  }
  for (const reference of references) {
    if (!isEvalReference(reference) || reference.ref.toLowerCase().startsWith("room-")) {
      throw new RoomEvidenceEvalStoreBridgeError("untrusted_reference", "EvalStore advisory evidence cannot masquerade as immutable Room evidence.");
    }
  }
  return references.length;
}

function assertEvalRun(value: unknown): asserts value is EvalRun {
  if (!isRecord(value) || !isReference(value.id) || !isReference(value.projectId) || !isNonBlank(value.status)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore run must retain canonical identity and project provenance.");
  }
}

function assertEvalResult(value: unknown): asserts value is EvalTaskResult {
  if (
    !isRecord(value)
    || !isReference(value.id)
    || !isReference(value.runId)
    || !isReference(value.taskId)
    || !isRecord(value.taskSnapshot)
    || value.taskSnapshot.taskId !== value.taskId
    || !isEvalStatus(value.status)
    || !Array.isArray(value.evidence)
    || !Array.isArray(value.categoryScores)
    || !Array.isArray(value.deterministicSignals)
    || !Array.isArray(value.followUps)
  ) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore result must retain its typed immutable task evaluation shape.");
  }
}

function assertSourceReceipt(value: unknown): asserts value is RoomEvidenceEvalStoreSourceReceiptV1 {
  if (!isRecord(value) || !isReference(value.id) || !isHash(value.contentHash) || !isCanonicalTimestamp(value.issuedAt)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore source receipt must retain canonical identity, hash, and issuance time.");
  }
}

function normalizeScope(value: unknown): RoomEvidenceLedgerScope {
  if (!isScope(value)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "Room evidence scope must contain canonical project and Room IDs.");
  }
  return freeze({ projectId: value.projectId, roomId: value.roomId }) as RoomEvidenceLedgerScope;
}

function normalizeCandidate(value: unknown, scope: RoomEvidenceLedgerScope): RoomEvidenceEvalStoreCandidateV1 {
  if (
    !isRecord(value)
    || !isReference(value.id)
    || !isReference(value.roomId)
    || !isHash(value.contentHash)
    || !isReference(value.producingBindingId)
  ) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "Room candidate provenance must contain canonical ID, Room, hash, and producer binding.");
  }
  if (value.roomId !== scope.roomId) {
    throw new RoomEvidenceEvalStoreBridgeError("cross_scope", "Candidate Room does not match the requested Room evidence scope.");
  }
  return freeze({
    id: value.id,
    roomId: value.roomId,
    contentHash: value.contentHash,
    producingBindingId: value.producingBindingId,
  });
}

function requireVerifier(value: unknown): RoomEvidenceEvalStoreAuthorizationVerifierPortV1 {
  if (!isRecord(value) || typeof value.verify !== "function") {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore evidence bridge requires an independent authorization verifier.");
  }
  return value as unknown as RoomEvidenceEvalStoreAuthorizationVerifierPortV1;
}

function requireReceiptLedger(value: unknown): RoomEvidenceEvalStoreReceiptLedgerPortV1 {
  if (!isRecord(value) || typeof value.claim !== "function") {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", "EvalStore evidence bridge requires an atomic source-receipt ledger.");
  }
  return value as unknown as RoomEvidenceEvalStoreReceiptLedgerPortV1;
}

function cloneMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value === undefined ? {} : cloneImmutable(value);
}

function cloneImmutable<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneImmutable(entry);
  }
  return freeze(copy) as T;
}

function isDeepFrozenJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || !Object.isFrozen(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => entry !== undefined && isDeepFrozenJson(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !isDeepFrozenJson(descriptor.value, seen)) return false;
  }
  return true;
}

function isEvalReference(value: unknown): value is EvalEvidenceReference {
  return isRecord(value)
    && typeof value.type === "string"
    && EVAL_REFERENCE_TYPES.has(value.type as EvalEvidenceReference["type"])
    && isReference(value.ref);
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value) && isReference(value.projectId) && isReference(value.roomId);
}

function isEvalStatus(value: unknown): value is EvalTaskResult["status"] {
  return value === "scored" || value === "skipped" || value === "error";
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_PATTERN.test(value);
}

function assertReference(value: unknown, label: string): asserts value is string {
  if (!isReference(value)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", `${label} must be a canonical nonblank reference.`);
  }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (!isHash(value)) {
    throw new RoomEvidenceEvalStoreBridgeError("invalid_input", `${label} must be a canonical sha256 hash.`);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId }) as RoomEvidenceLedgerScope;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
