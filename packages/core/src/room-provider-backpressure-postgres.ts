import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { assertRoomLeaseFence, type StoredRoomLeaseV1 } from "./async-room-lease-store.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomProviderBackpressureOperations,
  roomProviderBackpressureReservations,
  roomProviderBackpressureStates,
} from "./postgres/schema/room.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_PROVIDER_BACKPRESSURE_POSTGRES_CONTRACT_VERSION = 1 as const;
export const ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION = 1 as const;

export type RoomProviderBackpressureWorkClassV1 = "normal" | "verifier" | "recovery";
export type RoomProviderBackpressureCircuitStateV1 = "closed" | "open" | "half_open";
export type RoomProviderBackpressureActionV1 = "admit" | "hold" | "recorded";
export type RoomProviderBackpressureFailureKindV1 = "rate_limited" | "transient" | "connector_unavailable";
export type RoomProviderBackpressureOperationV1 =
  | { readonly kind: "dispatch" }
  | { readonly kind: "success" }
  | {
      readonly kind: "failure";
      readonly failureKind: RoomProviderBackpressureFailureKindV1;
      readonly retryAfterMs?: number;
    };

export type RoomProviderBackpressureReleaseOutcomeV1 =
  | "worker_completed"
  | "worker_failed"
  | "controller_stop"
  | "room_not_runnable"
  | "lease_lost"
  | "recovery_withheld"
  | "semantic_inbox_stopped"
  | "renew_guard_lost"
  | "provider_backpressure"
  | "pre_start_authority_lost"
  | "start_audit_failed"
  | "unknown";

export interface RoomProviderBackpressureScopeV1 {
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly connectorId: string;
  readonly nodeId: string;
}

export interface RoomProviderBackpressureWorkV1 {
  readonly requestId: string;
  readonly class: RoomProviderBackpressureWorkClassV1;
  readonly allowHalfOpenProbe: boolean;
}

export interface RoomProviderBackpressureTelemetryV1 {
  readonly known: boolean;
  readonly observedAt: string;
  readonly admissionConfirmed: boolean;
  readonly activeRequests: number;
}

export interface RoomProviderBackpressurePolicyV1 {
  readonly concurrencyCap: number;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly telemetryTtlMs: number;
  readonly failureThreshold: number;
  readonly maxRetryAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly circuitOpenMs: number;
}

export interface RoomProviderBackpressureStateV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly scopeKey: string;
  readonly circuitState: RoomProviderBackpressureCircuitStateV1;
  readonly consecutiveFailures: number;
  readonly retryAttempt: number;
  readonly retryNotBefore: string | null;
  readonly openUntil: string | null;
  readonly halfOpenProbeInFlight: boolean;
  readonly lastUpdatedAt: string;
}

/**
 * The Engine controller treats this as its ordinary state shape. `revision` is
 * deliberately additive so a read/decide/commit caller cannot replay a stale
 * decision after another worker changes the same provider scope.
 */
export interface RoomProviderBackpressurePostgresStateV1 extends RoomProviderBackpressureStateV1 {
  readonly revision: number;
}

export interface RoomProviderBackpressureDecisionV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly action: RoomProviderBackpressureActionV1;
  readonly reason: string;
  readonly retryAfterMs: number | null;
  readonly exponentialBackoffMs: number | null;
  readonly retryDelayMs: number | null;
  readonly effectiveConcurrencyCap: number | null;
}

export interface RoomProviderBackpressureControllerInputV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly asOf: string;
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly work: RoomProviderBackpressureWorkV1;
  readonly operation: RoomProviderBackpressureOperationV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly state?: RoomProviderBackpressureStateV1;
}

export interface RoomProviderBackpressureControllerResultV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly scopeKey: string;
  readonly decision: RoomProviderBackpressureDecisionV1;
  readonly state: RoomProviderBackpressureStateV1;
}

export interface RoomProviderBackpressurePostgresReadInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
  readonly requestId: string;
  readonly workClass: RoomProviderBackpressureWorkClassV1;
  readonly allowHalfOpenProbe: boolean;
  readonly asOf: string;
}

export interface RoomProviderBackpressurePostgresSourceSnapshotV1 {
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
}

/**
 * Provider telemetry remains an Engine/connector concern. This durable Core
 * adapter only reads that source and owns the state, admission fence, and TTL
 * reservation that turn telemetry into a safe multi-worker decision.
 */
export interface RoomProviderBackpressurePostgresSnapshotSourceV1 {
  read(
    input: RoomProviderBackpressurePostgresReadInputV1,
  ): Promise<RoomProviderBackpressurePostgresSourceSnapshotV1>;
}

export interface RoomProviderBackpressurePostgresSnapshotV1 extends RoomProviderBackpressurePostgresSourceSnapshotV1 {
  readonly state?: RoomProviderBackpressurePostgresStateV1;
}

export interface RoomProviderBackpressurePostgresCommitInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
  readonly requestId: string;
  readonly decisionInput: RoomProviderBackpressureControllerInputV1;
  readonly decision: RoomProviderBackpressureControllerResultV1;
}

export type RoomProviderBackpressurePostgresCommitResultV1 =
  | { readonly status: "reserved"; readonly reservationId: string }
  | { readonly status: "held"; readonly reason: string };

export interface RoomProviderBackpressurePostgresReleaseInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
  readonly requestId: string;
  readonly reservationId: string;
  readonly claimId: string;
  readonly outcome: RoomProviderBackpressureReleaseOutcomeV1;
  readonly releasedAt: string;
}

export interface RoomProviderBackpressurePostgresPortsV1 {
  read(input: RoomProviderBackpressurePostgresReadInputV1): Promise<RoomProviderBackpressurePostgresSnapshotV1>;
  commit(
    input: RoomProviderBackpressurePostgresCommitInputV1,
  ): Promise<RoomProviderBackpressurePostgresCommitResultV1>;
  release(input: RoomProviderBackpressurePostgresReleaseInputV1): Promise<void>;
}

