import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import {
  ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION,
  RoomEvolutionExecutionStoreError,
  type CreateRoomEvolutionExecutionRunInputV1,
  type CreateRoomEvolutionExecutionRunResultV1,
  type ReadRoomEvolutionExecutionRunInputV1,
  type RecordRoomEvolutionEffectOutcomeInputV1,
  type RoomEvolutionEffectClaimResultV1,
  type RoomEvolutionEffectOutboxRecordV1,
  type RoomEvolutionExecutionCompletionResultV1,
  type RoomEvolutionExecutionOutcomeRecordV1,
  type RoomEvolutionExecutionPersistence,
  type RoomEvolutionExecutionRunRecordV1,
  type RoomEvolutionExecutionRunSnapshotV1,
  type RoomEvolutionExecutionTransaction,
} from "./room-evolution-execution-store.js";
import type { RoomEvolutionJsonObjectV1, RoomEvolutionLedgerScope } from "./async-room-evolution-ledger.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomEvolutionCandidateVersions,
  roomEvolutionExecutionOutcomes,
  roomEvolutionExecutionRuns,
  roomEvolutionEffectOutbox,
  roomEvolutionExperiments,
} from "./postgres/schema/room.js";
import { hashRoomValue } from "./room-integrity.js";

export class AsyncRoomEvolutionExecutionPostgresPersistence implements RoomEvolutionExecutionPersistence {
  constructor(private readonly layer: AsyncDataLayer) {}

  async transaction<TResult>(
    operation: (transaction: RoomEvolutionExecutionTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.layer.transactionImmediate(async (tx) =>
      operation(new DrizzleRoomEvolutionExecutionTransaction(tx, this.layer.projectId)));
  }
}

class DrizzleRoomEvolutionExecutionTransaction implements RoomEvolutionExecutionTransaction {
  constructor(
    private readonly tx: DbTransaction,
    private readonly boundProjectId: string | undefined,
  ) {}

  async createOrReadRun(input: CreateRoomEvolutionExecutionRunInputV1): Promise<CreateRoomEvolutionExecutionRunResultV1> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    await assertExperimentCandidate(this.tx, input.scope, input.experimentId, input.candidateVersionId);

    const existing = await loadRunByIdempotency(this.tx, input.scope, input.idempotencyKey);
    if (existing !== null) return idempotentResult(existing, input);

    const inserted = await this.tx
      .insert(roomEvolutionExecutionRuns)
      .values({
        id: input.id,
        ...scopeValues(input.scope),
        experimentId: input.experimentId,
        candidateVersionId: input.candidateVersionId,
        idempotencyKey: input.idempotencyKey,
        request: input.request,
        requestHash: input.requestHash,
        state: "pending",
        effectCount: input.effects.length,
        completedEffectCount: 0,
        failedEffectCount: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      const raced = await loadRunByIdempotency(this.tx, input.scope, input.idempotencyKey);
      if (raced !== null) return idempotentResult(raced, input);
      throw new RoomEvolutionExecutionStoreError(
        "immutable_conflict",
        "Execution run id is already bound to another durable record",
      );
    }

    await this.tx.insert(roomEvolutionEffectOutbox).values(input.effects.map((effect) => ({
      id: effect.id,
      ...scopeValues(input.scope),
      runId: input.id,
      effectKey: effect.effectKey,
      effectKind: effect.effectKind,
      payload: effect.payload,
      payloadHash: effect.payloadHash,
      state: "pending",
      attemptCount: 0,
      maxAttempts: effect.maxAttempts,
      nextEligibleAt: effect.availableAt,
      claimToken: null,
      claimExpiresAt: null,
      claimedByWorkerId: null,
      claimedAt: null,
      lastErrorCode: null,
      completedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })));
    const snapshot = await requireRunSnapshot(this.tx, input.scope, input.id);
    return { status: "created", ...snapshot };
  }

