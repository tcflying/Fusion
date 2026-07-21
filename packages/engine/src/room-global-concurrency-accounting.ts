export const ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION = 1 as const;

export type RoomGlobalConcurrencyWorkClassV1 = "normal" | "verifier" | "recovery";

export type RoomGlobalConcurrencyAccountingActionV1 = "acquired" | "renewed" | "released" | "held" | "rejected";

export type RoomGlobalConcurrencyAccountingReasonV1 =
  | "capacity_admitted"
  | "capacity_policy_unavailable"
  | "capacity_stale"
  | "capacity_unknown"
  | "claim_expired"
  | "claim_not_found"
  | "claim_conflict"
  | "claim_scope_mismatch"
  | "global_capacity_exhausted"
  | "invalid_request"
  | "invalid_snapshot"
  | "legacy_task_triage_reserve_protected"
  | "legacy_room_migration_pending"
  | "idempotency_conflict"
  | "policy_mismatch"
  | "project_isolation"
  | "reserved_capacity_protected"
  | "renewal_regression"
  | "snapshot_unavailable"
  | "stale_fence"
  | "store_failure"
  | "store_rejected";

export interface RoomGlobalConcurrencyReservationsV1 {
  readonly verifierSlots: number;
  readonly recoverySlots: number;
  readonly legacyTaskTriageSlots: number;
}

export interface RoomGlobalConcurrencyLegacySnapshotV1 {
  readonly activeTaskSlots: number;
  readonly activeTriageSlots: number;
  readonly queuedTaskSlots: number;
  readonly queuedTriageSlots: number;
}

export interface RoomGlobalConcurrencyClaimV1 {
  readonly claimId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface RoomGlobalConcurrencySnapshotV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly totalSlots: number | null;
  readonly reservations: RoomGlobalConcurrencyReservationsV1;
  readonly legacy: RoomGlobalConcurrencyLegacySnapshotV1;
  readonly roomClaims: readonly RoomGlobalConcurrencyClaimV1[];
}

export interface RoomGlobalConcurrencySnapshotReadInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
}

export interface RoomGlobalConcurrencySnapshotPortV1 {
  readSnapshot(input: RoomGlobalConcurrencySnapshotReadInputV1): Promise<RoomGlobalConcurrencySnapshotV1>;
}

export interface RoomGlobalConcurrencyAcquireInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface RoomGlobalConcurrencyReleaseInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
}

export interface RoomGlobalConcurrencyRenewInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface RecoverDanglingRoomGlobalConcurrencyClaimsInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly recoveryOperationId: string;
  readonly recovererId: string;
  readonly asOf: string;
}

export interface RoomGlobalConcurrencyBudgetV1 {
  readonly totalSlots: number;
  readonly occupiedSlots: number;
  readonly legacyTaskTriageActiveSlots: number;
  readonly roomActiveSlots: number;
  readonly normalOccupiedSlots: number;
  readonly verifierOccupiedSlots: number;
  readonly recoveryOccupiedSlots: number;
  readonly protectedLegacyTaskTriageSlots: number;
  readonly normalLimitSlots: number;
  readonly verifierLimitSlots: number;
  readonly recoveryLimitSlots: number;
  readonly requestedWorkClass: RoomGlobalConcurrencyWorkClassV1;
  readonly requestedSlots: number;
}

interface RoomGlobalConcurrencyStoreCommandBaseV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION;
  readonly expectedSnapshotId: string;
  readonly claimId: string;
  readonly fence: number;
}

export interface RoomGlobalConcurrencyAcquireStoreCommandV1 extends RoomGlobalConcurrencyStoreCommandBaseV1 {
  readonly kind: "acquire";
  readonly request: RoomGlobalConcurrencyAcquireInputV1;
  readonly budget: RoomGlobalConcurrencyBudgetV1;
}

export interface RoomGlobalConcurrencyReleaseStoreCommandV1 extends RoomGlobalConcurrencyStoreCommandBaseV1 {
  readonly kind: "release";
  readonly request: RoomGlobalConcurrencyReleaseInputV1;
  readonly claim: RoomGlobalConcurrencyClaimV1 | null;
}

export interface RoomGlobalConcurrencyRenewStoreCommandV1 extends RoomGlobalConcurrencyStoreCommandBaseV1 {
  readonly kind: "renew";
  readonly request: RoomGlobalConcurrencyRenewInputV1;
  readonly claim: RoomGlobalConcurrencyClaimV1;
}

