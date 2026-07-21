import type { RoomEvolutionJsonObjectV1, RoomEvolutionLedgerScope } from "./async-room-evolution-ledger.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION = 1 as const;
export const DEFAULT_ROOM_EVOLUTION_EFFECT_CLAIM_TTL_MS = 30_000;

export type RoomEvolutionExecutionRunStateV1 = "pending" | "running" | "succeeded" | "failed";
export type RoomEvolutionEffectOutboxStateV1 = "pending" | "claimed" | "retry_scheduled" | "succeeded" | "failed";
export type RoomEvolutionExecutionOutcomeKindV1 = "claim_expired" | "retry_scheduled" | "succeeded" | "failed";
export type RoomEvolutionExecutionOutcomeInputKindV1 = "retryable_failure" | "succeeded" | "terminal_failure";

/*
FNXC:RoomEvolutionExecutionRecovery 2026-07-19-21:32:
Evolution execution is only a durable intent and recovery contract. It never
executes a provider, source change, or policy by itself. A future Engine must
claim a stable effect idempotency key, execute the external effect at-least-once,
and report a claim-token-matched outcome so a crash cannot be displayed as success.
*/
export interface RoomEvolutionExecutionRunRecordV1 extends RoomEvolutionLedgerScope {
  readonly contractVersion: typeof ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION;
  readonly id: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly idempotencyKey: string;
  readonly request: RoomEvolutionJsonObjectV1;
  readonly requestHash: string;
  readonly state: RoomEvolutionExecutionRunStateV1;
  readonly effectCount: number;
  readonly completedEffectCount: number;
  readonly failedEffectCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface RoomEvolutionEffectOutboxRecordV1 extends RoomEvolutionLedgerScope {
  readonly contractVersion: typeof ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly effectKey: string;
  readonly effectKind: string;
  readonly payload: RoomEvolutionJsonObjectV1;
  readonly payloadHash: string;
  readonly state: RoomEvolutionEffectOutboxStateV1;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextEligibleAt: string | null;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly claimedByWorkerId: string | null;
  readonly claimedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomEvolutionExecutionOutcomeRecordV1 extends RoomEvolutionLedgerScope {
  readonly contractVersion: typeof ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly effectId: string;
  readonly claimToken: string;
  readonly attemptCount: number;
  readonly kind: RoomEvolutionExecutionOutcomeKindV1;
  readonly payload: RoomEvolutionJsonObjectV1;
  readonly payloadHash: string;
  readonly errorCode: string | null;
  readonly recordedAt: string;
}

export interface RoomEvolutionExecutionRunSnapshotV1 {
  readonly run: RoomEvolutionExecutionRunRecordV1;
  readonly effects: readonly RoomEvolutionEffectOutboxRecordV1[];
  readonly outcomes: readonly RoomEvolutionExecutionOutcomeRecordV1[];
}

export interface RoomEvolutionExecutionEffectInputV1 {
  readonly id: string;
  /** Stable handler idempotency key; retries of the same effect must reuse it. */
  readonly effectKey: string;
  readonly effectKind: string;
  readonly payload: RoomEvolutionJsonObjectV1;
  readonly payloadHash: string;
  readonly maxAttempts: number;
  readonly availableAt: string;
}

export interface CreateRoomEvolutionExecutionRunInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly experimentId: string;
  readonly candidateVersionId: string;
  readonly request: RoomEvolutionJsonObjectV1;
  readonly requestHash: string;
  readonly effects: readonly RoomEvolutionExecutionEffectInputV1[];
  readonly createdAt: string;
}

export interface CreateRoomEvolutionExecutionRunResultV1 extends RoomEvolutionExecutionRunSnapshotV1 {
  readonly status: "created" | "idempotent";
}

export interface ClaimRoomEvolutionEffectInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly workerId: string;
  readonly now: string;
  readonly claimTtlMs?: number;
}

export interface RoomEvolutionEffectClaimV1 {
  readonly run: RoomEvolutionExecutionRunRecordV1;
  readonly effect: RoomEvolutionEffectOutboxRecordV1;
}