  async claimNextEffect(input: Required<Parameters<RoomEvolutionExecutionTransaction["claimNextEffect"]>[0]>): Promise<RoomEvolutionEffectClaimResultV1> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    const recoveredOutcome = await recoverOneExpiredClaim(this.tx, input.scope, input.now);
    const candidates = await this.tx
      .select()
      .from(roomEvolutionEffectOutbox)
      .where(and(
        scopeWhere(roomEvolutionEffectOutbox, input.scope),
        or(
          and(eq(roomEvolutionEffectOutbox.state, "pending"), lte(roomEvolutionEffectOutbox.nextEligibleAt, input.now)),
          and(eq(roomEvolutionEffectOutbox.state, "retry_scheduled"), lte(roomEvolutionEffectOutbox.nextEligibleAt, input.now)),
        ),
      ))
      .orderBy(asc(roomEvolutionEffectOutbox.nextEligibleAt), asc(roomEvolutionEffectOutbox.createdAt), asc(roomEvolutionEffectOutbox.id))
      .limit(8);
    for (const candidate of candidates) {
      if (candidate.attemptCount >= candidate.maxAttempts) continue;
      const claimToken = `room-evolution-effect-claim-${randomUUID()}`;
      const claimExpiresAt = new Date(Date.parse(input.now) + input.claimTtlMs).toISOString();
      const claimed = await this.tx
        .update(roomEvolutionEffectOutbox)
        .set({
          state: "claimed",
          attemptCount: candidate.attemptCount + 1,
          nextEligibleAt: null,
          claimToken,
          claimExpiresAt,
          claimedByWorkerId: input.workerId,
          claimedAt: input.now,
          lastErrorCode: null,
          completedAt: null,
          updatedAt: input.now,
        })
        .where(and(
          eq(roomEvolutionEffectOutbox.id, candidate.id),
          scopeWhere(roomEvolutionEffectOutbox, input.scope),
          eq(roomEvolutionEffectOutbox.state, candidate.state),
          eq(roomEvolutionEffectOutbox.nextEligibleAt, candidate.nextEligibleAt!),
        ))
        .returning();
      if (claimed.length !== 1) continue;
      const run = await updateRunState(this.tx, input.scope, candidate.runId, input.now);
      return {
        recoveredOutcome,
        claim: { run, effect: rowToEffect(claimed[0]!) },
      };
    }
    return { claim: null, recoveredOutcome };
  }

  async recordEffectOutcome(
    input: RecordRoomEvolutionEffectOutcomeInputV1,
  ): Promise<RoomEvolutionExecutionCompletionResultV1> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    const rows = await this.tx
      .select()
      .from(roomEvolutionEffectOutbox)
      .where(and(
        eq(roomEvolutionEffectOutbox.id, input.effectId),
        eq(roomEvolutionEffectOutbox.runId, input.runId),
        scopeWhere(roomEvolutionEffectOutbox, input.scope),
      ))
      .limit(1);
    const current = rows[0];
    if (!current) {
      throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution effect is not present in the requested scope");
    }
    if (current.state !== "claimed" || current.claimToken !== input.claimToken
      || current.claimExpiresAt === null || Date.parse(current.claimExpiresAt) <= Date.parse(input.recordedAt)) {
      throw new RoomEvolutionExecutionStoreError("claim_conflict", "Execution effect claim is stale or belongs to another worker");
    }