export interface RoomGlobalConcurrencyRecoverDanglingStoreCommandV1 extends RoomGlobalConcurrencyStoreCommandBaseV1 {
  readonly kind: "recover_dangling";
  readonly projectId: string;
  readonly recoveryOperationId: string;
  readonly recovererId: string;
  readonly asOf: string;
  readonly claim: RoomGlobalConcurrencyClaimV1;
}

export type RoomGlobalConcurrencyClaimStoreCommandV1 =
  | RoomGlobalConcurrencyAcquireStoreCommandV1
  | RoomGlobalConcurrencyRenewStoreCommandV1
  | RoomGlobalConcurrencyReleaseStoreCommandV1
  | RoomGlobalConcurrencyRecoverDanglingStoreCommandV1;

export type RoomGlobalConcurrencyClaimStoreResultV1 =
  | {
      readonly ok: true;
      readonly action: "acquired" | "renewed" | "released" | "recovered";
      readonly replayed: boolean;
      readonly claimId: string;
      readonly fence: number;
    }
  | {
      readonly ok: false;
      readonly reason: "claim_not_found" | "claim_expired" | "idempotency_conflict" | "renewal_regression" | "snapshot_stale" | "stale_fence" | "store_rejected";
    };

export interface RoomGlobalConcurrencyClaimStorePortV1 {
  apply(command: RoomGlobalConcurrencyClaimStoreCommandV1): Promise<RoomGlobalConcurrencyClaimStoreResultV1>;
}

export interface RoomGlobalConcurrencyAccountingPortsV1 {
  readonly snapshotPort: RoomGlobalConcurrencySnapshotPortV1;
  readonly claimStore: RoomGlobalConcurrencyClaimStorePortV1;
}

export interface RoomGlobalConcurrencyMutationResultV1 {
  readonly action: RoomGlobalConcurrencyAccountingActionV1;
  readonly reason: RoomGlobalConcurrencyAccountingReasonV1;
  readonly replayed: boolean;
  readonly claimId: string | null;
  readonly fence: number | null;
}

export interface RecoverDanglingRoomGlobalConcurrencyClaimsResultV1 {
  readonly action: "recovered" | "held";
  readonly recoveredClaimIds: readonly string[];
  readonly replayedClaimIds: readonly string[];
  readonly rejected: readonly { readonly claimId: string; readonly reason: RoomGlobalConcurrencyAccountingReasonV1 }[];
}

interface ValidSnapshotV1 {
  readonly snapshot: RoomGlobalConcurrencySnapshotV1;
  readonly stale: boolean;
  readonly budget: Omit<RoomGlobalConcurrencyBudgetV1, "requestedWorkClass" | "requestedSlots">;
}

const WORK_CLASSES = new Set<RoomGlobalConcurrencyWorkClassV1>(["normal", "verifier", "recovery"]);

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

function laterThan(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function activeSlots(claims: readonly RoomGlobalConcurrencyClaimV1[]): number {
  return claims.reduce((total, current) => total + current.slots, 0);
}

function slotsForWorkClass(
  claims: readonly RoomGlobalConcurrencyClaimV1[],
  workClass: RoomGlobalConcurrencyWorkClassV1,
): number {
  return claims.filter((claim) => claim.workClass === workClass).reduce((total, claim) => total + claim.slots, 0);
}

function mutation(
  action: RoomGlobalConcurrencyAccountingActionV1,
  reason: RoomGlobalConcurrencyAccountingReasonV1,
  replayed = false,
  claimId: string | null = null,
  fence: number | null = null,
): RoomGlobalConcurrencyMutationResultV1 {
  return Object.freeze({ action, reason, replayed, claimId, fence });
}

function hasValidClaim(value: unknown): value is RoomGlobalConcurrencyClaimV1 {
  if (!isRecord(value)) return false;
  return canonicalString(value.claimId)
    && canonicalString(value.projectId)
    && canonicalString(value.roomId)
    && typeof value.workClass === "string"
    && WORK_CLASSES.has(value.workClass as RoomGlobalConcurrencyWorkClassV1)
    && positiveSafeInteger(value.slots)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.acquiredAt)
    && canonicalTimestamp(value.expiresAt)
    && laterThan(value.expiresAt, value.acquiredAt);
}