export interface CreateRoomProviderBackpressurePostgresPortsInputV1 {
  readonly layer: AsyncDataLayer;
  readonly snapshotSource: RoomProviderBackpressurePostgresSnapshotSourceV1;
  readonly projectId?: string;
}

export class RoomProviderBackpressurePostgresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomProviderBackpressurePostgresError";
  }
}

const WORK_CLASSES = new Set<RoomProviderBackpressureWorkClassV1>(["normal", "verifier", "recovery"]);
const CIRCUIT_STATES = new Set<RoomProviderBackpressureCircuitStateV1>(["closed", "open", "half_open"]);
const RELEASE_OUTCOMES = new Set<RoomProviderBackpressureReleaseOutcomeV1>([
  "worker_completed",
  "worker_failed",
  "controller_stop",
  "room_not_runnable",
  "lease_lost",
  "recovery_withheld",
  "semantic_inbox_stopped",
  "renew_guard_lost",
  "provider_backpressure",
  "pre_start_authority_lost",
  "start_audit_failed",
  "unknown",
]);
const MAX_SAFE_DATABASE_INTEGER = 9_007_199_254_740_991;
const LOCK_PREFIX = "fusion-room-provider-backpressure-v1";

type StateRow = typeof roomProviderBackpressureStates.$inferSelect;
type ReservationRow = typeof roomProviderBackpressureReservations.$inferSelect;
type OperationRow = typeof roomProviderBackpressureOperations.$inferSelect;

interface EvaluatedDecisionV1 {
  readonly action: RoomProviderBackpressureActionV1;
  readonly reason: string;
  readonly decision: RoomProviderBackpressureDecisionV1;
  readonly state: RoomProviderBackpressureStateV1;
  readonly reserve: boolean;
}

export function createRoomProviderBackpressurePostgresPorts(
  input: CreateRoomProviderBackpressurePostgresPortsInputV1,
): RoomProviderBackpressurePostgresPortsV1 {
  const implementation = new RoomProviderBackpressurePostgresPorts(input);
  return Object.freeze({
    read: implementation.read.bind(implementation),
    commit: implementation.commit.bind(implementation),
    release: implementation.release.bind(implementation),
  });
}

class RoomProviderBackpressurePostgresPorts {
  private readonly boundProjectId: string | undefined;

  constructor(private readonly input: CreateRoomProviderBackpressurePostgresPortsInputV1) {
    if (!input.layer || !input.snapshotSource || typeof input.snapshotSource.read !== "function") {
      throw new RoomProviderBackpressurePostgresError(
        "Room provider backpressure PostgreSQL ports require a data layer and snapshot source",
      );
    }
    if (input.projectId && input.layer.projectId && input.projectId !== input.layer.projectId) {
      throw new RoomProviderBackpressurePostgresError(
        "Room provider backpressure PostgreSQL factory project scope conflicts with its data layer",
      );
    }
    if (input.projectId !== undefined && !canonicalString(input.projectId)) {
      throw new RoomProviderBackpressurePostgresError(
        "Room provider backpressure PostgreSQL factory project scope is invalid",
      );
    }
    this.boundProjectId = input.projectId ?? input.layer.projectId;
  }

  async read(
    readInput: RoomProviderBackpressurePostgresReadInputV1,
  ): Promise<RoomProviderBackpressurePostgresSnapshotV1> {
    validateReadInput(readInput);
    this.assertProjectScope(readInput.projectId);
    const sourceSnapshot = await this.input.snapshotSource.read(readInput);
    validateSourceSnapshot(sourceSnapshot);
    const scope = freezeScope(sourceSnapshot.scope);
    const scopeKey = scopeToKey(scope);

    return this.input.layer.transactionImmediate(async (tx) => {
      await assertWorkerLease(tx, readInput.projectId, readInput.roomId, readInput.lease, readInput.asOf);
      if (!await roomHasVersion(tx, readInput.projectId, readInput.roomId, readInput.expectedAggregateVersion)) {
        throw new RoomProviderBackpressurePostgresError("Room provider backpressure read has a stale aggregate version");
      }
      await lockScope(tx, readInput.projectId, scopeKey);
      let state = await loadState(tx, readInput.projectId, scopeKey);
      state = await stabilizeState(tx, state, readInput.projectId, scopeKey, readInput.asOf);
      const activeReservations = await loadActiveReservations(tx, readInput.projectId, scopeKey, readInput.asOf);
      return Object.freeze({
        scope,
        telemetry: freezeTelemetry(sourceSnapshot.telemetry),
        policy: freezePolicy(sourceSnapshot.policy),
        ...(state === null
          ? {}
          : { state: rowToState(state, activeReservations.some((reservation) => reservation.isHalfOpenProbe)) }),
      });
    });
  }