export interface RoomEvolutionEffectClaimResultV1 {
  readonly claim: RoomEvolutionEffectClaimV1 | null;
  /** The abandoned attempt is durable evidence; a new claim never erases it. */
  readonly recoveredOutcome: RoomEvolutionExecutionOutcomeRecordV1 | null;
}

export interface RecordRoomEvolutionEffectOutcomeInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly runId: string;
  readonly effectId: string;
  readonly claimToken: string;
  readonly outcome: RoomEvolutionExecutionOutcomeInputKindV1;
  readonly outcomePayload: RoomEvolutionJsonObjectV1;
  readonly outcomeHash: string;
  readonly errorCode: string | null;
  readonly retryAt: string | null;
  readonly recordedAt: string;
}

export interface RoomEvolutionExecutionCompletionResultV1 {
  readonly run: RoomEvolutionExecutionRunRecordV1;
  readonly effect: RoomEvolutionEffectOutboxRecordV1;
  readonly outcome: RoomEvolutionExecutionOutcomeRecordV1;
}

export interface ReadRoomEvolutionExecutionRunInputV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly runId: string;
}

export interface RoomEvolutionExecutionTransaction {
  createOrReadRun(input: CreateRoomEvolutionExecutionRunInputV1): Promise<CreateRoomEvolutionExecutionRunResultV1>;
  claimNextEffect(input: Required<ClaimRoomEvolutionEffectInputV1>): Promise<RoomEvolutionEffectClaimResultV1>;
  recordEffectOutcome(input: RecordRoomEvolutionEffectOutcomeInputV1): Promise<RoomEvolutionExecutionCompletionResultV1>;
  readRun(input: ReadRoomEvolutionExecutionRunInputV1): Promise<RoomEvolutionExecutionRunSnapshotV1 | null>;
}

