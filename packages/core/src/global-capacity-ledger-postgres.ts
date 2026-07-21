import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  globalCapacityClaims,
  globalCapacityOperations,
  globalCapacityState,
  globalConcurrency,
} from "./postgres/schema/central.js";
import { roomGlobalConcurrencyClaims } from "./postgres/schema/room.js";
import { hashRoomValue } from "./room-integrity.js";

export const GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION = 1 as const;

export type GlobalCapacityResourceKindV1 = "room_worker" | "legacy_task" | "legacy_triage";
export type GlobalCapacityWorkClassV1 = "normal" | "verifier" | "recovery";
export type GlobalCapacityLedgerActionV1 = "acquired" | "renewed" | "released" | "held" | "rejected";
export type GlobalCapacityLedgerReasonV1 =
  | "capacity_admitted"
  | "capacity_renewed"
  | "capacity_released"
  | "capacity_unavailable"
  | "capacity_policy_unavailable"
  | "global_capacity_exhausted"
  | "legacy_task_triage_reserve_protected"
  /** A pre-central Room claim exists; stop rather than mixing two ledgers. */
  | "legacy_room_migration_pending"
  | "reserved_capacity_protected"
  | "claim_conflict"
  | "claim_expired"
  | "claim_not_found"
  | "idempotency_conflict"
  | "invalid_request"
| "project_isolation"
| "policy_mismatch"
| "renewal_regression"
  | "stale_fence"
  | "store_failure";

export interface GlobalCapacityLedgerReservationsV1 {
  readonly verifierSlots: number;
  readonly recoverySlots: number;
  readonly legacyTaskTriageSlots: number;
}

export interface GlobalCapacityLedgerPolicyV1 {
  readonly reservations: GlobalCapacityLedgerReservationsV1;
  readonly snapshotTtlMs: number;
  /**
   * Maximum duration of a durable capacity lease. The host derives claim expiry
   * from this verified policy; request payload timestamps are not an authority.
   */
  readonly leaseTtlMs: number;
}

export interface GlobalCapacityLedgerClaimV1 {
  readonly claimId: string;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityResourceKindV1;
  readonly resourceId: string;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface GlobalCapacityLedgerForeignOccupancyV1 {
  readonly totalSlots: number;
  readonly legacyTaskSlots: number;
  readonly legacyTriageSlots: number;
  readonly roomWorkerSlots: number;
  readonly normalSlots: number;
  readonly verifierSlots: number;
  readonly recoverySlots: number;
}

export interface GlobalCapacityLedgerSnapshotV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly stateRevision: number;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly totalSlots: number | null;
  readonly reservations: GlobalCapacityLedgerReservationsV1;
  readonly ownClaims: readonly GlobalCapacityLedgerClaimV1[];
  readonly foreignOccupancy: GlobalCapacityLedgerForeignOccupancyV1;
}

export interface GlobalCapacityLedgerSnapshotReadInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
}

export interface GlobalCapacityLedgerAcquireInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityResourceKindV1;
  readonly resourceId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface GlobalCapacityLedgerRenewInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityResourceKindV1;
  readonly resourceId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface GlobalCapacityLedgerReleaseInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityResourceKindV1;
  readonly resourceId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
}

export interface GlobalCapacityLedgerMutationResultV1 {
  readonly action: GlobalCapacityLedgerActionV1;
  readonly reason: GlobalCapacityLedgerReasonV1;
  readonly replayed: boolean;
  readonly claimId: string | null;
  readonly fence: number | null;
}

export interface CreateGlobalCapacityLedgerPostgresPortsInputV1 {
  readonly layer: AsyncDataLayer;
  readonly policy: GlobalCapacityLedgerPolicyV1;
  readonly projectId: string;
  /**
   * Host-owned clock used for durable expiry and event timestamps. It exists so
   * tests can be deterministic; request payload timestamps are never trusted
   * to advance the shared ledger.
   */
  readonly now?: () => string;
}