  async commit(
    commitInput: RoomProviderBackpressurePostgresCommitInputV1,
  ): Promise<RoomProviderBackpressurePostgresCommitResultV1> {
    if (!validCommitInput(commitInput)) return held("invalid_input");
    this.assertProjectScope(commitInput.projectId);
    const scope = freezeScope(commitInput.decisionInput.scope);
    const scopeKey = scopeToKey(scope);
    const requestHash = commitRequestHash(commitInput);

    return this.input.layer.transactionImmediate(async (tx) => {
      try {
        await assertWorkerLease(
          tx,
          commitInput.projectId,
          commitInput.roomId,
          commitInput.lease,
          commitInput.decisionInput.asOf,
        );
      } catch {
        return held("stale_fence");
      }
      if (!await roomHasVersion(
        tx,
        commitInput.projectId,
        commitInput.roomId,
        commitInput.expectedAggregateVersion,
      )) {
        return held("stale_room_version");
      }

      await lockScope(tx, commitInput.projectId, scopeKey);
      let state = await loadState(tx, commitInput.projectId, scopeKey);
      state = await stabilizeState(tx, state, commitInput.projectId, scopeKey, commitInput.decisionInput.asOf);

      const operation = await findOperation(
        tx,
        commitInput.projectId,
        scopeKey,
        commitInput.requestId,
        commitInput.decisionInput.operation.kind,
      );
      if (operation) return replayOperation(tx, operation, requestHash, commitInput.decisionInput.asOf);

      state ??= await createInitialState(tx, commitInput.projectId, scope, scopeKey, commitInput.decisionInput.asOf);
      const activeReservations = await loadActiveReservations(
        tx,
        commitInput.projectId,
        scopeKey,
        commitInput.decisionInput.asOf,
      );
      const current = rowToState(state, activeReservations.some((reservation) => reservation.isHalfOpenProbe));
      if (!expectedStateMatches(commitInput.decisionInput.state, current)) return held("state_stale");

      const evaluated = evaluateDecision(commitInput.decisionInput, current, activeReservations.length);
      if (!sameControllerResult(commitInput.decision, scope, scopeKey, evaluated)) {
        return commitInput.decision.decision.action === "admit" && evaluated.action !== "admit"
          ? held(evaluated.reason)
          : held("decision_mismatch");
      }

      let reservationId: string | null = null;
      if (evaluated.reserve) {
        const claimId = claimIdFromRequestId(commitInput.requestId);
        if (claimId === null) return held("claim_identity_invalid");
        const fencedLease = await assertWorkerLease(
          tx,
          commitInput.projectId,
          commitInput.roomId,
          commitInput.lease,
          commitInput.decisionInput.asOf,
        );
        reservationId = randomUUID();
        await tx.insert(roomProviderBackpressureReservations).values({
          id: reservationId,
          projectId: commitInput.projectId,
          scopeKey,
          roomId: commitInput.roomId,
          requestId: commitInput.requestId,
          claimId,
          leaseId: fencedLease.id,
          leaseEpoch: fencedLease.epoch,
          expectedAggregateVersion: commitInput.expectedAggregateVersion,
          workClass: commitInput.decisionInput.work.class,
          isHalfOpenProbe: evaluated.reason === "half_open_probe_admitted",
          circuitOpenMs: commitInput.decisionInput.policy.circuitOpenMs,
          acquiredAt: commitInput.decisionInput.asOf,
          expiresAt: fencedLease.expiresAt,
          releasedAt: null,
          releaseOutcome: null,
        });
      }

      const persistedState = await updateState(tx, state, evaluated.state);
      await tx.insert(roomProviderBackpressureOperations).values({
        projectId: commitInput.projectId,
        scopeKey,
        requestId: commitInput.requestId,
        operationKind: commitInput.decisionInput.operation.kind,
        requestHash,
        action: evaluated.action,
        reason: evaluated.reason,
        stateRevision: persistedState.revision,
        reservationId,
        occurredAt: commitInput.decisionInput.asOf,
      });

      return reservationId === null ? held(evaluated.reason) : reserved(reservationId);
    });
  }

  async release(releaseInput: RoomProviderBackpressurePostgresReleaseInputV1): Promise<void> {
    validateReleaseInput(releaseInput);
    this.assertProjectScope(releaseInput.projectId);

    await this.input.layer.transactionImmediate(async (tx) => {
      await assertWorkerLease(
        tx,
        releaseInput.projectId,
        releaseInput.roomId,
        releaseInput.lease,
        releaseInput.releasedAt,
      );
      const preliminary = await findReservationById(tx, releaseInput.projectId, releaseInput.reservationId);
      if (!preliminary) {
        throw new RoomProviderBackpressurePostgresError("Room provider backpressure reservation was not found");
      }
      await lockScope(tx, releaseInput.projectId, preliminary.scopeKey);
      const reservation = await findReservationById(tx, releaseInput.projectId, releaseInput.reservationId);
      if (!reservation || !releaseMatchesReservation(releaseInput, reservation)) {
        throw new RoomProviderBackpressurePostgresError("Room provider backpressure release fence was rejected");
      }
      if (reservation.releasedAt !== null) return;

      const released = await tx
        .update(roomProviderBackpressureReservations)
        .set({ releasedAt: releaseInput.releasedAt, releaseOutcome: releaseInput.outcome })
        .where(and(
          eq(roomProviderBackpressureReservations.projectId, releaseInput.projectId),
          eq(roomProviderBackpressureReservations.id, releaseInput.reservationId),
          eq(roomProviderBackpressureReservations.leaseId, releaseInput.lease.id),
          eq(roomProviderBackpressureReservations.leaseEpoch, releaseInput.lease.epoch),
          isNull(roomProviderBackpressureReservations.releasedAt),
        ))
        .returning({ id: roomProviderBackpressureReservations.id });
      if (!released[0]) {
        throw new RoomProviderBackpressurePostgresError("Room provider backpressure release lost its fence");
      }

      const state = await loadState(tx, releaseInput.projectId, reservation.scopeKey);
      if (!state) throw new RoomProviderBackpressurePostgresError("Room provider backpressure state was not found");
      const current = rowToState(state, false);
      const next = releaseInput.outcome === "worker_completed"
        ? recoveredState(current, releaseInput.releasedAt)
        : reservation.isHalfOpenProbe
          ? reopenAfterProbeFailure(current, releaseInput.releasedAt, reservation.circuitOpenMs)
          : Object.freeze({ ...current, halfOpenProbeInFlight: false, lastUpdatedAt: releaseInput.releasedAt });
      await updateState(tx, state, next);
    });
  }