export interface RoomEvolutionExecutionPersistence {
  transaction<TResult>(
    operation: (transaction: RoomEvolutionExecutionTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

/** Minimal Engine injection seam; the Core store never invokes an effect handler. */
export interface RoomEvolutionExecutionRecoveryPortV1 {
  createOrReadRun(input: CreateRoomEvolutionExecutionRunInputV1): Promise<CreateRoomEvolutionExecutionRunResultV1>;
  claimNextEffect(input: ClaimRoomEvolutionEffectInputV1): Promise<RoomEvolutionEffectClaimResultV1>;
  recordEffectOutcome(input: RecordRoomEvolutionEffectOutcomeInputV1): Promise<RoomEvolutionExecutionCompletionResultV1>;
  readRun(input: ReadRoomEvolutionExecutionRunInputV1): Promise<RoomEvolutionExecutionRunSnapshotV1 | null>;
}

export type RoomEvolutionExecutionStoreErrorCode =
  | "invalid_input"
  | "idempotency_conflict"
  | "reference_not_found"
  | "scope_mismatch"
  | "claim_conflict"
  | "immutable_conflict"
  | "state_conflict";

export class RoomEvolutionExecutionStoreError extends Error {
  constructor(
    readonly code: RoomEvolutionExecutionStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionExecutionStoreError";
  }
}

export class AsyncRoomEvolutionExecutionStore implements RoomEvolutionExecutionRecoveryPortV1 {
  constructor(private readonly persistence: RoomEvolutionExecutionPersistence) {}

  async createOrReadRun(input: CreateRoomEvolutionExecutionRunInputV1): Promise<CreateRoomEvolutionExecutionRunResultV1> {
    const normalized = normalizeCreateInput(input);
    const result = await this.persistence.transaction((transaction) => transaction.createOrReadRun(immutableCopy(normalized)));
    assertCreateResult(result, normalized);
    return immutableCopy(result);
  }

  async claimNextEffect(input: ClaimRoomEvolutionEffectInputV1): Promise<RoomEvolutionEffectClaimResultV1> {
    const normalized = normalizeClaimInput(input);
    const result = await this.persistence.transaction((transaction) => transaction.claimNextEffect(immutableCopy(normalized)));
    assertClaimResult(result, normalized);
    return immutableCopy(result);
  }

  async recordEffectOutcome(
    input: RecordRoomEvolutionEffectOutcomeInputV1,
  ): Promise<RoomEvolutionExecutionCompletionResultV1> {
    const normalized = normalizeOutcomeInput(input);
    const result = await this.persistence.transaction((transaction) => transaction.recordEffectOutcome(immutableCopy(normalized)));
    assertCompletionResult(result, normalized);
    return immutableCopy(result);
  }

  async readRun(input: ReadRoomEvolutionExecutionRunInputV1): Promise<RoomEvolutionExecutionRunSnapshotV1 | null> {
    const normalized = {
      scope: normalizeScope(input.scope),
      runId: requiredText(input.runId, "execution run id"),
    } satisfies ReadRoomEvolutionExecutionRunInputV1;
    const snapshot = await this.persistence.transaction((transaction) => transaction.readRun(immutableCopy(normalized)));
    if (snapshot !== null) assertSnapshot(snapshot, normalized.scope, normalized.runId);
    return snapshot === null ? null : immutableCopy(snapshot);
  }
}

function normalizeCreateInput(input: CreateRoomEvolutionExecutionRunInputV1): CreateRoomEvolutionExecutionRunInputV1 {
  const scope = normalizeScope(input.scope);
  const request = requiredJsonObject(input.request, "execution request");
  const requestHash = requiredHash(input.requestHash, "execution request hash");
  if (requestHash !== hashRoomValue(request)) {
    throw invalidInput("Execution request hash does not bind the submitted request");
  }
  const createdAt = canonicalTimestamp(input.createdAt, "execution createdAt");
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw invalidInput("Execution run requires at least one durable effect");
  }
  const effectIds = new Set<string>();
  const effectKeys = new Set<string>();
  const effects = input.effects.map((effect) => {
    const id = requiredText(effect.id, "execution effect id");
    const effectKey = requiredText(effect.effectKey, "execution effect key");
    if (effectIds.has(id) || effectKeys.has(effectKey)) {
      throw invalidInput("Execution run effect ids and effect keys must be unique");
    }
    effectIds.add(id);
    effectKeys.add(effectKey);
    const payload = requiredJsonObject(effect.payload, "execution effect payload");
    const payloadHash = requiredHash(effect.payloadHash, "execution effect payload hash");
    if (payloadHash !== hashRoomValue(payload)) {
      throw invalidInput("Execution effect payload hash does not bind the submitted payload");
    }
    return {
      id,
      effectKey,
      effectKind: requiredText(effect.effectKind, "execution effect kind"),
      payload,
      payloadHash,
      maxAttempts: positiveSafeInteger(effect.maxAttempts, "execution effect maxAttempts"),
      availableAt: canonicalTimestamp(effect.availableAt, "execution effect availableAt"),
    } satisfies RoomEvolutionExecutionEffectInputV1;
  });
  return {
    scope,
    id: requiredText(input.id, "execution run id"),
    idempotencyKey: requiredText(input.idempotencyKey, "execution idempotency key"),
    experimentId: requiredText(input.experimentId, "execution experiment id"),
    candidateVersionId: requiredText(input.candidateVersionId, "execution candidate version id"),
    request,
    requestHash,
    effects,
    createdAt,
  };
}

function normalizeClaimInput(input: ClaimRoomEvolutionEffectInputV1): Required<ClaimRoomEvolutionEffectInputV1> {
  return {
    scope: normalizeScope(input.scope),
    workerId: requiredText(input.workerId, "execution worker id"),
    now: canonicalTimestamp(input.now, "execution claim now"),
    claimTtlMs: positiveSafeInteger(
      input.claimTtlMs ?? DEFAULT_ROOM_EVOLUTION_EFFECT_CLAIM_TTL_MS,
      "execution claim ttl",
    ),
  };
}

function normalizeOutcomeInput(
  input: RecordRoomEvolutionEffectOutcomeInputV1,
): RecordRoomEvolutionEffectOutcomeInputV1 {
  const recordedAt = canonicalTimestamp(input.recordedAt, "execution outcome recordedAt");
  const outcomePayload = requiredJsonObject(input.outcomePayload, "execution outcome payload");
  const outcomeHash = requiredHash(input.outcomeHash, "execution outcome hash");
  if (outcomeHash !== hashRoomValue(outcomePayload)) {
    throw invalidInput("Execution outcome hash does not bind the submitted outcome payload");
  }
  if (!(input.outcome === "retryable_failure" || input.outcome === "succeeded" || input.outcome === "terminal_failure")) {
    throw invalidInput("Execution outcome kind is unsupported");
  }
  const errorCode = input.errorCode === null ? null : requiredText(input.errorCode, "execution outcome error code");
  let retryAt: string | null = input.retryAt;
  if (input.outcome === "retryable_failure") {
    if (errorCode === null) throw invalidInput("Retryable execution outcome requires an error code");
    retryAt = retryAt === null ? null : canonicalTimestamp(retryAt, "execution retryAt");
    if (retryAt === null || Date.parse(retryAt) <= Date.parse(recordedAt)) {
      throw invalidInput("Retryable execution outcome requires a retryAt strictly after recordedAt");
    }
  } else if (retryAt !== null) {
    throw invalidInput("Terminal execution outcomes cannot retain a retryAt");
  }
  if (input.outcome === "succeeded" && errorCode !== null) {
    throw invalidInput("Successful execution outcome cannot retain an error code");
  }
  return {
    scope: normalizeScope(input.scope),
    runId: requiredText(input.runId, "execution outcome run id"),
    effectId: requiredText(input.effectId, "execution outcome effect id"),
    claimToken: requiredText(input.claimToken, "execution outcome claim token"),
    outcome: input.outcome,
    outcomePayload,
    outcomeHash,
    errorCode,
    retryAt,
    recordedAt,
  };
}

function assertCreateResult(
  result: CreateRoomEvolutionExecutionRunResultV1,
  input: CreateRoomEvolutionExecutionRunInputV1,
): void {
  if (!(result.status === "created" || result.status === "idempotent")) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution persistence returned an unsupported create status");
  }
  assertSnapshot(result, input.scope);
  if (result.run.experimentId !== input.experimentId
    || result.run.candidateVersionId !== input.candidateVersionId
    || result.run.idempotencyKey !== input.idempotencyKey
    || result.run.requestHash !== input.requestHash) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution persistence returned a run that does not match its request");
  }
  if (result.status === "created" && result.run.id !== input.id) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Created execution run did not preserve the requested run id");
  }
}