export interface GlobalCapacityLedgerPostgresPortsV1 {
  readSnapshot(input: GlobalCapacityLedgerSnapshotReadInputV1): Promise<GlobalCapacityLedgerSnapshotV1>;
  acquire(input: GlobalCapacityLedgerAcquireInputV1): Promise<GlobalCapacityLedgerMutationResultV1>;
  renew(input: GlobalCapacityLedgerRenewInputV1): Promise<GlobalCapacityLedgerMutationResultV1>;
  release(input: GlobalCapacityLedgerReleaseInputV1): Promise<GlobalCapacityLedgerMutationResultV1>;
}

export class GlobalCapacityLedgerPostgresError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GlobalCapacityLedgerPostgresError";
  }
}

/** Central singleton identity shared only with the host policy authority. */
export const GLOBAL_CAPACITY_LEDGER_STATE_ID = "global-capacity-ledger-v1";
/** Advisory-lock identity for serialized ledger state and authority transitions. */
export const GLOBAL_CAPACITY_LEDGER_LOCK_KEY = "fusion-global-capacity-ledger-v1";
const RESOURCE_KINDS = new Set<GlobalCapacityResourceKindV1>([
  "room_worker",
  "legacy_task",
  "legacy_triage",
]);
const WORK_CLASSES = new Set<GlobalCapacityWorkClassV1>(["normal", "verifier", "recovery"]);

type CommandKind = "acquire" | "renew" | "release";

interface StateRow {
readonly id: string;
readonly revision: number;
readonly policyHash: string;
readonly updatedAt: string;
}

class GlobalCapacityLedgerPolicyMismatchError extends Error {
public constructor() {
super("Global capacity ledger policy conflicts with the durable global policy");
this.name = "GlobalCapacityLedgerPolicyMismatchError";
}
}

class GlobalCapacityLedgerPolicyUnavailableError extends Error {
  public constructor() {
    super("Global capacity ledger state is unavailable until the central policy authority installs a verified policy");
    this.name = "GlobalCapacityLedgerPolicyUnavailableError";
  }
}

interface ActiveTotals {
  totalSlots: number;
  legacyTaskSlots: number;
  legacyTriageSlots: number;
  roomWorkerSlots: number;
  normalSlots: number;
  verifierSlots: number;
  recoverySlots: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validResourceKind(value: unknown): value is GlobalCapacityResourceKindV1 {
  return typeof value === "string" && RESOURCE_KINDS.has(value as GlobalCapacityResourceKindV1);
}

function validWorkClass(value: unknown): value is GlobalCapacityWorkClassV1 {
  return typeof value === "string" && WORK_CLASSES.has(value as GlobalCapacityWorkClassV1);
}

/**
 * Validate the complete policy that only the central host authority may issue.
 * Project-bound ledger ports consume this invariant but must never invent a
 * reservation or lease lifetime from project-local configuration.
 */
export function assertGlobalCapacityLedgerPolicy(
  value: unknown,
): asserts value is GlobalCapacityLedgerPolicyV1 {
  if (!isRecord(value) || !isRecord(value.reservations)) {
    throw new GlobalCapacityLedgerPostgresError("Global capacity ledger requires a complete verified policy");
  }
  const reservations = value.reservations;
  if (
    !nonNegativeSafeInteger(reservations.verifierSlots)
    || !nonNegativeSafeInteger(reservations.recoverySlots)
    || !nonNegativeSafeInteger(reservations.legacyTaskTriageSlots)
    || !positiveSafeInteger(value.snapshotTtlMs)
    || !positiveSafeInteger(value.leaseTtlMs)
  ) {
    throw new GlobalCapacityLedgerPostgresError("Global capacity ledger policy is invalid");
  }
}

export function hashGlobalCapacityLedgerPolicy(
  policy: GlobalCapacityLedgerPolicyV1,
): string {
  return hashRoomValue({
    reservations: {
      verifierSlots: policy.reservations.verifierSlots,
      recoverySlots: policy.reservations.recoverySlots,
      legacyTaskTriageSlots: policy.reservations.legacyTaskTriageSlots,
    },
    snapshotTtlMs: policy.snapshotTtlMs,
    leaseTtlMs: policy.leaseTtlMs,
  });
}

function validSnapshotInput(value: unknown): value is GlobalCapacityLedgerSnapshotReadInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.projectId)
    && canonicalTimestamp(value.asOf);
}