function inspectSnapshot(snapshot: unknown, asOf: string): { readonly ok: true; readonly value: ValidSnapshotV1 } | { readonly ok: false } {
  if (!isRecord(snapshot)) return { ok: false };
  if (snapshot.contractVersion !== ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION) return { ok: false };
  if (!canonicalString(snapshot.snapshotId) || !canonicalTimestamp(snapshot.observedAt) || !canonicalTimestamp(snapshot.expiresAt)) return { ok: false };
  if (!laterThan(snapshot.expiresAt, snapshot.observedAt)) return { ok: false };
  if (snapshot.totalSlots !== null && !nonNegativeSafeInteger(snapshot.totalSlots)) return { ok: false };
  if (!isRecord(snapshot.reservations) || !isRecord(snapshot.legacy) || !Array.isArray(snapshot.roomClaims)) return { ok: false };

  const reservations = snapshot.reservations;
  const legacy = snapshot.legacy;
  if (
    !nonNegativeSafeInteger(reservations.verifierSlots)
    || !nonNegativeSafeInteger(reservations.recoverySlots)
    || !nonNegativeSafeInteger(reservations.legacyTaskTriageSlots)
    || !nonNegativeSafeInteger(legacy.activeTaskSlots)
    || !nonNegativeSafeInteger(legacy.activeTriageSlots)
    || !nonNegativeSafeInteger(legacy.queuedTaskSlots)
    || !nonNegativeSafeInteger(legacy.queuedTriageSlots)
    || !snapshot.roomClaims.every(hasValidClaim)
  ) {
    return { ok: false };
  }

  const claimIds = new Set<string>();
  for (const roomClaim of snapshot.roomClaims) {
    if (claimIds.has(roomClaim.claimId)) return { ok: false };
    claimIds.add(roomClaim.claimId);
  }

  const legacyTaskTriageActiveSlots = legacy.activeTaskSlots + legacy.activeTriageSlots;
  const roomActiveSlots = activeSlots(snapshot.roomClaims);
  const verifierOccupiedSlots = slotsForWorkClass(snapshot.roomClaims, "verifier");
  const recoveryOccupiedSlots = slotsForWorkClass(snapshot.roomClaims, "recovery");
  const normalOccupiedSlots = legacyTaskTriageActiveSlots + slotsForWorkClass(snapshot.roomClaims, "normal");
  const occupiedSlots = legacyTaskTriageActiveSlots + roomActiveSlots;
  const protectedLegacyTaskTriageSlots = Math.max(0, reservations.legacyTaskTriageSlots - legacyTaskTriageActiveSlots);

  if (snapshot.totalSlots !== null) {
    if (reservations.verifierSlots + reservations.recoverySlots + reservations.legacyTaskTriageSlots > snapshot.totalSlots) return { ok: false };
    if (occupiedSlots > snapshot.totalSlots) return { ok: false };
  }

  const totalSlots = snapshot.totalSlots ?? 0;
  const normalLimitSlots = Math.max(
    0,
    totalSlots - reservations.verifierSlots - reservations.recoverySlots - protectedLegacyTaskTriageSlots,
  );
  const verifierLimitSlots = Math.max(
    0,
    totalSlots - Math.max(0, reservations.recoverySlots - recoveryOccupiedSlots) - protectedLegacyTaskTriageSlots,
  );
  const recoveryLimitSlots = Math.max(
    0,
    totalSlots - Math.max(0, reservations.verifierSlots - verifierOccupiedSlots) - protectedLegacyTaskTriageSlots,
  );

  return {
    ok: true,
    value: {
      snapshot: snapshot as unknown as RoomGlobalConcurrencySnapshotV1,
      stale: Date.parse(asOf) > Date.parse(snapshot.expiresAt),
      budget: Object.freeze({
        totalSlots,
        occupiedSlots,
        legacyTaskTriageActiveSlots,
        roomActiveSlots,
        normalOccupiedSlots,
        verifierOccupiedSlots,
        recoveryOccupiedSlots,
        protectedLegacyTaskTriageSlots,
        normalLimitSlots,
        verifierLimitSlots,
        recoveryLimitSlots,
      }),
    },
  };
}

function validateAcquireInput(input: unknown): input is RoomGlobalConcurrencyAcquireInputV1 {
  if (!isRecord(input)) return false;
  return input.contractVersion === ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION
    && canonicalString(input.projectId)
    && canonicalString(input.roomId)
    && canonicalString(input.claimId)
    && canonicalString(input.operationId)
    && typeof input.workClass === "string"
    && WORK_CLASSES.has(input.workClass as RoomGlobalConcurrencyWorkClassV1)
    && positiveSafeInteger(input.slots)
    && canonicalString(input.holderId)
    && canonicalString(input.leaseId)
    && positiveSafeInteger(input.fence)
    && canonicalTimestamp(input.asOf)
    && canonicalTimestamp(input.expiresAt)
    && laterThan(input.expiresAt, input.asOf);
}

