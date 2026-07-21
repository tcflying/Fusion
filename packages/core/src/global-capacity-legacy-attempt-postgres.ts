import { and, desc, eq, sql } from "drizzle-orm";

import {
  GLOBAL_CAPACITY_LEDGER_LOCK_KEY,
  GLOBAL_CAPACITY_LEDGER_STATE_ID,
  assertGlobalCapacityLedgerPolicy,
  hashGlobalCapacityLedgerPolicy,
  type GlobalCapacityLedgerPolicyV1,
  type GlobalCapacityWorkClassV1,
} from "./global-capacity-ledger-postgres.js";
import { GLOBAL_CAPACITY_POLICY_AUTHORITY_ID } from "./global-capacity-policy-authority.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  globalCapacityClaims,
  globalCapacityLegacyAttempts,
  globalCapacityOperations,
  globalCapacityPolicyAuthority,
  globalCapacityState,
} from "./postgres/schema/central.js";

export const GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION = 1 as const;

export type GlobalCapacityLegacyAttemptResourceKindV1 = "legacy_task" | "legacy_triage";
export type GlobalCapacityLegacyAttemptStateV1 =
  | "prepared"
  | "withheld"
  | "admitted"
  | "work_started"
  | "work_finished"
  | "released"
  | "superseded";
export type GlobalCapacityLegacyAttemptIdKindV1 =
  | "attempt"
  | "claim"
  | "lease"
  | "acquire_operation"
  | "renew_operation"
  | "work_start_receipt"
  | "release_operation";

export interface GlobalCapacityLegacyAttemptV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly state: GlobalCapacityLegacyAttemptStateV1;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  /** Monotonic capacity fence, independent from a task checkout lease epoch. */
  readonly capacityFence: number;
  readonly claimId: string;
  /** The next durable ledger-acquire id to submit. */
  readonly acquireOperationId: string;
  /** Increments after a durable held response before a new acquire can be sent. */
  readonly acquireGeneration: number;
  readonly lastWithheldOperationId: string | null;
  /** The next durable ledger-renew id to submit while the external work runs. */
  readonly renewOperationId: string;
  readonly renewGeneration: number;
  readonly lastRenewalOperationId: string | null;
  readonly releaseOperationId: string;
  readonly preparedAt: string;
  readonly expiresAt: string;
  readonly admittedAt: string | null;
  readonly workStartedAt: string | null;
  readonly workFinishedAt: string | null;
  readonly releasedAt: string | null;
  readonly supersededAt: string | null;
  readonly updatedAt: string;
}

export interface GlobalCapacityLegacyAttemptReferenceV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION;
  readonly attemptId: string;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly capacityFence: number;
}

/** A restart-safe lookup identity that does not require a private work receipt. */
export interface GlobalCapacityLegacyAttemptRecoveryInspectionInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
}

export type GlobalCapacityLegacyAttemptRecoveryFindingV1 =
  | "work_started"
  | "renewal_lost"
  | "release_pending"
  | "unresolved";

export type GlobalCapacityLegacyAttemptRecoveryInspectionV1 =
  | { readonly state: "clear" }
  | {
      readonly state: "reconciliation_required";
      readonly reason: "external_work_may_have_started" | "release_pending";
      readonly finding: GlobalCapacityLegacyAttemptRecoveryFindingV1;
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    };

export interface GlobalCapacityLegacyAttemptPrepareInputV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
  /** Stable executor/triage attempt owner, not a volatile process id. */
  readonly holderId: string;
}

export interface GlobalCapacityLegacyAttemptIdFactoryInputV1 {
  readonly kind: GlobalCapacityLegacyAttemptIdKindV1;
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly capacityFence: number;
  readonly acquireGeneration: number;
}

export type GlobalCapacityLegacyAttemptIdFactoryV1 = (
  input: GlobalCapacityLegacyAttemptIdFactoryInputV1,
) => string;

export interface CreateGlobalCapacityLegacyAttemptStoreInputV1 {
  readonly layer: AsyncDataLayer;
  readonly projectId: string;
  /**
   * A copy of the policy loaded from the central authority. Every mutation
   * re-checks it against the central authority and ledger singleton so a
   * project-local caller cannot invent a lease lifetime.
   */
  readonly policy: GlobalCapacityLedgerPolicyV1;
  readonly idFactory: GlobalCapacityLegacyAttemptIdFactoryV1;
  /** Host-owned clock used for all durable boundaries. */
  readonly now?: () => string;
}

export type GlobalCapacityLegacyAttemptPrepareResultV1 =
  | {
      readonly outcome: "ready";
      readonly reason: "created" | "resumed";
      readonly replayed: boolean;
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    }
  | {
      readonly outcome: "blocked";
      readonly reason: "active_attempt_conflict";
      readonly replayed: false;
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    }
  | {
      readonly outcome: "recovery_required";
      readonly reason: "external_work_may_have_started";
      readonly replayed: true;
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    };

export interface RecordGlobalCapacityLegacyAttemptWithheldInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedAcquireOperationId: string;
}

export interface RecordGlobalCapacityLegacyAttemptAdmissionInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedAcquireOperationId: string;
}

export interface RecordGlobalCapacityLegacyAttemptReleaseInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedReleaseOperationId: string;
  readonly executionReceiptId?: string;
}

/**
 * A crash-recovery-only release acknowledgement. The work-start receipt stays
 * private inside the durable store: a restarted process cannot safely recreate
 * or receive that capability from an untrusted caller.
 */
export interface RecordGlobalCapacityLegacyAttemptRecoveredWorkFinishedReleaseInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedReleaseOperationId: string;
}

export interface RecordGlobalCapacityLegacyAttemptWorkFinishedInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly executionReceiptId: string;
}

export interface RecordGlobalCapacityLegacyAttemptRenewedInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedRenewOperationId: string;
}

/**
 * Used only after a persisted non-renewed ledger result. An unknown transport
 * outcome must retry the same id, never mint a second renewal operation.
 */
export interface AdvanceGlobalCapacityLegacyAttemptRenewalInputV1
  extends GlobalCapacityLegacyAttemptReferenceV1 {
  readonly observedRenewOperationId: string;
}

export type GlobalCapacityLegacyAttemptWorkStartResultV1 =
  | {
      /** The sole result that permits the caller to invoke the external worker. */
      readonly outcome: "execution_granted";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly executionReceiptId: string;
    }
  | {
      /** A prior caller may have crossed the side-effect boundary; recover, never rerun. */
      readonly outcome: "recovery_required";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    };