    const retryExhausted = input.outcome === "retryable_failure" && current.attemptCount >= current.maxAttempts;
    const outcomeKind = input.outcome === "succeeded"
      ? "succeeded"
      : input.outcome === "retryable_failure" && !retryExhausted
        ? "retry_scheduled"
        : "failed";
    const nextState = outcomeKind === "succeeded"
      ? "succeeded"
      : outcomeKind === "retry_scheduled"
        ? "retry_scheduled"
        : "failed";
    const nextEligibleAt = outcomeKind === "retry_scheduled" ? input.retryAt : null;
    const completedAt = outcomeKind === "retry_scheduled" ? null : input.recordedAt;
    const effectiveErrorCode = outcomeKind === "succeeded"
      ? null
      : input.errorCode ?? "execution_effect_failed";
    const updated = await this.tx
      .update(roomEvolutionEffectOutbox)
      .set({
        state: nextState,
        nextEligibleAt,
        claimToken: null,
        claimExpiresAt: null,
        claimedByWorkerId: null,
        claimedAt: null,
        lastErrorCode: effectiveErrorCode,
        completedAt,
        updatedAt: input.recordedAt,
      })
      .where(and(
        eq(roomEvolutionEffectOutbox.id, input.effectId),
        eq(roomEvolutionEffectOutbox.runId, input.runId),
        scopeWhere(roomEvolutionEffectOutbox, input.scope),
        eq(roomEvolutionEffectOutbox.state, "claimed"),
        eq(roomEvolutionEffectOutbox.claimToken, input.claimToken),
      ))
      .returning();
    if (updated.length !== 1) {
      throw new RoomEvolutionExecutionStoreError("claim_conflict", "Execution effect claim changed before its outcome could be recorded");
    }
    const outcome = await insertOutcome(this.tx, input.scope, {
      runId: input.runId,
      effectId: input.effectId,
      claimToken: input.claimToken,
      attemptCount: current.attemptCount,
      kind: outcomeKind,
      payload: input.outcomePayload,
      payloadHash: input.outcomeHash,
      errorCode: effectiveErrorCode,
      recordedAt: input.recordedAt,
    });
    const run = await updateRunState(this.tx, input.scope, input.runId, input.recordedAt);
    return { run, effect: rowToEffect(updated[0]!), outcome };
  }

  async readRun(input: ReadRoomEvolutionExecutionRunInputV1): Promise<RoomEvolutionExecutionRunSnapshotV1 | null> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    return loadRunSnapshot(this.tx, input.scope, input.runId);
  }
}

async function recoverOneExpiredClaim(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  now: string,
): Promise<RoomEvolutionExecutionOutcomeRecordV1 | null> {
  const candidates = await tx
    .select()
    .from(roomEvolutionEffectOutbox)
    .where(and(
      scopeWhere(roomEvolutionEffectOutbox, scope),
      eq(roomEvolutionEffectOutbox.state, "claimed"),
      lte(roomEvolutionEffectOutbox.claimExpiresAt, now),
    ))
    .orderBy(asc(roomEvolutionEffectOutbox.claimExpiresAt), asc(roomEvolutionEffectOutbox.id))
    .limit(8);
  for (const candidate of candidates) {
    if (candidate.claimToken === null) continue;
    const exhausted = candidate.attemptCount >= candidate.maxAttempts;
    const kind = exhausted ? "failed" : "claim_expired";
    const errorCode = exhausted ? "claim_expired_exhausted" : "claim_expired";
    const nextState = exhausted ? "failed" : "retry_scheduled";
    const payload = {
      reason: "claim_expired",
      priorClaimExpiresAt: candidate.claimExpiresAt,
      priorWorkerId: candidate.claimedByWorkerId,
    } satisfies RoomEvolutionJsonObjectV1;
    const recovered = await tx
      .update(roomEvolutionEffectOutbox)
      .set({
        state: nextState,
        nextEligibleAt: exhausted ? null : now,
        claimToken: null,
        claimExpiresAt: null,
        claimedByWorkerId: null,
        claimedAt: null,
        lastErrorCode: errorCode,
        completedAt: exhausted ? now : null,
        updatedAt: now,
      })
      .where(and(
        eq(roomEvolutionEffectOutbox.id, candidate.id),
        scopeWhere(roomEvolutionEffectOutbox, scope),
        eq(roomEvolutionEffectOutbox.state, "claimed"),
        eq(roomEvolutionEffectOutbox.claimToken, candidate.claimToken),
        eq(roomEvolutionEffectOutbox.claimExpiresAt, candidate.claimExpiresAt!),
      ))
      .returning();
    if (recovered.length !== 1) continue;
    const outcome = await insertOutcome(tx, scope, {
      runId: candidate.runId,
      effectId: candidate.id,
      claimToken: candidate.claimToken,
      attemptCount: candidate.attemptCount,
      kind,
      payload,
      payloadHash: hashRoomValue(payload),
      errorCode,
      recordedAt: now,
    });
    await updateRunState(tx, scope, candidate.runId, now);
    return outcome;
  }
  return null;
}