function assertClaimResult(
  result: RoomEvolutionEffectClaimResultV1,
  input: Required<ClaimRoomEvolutionEffectInputV1>,
): void {
  if (result.claim !== null) {
    assertScope(result.claim.run, input.scope, "claimed execution run");
    assertScope(result.claim.effect, input.scope, "claimed execution effect");
    if (result.claim.effect.runId !== result.claim.run.id
      || result.claim.effect.state !== "claimed"
      || !isNonBlankString(result.claim.effect.claimToken)
      || !isCanonicalTimestamp(result.claim.effect.claimExpiresAt)
      || !isNonBlankString(result.claim.effect.claimedByWorkerId)
      || result.claim.effect.claimedByWorkerId !== input.workerId
      || !isCanonicalTimestamp(result.claim.effect.claimedAt)
      || Date.parse(result.claim.effect.claimExpiresAt) <= Date.parse(result.claim.effect.claimedAt)) {
      throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution persistence returned an invalid effect claim");
    }
  }
  if (result.recoveredOutcome !== null) {
    assertScope(result.recoveredOutcome, input.scope, "recovered execution outcome");
    if (result.recoveredOutcome.kind !== "claim_expired") {
      throw new RoomEvolutionExecutionStoreError("state_conflict", "Recovered execution outcome must record an expired claim");
    }
  }
}