  private assertProjectScope(projectId: string): void {
    if (this.boundProjectId && this.boundProjectId !== projectId) {
      throw new RoomProviderBackpressurePostgresError(
        "Room provider backpressure request violates the factory project scope",
      );
    }
  }
}

async function assertWorkerLease(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  lease: StoredRoomLeaseV1,
  now: string,
): Promise<StoredRoomLeaseV1> {
  if (!validRoomWorkerLease(lease, roomId)) {
    throw new RoomProviderBackpressurePostgresError("Room provider backpressure worker lease is invalid");
  }
  return assertRoomLeaseFence(tx, projectId, {
    leaseId: lease.id,
    roomId,
    kind: "room_worker",
    resourceId: roomId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  });
}

async function lockScope(tx: DbTransaction, projectId: string, scopeKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${LOCK_PREFIX}:${projectId}:${scopeKey}`}))`);
}

async function roomHasVersion(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  expectedAggregateVersion: number,
): Promise<boolean> {
  const rows = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(
      eq(operationalRooms.projectId, projectId),
      eq(operationalRooms.id, roomId),
      eq(operationalRooms.aggregateVersion, expectedAggregateVersion),
    ))
    .limit(1);
  return rows.length === 1;
}

async function stabilizeState(
  tx: DbTransaction,
  state: StateRow | null,
  projectId: string,
  scopeKey: string,
  asOf: string,
): Promise<StateRow | null> {
  const expired = await tx
    .update(roomProviderBackpressureReservations)
    .set({ releasedAt: asOf, releaseOutcome: "expired" })
    .where(and(
      eq(roomProviderBackpressureReservations.projectId, projectId),
      eq(roomProviderBackpressureReservations.scopeKey, scopeKey),
      isNull(roomProviderBackpressureReservations.releasedAt),
      lte(roomProviderBackpressureReservations.expiresAt, asOf),
    ))
    .returning({
      isHalfOpenProbe: roomProviderBackpressureReservations.isHalfOpenProbe,
      circuitOpenMs: roomProviderBackpressureReservations.circuitOpenMs,
    });
  if (state && expired.length > 0) {
    const failedProbe = expired.find((reservation) => reservation.isHalfOpenProbe);
    state = await updateState(
      tx,
      state,
      failedProbe
        ? reopenAfterProbeFailure(rowToState(state, false), asOf, failedProbe.circuitOpenMs)
        : Object.freeze({ ...rowToState(state, false), lastUpdatedAt: asOf }),
    );
  }
  if (!state) return null;
  const current = rowToState(state, false);
  const normalized = normalizeCircuitAt(current, asOf);
  return samePersistedState(current, normalized) ? state : updateState(tx, state, normalized);
}