async function insertOutcome(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  input: Omit<RoomEvolutionExecutionOutcomeRecordV1, "contractVersion" | "id" | "projectId" | "roomId" | "scopeKind" | "scopeKey">,
): Promise<RoomEvolutionExecutionOutcomeRecordV1> {
  const id = `room-evolution-execution-outcome-${randomUUID()}`;
  const inserted = await tx
    .insert(roomEvolutionExecutionOutcomes)
    .values({ id, ...scopeValues(scope), ...input })
    .returning();
  if (inserted.length !== 1) {
    throw new RoomEvolutionExecutionStoreError("immutable_conflict", "Execution outcome could not be appended exactly once");
  }
  return rowToOutcome(inserted[0]!);
}

async function updateRunState(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  runId: string,
  now: string,
): Promise<RoomEvolutionExecutionRunRecordV1> {
  const effects = await tx
    .select({ state: roomEvolutionEffectOutbox.state })
    .from(roomEvolutionEffectOutbox)
    .where(and(eq(roomEvolutionEffectOutbox.runId, runId), scopeWhere(roomEvolutionEffectOutbox, scope)));
  if (effects.length === 0) {
    throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution run has no durable effect records");
  }
  const completedEffectCount = effects.filter((effect) => effect.state === "succeeded").length;
  const failedEffectCount = effects.filter((effect) => effect.state === "failed").length;
  const terminalCount = completedEffectCount + failedEffectCount;
  const state = completedEffectCount === effects.length
    ? "succeeded"
    : terminalCount === effects.length
      ? "failed"
      : effects.some((effect) => effect.state === "claimed")
        ? "running"
        : "pending";
  const updated = await tx
    .update(roomEvolutionExecutionRuns)
    .set({
      state,
      completedEffectCount,
      failedEffectCount,
      updatedAt: now,
      completedAt: state === "succeeded" || state === "failed" ? now : null,
    })
    .where(and(eq(roomEvolutionExecutionRuns.id, runId), scopeWhere(roomEvolutionExecutionRuns, scope)))
    .returning();
  if (updated.length !== 1) {
    throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution run is not present in the requested scope");
  }
  return rowToRun(updated[0]!);
}

async function assertExperimentCandidate(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  experimentId: string,
  candidateVersionId: string,
): Promise<void> {
  const experimentRows = await tx
    .select({ candidateVersionId: roomEvolutionExperiments.candidateVersionId, state: roomEvolutionExperiments.state })
    .from(roomEvolutionExperiments)
    .where(and(eq(roomEvolutionExperiments.id, experimentId), scopeWhere(roomEvolutionExperiments, scope)))
    .limit(1);
  const experiment = experimentRows[0];
  if (!experiment) {
    throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution experiment is not present in the requested scope");
  }
  if (experiment.candidateVersionId !== candidateVersionId) {
    throw new RoomEvolutionExecutionStoreError("scope_mismatch", "Execution experiment does not bind the submitted candidate version");
  }
  if (!(experiment.state === "planned" || experiment.state === "running")) {
    throw new RoomEvolutionExecutionStoreError("state_conflict", "Execution experiment is not in a runnable state");
  }
  const candidateRows = await tx
    .select({ id: roomEvolutionCandidateVersions.id })
    .from(roomEvolutionCandidateVersions)
    .where(and(eq(roomEvolutionCandidateVersions.id, candidateVersionId), scopeWhere(roomEvolutionCandidateVersions, scope)))
    .limit(1);
  if (!candidateRows[0]) {
    throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution candidate version is not present in the requested scope");
  }
}