function validAcquireInput(value: unknown): value is GlobalCapacityLedgerAcquireInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.projectId)
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId)
    && canonicalString(value.claimId)
    && canonicalString(value.operationId)
    && validWorkClass(value.workClass)
    && positiveSafeInteger(value.slots)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.asOf)
    && canonicalTimestamp(value.expiresAt);
}

function validRenewInput(value: unknown): value is GlobalCapacityLedgerRenewInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.projectId)
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId)
    && canonicalString(value.claimId)
    && canonicalString(value.operationId)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.asOf)
    && canonicalTimestamp(value.expiresAt);
}

function validReleaseInput(value: unknown): value is GlobalCapacityLedgerReleaseInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.projectId)
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId)
    && canonicalString(value.claimId)
    && canonicalString(value.operationId)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.asOf);
}

function mutation(
  action: GlobalCapacityLedgerActionV1,
  reason: GlobalCapacityLedgerReasonV1,
  replayed = false,
  claimId: string | null = null,
  fence: number | null = null,
): GlobalCapacityLedgerMutationResultV1 {
  return Object.freeze({ action, reason, replayed, claimId, fence });
}

function requestHash(kind: CommandKind, input: GlobalCapacityLedgerAcquireInputV1 | GlobalCapacityLedgerRenewInputV1 | GlobalCapacityLedgerReleaseInputV1): string {
  if ("expiresAt" in input) {
    const { asOf: _asOf, expiresAt: _expiresAt, ...identity } = input;
    return hashRoomValue({ kind, ...identity });
  }
  const { asOf: _asOf, ...identity } = input;
  return hashRoomValue({ kind, ...identity });
}

function snapshotExpiry(asOf: string, ttlMs: number): string {
  return new Date(Date.parse(asOf) + ttlMs).toISOString();
}

function zeroTotals(): ActiveTotals {
  return {
    totalSlots: 0,
    legacyTaskSlots: 0,
    legacyTriageSlots: 0,
    roomWorkerSlots: 0,
    normalSlots: 0,
    verifierSlots: 0,
    recoverySlots: 0,
  };
}

function summarize(rows: readonly (typeof globalCapacityClaims.$inferSelect)[]): ActiveTotals {
  const total = zeroTotals();
  for (const row of rows) {
    total.totalSlots += row.slots;
    switch (row.resourceKind as GlobalCapacityResourceKindV1) {
      case "legacy_task": total.legacyTaskSlots += row.slots; break;
      case "legacy_triage": total.legacyTriageSlots += row.slots; break;
      case "room_worker": total.roomWorkerSlots += row.slots; break;
    }
    switch (row.workClass as GlobalCapacityWorkClassV1) {
      case "normal": total.normalSlots += row.slots; break;
      case "verifier": total.verifierSlots += row.slots; break;
      case "recovery": total.recoverySlots += row.slots; break;
    }
  }
  return Object.freeze(total);
}

function rowToClaim(row: typeof globalCapacityClaims.$inferSelect): GlobalCapacityLedgerClaimV1 {
  return Object.freeze({
    claimId: row.id,
    projectId: row.projectId,
    resourceKind: row.resourceKind as GlobalCapacityResourceKindV1,
    resourceId: row.resourceId,
    workClass: row.workClass as GlobalCapacityWorkClassV1,
    slots: row.slots,
    holderId: row.holderId,
    leaseId: row.leaseId,
    fence: row.fence,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  });
}

function operationResult(row: typeof globalCapacityOperations.$inferSelect, replayed: boolean): GlobalCapacityLedgerMutationResultV1 {
  const action = row.action as GlobalCapacityLedgerActionV1;
  const reason = row.reason as GlobalCapacityLedgerReasonV1;
  if (!(["acquired", "renewed", "released", "held", "rejected"] as const).includes(action)) {
    return mutation("rejected", "store_failure");
  }
  return mutation(action, reason, replayed, row.claimId, row.fence);
}