function validateReleaseInput(input: unknown): input is RoomGlobalConcurrencyReleaseInputV1 {
  if (!isRecord(input)) return false;
  return input.contractVersion === ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION
    && canonicalString(input.projectId)
    && canonicalString(input.roomId)
    && canonicalString(input.claimId)
    && canonicalString(input.operationId)
    && canonicalString(input.holderId)
    && canonicalString(input.leaseId)
    && positiveSafeInteger(input.fence)
    && canonicalTimestamp(input.asOf);
}

function validateRenewInput(input: unknown): input is RoomGlobalConcurrencyRenewInputV1 {
  if (!isRecord(input)) return false;
  return input.contractVersion === ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION
    && canonicalString(input.projectId)
    && canonicalString(input.roomId)
    && canonicalString(input.claimId)
    && canonicalString(input.operationId)
    && canonicalString(input.holderId)
    && canonicalString(input.leaseId)
    && positiveSafeInteger(input.fence)
    && canonicalTimestamp(input.asOf)
    && canonicalTimestamp(input.expiresAt)
    && laterThan(input.expiresAt, input.asOf);
}

function validateRecoveryInput(input: unknown): input is RecoverDanglingRoomGlobalConcurrencyClaimsInputV1 {
  if (!isRecord(input)) return false;
  return input.contractVersion === ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION
    && canonicalString(input.projectId)
    && canonicalString(input.recoveryOperationId)
    && canonicalString(input.recovererId)
    && canonicalTimestamp(input.asOf);
}

function sameAcquireClaim(claim: RoomGlobalConcurrencyClaimV1, input: RoomGlobalConcurrencyAcquireInputV1): boolean {
  return claim.projectId === input.projectId
    && claim.roomId === input.roomId
    && claim.workClass === input.workClass
    && claim.slots === input.slots
    && claim.holderId === input.holderId
    && claim.leaseId === input.leaseId
    && claim.fence === input.fence
    && claim.expiresAt === input.expiresAt;
}

function sameRenewClaim(claim: RoomGlobalConcurrencyClaimV1, input: RoomGlobalConcurrencyRenewInputV1): boolean {
  return claim.holderId === input.holderId
    && claim.leaseId === input.leaseId
    && claim.fence === input.fence;
}

function capacityReason(
  budget: Omit<RoomGlobalConcurrencyBudgetV1, "requestedWorkClass" | "requestedSlots">,
  workClass: RoomGlobalConcurrencyWorkClassV1,
  slots: number,
): RoomGlobalConcurrencyAccountingReasonV1 | null {
  if (budget.occupiedSlots + slots > budget.totalSlots) return "global_capacity_exhausted";
  if (workClass === "normal") {
    if (budget.normalOccupiedSlots + slots <= budget.normalLimitSlots) return null;
    return budget.protectedLegacyTaskTriageSlots > 0
      ? "legacy_task_triage_reserve_protected"
      : "reserved_capacity_protected";
  }
  if (workClass === "verifier") {
    if (budget.verifierOccupiedSlots + slots + budget.normalOccupiedSlots + budget.recoveryOccupiedSlots <= budget.verifierLimitSlots) return null;
  } else if (budget.recoveryOccupiedSlots + slots + budget.normalOccupiedSlots + budget.verifierOccupiedSlots <= budget.recoveryLimitSlots) {
    return null;
  }
  return budget.protectedLegacyTaskTriageSlots > 0
    ? "legacy_task_triage_reserve_protected"
    : "reserved_capacity_protected";
}

function storeFailureResult(
  action: "held" | "rejected",
  result: RoomGlobalConcurrencyClaimStoreResultV1,
): RoomGlobalConcurrencyMutationResultV1 {
  if (result.ok) return mutation(action, "store_rejected");
  if (result.reason === "stale_fence") return mutation(action, "stale_fence");
  if (result.reason === "claim_expired") return mutation(action, "claim_expired");
  if (result.reason === "renewal_regression") return mutation(action, "renewal_regression");
  return mutation(action, "store_rejected");
}

function isMatchingStoreSuccess(
  result: RoomGlobalConcurrencyClaimStoreResultV1,
  action: "acquired" | "renewed" | "released" | "recovered",
  claimId: string,
  fence: number,
): result is Extract<RoomGlobalConcurrencyClaimStoreResultV1, { readonly ok: true }> {
  return result.ok && result.action === action && result.claimId === claimId && result.fence === fence;
}