async function loadRunByIdempotency(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  idempotencyKey: string,
): Promise<RoomEvolutionExecutionRunSnapshotV1 | null> {
  const rows = await tx
    .select({ id: roomEvolutionExecutionRuns.id })
    .from(roomEvolutionExecutionRuns)
    .where(and(eq(roomEvolutionExecutionRuns.idempotencyKey, idempotencyKey), scopeWhere(roomEvolutionExecutionRuns, scope)))
    .limit(1);
  return rows[0] ? loadRunSnapshot(tx, scope, rows[0].id) : null;
}

function idempotentResult(
  snapshot: RoomEvolutionExecutionRunSnapshotV1,
  input: CreateRoomEvolutionExecutionRunInputV1,
): CreateRoomEvolutionExecutionRunResultV1 {
  const expectedEffects = new Map(input.effects.map((effect) => [effect.effectKey, effect]));
  const identical = snapshot.run.experimentId === input.experimentId
    && snapshot.run.candidateVersionId === input.candidateVersionId
    && snapshot.run.requestHash === input.requestHash
    && snapshot.effects.length === input.effects.length
    && snapshot.effects.every((effect) => {
      const expected = expectedEffects.get(effect.effectKey);
      return expected !== undefined
        && effect.id === expected.id
        && effect.effectKind === expected.effectKind
        && effect.payloadHash === expected.payloadHash
        && effect.maxAttempts === expected.maxAttempts;
    });
  if (!identical) {
    throw new RoomEvolutionExecutionStoreError(
      "idempotency_conflict",
      "Execution idempotency key already binds a different durable request or effect set",
    );
  }
  return { status: "idempotent", ...snapshot };
}

async function requireRunSnapshot(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  runId: string,
): Promise<RoomEvolutionExecutionRunSnapshotV1> {
  const snapshot = await loadRunSnapshot(tx, scope, runId);
  if (!snapshot) throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution run is not present in the requested scope");
  return snapshot;
}

async function loadRunSnapshot(
  tx: DbTransaction,
  scope: RoomEvolutionLedgerScope,
  runId: string,
): Promise<RoomEvolutionExecutionRunSnapshotV1 | null> {
  const runRows = await tx
    .select()
    .from(roomEvolutionExecutionRuns)
    .where(and(eq(roomEvolutionExecutionRuns.id, runId), scopeWhere(roomEvolutionExecutionRuns, scope)))
    .limit(1);
  const run = runRows[0];
  if (!run) return null;
  const effects = await tx
    .select()
    .from(roomEvolutionEffectOutbox)
    .where(and(eq(roomEvolutionEffectOutbox.runId, runId), scopeWhere(roomEvolutionEffectOutbox, scope)))
    .orderBy(asc(roomEvolutionEffectOutbox.createdAt), asc(roomEvolutionEffectOutbox.id));
  const outcomes = await tx
    .select()
    .from(roomEvolutionExecutionOutcomes)
    .where(and(eq(roomEvolutionExecutionOutcomes.runId, runId), scopeWhere(roomEvolutionExecutionOutcomes, scope)))
    .orderBy(asc(roomEvolutionExecutionOutcomes.recordedAt), asc(roomEvolutionExecutionOutcomes.id));
  return {
    run: rowToRun(run),
    effects: effects.map(rowToEffect),
    outcomes: outcomes.map(rowToOutcome),
  };
}