function sameLeaseIdentity(
  row: typeof globalCapacityClaims.$inferSelect,
  input: GlobalCapacityLedgerRenewInputV1 | GlobalCapacityLedgerReleaseInputV1,
): boolean {
  return row.projectId === input.projectId
    && row.resourceKind === input.resourceKind
    && row.resourceId === input.resourceId
    && row.holderId === input.holderId
    && row.leaseId === input.leaseId
    && row.fence === input.fence;
}

function capacityReason(
  totalSlots: number | null,
  active: ActiveTotals,
  policy: GlobalCapacityLedgerPolicyV1,
  input: GlobalCapacityLedgerAcquireInputV1,
): GlobalCapacityLedgerReasonV1 | null {
  if (totalSlots === null) return "capacity_unavailable";
  const reservations = policy.reservations;
  if (reservations.verifierSlots + reservations.recoverySlots + reservations.legacyTaskTriageSlots > totalSlots) {
    return "capacity_unavailable";
  }
  if (active.totalSlots + input.slots > totalSlots) return "global_capacity_exhausted";

  const legacyActiveSlots = active.legacyTaskSlots + active.legacyTriageSlots;
  const isLegacy = input.resourceKind === "legacy_task" || input.resourceKind === "legacy_triage";
  const protectedLegacySlots = isLegacy
    ? 0
    : Math.max(0, reservations.legacyTaskTriageSlots - legacyActiveSlots);
  const protectedVerifierSlots = input.workClass === "verifier"
    ? 0
    : Math.max(0, reservations.verifierSlots - active.verifierSlots);
  const protectedRecoverySlots = input.workClass === "recovery"
    ? 0
    : Math.max(0, reservations.recoverySlots - active.recoverySlots);
  const protectedSlots = protectedLegacySlots + protectedVerifierSlots + protectedRecoverySlots;

  if (active.totalSlots + input.slots > totalSlots - protectedSlots) {
    return protectedLegacySlots > 0 ? "legacy_task_triage_reserve_protected" : "reserved_capacity_protected";
  }
  return null;
}

export function createGlobalCapacityLedgerPostgresPorts(
  input: CreateGlobalCapacityLedgerPostgresPortsInputV1,
): GlobalCapacityLedgerPostgresPortsV1 {
  const implementation = new GlobalCapacityLedgerPostgresPorts(input);
  return Object.freeze({
    readSnapshot: implementation.readSnapshot.bind(implementation),
    acquire: implementation.acquire.bind(implementation),
    renew: implementation.renew.bind(implementation),
    release: implementation.release.bind(implementation),
  });
}

class GlobalCapacityLedgerPostgresPorts {
  private readonly boundProjectId: string;
  private readonly now: () => string;