export class RoomGlobalConcurrencyAccounting {
  public constructor(private readonly ports: RoomGlobalConcurrencyAccountingPortsV1) {}

  public async acquire(input: RoomGlobalConcurrencyAcquireInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (!validateAcquireInput(input)) return mutation("rejected", "invalid_request");

    let rawSnapshot: RoomGlobalConcurrencySnapshotV1;
    try {
      rawSnapshot = await this.ports.snapshotPort.readSnapshot({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: input.projectId,
        asOf: input.asOf,
      });
    } catch {
      return mutation("held", "snapshot_unavailable");
    }

    const inspected = inspectSnapshot(rawSnapshot, input.asOf);
    if (!inspected.ok) return mutation("held", "invalid_snapshot");
    if (inspected.value.stale) return mutation("held", "capacity_stale");
    if (inspected.value.snapshot.totalSlots === null) return mutation("held", "capacity_unknown");

    const existing = inspected.value.snapshot.roomClaims.find((claim) => claim.claimId === input.claimId);
    if (existing && !sameAcquireClaim(existing, input)) return mutation("rejected", "claim_conflict");

    const reason = capacityReason(inspected.value.budget, input.workClass, input.slots);
    if (reason !== null && !existing) return mutation("held", reason);

    const budget = Object.freeze({
      ...inspected.value.budget,
      requestedWorkClass: input.workClass,
      requestedSlots: input.slots,
    });
    const command: RoomGlobalConcurrencyAcquireStoreCommandV1 = Object.freeze({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      kind: "acquire",
      expectedSnapshotId: inspected.value.snapshot.snapshotId,
      claimId: input.claimId,
      fence: input.fence,
      request: Object.freeze({ ...input }),
      budget,
    });

    try {
      const result = await this.ports.claimStore.apply(command);
      if (!isMatchingStoreSuccess(result, "acquired", input.claimId, input.fence)) return storeFailureResult("held", result);
      return mutation("acquired", "capacity_admitted", result.replayed, result.claimId, result.fence);
    } catch {
      return mutation("held", "store_failure");
    }
  }

  public async release(input: RoomGlobalConcurrencyReleaseInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (!validateReleaseInput(input)) return mutation("rejected", "invalid_request");

    let rawSnapshot: RoomGlobalConcurrencySnapshotV1;
    try {
      rawSnapshot = await this.ports.snapshotPort.readSnapshot({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: input.projectId,
        asOf: input.asOf,
      });
    } catch {
      return mutation("rejected", "snapshot_unavailable");
    }

    const inspected = inspectSnapshot(rawSnapshot, input.asOf);
    if (!inspected.ok) return mutation("rejected", "invalid_snapshot");
    const existing = inspected.value.snapshot.roomClaims.find((claim) => claim.claimId === input.claimId) ?? null;
    if (existing?.projectId !== undefined && existing.projectId !== input.projectId) return mutation("rejected", "project_isolation");
    if (existing && existing.roomId !== input.roomId) return mutation("rejected", "claim_scope_mismatch");
    if (
      existing
      && (existing.holderId !== input.holderId || existing.leaseId !== input.leaseId || existing.fence !== input.fence)
    ) {
      return mutation("rejected", "stale_fence");
    }

    const command: RoomGlobalConcurrencyReleaseStoreCommandV1 = Object.freeze({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      kind: "release",
      expectedSnapshotId: inspected.value.snapshot.snapshotId,
      claimId: input.claimId,
      fence: input.fence,
      request: Object.freeze({ ...input }),
      claim: existing,
    });
    try {
      const result = await this.ports.claimStore.apply(command);
      if (!isMatchingStoreSuccess(result, "released", input.claimId, input.fence)) return storeFailureResult("rejected", result);
      return mutation("released", "capacity_admitted", result.replayed, result.claimId, result.fence);
    } catch {
      return mutation("rejected", "store_failure");
    }
  }