export interface GlobalCapacityLegacyAttemptStoreV1 {
  prepare(
    input: GlobalCapacityLegacyAttemptPrepareInputV1,
  ): Promise<GlobalCapacityLegacyAttemptPrepareResultV1>;
  read(
    input: GlobalCapacityLegacyAttemptReferenceV1,
  ): Promise<GlobalCapacityLegacyAttemptV1 | null>;
  /**
   * Reads only the newest durable attempt for a resource and identifies the
   * states that must be parked before any executor/triage side effect begins.
   */
  inspectRecovery(
    input: GlobalCapacityLegacyAttemptRecoveryInspectionInputV1,
  ): Promise<GlobalCapacityLegacyAttemptRecoveryInspectionV1>;
  recordWithheld(
    input: RecordGlobalCapacityLegacyAttemptWithheldInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  recordAdmission(
    input: RecordGlobalCapacityLegacyAttemptAdmissionInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  recordRenewed(
    input: RecordGlobalCapacityLegacyAttemptRenewedInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  advanceRenewalAfterDurableFailure(
    input: AdvanceGlobalCapacityLegacyAttemptRenewalInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  /** Must commit immediately before the first external executor/triage side effect. */
  recordWorkStarted(
    input: GlobalCapacityLegacyAttemptReferenceV1,
  ): Promise<GlobalCapacityLegacyAttemptWorkStartResultV1>;
  recordWorkFinished(
    input: RecordGlobalCapacityLegacyAttemptWorkFinishedInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  /** Must follow a durable ledger-release receipt (including an idempotent replay). */
  recordReleased(
    input: RecordGlobalCapacityLegacyAttemptReleaseInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
  /**
   * Crash recovery may acknowledge only an already-finished attempt. It never
   * exposes or accepts the private work-start receipt, and still requires the
   * exact durable ledger-release operation before changing state.
   */
  recordRecoveredWorkFinishedRelease(
    input: RecordGlobalCapacityLegacyAttemptRecoveredWorkFinishedReleaseInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1>;
}

export class GlobalCapacityLegacyAttemptPostgresError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GlobalCapacityLegacyAttemptPostgresError";
  }
}

/** Internal row shape. The single-use work receipt is never exposed by read/prepare. */
interface StoredGlobalCapacityLegacyAttemptV1 extends GlobalCapacityLegacyAttemptV1 {
  readonly workStartReceiptId: string | null;
}

const RESOURCE_KINDS = new Set<GlobalCapacityLegacyAttemptResourceKindV1>([
  "legacy_task",
  "legacy_triage",
]);
const WORK_CLASSES = new Set<GlobalCapacityWorkClassV1>(["normal", "verifier", "recovery"]);
const ATTEMPT_STATES = new Set<GlobalCapacityLegacyAttemptStateV1>([
  "prepared",
  "withheld",
  "admitted",
  "work_started",
  "work_finished",
  "released",
  "superseded",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableCanonicalTimestamp(value: unknown): value is string | null {
  return value === null || canonicalTimestamp(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validResourceKind(value: unknown): value is GlobalCapacityLegacyAttemptResourceKindV1 {
  return typeof value === "string" && RESOURCE_KINDS.has(value as GlobalCapacityLegacyAttemptResourceKindV1);
}

function validWorkClass(value: unknown): value is GlobalCapacityWorkClassV1 {
  return typeof value === "string" && WORK_CLASSES.has(value as GlobalCapacityWorkClassV1);
}

function validState(value: unknown): value is GlobalCapacityLegacyAttemptStateV1 {
  return typeof value === "string" && ATTEMPT_STATES.has(value as GlobalCapacityLegacyAttemptStateV1);
}

function validReference(value: unknown): value is GlobalCapacityLegacyAttemptReferenceV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.attemptId)
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId)
    && positiveSafeInteger(value.capacityFence);
}

function validRecoveryInspectionInput(
  value: unknown,
): value is GlobalCapacityLegacyAttemptRecoveryInspectionInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId);
}

function validPrepareInput(value: unknown): value is GlobalCapacityLegacyAttemptPrepareInputV1 {
  return isRecord(value)
    && value.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && validResourceKind(value.resourceKind)
    && canonicalString(value.resourceId)
    && validWorkClass(value.workClass)
    && positiveSafeInteger(value.slots)
    && canonicalString(value.holderId);
}

function samePreparation(
  attempt: GlobalCapacityLegacyAttemptV1,
  input: GlobalCapacityLegacyAttemptPrepareInputV1,
): boolean {
  return attempt.resourceKind === input.resourceKind
    && attempt.resourceId === input.resourceId
    && attempt.workClass === input.workClass
    && attempt.slots === input.slots
    && attempt.holderId === input.holderId;
}

function isPreStartState(state: GlobalCapacityLegacyAttemptStateV1): boolean {
  return state === "prepared" || state === "withheld" || state === "admitted";
}

function isRecoveryState(state: GlobalCapacityLegacyAttemptStateV1): boolean {
  return state === "work_started" || state === "work_finished";
}

function isExpired(attempt: GlobalCapacityLegacyAttemptV1, asOf: string): boolean {
  return Date.parse(attempt.expiresAt) <= Date.parse(asOf);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const next = new Date(Date.parse(timestamp) + milliseconds);
  if (!Number.isFinite(next.getTime())) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt expiry overflowed the trusted clock");
  }
  return next.toISOString();
}

function attemptLockKey(
  projectId: string,
  resourceKind: GlobalCapacityLegacyAttemptResourceKindV1,
  resourceId: string,
): string {
  return `fusion-global-capacity-legacy-attempt-v1:${projectId}:${resourceKind}:${resourceId}`;
}

function freezePolicy(value: unknown): GlobalCapacityLedgerPolicyV1 {
  assertGlobalCapacityLedgerPolicy(value);
  return Object.freeze({
    reservations: Object.freeze({
      verifierSlots: value.reservations.verifierSlots,
      recoverySlots: value.reservations.recoverySlots,
      legacyTaskTriageSlots: value.reservations.legacyTaskTriageSlots,
    }),
    snapshotTtlMs: value.snapshotTtlMs,
    leaseTtlMs: value.leaseTtlMs,
  });
}

function referenceFor(attempt: GlobalCapacityLegacyAttemptV1): GlobalCapacityLegacyAttemptReferenceV1 {
  return Object.freeze({
    contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
    attemptId: attempt.id,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    capacityFence: attempt.capacityFence,
  });
}

/** Build the exact persisted fence reference required for later transitions. */
export function toGlobalCapacityLegacyAttemptReference(
  attempt: GlobalCapacityLegacyAttemptV1,
): GlobalCapacityLegacyAttemptReferenceV1 {
  return referenceFor(attempt);
}

function storedAttemptFromRow(
  row: typeof globalCapacityLegacyAttempts.$inferSelect,
): StoredGlobalCapacityLegacyAttemptV1 {
  if (
    !canonicalString(row.id)
    || !canonicalString(row.projectId)
    || !validResourceKind(row.resourceKind)
    || !canonicalString(row.resourceId)
    || !validState(row.state)
    || !validWorkClass(row.workClass)
    || !positiveSafeInteger(row.slots)
    || !canonicalString(row.holderId)
    || !canonicalString(row.leaseId)
    || !positiveSafeInteger(row.capacityFence)
    || !canonicalString(row.claimId)
    || !canonicalString(row.acquireOperationId)
    || !positiveSafeInteger(row.acquireGeneration)
    || (row.lastWithheldOperationId !== null && !canonicalString(row.lastWithheldOperationId))
    || !canonicalString(row.renewOperationId)
    || !positiveSafeInteger(row.renewGeneration)
    || (row.lastRenewalOperationId !== null && !canonicalString(row.lastRenewalOperationId))
    || !canonicalString(row.releaseOperationId)
    || !canonicalTimestamp(row.preparedAt)
    || !canonicalTimestamp(row.expiresAt)
    || !nullableCanonicalTimestamp(row.admittedAt)
    || !nullableCanonicalTimestamp(row.workStartedAt)
    || (row.workStartReceiptId !== null && !canonicalString(row.workStartReceiptId))
    || !nullableCanonicalTimestamp(row.workFinishedAt)
    || !nullableCanonicalTimestamp(row.releasedAt)
    || !nullableCanonicalTimestamp(row.supersededAt)
    || !canonicalTimestamp(row.updatedAt)
    || Date.parse(row.expiresAt) <= Date.parse(row.preparedAt)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt record is malformed");
  }
  if (
    (row.state === "prepared" || row.state === "withheld")
    && (row.admittedAt !== null || row.workStartedAt !== null || row.workStartReceiptId !== null || row.workFinishedAt !== null || row.releasedAt !== null || row.supersededAt !== null)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt pre-start state is malformed");
  }
  if (
    row.state === "admitted"
    && (row.admittedAt === null || row.workStartedAt !== null || row.workStartReceiptId !== null || row.workFinishedAt !== null || row.releasedAt !== null || row.supersededAt !== null)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt admission state is malformed");
  }
  if (
    row.state === "work_started"
    && (row.admittedAt === null || row.workStartedAt === null || row.workStartReceiptId === null || row.workFinishedAt !== null || row.releasedAt !== null || row.supersededAt !== null)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt work-start state is malformed");
  }
  if (
    row.state === "work_finished"
    && (row.admittedAt === null || row.workStartedAt === null || row.workStartReceiptId === null || row.workFinishedAt === null || row.releasedAt !== null || row.supersededAt !== null)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt work-finished state is malformed");
  }
  if (
    row.state === "released"
    && (
      row.releasedAt === null
      || row.supersededAt !== null
      || (row.workStartedAt === null && (row.workStartReceiptId !== null || row.workFinishedAt !== null))
      || (row.workStartedAt !== null && (row.workStartReceiptId === null || (row.workFinishedAt !== null && row.workFinishedAt < row.workStartedAt)))
    )
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt release state is malformed");
  }
  if (
    row.state === "superseded"
    && (row.workStartedAt !== null || row.workStartReceiptId !== null || row.workFinishedAt !== null || row.releasedAt !== null || row.supersededAt === null)
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt superseded state is malformed");
  }
  return Object.freeze({
    contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
    id: row.id,
    projectId: row.projectId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    state: row.state,
    workClass: row.workClass,
    slots: row.slots,
    holderId: row.holderId,
    leaseId: row.leaseId,
    capacityFence: row.capacityFence,
    claimId: row.claimId,
    acquireOperationId: row.acquireOperationId,
    acquireGeneration: row.acquireGeneration,
    lastWithheldOperationId: row.lastWithheldOperationId,
    renewOperationId: row.renewOperationId,
    renewGeneration: row.renewGeneration,
    lastRenewalOperationId: row.lastRenewalOperationId,
    releaseOperationId: row.releaseOperationId,
    preparedAt: row.preparedAt,
    expiresAt: row.expiresAt,
    admittedAt: row.admittedAt,
    workStartedAt: row.workStartedAt,
    workStartReceiptId: row.workStartReceiptId,
    workFinishedAt: row.workFinishedAt,
    releasedAt: row.releasedAt,
    supersededAt: row.supersededAt,
    updatedAt: row.updatedAt,
  });
}

function publicAttempt(
  attempt: StoredGlobalCapacityLegacyAttemptV1,
): GlobalCapacityLegacyAttemptV1 {
  const { workStartReceiptId: _receipt, ...publicFields } = attempt;
  return Object.freeze(publicFields);
}

/**
 * FNXC:GlobalCapacityLegacyAttempt 2026-07-20-04:31:
 * Persist the execution-attempt boundary independently from the ledger. A
 * holder can retry an unstarted acquire, but after work_started every restart
 * must enter recovery instead of invoking an executor/triage side effect a
 * second time. The store intentionally never calls a provider, task store, or
 * capacity ledger; the host makes those boundary calls around these receipts.
 */
export function createGlobalCapacityLegacyAttemptStore(
  input: CreateGlobalCapacityLegacyAttemptStoreInputV1,
): GlobalCapacityLegacyAttemptStoreV1 {
  const implementation = new GlobalCapacityLegacyAttemptStore(input);
  return Object.freeze({
    prepare: implementation.prepare.bind(implementation),
    read: implementation.read.bind(implementation),
    inspectRecovery: implementation.inspectRecovery.bind(implementation),
    recordWithheld: implementation.recordWithheld.bind(implementation),
    recordAdmission: implementation.recordAdmission.bind(implementation),
    recordRenewed: implementation.recordRenewed.bind(implementation),
    advanceRenewalAfterDurableFailure: implementation.advanceRenewalAfterDurableFailure.bind(implementation),
    recordWorkStarted: implementation.recordWorkStarted.bind(implementation),
    recordWorkFinished: implementation.recordWorkFinished.bind(implementation),
    recordReleased: implementation.recordReleased.bind(implementation),
    recordRecoveredWorkFinishedRelease: implementation.recordRecoveredWorkFinishedRelease.bind(implementation),
  });
}

class GlobalCapacityLegacyAttemptStore {
  private readonly projectId: string;
  private readonly policy: GlobalCapacityLedgerPolicyV1;
  private readonly now: () => string;

  public constructor(private readonly input: CreateGlobalCapacityLegacyAttemptStoreInputV1) {
    if (!input.layer) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt store requires a data layer");
    }
    if (!canonicalString(input.projectId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt project scope is invalid");
    }
    if (input.layer.projectId && input.layer.projectId !== input.projectId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt project scope conflicts with its data layer");
    }
    if (typeof input.idFactory !== "function") {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory is invalid");
    }
    if (input.now !== undefined && typeof input.now !== "function") {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt trusted clock is invalid");
    }
    this.projectId = input.projectId;
    this.policy = freezePolicy(input.policy);
    this.now = input.now ?? (() => new Date().toISOString());
  }

  public async prepare(
    input: GlobalCapacityLegacyAttemptPrepareInputV1,
  ): Promise<GlobalCapacityLegacyAttemptPrepareResultV1> {
    if (!validPrepareInput(input)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt preparation input is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const latest = await latestAttemptForResource(tx, this.projectId, input.resourceKind, input.resourceId);
      if (latest) {
        const current = storedAttemptFromRow(latest);
        if (isRecoveryState(current.state)) {
          return {
            outcome: "recovery_required",
            reason: "external_work_may_have_started",
            replayed: true,
            attempt: publicAttempt(current),
          };
        }
        if (isPreStartState(current.state) && isExpired(current, asOf)) {
          await supersedeAttempt(tx, current, asOf);
        } else if (isPreStartState(current.state)) {
          return samePreparation(current, input)
            ? { outcome: "ready", reason: "resumed", replayed: true, attempt: publicAttempt(current) }
            : { outcome: "blocked", reason: "active_attempt_conflict", replayed: false, attempt: publicAttempt(current) };
        }
      }
      const nextFence = await nextCapacityFence(tx, this.projectId, input.resourceKind, input.resourceId);
      const created = this.createAttempt(input, nextFence, asOf);
      await tx.insert(globalCapacityLegacyAttempts).values({
        id: created.id,
        projectId: created.projectId,
        resourceKind: created.resourceKind,
        resourceId: created.resourceId,
        state: created.state,
        workClass: created.workClass,
        slots: created.slots,
        holderId: created.holderId,
        leaseId: created.leaseId,
        capacityFence: created.capacityFence,
        claimId: created.claimId,
        acquireOperationId: created.acquireOperationId,
        acquireGeneration: created.acquireGeneration,
        lastWithheldOperationId: created.lastWithheldOperationId,
        renewOperationId: created.renewOperationId,
        renewGeneration: created.renewGeneration,
        lastRenewalOperationId: created.lastRenewalOperationId,
        releaseOperationId: created.releaseOperationId,
        preparedAt: created.preparedAt,
        expiresAt: created.expiresAt,
        admittedAt: created.admittedAt,
        workStartedAt: created.workStartedAt,
        workStartReceiptId: created.workStartReceiptId,
        workFinishedAt: created.workFinishedAt,
        releasedAt: created.releasedAt,
        supersededAt: created.supersededAt,
        updatedAt: created.updatedAt,
      });
      return { outcome: "ready", reason: "created", replayed: false, attempt: publicAttempt(created) };
    });
  }

  public async read(
    input: GlobalCapacityLegacyAttemptReferenceV1,
  ): Promise<GlobalCapacityLegacyAttemptV1 | null> {
    this.assertReference(input);
    const rows = await this.input.layer.db
      .select()
      .from(globalCapacityLegacyAttempts)
      .where(and(
        eq(globalCapacityLegacyAttempts.projectId, this.projectId),
        eq(globalCapacityLegacyAttempts.id, input.attemptId),
        eq(globalCapacityLegacyAttempts.resourceKind, input.resourceKind),
        eq(globalCapacityLegacyAttempts.resourceId, input.resourceId),
        eq(globalCapacityLegacyAttempts.capacityFence, input.capacityFence),
      ))
      .limit(1);
    return rows[0] ? publicAttempt(storedAttemptFromRow(rows[0])) : null;
  }

  /**
   * FNXC:GlobalCapacityLegacyRecoveryInspection 2026-07-20-05:47:
   * A restarted dispatcher has no private work-start receipt, but it must still
   * discover whether a prior worker crossed the external-effect boundary before
   * it creates a worktree or session. Inspect only the newest durable attempt;
   * pre-start and released states remain safe for the normal runner to resolve,
   * while work_started/work_finished are projected as a fail-closed park.
   */
  public async inspectRecovery(
    input: GlobalCapacityLegacyAttemptRecoveryInspectionInputV1,
  ): Promise<GlobalCapacityLegacyAttemptRecoveryInspectionV1> {
    if (!validRecoveryInspectionInput(input)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy recovery inspection input is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const latest = await latestAttemptForResource(tx, this.projectId, input.resourceKind, input.resourceId);
      if (!latest) return { state: "clear" };
      const attempt = storedAttemptFromRow(latest);
      if (attempt.state === "work_started") {
        return {
          state: "reconciliation_required",
          reason: "external_work_may_have_started",
          finding: await recoveryFindingForWorkStarted(tx, attempt, asOf),
          attempt: publicAttempt(attempt),
        };
      }
      if (attempt.state === "work_finished") {
        return {
          state: "reconciliation_required",
          reason: "release_pending",
          finding: "release_pending",
          attempt: publicAttempt(attempt),
        };
      }
      return { state: "clear" };
    });
  }

  public async recordWithheld(
    input: RecordGlobalCapacityLegacyAttemptWithheldInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedAcquireOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt withheld operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      if (current.state === "withheld" && current.lastWithheldOperationId === input.observedAcquireOperationId) {
        await assertDurableLedgerWithheld(tx, current, input.observedAcquireOperationId);
        return publicAttempt(current);
      }
      if (current.state !== "prepared" && current.state !== "withheld") {
        throw new GlobalCapacityLegacyAttemptPostgresError(
          `Global capacity legacy attempt cannot record a withheld capacity response from ${current.state}`,
        );
      }
      if (isExpired(current, asOf)) {
        await supersedeAttempt(tx, current, asOf);
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt expired before its withheld response was recorded");
      }
      this.requireAcquireOperation(current, input.observedAcquireOperationId);
      await assertDurableLedgerWithheld(tx, current, input.observedAcquireOperationId);
      const nextGeneration = current.acquireGeneration + 1;
      const nextOperationId = this.nextId("acquire_operation", current, nextGeneration);
      if (
        nextOperationId === current.acquireOperationId
        || nextOperationId === current.renewOperationId
        || nextOperationId === current.releaseOperationId
      ) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory reused an operation id");
      }
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({
          state: "withheld",
          acquireOperationId: nextOperationId,
          acquireGeneration: nextGeneration,
          lastWithheldOperationId: input.observedAcquireOperationId,
          expiresAt: this.expiresAt(asOf),
          updatedAt: asOf,
        })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.acquireOperationId, current.acquireOperationId),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed while its withheld response was recorded");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  public async recordAdmission(
    input: RecordGlobalCapacityLegacyAttemptAdmissionInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedAcquireOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt admission operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      if (current.state === "admitted" && current.acquireOperationId === input.observedAcquireOperationId) {
        await assertDurableLedgerAdmission(tx, current, input.observedAcquireOperationId, asOf);
        return publicAttempt(current);
      }
      if (current.state !== "prepared" && current.state !== "withheld") {
        throw new GlobalCapacityLegacyAttemptPostgresError(
          `Global capacity legacy attempt cannot record a capacity admission from ${current.state}`,
        );
      }
      if (isExpired(current, asOf)) {
        await supersedeAttempt(tx, current, asOf);
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt expired before its admission was recorded");
      }
      this.requireAcquireOperation(current, input.observedAcquireOperationId);
      await assertDurableLedgerAdmission(tx, current, input.observedAcquireOperationId, asOf);
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({
          state: "admitted",
          expiresAt: this.expiresAt(asOf),
          admittedAt: asOf,
          updatedAt: asOf,
        })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.acquireOperationId, current.acquireOperationId),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed while its admission was recorded");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  public async recordRenewed(
    input: RecordGlobalCapacityLegacyAttemptRenewedInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedRenewOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      if (current.lastRenewalOperationId === input.observedRenewOperationId) return publicAttempt(current);
      this.requireRenewableAttempt(current);
      this.requireRenewOperation(current, input.observedRenewOperationId);
      const expiresAt = await assertDurableLedgerRenewal(tx, current, input.observedRenewOperationId, asOf);
      const nextGeneration = current.renewGeneration + 1;
      if (!positiveSafeInteger(nextGeneration)) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal generation overflowed");
      }
      const nextOperationId = this.nextId("renew_operation", current, nextGeneration);
      this.assertFreshOperationId(current, nextOperationId);
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({
          renewOperationId: nextOperationId,
          renewGeneration: nextGeneration,
          lastRenewalOperationId: input.observedRenewOperationId,
          expiresAt,
          updatedAt: asOf,
        })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.renewOperationId, current.renewOperationId),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed while its renewal was recorded");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  public async advanceRenewalAfterDurableFailure(
    input: AdvanceGlobalCapacityLegacyAttemptRenewalInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedRenewOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      if (current.lastRenewalOperationId === input.observedRenewOperationId) return publicAttempt(current);
      this.requireRenewableAttempt(current);
      this.requireRenewOperation(current, input.observedRenewOperationId);
      await assertDurableNonRenewal(tx, current, input.observedRenewOperationId);
      const nextGeneration = current.renewGeneration + 1;
      if (!positiveSafeInteger(nextGeneration)) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal generation overflowed");
      }
      const nextOperationId = this.nextId("renew_operation", current, nextGeneration);
      this.assertFreshOperationId(current, nextOperationId);
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({
          renewOperationId: nextOperationId,
          renewGeneration: nextGeneration,
          lastRenewalOperationId: input.observedRenewOperationId,
          updatedAt: asOf,
        })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.renewOperationId, current.renewOperationId),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed while its failed renewal was advanced");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  public async recordWorkStarted(
    input: GlobalCapacityLegacyAttemptReferenceV1,
  ): Promise<GlobalCapacityLegacyAttemptWorkStartResultV1> {
    this.assertReference(input);
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      if (current.state === "work_started" || current.state === "work_finished") {
        return { outcome: "recovery_required", attempt: publicAttempt(current) };
      }
      if (current.state !== "admitted") {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt must be admitted before work can start");
      }
      if (isExpired(current, asOf)) {
        await supersedeAttempt(tx, current, asOf);
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt admission expired before external work started");
      }
      const executionReceiptId = this.nextId("work_start_receipt", current, current.acquireGeneration);
      if (
        executionReceiptId === current.id
        || executionReceiptId === current.claimId
        || executionReceiptId === current.leaseId
        || executionReceiptId === current.acquireOperationId
        || executionReceiptId === current.renewOperationId
        || executionReceiptId === current.releaseOperationId
      ) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory reused an execution receipt id");
      }
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({
          state: "work_started",
          workStartedAt: asOf,
          workStartReceiptId: executionReceiptId,
          updatedAt: asOf,
        })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.state, "admitted"),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed before external work started");
      }
      return {
        outcome: "execution_granted",
        attempt: publicAttempt(storedAttemptFromRow(updated[0])),
        executionReceiptId,
      };
    });
  }

  public async recordWorkFinished(
    input: RecordGlobalCapacityLegacyAttemptWorkFinishedInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.executionReceiptId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt execution receipt is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      this.requireExecutionReceipt(current, input.executionReceiptId);
      if (current.state === "work_finished") return publicAttempt(current);
      if (current.state !== "work_started") {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt must have started before work can finish");
      }
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({ state: "work_finished", workFinishedAt: asOf, updatedAt: asOf })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.state, "work_started"),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed before work finished");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  public async recordReleased(
    input: RecordGlobalCapacityLegacyAttemptReleaseInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedReleaseOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt release operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      this.requireReleaseOperation(current, input.observedReleaseOperationId);
      this.requireExecutionReceiptIfPresent(current, input.executionReceiptId);
      await assertDurableLedgerRelease(tx, current, input.observedReleaseOperationId);
      if (current.state === "released") return publicAttempt(current);
      if (
        current.state !== "admitted"
        && current.state !== "work_started"
        && current.state !== "work_finished"
        && current.state !== "superseded"
      ) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt has no durable admission to release");
      }
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({ state: "released", releasedAt: asOf, supersededAt: null, updatedAt: asOf })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.releaseOperationId, current.releaseOperationId),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed while its release was recorded");
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  /**
   * FNXC:GlobalCapacityLegacyRecovery 2026-07-20-05:45:
   * A process can die after it durably records work_finished but before it
   * persists the release acknowledgement. The original work-start receipt is a
   * single-use capability and is intentionally not returned by read()/prepare(),
   * so recovery must use this narrowly-scoped store operation instead of asking
   * a restarted worker to invent or replay that receipt. Only work_finished (or
   * its idempotent released successor) can pass, and the exact durable ledger
   * release receipt remains mandatory.
   */
  public async recordRecoveredWorkFinishedRelease(
    input: RecordGlobalCapacityLegacyAttemptRecoveredWorkFinishedReleaseInputV1,
  ): Promise<GlobalCapacityLegacyAttemptV1> {
    this.assertReference(input);
    if (!canonicalString(input.observedReleaseOperationId)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt recovery release operation is invalid");
    }
    const asOf = this.currentTime();
    return this.withLockedResource(input.resourceKind, input.resourceId, asOf, async (tx) => {
      const current = await this.requireAttempt(tx, input);
      this.requireReleaseOperation(current, input.observedReleaseOperationId);
      if (current.state !== "work_finished" && current.state !== "released") {
        throw new GlobalCapacityLegacyAttemptPostgresError(
          "Global capacity legacy attempt recovery may release only durable work_finished state",
        );
      }
      if (current.workStartReceiptId === null) {
        throw new GlobalCapacityLegacyAttemptPostgresError(
          "Global capacity legacy attempt recovery requires its private execution receipt",
        );
      }
      await assertDurableLedgerRelease(tx, current, input.observedReleaseOperationId);
      if (current.state === "released") return publicAttempt(current);
      const updated = await tx
        .update(globalCapacityLegacyAttempts)
        .set({ state: "released", releasedAt: asOf, supersededAt: null, updatedAt: asOf })
        .where(and(
          eq(globalCapacityLegacyAttempts.projectId, this.projectId),
          eq(globalCapacityLegacyAttempts.id, current.id),
          eq(globalCapacityLegacyAttempts.capacityFence, current.capacityFence),
          eq(globalCapacityLegacyAttempts.releaseOperationId, current.releaseOperationId),
          eq(globalCapacityLegacyAttempts.state, "work_finished"),
        ))
        .returning();
      if (!updated[0]) {
        throw new GlobalCapacityLegacyAttemptPostgresError(
          "Global capacity legacy attempt changed before recovered release was recorded",
        );
      }
      return publicAttempt(storedAttemptFromRow(updated[0]));
    });
  }

  private async withLockedResource<T>(
    resourceKind: GlobalCapacityLegacyAttemptResourceKindV1,
    resourceId: string,
    asOf: string,
    action: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    return this.input.layer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_CAPACITY_LEDGER_LOCK_KEY}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${attemptLockKey(this.projectId, resourceKind, resourceId)}))`);
      await assertCentralPolicyMatches(tx, this.policy);
      return action(tx);
    });
  }

  private createAttempt(
    input: GlobalCapacityLegacyAttemptPrepareInputV1,
    capacityFence: number,
    preparedAt: string,
  ): StoredGlobalCapacityLegacyAttemptV1 {
    const acquireGeneration = 1;
    const idInput = {
      projectId: this.projectId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      capacityFence,
      acquireGeneration,
    } as const;
    const id = this.generateId("attempt", idInput);
    const claimId = this.generateId("claim", idInput);
    const leaseId = this.generateId("lease", idInput);
    const acquireOperationId = this.generateId("acquire_operation", idInput);
    const renewOperationId = this.generateId("renew_operation", idInput);
    const releaseOperationId = this.generateId("release_operation", idInput);
    if (new Set([id, claimId, leaseId, acquireOperationId, renewOperationId, releaseOperationId]).size !== 6) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory must create distinct bundle ids");
    }
    return Object.freeze({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
      id,
      projectId: this.projectId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      state: "prepared",
      workClass: input.workClass,
      slots: input.slots,
      holderId: input.holderId,
      leaseId,
      capacityFence,
      claimId,
      acquireOperationId,
      acquireGeneration,
      lastWithheldOperationId: null,
      renewOperationId,
      renewGeneration: 1,
      lastRenewalOperationId: null,
      releaseOperationId,
      preparedAt,
      expiresAt: this.expiresAt(preparedAt),
      admittedAt: null,
      workStartedAt: null,
      workStartReceiptId: null,
      workFinishedAt: null,
      releasedAt: null,
      supersededAt: null,
      updatedAt: preparedAt,
    });
  }

  private nextId(
    kind: GlobalCapacityLegacyAttemptIdKindV1,
    attempt: GlobalCapacityLegacyAttemptV1,
    acquireGeneration: number,
  ): string {
    return this.generateId(kind, {
      projectId: attempt.projectId,
      resourceKind: attempt.resourceKind,
      resourceId: attempt.resourceId,
      capacityFence: attempt.capacityFence,
      acquireGeneration,
    });
  }

  private generateId(
    kind: GlobalCapacityLegacyAttemptIdKindV1,
    input: Omit<GlobalCapacityLegacyAttemptIdFactoryInputV1, "kind">,
  ): string {
    const id = this.input.idFactory(Object.freeze({ kind, ...input }));
    if (!canonicalString(id)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory returned an invalid id");
    }
    return id;
  }

  private expiresAt(asOf: string): string {
    return addMilliseconds(asOf, this.policy.leaseTtlMs);
  }

  private currentTime(): string {
    const asOf = this.now();
    if (!canonicalTimestamp(asOf)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt trusted clock returned an invalid timestamp");
    }
    return asOf;
  }

  private assertReference(input: unknown): asserts input is GlobalCapacityLegacyAttemptReferenceV1 {
    if (!validReference(input)) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt reference is invalid");
    }
  }

  private async requireAttempt(
    tx: DbTransaction,
    input: GlobalCapacityLegacyAttemptReferenceV1,
  ): Promise<StoredGlobalCapacityLegacyAttemptV1> {
    const rows = await tx
      .select()
      .from(globalCapacityLegacyAttempts)
      .where(and(
        eq(globalCapacityLegacyAttempts.projectId, this.projectId),
        eq(globalCapacityLegacyAttempts.id, input.attemptId),
        eq(globalCapacityLegacyAttempts.resourceKind, input.resourceKind),
        eq(globalCapacityLegacyAttempts.resourceId, input.resourceId),
        eq(globalCapacityLegacyAttempts.capacityFence, input.capacityFence),
      ))
      .limit(1);
    if (!rows[0]) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt does not match the durable project fence");
    }
    return storedAttemptFromRow(rows[0]);
  }

  private requireAcquireOperation(attempt: GlobalCapacityLegacyAttemptV1, observedOperationId: string): void {
    if (attempt.acquireOperationId !== observedOperationId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt acquire operation is stale");
    }
  }

  private requireReleaseOperation(attempt: GlobalCapacityLegacyAttemptV1, observedOperationId: string): void {
    if (attempt.releaseOperationId !== observedOperationId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt release operation is stale");
    }
  }

  private requireRenewOperation(attempt: GlobalCapacityLegacyAttemptV1, observedOperationId: string): void {
    if (attempt.renewOperationId !== observedOperationId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal operation is stale");
    }
  }

  private requireRenewableAttempt(attempt: GlobalCapacityLegacyAttemptV1): void {
    if (attempt.state !== "admitted" && attempt.state !== "work_started") {
      throw new GlobalCapacityLegacyAttemptPostgresError(
        `Global capacity legacy attempt cannot renew capacity from ${attempt.state}`,
      );
    }
  }

  private assertFreshOperationId(attempt: StoredGlobalCapacityLegacyAttemptV1, candidate: string): void {
    if (
      candidate === attempt.id
      || candidate === attempt.claimId
      || candidate === attempt.leaseId
      || candidate === attempt.acquireOperationId
      || candidate === attempt.renewOperationId
      || candidate === attempt.releaseOperationId
      || candidate === attempt.workStartReceiptId
    ) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt id factory reused an operation id");
    }
  }

  private requireExecutionReceipt(attempt: StoredGlobalCapacityLegacyAttemptV1, executionReceiptId: string): void {
    if (attempt.workStartReceiptId === null || attempt.workStartReceiptId !== executionReceiptId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt execution receipt is stale");
    }
  }

  private requireExecutionReceiptIfPresent(
    attempt: StoredGlobalCapacityLegacyAttemptV1,
    executionReceiptId: string | undefined,
  ): void {
    if (attempt.workStartReceiptId === null) {
      if (executionReceiptId !== undefined) {
        throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt has no execution receipt");
      }
      return;
    }
    if (!canonicalString(executionReceiptId) || attempt.workStartReceiptId !== executionReceiptId) {
      throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt execution receipt is stale");
    }
  }
}

async function latestAttemptForResource(
  tx: DbTransaction,
  projectId: string,
  resourceKind: GlobalCapacityLegacyAttemptResourceKindV1,
  resourceId: string,
): Promise<(typeof globalCapacityLegacyAttempts.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(globalCapacityLegacyAttempts)
    .where(and(
      eq(globalCapacityLegacyAttempts.projectId, projectId),
      eq(globalCapacityLegacyAttempts.resourceKind, resourceKind),
      eq(globalCapacityLegacyAttempts.resourceId, resourceId),
    ))
    .orderBy(desc(globalCapacityLegacyAttempts.capacityFence))
    .limit(1);
  return rows[0] ?? null;
}

interface StoredGlobalCapacityRenewalOperationV1 {
  readonly action: string;
  readonly claimId: string | null;
  readonly fence: number | null;
}

async function renewalOperationForAttempt(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
): Promise<StoredGlobalCapacityRenewalOperationV1 | null> {
  const rows = await tx
    .select({
      action: globalCapacityOperations.action,
      claimId: globalCapacityOperations.claimId,
      fence: globalCapacityOperations.fence,
    })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "renew"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

function isExactRenewalOperation(
  operation: StoredGlobalCapacityRenewalOperationV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return operation.action === "renewed"
    && operation.claimId === attempt.claimId
    && operation.fence === attempt.capacityFence;
}

async function recoveryFindingForWorkStarted(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  asOf: string,
): Promise<GlobalCapacityLegacyAttemptRecoveryFindingV1> {
  const currentRenewal = await renewalOperationForAttempt(tx, attempt, attempt.renewOperationId);
  if (currentRenewal) {
    if (currentRenewal.action === "rejected") return "renewal_lost";
    return isExactRenewalOperation(currentRenewal, attempt) ? "work_started" : "unresolved";
  }

  if (attempt.lastRenewalOperationId !== null) {
    const priorRenewal = await renewalOperationForAttempt(tx, attempt, attempt.lastRenewalOperationId);
    if (!priorRenewal) return "unresolved";
    if (priorRenewal.action === "rejected") return "renewal_lost";
    if (!isExactRenewalOperation(priorRenewal, attempt)) return "unresolved";
  }

  return isExpired(attempt, asOf) ? "unresolved" : "work_started";
}

async function nextCapacityFence(
  tx: DbTransaction,
  projectId: string,
  resourceKind: GlobalCapacityLegacyAttemptResourceKindV1,
  resourceId: string,
): Promise<number> {
  const latest = await latestAttemptForResource(tx, projectId, resourceKind, resourceId);
  const previousFence = latest ? storedAttemptFromRow(latest).capacityFence : 0;
  if (previousFence >= Number.MAX_SAFE_INTEGER) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt fence overflowed");
  }
  return previousFence + 1;
}

async function supersedeAttempt(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  supersededAt: string,
): Promise<void> {
  const updated = await tx
    .update(globalCapacityLegacyAttempts)
    .set({ state: "superseded", supersededAt, updatedAt: supersededAt })
    .where(and(
      eq(globalCapacityLegacyAttempts.projectId, attempt.projectId),
      eq(globalCapacityLegacyAttempts.id, attempt.id),
      eq(globalCapacityLegacyAttempts.capacityFence, attempt.capacityFence),
      eq(globalCapacityLegacyAttempts.state, attempt.state),
    ))
    .returning({ id: globalCapacityLegacyAttempts.id });
  if (!updated[0]) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt changed before it could be superseded");
  }
}

/**
 * The attempt receipt is not a substitute for global capacity. Admission is
 * legal only when the exact persisted acquire operation and still-live claim
 * agree on every resource/lease/fence dimension. This query runs while the
 * same global ledger advisory lock is held, so a policy mutation or expiry
 * cleanup cannot interleave between verification and the admission receipt.
 */
async function assertDurableLedgerAdmission(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
  asOf: string,
): Promise<void> {
  const operationRows = await tx
    .select({
      action: globalCapacityOperations.action,
      claimId: globalCapacityOperations.claimId,
      fence: globalCapacityOperations.fence,
    })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "acquire"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  const operation = operationRows[0];
  if (
    !operation
    || operation.action !== "acquired"
    || operation.claimId !== attempt.claimId
    || operation.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt admission lacks its durable acquire receipt");
  }
  const claimRows = await tx
    .select()
    .from(globalCapacityClaims)
    .where(and(
      eq(globalCapacityClaims.projectId, attempt.projectId),
      eq(globalCapacityClaims.id, attempt.claimId),
    ))
    .limit(1);
  const claim = claimRows[0];
  if (
    !claim
    || claim.releasedAt !== null
    || !canonicalTimestamp(claim.expiresAt)
    || Date.parse(claim.expiresAt) <= Date.parse(asOf)
    || claim.resourceKind !== attempt.resourceKind
    || claim.resourceId !== attempt.resourceId
    || claim.workClass !== attempt.workClass
    || claim.slots !== attempt.slots
    || claim.holderId !== attempt.holderId
    || claim.leaseId !== attempt.leaseId
    || claim.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt admission claim is missing or no longer live");
  }
}

// FNXC:GlobalCapacityLegacyAttempt 2026-07-20-05:12:
// A local "withheld" transition must name a persisted ledger result. Otherwise
// an unsubmitted acquire id could be rotated away and leave an orphaned future
// acquire/replay path outside the attempt's durable fence.
async function assertDurableLedgerWithheld(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
): Promise<void> {
  const operationRows = await tx
    .select({
      action: globalCapacityOperations.action,
      claimId: globalCapacityOperations.claimId,
      fence: globalCapacityOperations.fence,
    })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "acquire"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  const operation = operationRows[0];
  if (
    !operation
    || operation.action !== "held"
    || operation.claimId !== null
    || operation.fence !== null
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt withheld response lacks its durable ledger receipt");
  }
}

async function assertDurableLedgerRenewal(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
  asOf: string,
): Promise<string> {
  const operationRows = await tx
    .select({
      action: globalCapacityOperations.action,
      claimId: globalCapacityOperations.claimId,
      fence: globalCapacityOperations.fence,
    })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "renew"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  const operation = operationRows[0];
  if (
    !operation
    || operation.action !== "renewed"
    || operation.claimId !== attempt.claimId
    || operation.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal lacks its durable ledger receipt");
  }
  const claim = await requireLiveLedgerClaim(tx, attempt, asOf, "renewal");
  return claim.expiresAt;
}

// FNXC:GlobalCapacityLegacyAttempt 2026-07-20-05:06:
// Releasing the attempt without the exact ledger receipt would free its
// resource fence while an old worker could still be running. Treat the
// ledger's released operation and matching released claim as one boundary.
async function assertDurableLedgerRelease(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
): Promise<void> {
  const operationRows = await tx
    .select({
      action: globalCapacityOperations.action,
      claimId: globalCapacityOperations.claimId,
      fence: globalCapacityOperations.fence,
    })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "release"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  const operation = operationRows[0];
  if (
    !operation
    || operation.action !== "released"
    || operation.claimId !== attempt.claimId
    || operation.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt release lacks its durable ledger receipt");
  }
  const claimRows = await tx
    .select()
    .from(globalCapacityClaims)
    .where(and(
      eq(globalCapacityClaims.projectId, attempt.projectId),
      eq(globalCapacityClaims.id, attempt.claimId),
    ))
    .limit(1);
  const claim = claimRows[0];
  if (
    !claim
    || claim.releasedAt === null
    || claim.resourceKind !== attempt.resourceKind
    || claim.resourceId !== attempt.resourceId
    || claim.workClass !== attempt.workClass
    || claim.slots !== attempt.slots
    || claim.holderId !== attempt.holderId
    || claim.leaseId !== attempt.leaseId
    || claim.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt release claim is missing or does not match its durable receipt");
  }
}

async function assertDurableNonRenewal(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  operationId: string,
): Promise<void> {
  const operationRows = await tx
    .select({ action: globalCapacityOperations.action })
    .from(globalCapacityOperations)
    .where(and(
      eq(globalCapacityOperations.projectId, attempt.projectId),
      eq(globalCapacityOperations.commandKind, "renew"),
      eq(globalCapacityOperations.operationId, operationId),
    ))
    .limit(1);
  const operation = operationRows[0];
  if (!operation) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal outcome is not durable yet");
  }
  if (operation.action === "renewed") {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt renewal already succeeded and must be recorded");
  }
}

async function requireLiveLedgerClaim(
  tx: DbTransaction,
  attempt: GlobalCapacityLegacyAttemptV1,
  asOf: string,
  purpose: "admission" | "renewal",
): Promise<typeof globalCapacityClaims.$inferSelect> {
  const claimRows = await tx
    .select()
    .from(globalCapacityClaims)
    .where(and(
      eq(globalCapacityClaims.projectId, attempt.projectId),
      eq(globalCapacityClaims.id, attempt.claimId),
    ))
    .limit(1);
  const claim = claimRows[0];
  if (
    !claim
    || claim.releasedAt !== null
    || !canonicalTimestamp(claim.expiresAt)
    || Date.parse(claim.expiresAt) <= Date.parse(asOf)
    || claim.resourceKind !== attempt.resourceKind
    || claim.resourceId !== attempt.resourceId
    || claim.workClass !== attempt.workClass
    || claim.slots !== attempt.slots
    || claim.holderId !== attempt.holderId
    || claim.leaseId !== attempt.leaseId
    || claim.fence !== attempt.capacityFence
  ) {
    throw new GlobalCapacityLegacyAttemptPostgresError(`Global capacity legacy attempt ${purpose} claim is missing or no longer live`);
  }
  return claim;
}

async function assertCentralPolicyMatches(
  tx: DbTransaction,
  expectedPolicy: GlobalCapacityLedgerPolicyV1,
): Promise<void> {
  const authorityRows = await tx
    .select({ policyJson: globalCapacityPolicyAuthority.policyJson, policyHash: globalCapacityPolicyAuthority.policyHash })
    .from(globalCapacityPolicyAuthority)
    .where(eq(globalCapacityPolicyAuthority.id, GLOBAL_CAPACITY_POLICY_AUTHORITY_ID))
    .limit(1);
  const authority = authorityRows[0];
  if (!authority) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt requires an installed central policy authority");
  }
  const authorityPolicy = freezePolicy(authority.policyJson);
  const authorityHash = hashGlobalCapacityLedgerPolicy(authorityPolicy);
  const expectedHash = hashGlobalCapacityLedgerPolicy(expectedPolicy);
  if (authority.policyHash !== authorityHash || authorityHash !== expectedHash) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt policy no longer matches central authority");
  }
  const stateRows = await tx
    .select({ policyHash: globalCapacityState.policyHash })
    .from(globalCapacityState)
    .where(eq(globalCapacityState.id, GLOBAL_CAPACITY_LEDGER_STATE_ID))
    .limit(1);
  if (!stateRows[0] || stateRows[0].policyHash !== authorityHash) {
    throw new GlobalCapacityLegacyAttemptPostgresError("Global capacity legacy attempt policy does not match durable ledger state");
  }
}