async function assertRoomScope(tx: DbTransaction, scope: RoomEvolutionLedgerScope): Promise<void> {
  if (scope.roomId === null) return;
  const rooms = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(eq(operationalRooms.projectId, scope.projectId), eq(operationalRooms.id, scope.roomId)))
    .limit(1);
  if (!rooms[0]) {
    throw new RoomEvolutionExecutionStoreError("reference_not_found", "Execution scope Room is not present in the submitted project");
  }
}

function assertBoundProjectScope(boundProjectId: string | undefined, scope: RoomEvolutionLedgerScope): void {
  if (boundProjectId !== undefined && boundProjectId !== scope.projectId) {
    throw new RoomEvolutionExecutionStoreError("scope_mismatch", "Execution scope does not match the bound project");
  }
}

function scopeValues(scope: RoomEvolutionLedgerScope): {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: string;
  readonly scopeKey: string;
} {
  return {
    projectId: scope.projectId,
    roomId: scope.roomId,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
  };
}

interface EvolutionScopedColumns {
  readonly projectId: SQLWrapper;
  readonly roomId: SQLWrapper;
  readonly scopeKind: SQLWrapper;
  readonly scopeKey: SQLWrapper;
}

function scopeWhere(table: EvolutionScopedColumns, scope: RoomEvolutionLedgerScope): SQL {
  return and(
    sql`${table.projectId} = ${scope.projectId}`,
    scope.roomId === null ? sql`${table.roomId} IS NULL` : sql`${table.roomId} = ${scope.roomId}`,
    sql`${table.scopeKind} = ${scope.scopeKind}`,
    sql`${table.scopeKey} = ${scope.scopeKey}`,
  )!;
}

function rowToRun(row: typeof roomEvolutionExecutionRuns.$inferSelect): RoomEvolutionExecutionRunRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    experimentId: row.experimentId,
    candidateVersionId: row.candidateVersionId,
    idempotencyKey: row.idempotencyKey,
    request: row.request as RoomEvolutionJsonObjectV1,
    requestHash: row.requestHash,
    state: row.state as RoomEvolutionExecutionRunRecordV1["state"],
    effectCount: row.effectCount,
    completedEffectCount: row.completedEffectCount,
    failedEffectCount: row.failedEffectCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function rowToEffect(row: typeof roomEvolutionEffectOutbox.$inferSelect): RoomEvolutionEffectOutboxRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    runId: row.runId,
    effectKey: row.effectKey,
    effectKind: row.effectKind,
    payload: row.payload as RoomEvolutionJsonObjectV1,
    payloadHash: row.payloadHash,
    state: row.state as RoomEvolutionEffectOutboxRecordV1["state"],
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextEligibleAt: row.nextEligibleAt,
    claimToken: row.claimToken,
    claimExpiresAt: row.claimExpiresAt,
    claimedByWorkerId: row.claimedByWorkerId,
    claimedAt: row.claimedAt,
    lastErrorCode: row.lastErrorCode,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToOutcome(row: typeof roomEvolutionExecutionOutcomes.$inferSelect): RoomEvolutionExecutionOutcomeRecordV1 {
  return {
    contractVersion: ROOM_EVOLUTION_EXECUTION_STORE_CONTRACT_VERSION,
    id: row.id,
    ...scopeFromRow(row),
    runId: row.runId,
    effectId: row.effectId,
    claimToken: row.claimToken,
    attemptCount: row.attemptCount,
    kind: row.kind as RoomEvolutionExecutionOutcomeRecordV1["kind"],
    payload: row.payload as RoomEvolutionJsonObjectV1,
    payloadHash: row.payloadHash,
    errorCode: row.errorCode,
    recordedAt: row.recordedAt,
  };
}

function scopeFromRow(row: {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: string;
  readonly scopeKey: string;
}): RoomEvolutionLedgerScope {
  return {
    projectId: row.projectId,
    roomId: row.roomId,
    scopeKind: row.scopeKind as RoomEvolutionLedgerScope["scopeKind"],
    scopeKey: row.scopeKey,
  };
}