  /*
  FNXC:RoomGlobalConcurrencyRenewal 2026-07-19-18:43:
  A worker lease renewal remains insufficient authority while its active global
  capacity claim retains an older expiry. Renew only the same project, Room,
  holder, lease, and fence; an old request may replay but can never shorten a
  claim that a newer worker renewal already extended.
  */
  public async renew(input: RoomGlobalConcurrencyRenewInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (!validateRenewInput(input)) return mutation("rejected", "invalid_request");

    let rawSnapshot: RoomGlobalConcurrencySnapshotV1;
    try {
      rawSnapshot = await this.ports.snapshotPort.readSnapshot({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: input.projectId,
        asOf: input.asOf,
      });
    } catch {
      return mutation("held", "snapshot_unavailable");
    }

    const inspected = inspectSnapshot(rawSnapshot, input.asOf);
    if (!inspected.ok) return mutation("held", "invalid_snapshot");
    if (inspected.value.stale) return mutation("held", "capacity_stale");
    if (inspected.value.snapshot.totalSlots === null) return mutation("held", "capacity_unknown");

    const existing = inspected.value.snapshot.roomClaims.find((claim) => claim.claimId === input.claimId);
    if (!existing) return mutation("rejected", "claim_not_found");
    if (existing.projectId !== input.projectId) return mutation("rejected", "project_isolation");
    if (existing.roomId !== input.roomId) return mutation("rejected", "claim_scope_mismatch");
    if (!sameRenewClaim(existing, input)) return mutation("rejected", "stale_fence");
    if (laterThan(existing.expiresAt, input.expiresAt)) {
      return mutation("renewed", "capacity_admitted", true, existing.claimId, existing.fence);
    }

    const command: RoomGlobalConcurrencyRenewStoreCommandV1 = Object.freeze({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      kind: "renew",
      expectedSnapshotId: inspected.value.snapshot.snapshotId,
      claimId: input.claimId,
      fence: input.fence,
      request: Object.freeze({ ...input }),
      claim: existing,
    });
    try {
      const result = await this.ports.claimStore.apply(command);
      if (!isMatchingStoreSuccess(result, "renewed", input.claimId, input.fence)) return storeFailureResult("held", result);
      return mutation("renewed", "capacity_admitted", result.replayed, result.claimId, result.fence);
    } catch {
      return mutation("held", "store_failure");
    }
  }

  public async recoverDanglingClaims(
    input: RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
  ): Promise<RecoverDanglingRoomGlobalConcurrencyClaimsResultV1> {
    if (!validateRecoveryInput(input)) return this.recoveryHeld();

    let rawSnapshot: RoomGlobalConcurrencySnapshotV1;
    try {
      rawSnapshot = await this.ports.snapshotPort.readSnapshot({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: input.projectId,
        asOf: input.asOf,
      });
    } catch {
      return this.recoveryHeld();
    }

    const inspected = inspectSnapshot(rawSnapshot, input.asOf);
    if (!inspected.ok || inspected.value.stale) return this.recoveryHeld();

    const candidates = inspected.value.snapshot.roomClaims
      .filter((claim) => claim.projectId === input.projectId && Date.parse(claim.expiresAt) <= Date.parse(input.asOf))
      .sort((left, right) => left.claimId.localeCompare(right.claimId));
    const recoveredClaimIds: string[] = [];
    const replayedClaimIds: string[] = [];
    const rejected: { claimId: string; reason: RoomGlobalConcurrencyAccountingReasonV1 }[] = [];

    for (const current of candidates) {
      const command: RoomGlobalConcurrencyRecoverDanglingStoreCommandV1 = Object.freeze({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        kind: "recover_dangling",
        expectedSnapshotId: inspected.value.snapshot.snapshotId,
        claimId: current.claimId,
        fence: current.fence,
        projectId: input.projectId,
        recoveryOperationId: input.recoveryOperationId,
        recovererId: input.recovererId,
        asOf: input.asOf,
        claim: current,
      });
      try {
        const result = await this.ports.claimStore.apply(command);
        if (isMatchingStoreSuccess(result, "recovered", current.claimId, current.fence)) {
          recoveredClaimIds.push(result.claimId);
          if (result.replayed) replayedClaimIds.push(result.claimId);
          continue;
        }
        rejected.push({
          claimId: current.claimId,
          reason: !result.ok && result.reason === "stale_fence" ? "stale_fence" : "store_rejected",
        });
      } catch {
        rejected.push({ claimId: current.claimId, reason: "store_failure" });
      }
    }

    return Object.freeze({
      action: "recovered",
      recoveredClaimIds: Object.freeze(recoveredClaimIds),
      replayedClaimIds: Object.freeze(replayedClaimIds),
      rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry))),
    });
  }

  private recoveryHeld(): RecoverDanglingRoomGlobalConcurrencyClaimsResultV1 {
    return Object.freeze({
      action: "held",
      recoveredClaimIds: Object.freeze([]),
      replayedClaimIds: Object.freeze([]),
      rejected: Object.freeze([]),
    });
  }
}