async function loadState(
  tx: DbTransaction,
  projectId: string,
  scopeKey: string,
): Promise<StateRow | null> {
  const rows = await tx
    .select()
    .from(roomProviderBackpressureStates)
    .where(and(
      eq(roomProviderBackpressureStates.projectId, projectId),
      eq(roomProviderBackpressureStates.scopeKey, scopeKey),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function createInitialState(
  tx: DbTransaction,
  projectId: string,
  scope: RoomProviderBackpressureScopeV1,
  scopeKey: string,
  asOf: string,
): Promise<StateRow> {
  await tx
    .insert(roomProviderBackpressureStates)
    .values({
      projectId,
      scopeKey,
      providerId: scope.providerId,
      accountId: scope.accountId,
      modelId: scope.modelId,
      connectorId: scope.connectorId,
      nodeId: scope.nodeId,
      circuitState: "closed",
      consecutiveFailures: 0,
      retryAttempt: 0,
      retryNotBefore: null,
      openUntil: null,
      revision: 0,
      lastUpdatedAt: asOf,
    })
    .onConflictDoNothing();
  const state = await loadState(tx, projectId, scopeKey);
  if (!state) throw new RoomProviderBackpressurePostgresError("Room provider backpressure state could not be initialized");
  return state;
}

async function updateState(
  tx: DbTransaction,
  state: StateRow,
  next: RoomProviderBackpressureStateV1,
): Promise<StateRow> {
  const rows = await tx
    .update(roomProviderBackpressureStates)
    .set({
      circuitState: next.circuitState,
      consecutiveFailures: next.consecutiveFailures,
      retryAttempt: next.retryAttempt,
      retryNotBefore: next.retryNotBefore,
      openUntil: next.openUntil,
      revision: sql`${roomProviderBackpressureStates.revision} + 1`,
      lastUpdatedAt: next.lastUpdatedAt,
    })
    .where(and(
      eq(roomProviderBackpressureStates.projectId, state.projectId),
      eq(roomProviderBackpressureStates.scopeKey, state.scopeKey),
      eq(roomProviderBackpressureStates.revision, state.revision),
    ))
    .returning();
  const row = rows[0];
  if (!row) throw new RoomProviderBackpressurePostgresError("Room provider backpressure state changed while locked");
  return row;
}

async function loadActiveReservations(
  tx: DbTransaction,
  projectId: string,
  scopeKey: string,
  asOf: string,
): Promise<readonly ReservationRow[]> {
  return tx
    .select()
    .from(roomProviderBackpressureReservations)
    .where(and(
      eq(roomProviderBackpressureReservations.projectId, projectId),
      eq(roomProviderBackpressureReservations.scopeKey, scopeKey),
      isNull(roomProviderBackpressureReservations.releasedAt),
      gt(roomProviderBackpressureReservations.expiresAt, asOf),
    ));
}

async function findReservationById(
  tx: DbTransaction,
  projectId: string,
  reservationId: string,
): Promise<ReservationRow | null> {
  const rows = await tx
    .select()
    .from(roomProviderBackpressureReservations)
    .where(and(
      eq(roomProviderBackpressureReservations.projectId, projectId),
      eq(roomProviderBackpressureReservations.id, reservationId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function findOperation(
  tx: DbTransaction,
  projectId: string,
  scopeKey: string,
  requestId: string,
  operationKind: RoomProviderBackpressureOperationV1["kind"],
): Promise<OperationRow | null> {
  const rows = await tx
    .select()
    .from(roomProviderBackpressureOperations)
    .where(and(
      eq(roomProviderBackpressureOperations.projectId, projectId),
      eq(roomProviderBackpressureOperations.scopeKey, scopeKey),
      eq(roomProviderBackpressureOperations.requestId, requestId),
      eq(roomProviderBackpressureOperations.operationKind, operationKind),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function replayOperation(
  tx: DbTransaction,
  operation: OperationRow,
  requestHash: string,
  asOf: string,
): Promise<RoomProviderBackpressurePostgresCommitResultV1> {
  if (operation.requestHash !== requestHash) return held("idempotency_conflict");
  if (operation.reservationId === null) return held(operation.reason);
  const reservation = await findReservationById(tx, operation.projectId, operation.reservationId);
  if (
    reservation
    && reservation.releasedAt === null
    && Date.parse(reservation.expiresAt) > Date.parse(asOf)
  ) {
    return reserved(reservation.id);
  }
  return held("reservation_expired");
}

function evaluateDecision(
  input: RoomProviderBackpressureControllerInputV1,
  current: RoomProviderBackpressurePostgresStateV1,
  activeReservationCount: number,
): EvaluatedDecisionV1 {
  const asOfMs = timestampToMs(input.asOf);
  if (asOfMs === null) throw new RoomProviderBackpressurePostgresError("Room provider backpressure timestamp is invalid");
  const state = normalizeCircuitAt(current, input.asOf);
  if (input.operation.kind === "success") {
    const next = recoveredState(state, input.asOf);
    return evaluated("recorded", "success_recovered", null, null, null, null, next, false);
  }
  if (input.operation.kind === "failure") {
    const retryAttempt = Math.min(incrementBounded(state.retryAttempt), input.policy.maxRetryAttempts);
    const exponentialBackoffMs = boundedExponentialBackoff(
      input.policy.baseBackoffMs,
      input.policy.maxBackoffMs,
      retryAttempt,
    );
    const retryAfterMs = input.operation.retryAfterMs ?? 0;
    const retryDelayMs = Math.max(exponentialBackoffMs, retryAfterMs);
    const opensCircuit =
      state.circuitState === "half_open"
      || input.operation.failureKind === "rate_limited"
      || incrementBounded(state.consecutiveFailures) >= input.policy.failureThreshold
      || retryAttempt >= input.policy.maxRetryAttempts;
    const next = Object.freeze({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
      scopeKey: state.scopeKey,
      circuitState: opensCircuit ? "open" as const : "closed" as const,
      consecutiveFailures: incrementBounded(state.consecutiveFailures),
      retryAttempt,
      retryNotBefore: toUtc(asOfMs + retryDelayMs),
      openUntil: opensCircuit ? toUtc(asOfMs + Math.max(input.policy.circuitOpenMs, retryDelayMs)) : null,
      halfOpenProbeInFlight: false,
      lastUpdatedAt: input.asOf,
    });
    return evaluated(
      "recorded",
      opensCircuit ? "circuit_opened" : "failure_backoff",
      retryAfterMs === 0 ? null : retryAfterMs,
      exponentialBackoffMs,
      retryDelayMs,
      null,
      next,
      false,
    );
  }

  if (!input.telemetry.known) return hold(state, "telemetry_unknown");
  const telemetryObservedAtMs = timestampToMs(input.telemetry.observedAt);
  if (telemetryObservedAtMs === null || asOfMs < telemetryObservedAtMs) return hold(state, "telemetry_stale");
  if (asOfMs - telemetryObservedAtMs > input.policy.telemetryTtlMs) return hold(state, "telemetry_stale");
  if (!input.telemetry.admissionConfirmed) return hold(state, "admission_unconfirmed");
  if (state.circuitState === "open") return hold(state, "circuit_open");
  if (state.circuitState === "half_open") {
    if (state.halfOpenProbeInFlight) return hold(state, "half_open_probe_in_flight");
    if (!input.work.allowHalfOpenProbe) return hold(state, "half_open_probe_required");
    const next = Object.freeze({ ...state, halfOpenProbeInFlight: true, lastUpdatedAt: input.asOf });
    return evaluated(
      "admit",
      "half_open_probe_admitted",
      null,
      null,
      null,
      effectiveCap(input.policy, input.work.class),
      next,
      true,
    );
  }
  const retryNotBeforeMs = state.retryNotBefore === null ? null : timestampToMs(state.retryNotBefore);
  if (retryNotBeforeMs !== null && asOfMs < retryNotBeforeMs) return hold(state, "retry_window_active");
  const cap = effectiveCap(input.policy, input.work.class);
  const observedActive = Math.max(input.telemetry.activeRequests, activeReservationCount);
  if (observedActive >= cap) {
    return hold(
      state,
      input.work.class === "normal" && observedActive < input.policy.concurrencyCap
        ? "reserved_capacity"
        : "concurrency_cap_reached",
      cap,
    );
  }
  return evaluated("admit", "capacity_confirmed", null, null, null, cap, state, true);
}

function hold(
  state: RoomProviderBackpressureStateV1,
  reason: string,
  effectiveConcurrencyCap: number | null = null,
): EvaluatedDecisionV1 {
  return evaluated("hold", reason, null, null, null, effectiveConcurrencyCap, state, false);
}

function evaluated(
  action: RoomProviderBackpressureActionV1,
  reason: string,
  retryAfterMs: number | null,
  exponentialBackoffMs: number | null,
  retryDelayMs: number | null,
  effectiveConcurrencyCap: number | null,
  state: RoomProviderBackpressureStateV1,
  reserve: boolean,
): EvaluatedDecisionV1 {
  return Object.freeze({
    action,
    reason,
    decision: Object.freeze({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
      action,
      reason,
      retryAfterMs,
      exponentialBackoffMs,
      retryDelayMs,
      effectiveConcurrencyCap,
    }),
    state: Object.freeze({ ...state }),
    reserve,
  });
}

function rowToState(state: StateRow, halfOpenProbeInFlight: boolean): RoomProviderBackpressurePostgresStateV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: state.scopeKey,
    circuitState: state.circuitState as RoomProviderBackpressureCircuitStateV1,
    consecutiveFailures: state.consecutiveFailures,
    retryAttempt: state.retryAttempt,
    retryNotBefore: state.retryNotBefore,
    openUntil: state.openUntil,
    halfOpenProbeInFlight,
    lastUpdatedAt: state.lastUpdatedAt,
    revision: state.revision,
  });
}

function recoveredState(
  state: RoomProviderBackpressureStateV1,
  asOf: string,
): RoomProviderBackpressureStateV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: state.scopeKey,
    circuitState: "closed",
    consecutiveFailures: 0,
    retryAttempt: 0,
    retryNotBefore: null,
    openUntil: null,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function reopenAfterProbeFailure(
  state: RoomProviderBackpressureStateV1,
  asOf: string,
  circuitOpenMs: number,
): RoomProviderBackpressureStateV1 {
  const asOfMs = timestampToMs(asOf);
  if (asOfMs === null) throw new RoomProviderBackpressurePostgresError("Room provider backpressure timestamp is invalid");
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: state.scopeKey,
    circuitState: "open",
    consecutiveFailures: incrementBounded(state.consecutiveFailures),
    retryAttempt: incrementBounded(state.retryAttempt),
    retryNotBefore: toUtc(asOfMs + circuitOpenMs),
    openUntil: toUtc(asOfMs + circuitOpenMs),
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function normalizeCircuitAt(
  state: RoomProviderBackpressureStateV1,
  asOf: string,
): RoomProviderBackpressureStateV1 {
  const asOfMs = timestampToMs(asOf);
  const openUntilMs = state.openUntil === null ? null : timestampToMs(state.openUntil);
  if (asOfMs === null || state.circuitState !== "open" || openUntilMs === null || asOfMs < openUntilMs) {
    return state;
  }
  return Object.freeze({
    ...state,
    circuitState: "half_open",
    openUntil: null,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function effectiveCap(policy: RoomProviderBackpressurePolicyV1, workClass: RoomProviderBackpressureWorkClassV1): number {
  if (workClass === "normal") {
    return policy.concurrencyCap - policy.reservedVerifierSlots - policy.reservedRecoverySlots;
  }
  if (workClass === "verifier") return policy.concurrencyCap - policy.reservedRecoverySlots;
  return policy.concurrencyCap;
}

function boundedExponentialBackoff(baseBackoffMs: number, maxBackoffMs: number, retryAttempt: number): number {
  const multiplier = 2 ** Math.min(Math.max(retryAttempt - 1, 0), 30);
  return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
}

function commitRequestHash(input: RoomProviderBackpressurePostgresCommitInputV1): string {
  return hashRoomValue({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_POSTGRES_CONTRACT_VERSION,
    projectId: input.projectId,
    roomId: input.roomId,
    requestId: input.requestId,
    expectedAggregateVersion: input.expectedAggregateVersion,
    lease: {
      id: input.lease.id,
      holderId: input.lease.holderId,
      hostId: input.lease.hostId,
      epoch: input.lease.epoch,
    },
    controller: {
      asOf: input.decisionInput.asOf,
      scope: input.decisionInput.scope,
      work: input.decisionInput.work,
      operation: input.decisionInput.operation,
      telemetry: input.decisionInput.telemetry,
      policy: input.decisionInput.policy,
      state: input.decisionInput.state === undefined
        ? null
        : {
            ...input.decisionInput.state,
            revision: durableRevision(input.decisionInput.state),
          },
    },
  });
}

function claimIdFromRequestId(requestId: string): string | null {
  const prefix = "room-provider-capacity:";
  if (!requestId.startsWith(prefix)) return null;
  const claimId = requestId.slice(prefix.length);
  return canonicalString(claimId) ? claimId : null;
}

function sameControllerResult(
  result: RoomProviderBackpressureControllerResultV1,
  scope: RoomProviderBackpressureScopeV1,
  scopeKey: string,
  evaluated: EvaluatedDecisionV1,
): boolean {
  return result.contractVersion === ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION
    && sameScope(result.scope, scope)
    && result.scopeKey === scopeKey
    && sameDecision(result.decision, evaluated.decision)
    && sameOutputState(result.state, evaluated.state);
}

function expectedStateMatches(
  expected: RoomProviderBackpressureStateV1 | undefined,
  current: RoomProviderBackpressurePostgresStateV1,
): boolean {
  if (expected === undefined) return current.revision === 0;
  const revision = durableRevision(expected);
  if (current.revision > 0 && revision !== current.revision) return false;
  if (current.revision === 0 && revision !== undefined && revision !== 0) return false;
  return sameOutputState(expected, current);
}

function durableRevision(state: RoomProviderBackpressureStateV1): number | undefined {
  const value = (state as unknown as Record<string, unknown>).revision;
  return nonNegativeSafeInteger(value) ? value : undefined;
}

function sameDecision(left: RoomProviderBackpressureDecisionV1, right: RoomProviderBackpressureDecisionV1): boolean {
  return left.contractVersion === right.contractVersion
    && left.action === right.action
    && left.reason === right.reason
    && left.retryAfterMs === right.retryAfterMs
    && left.exponentialBackoffMs === right.exponentialBackoffMs
    && left.retryDelayMs === right.retryDelayMs
    && left.effectiveConcurrencyCap === right.effectiveConcurrencyCap;
}

function sameOutputState(left: RoomProviderBackpressureStateV1, right: RoomProviderBackpressureStateV1): boolean {
  return left.contractVersion === right.contractVersion
    && left.scopeKey === right.scopeKey
    && left.circuitState === right.circuitState
    && left.consecutiveFailures === right.consecutiveFailures
    && left.retryAttempt === right.retryAttempt
    && left.retryNotBefore === right.retryNotBefore
    && left.openUntil === right.openUntil
    && left.halfOpenProbeInFlight === right.halfOpenProbeInFlight
    && left.lastUpdatedAt === right.lastUpdatedAt;
}

function samePersistedState(left: RoomProviderBackpressureStateV1, right: RoomProviderBackpressureStateV1): boolean {
  return left.contractVersion === right.contractVersion
    && left.scopeKey === right.scopeKey
    && left.circuitState === right.circuitState
    && left.consecutiveFailures === right.consecutiveFailures
    && left.retryAttempt === right.retryAttempt
    && left.retryNotBefore === right.retryNotBefore
    && left.openUntil === right.openUntil
    && left.lastUpdatedAt === right.lastUpdatedAt;
}

function releaseMatchesReservation(
  input: RoomProviderBackpressurePostgresReleaseInputV1,
  reservation: ReservationRow,
): boolean {
  return reservation.projectId === input.projectId
    && reservation.roomId === input.roomId
    && reservation.requestId === input.requestId
    && reservation.claimId === input.claimId
    && reservation.leaseId === input.lease.id
    && reservation.leaseEpoch === input.lease.epoch
    && reservation.expectedAggregateVersion === input.expectedAggregateVersion;
}

function reserved(reservationId: string): RoomProviderBackpressurePostgresCommitResultV1 {
  return Object.freeze({ status: "reserved", reservationId });
}

function held(reason: string): RoomProviderBackpressurePostgresCommitResultV1 {
  return Object.freeze({ status: "held", reason });
}

function validateReadInput(input: unknown): asserts input is RoomProviderBackpressurePostgresReadInputV1 {
  if (!validReadInput(input)) {
    throw new RoomProviderBackpressurePostgresError("Room provider backpressure read input is invalid");
  }
}

function validReadInput(value: unknown): value is RoomProviderBackpressurePostgresReadInputV1 {
  if (!isRecord(value)) return false;
  return canonicalString(value.projectId)
    && canonicalString(value.roomId)
    && validRoomWorkerLease(value.lease, value.roomId)
    && nonNegativeSafeInteger(value.expectedAggregateVersion)
    && canonicalString(value.requestId)
    && typeof value.workClass === "string"
    && WORK_CLASSES.has(value.workClass as RoomProviderBackpressureWorkClassV1)
    && typeof value.allowHalfOpenProbe === "boolean"
    && canonicalTimestamp(value.asOf);
}

function validateSourceSnapshot(value: unknown): asserts value is RoomProviderBackpressurePostgresSourceSnapshotV1 {
  if (!validSourceSnapshot(value)) {
    throw new RoomProviderBackpressurePostgresError("Room provider backpressure source snapshot is invalid");
  }
}

function validSourceSnapshot(value: unknown): value is RoomProviderBackpressurePostgresSourceSnapshotV1 {
  return isRecord(value) && isScope(value.scope) && isTelemetry(value.telemetry) && isPolicy(value.policy);
}

function validCommitInput(value: unknown): value is RoomProviderBackpressurePostgresCommitInputV1 {
  if (!isRecord(value)) return false;
  if (
    !canonicalString(value.projectId)
    || !canonicalString(value.roomId)
    || !validRoomWorkerLease(value.lease, value.roomId)
    || !nonNegativeSafeInteger(value.expectedAggregateVersion)
    || !canonicalString(value.requestId)
    || !validControllerInput(value.decisionInput)
    || !validControllerResult(value.decision)
  ) {
    return false;
  }
  return value.decisionInput.work.requestId === value.requestId
    && sameScope(value.decision.scope, value.decisionInput.scope)
    && value.decision.scopeKey === scopeToKey(value.decisionInput.scope)
    && value.decision.state.scopeKey === value.decision.scopeKey;
}

function validateReleaseInput(value: unknown): asserts value is RoomProviderBackpressurePostgresReleaseInputV1 {
  if (!isRecord(value)
    || !canonicalString(value.projectId)
    || !canonicalString(value.roomId)
    || !validRoomWorkerLease(value.lease, value.roomId)
    || !nonNegativeSafeInteger(value.expectedAggregateVersion)
    || !canonicalString(value.requestId)
    || !canonicalString(value.reservationId)
    || !canonicalString(value.claimId)
    || typeof value.outcome !== "string"
    || !RELEASE_OUTCOMES.has(value.outcome as RoomProviderBackpressureReleaseOutcomeV1)
    || !canonicalTimestamp(value.releasedAt)) {
    throw new RoomProviderBackpressurePostgresError("Room provider backpressure release input is invalid");
  }
}

function validControllerInput(value: unknown): value is RoomProviderBackpressureControllerInputV1 {
  if (!isRecord(value)) return false;
  return value.contractVersion === ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION
    && canonicalTimestamp(value.asOf)
    && isScope(value.scope)
    && isWork(value.work)
    && isOperation(value.operation)
    && isTelemetry(value.telemetry)
    && isPolicy(value.policy)
    && (value.state === undefined || (isState(value.state) && value.state.scopeKey === scopeToKey(value.scope)));
}

function validControllerResult(value: unknown): value is RoomProviderBackpressureControllerResultV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION
    && isScope(value.scope)
    && canonicalString(value.scopeKey)
    && isDecision(value.decision)
    && isState(value.state);
}

function isScope(value: unknown): value is RoomProviderBackpressureScopeV1 {
  return isRecord(value)
    && canonicalString(value.providerId)
    && canonicalString(value.accountId)
    && canonicalString(value.modelId)
    && canonicalString(value.connectorId)
    && canonicalString(value.nodeId);
}

function isWork(value: unknown): value is RoomProviderBackpressureWorkV1 {
  return isRecord(value)
    && canonicalString(value.requestId)
    && typeof value.class === "string"
    && WORK_CLASSES.has(value.class as RoomProviderBackpressureWorkClassV1)
    && typeof value.allowHalfOpenProbe === "boolean";
}

function isOperation(value: unknown): value is RoomProviderBackpressureOperationV1 {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "dispatch" || value.kind === "success") return true;
  return value.kind === "failure"
    && typeof value.failureKind === "string"
    && (value.failureKind === "rate_limited"
      || value.failureKind === "transient"
      || value.failureKind === "connector_unavailable")
    && (value.retryAfterMs === undefined || nonNegativeSafeInteger(value.retryAfterMs));
}

function isTelemetry(value: unknown): value is RoomProviderBackpressureTelemetryV1 {
  return isRecord(value)
    && typeof value.known === "boolean"
    && typeof value.admissionConfirmed === "boolean"
    && nonNegativeSafeInteger(value.activeRequests)
    && canonicalTimestamp(value.observedAt);
}

function isPolicy(value: unknown): value is RoomProviderBackpressurePolicyV1 {
  if (!isRecord(value)) return false;
  return positiveSafeInteger(value.concurrencyCap)
    && nonNegativeSafeInteger(value.reservedVerifierSlots)
    && nonNegativeSafeInteger(value.reservedRecoverySlots)
    && value.reservedVerifierSlots + value.reservedRecoverySlots < value.concurrencyCap
    && nonNegativeSafeInteger(value.telemetryTtlMs)
    && positiveSafeInteger(value.failureThreshold)
    && positiveSafeInteger(value.maxRetryAttempts)
    && positiveSafeInteger(value.baseBackoffMs)
    && positiveSafeInteger(value.maxBackoffMs)
    && value.baseBackoffMs <= value.maxBackoffMs
    && positiveSafeInteger(value.circuitOpenMs);
}

function isState(value: unknown): value is RoomProviderBackpressureStateV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION
    && canonicalString(value.scopeKey)
    && typeof value.circuitState === "string"
    && CIRCUIT_STATES.has(value.circuitState as RoomProviderBackpressureCircuitStateV1)
    && nonNegativeSafeInteger(value.consecutiveFailures)
    && nonNegativeSafeInteger(value.retryAttempt)
    && (value.retryNotBefore === null || canonicalTimestamp(value.retryNotBefore))
    && (value.openUntil === null || canonicalTimestamp(value.openUntil))
    && typeof value.halfOpenProbeInFlight === "boolean"
    && canonicalTimestamp(value.lastUpdatedAt);
}

function isDecision(value: unknown): value is RoomProviderBackpressureDecisionV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION
    && (value.action === "admit" || value.action === "hold" || value.action === "recorded")
    && canonicalString(value.reason)
    && nullableNonNegativeSafeInteger(value.retryAfterMs)
    && nullableNonNegativeSafeInteger(value.exponentialBackoffMs)
    && nullableNonNegativeSafeInteger(value.retryDelayMs)
    && nullablePositiveSafeInteger(value.effectiveConcurrencyCap);
}

function validRoomWorkerLease(value: unknown, roomId: unknown): value is StoredRoomLeaseV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && canonicalString(value.id)
    && value.roomId === roomId
    && value.kind === "room_worker"
    && value.resourceId === roomId
    && canonicalString(value.holderId)
    && canonicalString(value.hostId)
    && positiveSafeInteger(value.epoch)
    && canonicalTimestamp(value.acquiredAt)
    && canonicalTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) > Date.parse(value.acquiredAt)
    && (value.releasedAt === null || canonicalTimestamp(value.releasedAt))
    && canonicalTimestamp(value.heartbeatAt);
}

function freezeScope(scope: RoomProviderBackpressureScopeV1): RoomProviderBackpressureScopeV1 {
  return Object.freeze({ ...scope });
}

function freezeTelemetry(telemetry: RoomProviderBackpressureTelemetryV1): RoomProviderBackpressureTelemetryV1 {
  return Object.freeze({ ...telemetry });
}

function freezePolicy(policy: RoomProviderBackpressurePolicyV1): RoomProviderBackpressurePolicyV1 {
  return Object.freeze({ ...policy });
}

function scopeToKey(scope: RoomProviderBackpressureScopeV1): string {
  return JSON.stringify([scope.providerId, scope.accountId, scope.modelId, scope.connectorId, scope.nodeId]);
}

function sameScope(left: RoomProviderBackpressureScopeV1, right: RoomProviderBackpressureScopeV1): boolean {
  return left.providerId === right.providerId
    && left.accountId === right.accountId
    && left.modelId === right.modelId
    && left.connectorId === right.connectorId
    && left.nodeId === right.nodeId;
}

function incrementBounded(value: number): number {
  return Math.min(MAX_SAFE_DATABASE_INTEGER, value + 1);
}

function nullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || nonNegativeSafeInteger(value);
}

function nullablePositiveSafeInteger(value: unknown): boolean {
  return value === null || positiveSafeInteger(value);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timestampToMs(value: string): number | null {
  if (!canonicalTimestamp(value)) return null;
  return Date.parse(value);
}

function toUtc(value: number): string {
  return new Date(value).toISOString();
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