  public constructor(private readonly input: CreateGlobalCapacityLedgerPostgresPortsInputV1) {
    if (!input.layer) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger PostgreSQL ports require a data layer");
    }
    if (input.layer.projectId && input.projectId !== input.layer.projectId) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger project scope conflicts with its data layer");
    }
    if (!canonicalString(input.projectId)) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger project scope is invalid");
    }
    if (input.now !== undefined && typeof input.now !== "function") {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger trusted clock is invalid");
    }
    assertGlobalCapacityLedgerPolicy(input.policy);
    this.boundProjectId = input.projectId;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  public async readSnapshot(input: GlobalCapacityLedgerSnapshotReadInputV1): Promise<GlobalCapacityLedgerSnapshotV1> {
    if (!validSnapshotInput(input)) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger snapshot input is invalid");
    }
    this.assertProjectScope(input.projectId);
    const observedAt = this.currentTime();
    return this.input.layer.transactionImmediate(async (tx) => {
      const state = await lockAndRefreshState(tx, observedAt, this.input.policy, true);
      return buildSnapshot(tx, state, this.input.policy, input.projectId, observedAt);
    });
  }

  public async acquire(input: GlobalCapacityLedgerAcquireInputV1): Promise<GlobalCapacityLedgerMutationResultV1> {
    if (!validAcquireInput(input)) return mutation("rejected", "invalid_request");
    if (!this.isProjectInScope(input.projectId)) return mutation("rejected", "project_isolation");
    try {
      const asOf = this.currentTime();
      return await this.input.layer.transactionImmediate(async (tx) => {
        const state = await lockAndRefreshState(tx, asOf, this.input.policy, true);
        const hash = requestHash("acquire", input);
        const replay = await findOperation(tx, input.projectId, "acquire", input.operationId);
        if (replay) {
          return replay.requestHash === hash
            ? operationResult(replay, true)
            : mutation("rejected", "idempotency_conflict");
        }
        const expiresAt = snapshotExpiry(asOf, this.input.policy.leaseTtlMs);
        if (await findClaimById(tx, input.projectId, input.claimId)) {
          await insertOperation(tx, input.projectId, "acquire", input.operationId, hash, mutation("rejected", "claim_conflict"), asOf);
          return mutation("rejected", "claim_conflict");
        }
        if (await findActiveClaimForResource(tx, input.projectId, input.resourceKind, input.resourceId)) {
          await insertOperation(tx, input.projectId, "acquire", input.operationId, hash, mutation("rejected", "claim_conflict"), asOf);
          return mutation("rejected", "claim_conflict");
        }
        /*
         * FNXC:GlobalCapacityLegacyRoomCutover 2026-07-20-07:09:
         * The retired Room ledger cannot be combined atomically with the new
         * central one. While it still has a live claim, admit no new central
         * work of any kind; an operator must let that old lease end or perform
         * an explicit cutover instead of silently double-counting capacity.
         */
        if (await hasActiveLegacyRoomGlobalConcurrencyClaim(tx, asOf)) {
          const result = mutation("held", "legacy_room_migration_pending");
          await insertOperation(tx, input.projectId, "acquire", input.operationId, hash, result, asOf);
          return result;
        }
        const activeRows = await loadActiveClaims(tx, asOf);
        const totalSlots = await loadGlobalLimit(tx);
        const reason = capacityReason(totalSlots, summarize(activeRows), this.input.policy, input);
        if (reason) {
          const result = mutation("held", reason);
          await insertOperation(tx, input.projectId, "acquire", input.operationId, hash, result, asOf);
          return result;
        }
        await tx.insert(globalCapacityClaims).values({
          id: input.claimId,
          projectId: input.projectId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          workClass: input.workClass,
          slots: input.slots,
          holderId: input.holderId,
          leaseId: input.leaseId,
          fence: input.fence,
          acquiredAt: asOf,
          expiresAt,
          releasedAt: null,
        });
        await bumpState(tx, state, asOf);
        const result = mutation("acquired", "capacity_admitted", false, input.claimId, input.fence);
        await insertOperation(tx, input.projectId, "acquire", input.operationId, hash, result, asOf);
        return result;
      });
    } catch (error) {
      if (error instanceof GlobalCapacityLedgerPolicyUnavailableError) {
        return mutation("rejected", "capacity_policy_unavailable");
      }
      if (error instanceof GlobalCapacityLedgerPolicyMismatchError) {
        return mutation("rejected", "policy_mismatch");
      }
      return mutation("rejected", "store_failure");
    }
  }

  public async renew(input: GlobalCapacityLedgerRenewInputV1): Promise<GlobalCapacityLedgerMutationResultV1> {
    if (!validRenewInput(input)) return mutation("rejected", "invalid_request");
    if (!this.isProjectInScope(input.projectId)) return mutation("rejected", "project_isolation");
    try {
      const asOf = this.currentTime();
      return await this.input.layer.transactionImmediate(async (tx) => {
        const state = await lockAndRefreshState(tx, asOf, this.input.policy, false);
        const hash = requestHash("renew", input);
        const replay = await findOperation(tx, input.projectId, "renew", input.operationId);
        if (replay) {
          return replay.requestHash === hash
            ? operationResult(replay, true)
            : mutation("rejected", "idempotency_conflict");
        }
        const expiresAt = snapshotExpiry(asOf, this.input.policy.leaseTtlMs);
        const claim = await findClaimById(tx, input.projectId, input.claimId);
        if (!claim || claim.releasedAt !== null) {
          const result = mutation("rejected", "claim_not_found");
          await insertOperation(tx, input.projectId, "renew", input.operationId, hash, result, asOf);
          return result;
        }
        if (Date.parse(claim.expiresAt) <= Date.parse(asOf)) {
          const result = mutation("rejected", "claim_expired");
          await insertOperation(tx, input.projectId, "renew", input.operationId, hash, result, asOf);
          return result;
        }
        if (!sameLeaseIdentity(claim, input)) {
          const result = mutation("rejected", "stale_fence");
          await insertOperation(tx, input.projectId, "renew", input.operationId, hash, result, asOf);
          return result;
        }
        if (Date.parse(expiresAt) <= Date.parse(claim.expiresAt)) {
          const result = mutation("rejected", "renewal_regression");
          await insertOperation(tx, input.projectId, "renew", input.operationId, hash, result, asOf);
          return result;
        }
        const updated = await tx
          .update(globalCapacityClaims)
          .set({ expiresAt })
          .where(and(
            eq(globalCapacityClaims.id, claim.id),
            eq(globalCapacityClaims.projectId, claim.projectId),
            eq(globalCapacityClaims.resourceKind, claim.resourceKind),
            eq(globalCapacityClaims.resourceId, claim.resourceId),
            eq(globalCapacityClaims.holderId, claim.holderId),
            eq(globalCapacityClaims.leaseId, claim.leaseId),
            eq(globalCapacityClaims.fence, claim.fence),
            eq(globalCapacityClaims.expiresAt, claim.expiresAt),
            isNull(globalCapacityClaims.releasedAt),
          ))
          .returning({ id: globalCapacityClaims.id });
        if (!updated[0]) return mutation("rejected", "stale_fence");
        await bumpState(tx, state, asOf);
        const result = mutation("renewed", "capacity_renewed", false, input.claimId, input.fence);
        await insertOperation(tx, input.projectId, "renew", input.operationId, hash, result, asOf);
        return result;
      });
    } catch (error) {
      if (error instanceof GlobalCapacityLedgerPolicyUnavailableError) {
        return mutation("rejected", "capacity_policy_unavailable");
      }
      return mutation("rejected", "store_failure");
    }
  }

  public async release(input: GlobalCapacityLedgerReleaseInputV1): Promise<GlobalCapacityLedgerMutationResultV1> {
    if (!validReleaseInput(input)) return mutation("rejected", "invalid_request");
    if (!this.isProjectInScope(input.projectId)) return mutation("rejected", "project_isolation");
    try {
      const asOf = this.currentTime();
      return await this.input.layer.transactionImmediate(async (tx) => {
        const state = await lockAndRefreshState(tx, asOf, this.input.policy, false);
        const hash = requestHash("release", input);
        const replay = await findOperation(tx, input.projectId, "release", input.operationId);
        if (replay) {
          return replay.requestHash === hash
            ? operationResult(replay, true)
            : mutation("rejected", "idempotency_conflict");
        }
        const claim = await findClaimById(tx, input.projectId, input.claimId);
        if (!claim || claim.releasedAt !== null) {
          const result = mutation("rejected", "claim_not_found");
          await insertOperation(tx, input.projectId, "release", input.operationId, hash, result, asOf);
          return result;
        }
        if (!sameLeaseIdentity(claim, input)) {
          const result = mutation("rejected", "stale_fence");
          await insertOperation(tx, input.projectId, "release", input.operationId, hash, result, asOf);
          return result;
        }
        const released = await tx
          .update(globalCapacityClaims)
          .set({ releasedAt: asOf })
          .where(and(
            eq(globalCapacityClaims.id, claim.id),
            eq(globalCapacityClaims.projectId, claim.projectId),
            eq(globalCapacityClaims.resourceKind, claim.resourceKind),
            eq(globalCapacityClaims.resourceId, claim.resourceId),
            eq(globalCapacityClaims.holderId, claim.holderId),
            eq(globalCapacityClaims.leaseId, claim.leaseId),
            eq(globalCapacityClaims.fence, claim.fence),
            isNull(globalCapacityClaims.releasedAt),
          ))
          .returning({ id: globalCapacityClaims.id });
        if (!released[0]) return mutation("rejected", "stale_fence");
        await bumpState(tx, state, asOf);
        const result = mutation("released", "capacity_released", false, input.claimId, input.fence);
        await insertOperation(tx, input.projectId, "release", input.operationId, hash, result, asOf);
        return result;
      });
    } catch (error) {
      if (error instanceof GlobalCapacityLedgerPolicyUnavailableError) {
        return mutation("rejected", "capacity_policy_unavailable");
      }
      return mutation("rejected", "store_failure");
    }
  }

  private isProjectInScope(projectId: string): boolean {
    return this.boundProjectId === projectId;
  }

  private assertProjectScope(projectId: string): void {
    if (!this.isProjectInScope(projectId)) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger request violates the factory project scope");
    }
  }

  /*
   * FNXC:GlobalCapacityLedger 2026-07-20-03:29:
   * Request timestamps remain only for compatibility and idempotency transport.
   * Neither a request's observation time nor its requested expiry can advance a
   * lease or release another project's capacity: the host clock and verified
   * lease TTL are the only durable time authority.
   */
  private currentTime(): string {
    const observedAt = this.now();
    if (!canonicalTimestamp(observedAt)) {
      throw new GlobalCapacityLedgerPostgresError("Global capacity ledger trusted clock returned an invalid timestamp");
    }
    return observedAt;
  }
}