function assertCompletionResult(
  result: RoomEvolutionExecutionCompletionResultV1,
  input: RecordRoomEvolutionEffectOutcomeInputV1,
): void {
  assertScope(result.run, input.scope, "completed execution run");
  assertScope(result.effect, input.scope, "completed execution effect");
  assertScope(result.outcome, input.scope, "completed execution outcome");
  if (result.run.id !== input.runId || result.effect.id !== input.effectId || result.effect.runId !== input.runId
    || result.outcome.runId !== input.runId || result.outcome.effectId !== input.effectId
    || result.outcome.claimToken !== input.claimToken || result.outcome.payloadHash !== input.outcomeHash) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution persistence returned a mismatched outcome completion");
  }
}

function assertSnapshot(
  snapshot: RoomEvolutionExecutionRunSnapshotV1,
  scope: RoomEvolutionLedgerScope,
  expectedRunId?: string,
): void {
  assertScope(snapshot.run, scope, "execution run");
  if (expectedRunId !== undefined && snapshot.run.id !== expectedRunId) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution snapshot run id does not match the request");
  }
  for (const effect of snapshot.effects) {
    assertScope(effect, scope, "execution effect");
    if (effect.runId !== snapshot.run.id) {
      throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution snapshot effect belongs to another run");
    }
  }
  for (const outcome of snapshot.outcomes) {
    assertScope(outcome, scope, "execution outcome");
    if (outcome.runId !== snapshot.run.id || !snapshot.effects.some((effect) => effect.id === outcome.effectId)) {
      throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution snapshot outcome belongs to another run or effect");
    }
  }
}

function assertScope(
  record: RoomEvolutionLedgerScope,
  scope: RoomEvolutionLedgerScope,
  label: string,
): void {
  if (record.projectId !== scope.projectId
    || record.roomId !== scope.roomId
    || record.scopeKind !== scope.scopeKind
    || record.scopeKey !== scope.scopeKey) {
    throw new RoomEvolutionExecutionStoreError("scope_mismatch", label + " belongs to another project or Room scope");
  }
}

function normalizeScope(input: RoomEvolutionLedgerScope): RoomEvolutionLedgerScope {
  const projectId = requiredText(input.projectId, "execution scope project id");
  if (input.scopeKind === "project") {
    if (input.roomId !== null || input.scopeKey !== `project:${projectId}`) {
      throw invalidInput("Project execution scope must use a null room id and its canonical scope key");
    }
    return { projectId, roomId: null, scopeKind: "project", scopeKey: `project:${projectId}` };
  }
  if (input.scopeKind === "room") {
    const roomId = requiredText(input.roomId, "execution scope room id");
    if (input.scopeKey !== `room:${roomId}`) {
      throw invalidInput("Room execution scope must use its canonical scope key");
    }
    return { projectId, roomId, scopeKind: "room", scopeKey: `room:${roomId}` };
  }
  throw invalidInput("Execution scope kind is unsupported");
}

function requiredJsonObject(value: unknown, label: string): RoomEvolutionJsonObjectV1 {
  if (!isJsonObject(value)) throw invalidInput(label + " must be a non-array object");
  return immutableCopy(value);
}

function requiredHash(value: string, label: string): string {
  const hash = requiredText(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw invalidInput(label + " must be a sha256 hash");
  return hash;
}

function canonicalTimestamp(value: string, label: string): string {
  const timestamp = requiredText(value, label);
  if (!isCanonicalTimestamp(timestamp)) throw invalidInput(label + " must be a canonical UTC ISO timestamp");
  return timestamp;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(label + " must be a positive safe integer");
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (!isNonBlankString(value)) throw invalidInput(label + " must be non-blank");
  return value;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonObject(value: unknown): value is RoomEvolutionJsonObjectV1 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): RoomEvolutionExecutionStoreError {
  return new RoomEvolutionExecutionStoreError("invalid_input", message);
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