async function lockAndRefreshState(
tx: DbTransaction,
asOf: string,
policy: GlobalCapacityLedgerPolicyV1,
requirePolicyMatch: boolean,
): Promise<StateRow> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_CAPACITY_LEDGER_LOCK_KEY}))`);
  const expectedPolicyHash = hashGlobalCapacityLedgerPolicy(policy);
  const state = await loadState(tx);
if (requirePolicyMatch && state.policyHash !== expectedPolicyHash) {
throw new GlobalCapacityLedgerPolicyMismatchError();
}
const expired = await tx
    .update(globalCapacityClaims)
    .set({ releasedAt: asOf })
    .where(and(isNull(globalCapacityClaims.releasedAt), lte(globalCapacityClaims.expiresAt, asOf)))
    .returning({ id: globalCapacityClaims.id });
  return expired.length > 0 ? bumpState(tx, state, asOf) : state;
}

async function loadState(tx: DbTransaction): Promise<StateRow> {
const rows = await tx
.select({
id: globalCapacityState.id,
revision: globalCapacityState.revision,
policyHash: globalCapacityState.policyHash,
updatedAt: globalCapacityState.updatedAt,
})
    .from(globalCapacityState)
    .where(eq(globalCapacityState.id, GLOBAL_CAPACITY_LEDGER_STATE_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new GlobalCapacityLedgerPolicyUnavailableError();
  return row;
}

async function bumpState(tx: DbTransaction, state: StateRow, updatedAt: string): Promise<StateRow> {
  const rows = await tx
    .update(globalCapacityState)
    .set({
      revision: sql`${globalCapacityState.revision} + 1`,
      updatedAt,
    })
    .where(and(
      eq(globalCapacityState.id, GLOBAL_CAPACITY_LEDGER_STATE_ID),
      eq(globalCapacityState.revision, state.revision),
    ))
.returning({
id: globalCapacityState.id,
revision: globalCapacityState.revision,
policyHash: globalCapacityState.policyHash,
updatedAt: globalCapacityState.updatedAt,
});
  const row = rows[0];
  if (!row) throw new GlobalCapacityLedgerPostgresError("Global capacity ledger state changed while locked");
  return row;
}

async function loadGlobalLimit(tx: DbTransaction): Promise<number | null> {
  const rows = await tx
    .select({ limit: globalConcurrency.globalMaxConcurrent })
    .from(globalConcurrency)
    .where(eq(globalConcurrency.id, 1))
    .limit(1);
  const value = rows[0]?.limit;
  return positiveSafeInteger(value) ? value : null;
}

async function loadActiveClaims(
  tx: DbTransaction,
  asOf: string,
): Promise<readonly (typeof globalCapacityClaims.$inferSelect)[]> {
  return tx
    .select()
    .from(globalCapacityClaims)
    .where(and(isNull(globalCapacityClaims.releasedAt), gt(globalCapacityClaims.expiresAt, asOf)));
}

async function hasActiveLegacyRoomGlobalConcurrencyClaim(
  tx: DbTransaction,
  asOf: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: roomGlobalConcurrencyClaims.id })
    .from(roomGlobalConcurrencyClaims)
    .where(and(
      isNull(roomGlobalConcurrencyClaims.releasedAt),
      gt(roomGlobalConcurrencyClaims.expiresAt, asOf),
    ))
    .limit(1);
  return rows.length > 0;
}

async function findClaimById(
  tx: DbTransaction,
  projectId: string,
  claimId: string,
): Promise<(typeof globalCapacityClaims.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(globalCapacityClaims)
    .where(and(eq(globalCapacityClaims.id, claimId), eq(globalCapacityClaims.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

async function findActiveClaimForResource(
  tx: DbTransaction,
  projectId: string,
  resourceKind: GlobalCapacityResourceKindV1,
  resourceId: string,
): Promise<(typeof globalCapacityClaims.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(globalCapacityClaims)
    .where(and(
      eq(globalCapacityClaims.projectId, projectId),
      eq(globalCapacityClaims.resourceKind, resourceKind),
      eq(globalCapacityClaims.resourceId, resourceId),
      isNull(globalCapacityClaims.releasedAt),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function findOperation(
  tx: DbTransaction,
  projectId: string,
  kind: CommandKind,
  operationId: string,
): Promise<(typeof globalCapacityOperations.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, projectId),
      eq(globalCapacityOperations.commandKind, kind),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function insertOperation(
  tx: DbTransaction,
  projectId: string,
  kind: CommandKind,
  operationId: string,
  hash: string,
  result: GlobalCapacityLedgerMutationResultV1,
  occurredAt: string,
): Promise<void> {
  await tx.insert(globalCapacityOperations).values({
    projectId,
    commandKind: kind,
    operationId,
    requestHash: hash,
    action: result.action,
    reason: result.reason,
    claimId: result.claimId,
    fence: result.fence,
    occurredAt,
  });
}

async function buildSnapshot(
  tx: DbTransaction,
  state: StateRow,
  policy: GlobalCapacityLedgerPolicyV1,
  projectId: string,
  asOf: string,
): Promise<GlobalCapacityLedgerSnapshotV1> {
  const activeRows = await loadActiveClaims(tx, asOf);
  const ownRows = activeRows.filter((row) => row.projectId === projectId);
  const foreignRows = activeRows.filter((row) => row.projectId !== projectId);
  const totalSlots = await loadGlobalLimit(tx);
  const ownClaims = ownRows.map(rowToClaim).sort((left, right) => left.claimId.localeCompare(right.claimId));
  const foreignOccupancy = summarize(foreignRows);
  const snapshotId = hashRoomValue({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    stateRevision: state.revision,
    observedAt: asOf,
    totalSlots,
    policy,
    ownClaims,
    foreignOccupancy,
  });
  return Object.freeze({
    contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
    snapshotId,
    stateRevision: state.revision,
    observedAt: asOf,
    expiresAt: snapshotExpiry(asOf, policy.snapshotTtlMs),
    totalSlots,
    reservations: Object.freeze({ ...policy.reservations }),
    ownClaims: Object.freeze(ownClaims),
    foreignOccupancy: Object.freeze({ ...foreignOccupancy }),
  });
}
