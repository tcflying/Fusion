import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptReferenceV1,
  type GlobalCapacityLegacyAttemptStoreV1,
  type GlobalCapacityLegacyAttemptV1,
  type GlobalCapacityWorkClassV1,
} from "@fusion/core";

export const GLOBAL_CAPACITY_LEGACY_RECOVERY_CONTRACT_VERSION = 1 as const;

/**
 * FNXC:GlobalCapacityLegacyRecovery 2026-07-20-05:48:
 * Core deliberately withholds work-start receipts from public attempt reads.
 * Recovery binds directly to Core's trusted recovery acknowledgement instead of
 * reconstructing a receipt; this isolated seam is not production crash closure.
 */
export type GlobalCapacityLegacyRecoveryAttemptStoreV1 = Pick<
  GlobalCapacityLegacyAttemptStoreV1,
  "read" | "recordRecoveredWorkFinishedRelease"
>;

export type GlobalCapacityLegacyRecoveryLedgerPortV1 = Pick<
  GlobalCapacityLedgerPostgresPortsV1,
  "release"
>;

export interface CreateGlobalCapacityLegacyRecoveryCoordinatorInputV1 {
  readonly projectId: string;
  readonly store: GlobalCapacityLegacyRecoveryAttemptStoreV1;
  readonly ledger: GlobalCapacityLegacyRecoveryLedgerPortV1;
  readonly now: () => string;
}

export interface GlobalCapacityLegacyRecoveryRequestV1 {
  readonly prepareInput: GlobalCapacityLegacyAttemptPrepareInputV1;
  readonly attempt: GlobalCapacityLegacyAttemptReferenceV1;
}

export type GlobalCapacityLegacyRecoveryRetryReasonV1 =
  | "pre_start_not_started"
  | "ledger_held"
  | "admitted_without_work_start"
  | "pre_start_superseded";

export type GlobalCapacityLegacyRecoveryParkReasonV1 =
  | "invalid_identity"
  | "attempt_read_failed"
  | "attempt_not_found"
  | "identity_mismatch"
  | "work_started"
  | "unrecognized_state";

export type GlobalCapacityLegacyRecoveryResultV1 =
  | {
      readonly state: "released";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly release: GlobalCapacityLedgerMutationResultV1 | null;
      readonly replayed: boolean;
    }
  | {
      readonly state: "retryable";
      readonly reason: GlobalCapacityLegacyRecoveryRetryReasonV1;
      readonly attempt: GlobalCapacityLegacyAttemptV1;
    }
  | {
      readonly state: "reconciliation_required";
      readonly action: "park";
      readonly reason: GlobalCapacityLegacyRecoveryParkReasonV1;
      readonly attempt?: GlobalCapacityLegacyAttemptV1;
    }
  | {
      readonly state: "unresolved";
      readonly phase: "release" | "release_persistence";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly release?: GlobalCapacityLedgerMutationResultV1;
    };

export interface GlobalCapacityLegacyRecoveryCoordinatorV1 {
  recover(request: GlobalCapacityLegacyRecoveryRequestV1): Promise<GlobalCapacityLegacyRecoveryResultV1>;
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function canonicalTimestamp(value: unknown): value is string {
  return canonicalString(value) && Number.isFinite(Date.parse(value));
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validWorkClass(value: unknown): value is GlobalCapacityWorkClassV1 {
  return value === "normal" || value === "verifier" || value === "recovery";
}

function validPrepareInput(value: unknown): value is GlobalCapacityLegacyAttemptPrepareInputV1 {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<GlobalCapacityLegacyAttemptPrepareInputV1>;
  return input.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && (input.resourceKind === "legacy_task" || input.resourceKind === "legacy_triage")
    && canonicalString(input.resourceId)
    && validWorkClass(input.workClass)
    && positiveSafeInteger(input.slots)
    && canonicalString(input.holderId);
}

function validReference(value: unknown): value is GlobalCapacityLegacyAttemptReferenceV1 {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<GlobalCapacityLegacyAttemptReferenceV1>;
  return reference.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && canonicalString(reference.attemptId)
    && (reference.resourceKind === "legacy_task" || reference.resourceKind === "legacy_triage")
    && canonicalString(reference.resourceId)
    && positiveSafeInteger(reference.capacityFence);
}

function recoveryRequired(
  reason: GlobalCapacityLegacyRecoveryParkReasonV1,
  attempt?: GlobalCapacityLegacyAttemptV1,
): Extract<GlobalCapacityLegacyRecoveryResultV1, { state: "reconciliation_required" }> {
  return attempt
    ? { state: "reconciliation_required", action: "park", reason, attempt }
    : { state: "reconciliation_required", action: "park", reason };
}

function referenceOf(attempt: GlobalCapacityLegacyAttemptV1): GlobalCapacityLegacyAttemptReferenceV1 {
  return {
    contractVersion: attempt.contractVersion,
    attemptId: attempt.id,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    capacityFence: attempt.capacityFence,
  };
}

function matchesIdentity(
  projectId: string,
  request: GlobalCapacityLegacyRecoveryRequestV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return attempt.contractVersion === GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION
    && attempt.projectId === projectId
    && attempt.id === request.attempt.attemptId
    && attempt.resourceKind === request.attempt.resourceKind
    && attempt.resourceId === request.attempt.resourceId
    && attempt.capacityFence === request.attempt.capacityFence
    && attempt.resourceKind === request.prepareInput.resourceKind
    && attempt.resourceId === request.prepareInput.resourceId
    && attempt.workClass === request.prepareInput.workClass
    && attempt.slots === request.prepareInput.slots
    && attempt.holderId === request.prepareInput.holderId;
}

function exactReleased(
  release: GlobalCapacityLedgerMutationResultV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return release.action === "released"
    && release.claimId === attempt.claimId
    && release.fence === attempt.capacityFence;
}

function retryable(
  attempt: GlobalCapacityLegacyAttemptV1,
  reason: GlobalCapacityLegacyRecoveryRetryReasonV1,
): Extract<GlobalCapacityLegacyRecoveryResultV1, { state: "retryable" }> {
  return { state: "retryable", reason, attempt };
}

/**
 * FNXC:GlobalCapacityLegacyRecovery 2026-07-20-05:48:
 * Legacy crash recovery must never start external executor or triage work, nor
 * automatically rerun an attempt. It reads the caller-selected durable fence,
 * parks every uncertain/work_started state, and only replays the exact persisted
 * release operation after work_finished. Private receipt validation stays inside
 * Core; this coordinator alone does not claim runtime or production crash closure.
 */
export function createGlobalCapacityLegacyRecoveryCoordinator(
  input: CreateGlobalCapacityLegacyRecoveryCoordinatorInputV1,
): GlobalCapacityLegacyRecoveryCoordinatorV1 {
  if (
    !canonicalString(input.projectId)
    || !input.store
    || typeof input.store.read !== "function"
    || typeof input.store.recordRecoveredWorkFinishedRelease !== "function"
    || !input.ledger
    || typeof input.ledger.release !== "function"
    || typeof input.now !== "function"
  ) {
    throw new Error("Global capacity legacy recovery requires project-scoped durable release ports and a clock");
  }

  return Object.freeze({
    async recover(request: GlobalCapacityLegacyRecoveryRequestV1): Promise<GlobalCapacityLegacyRecoveryResultV1> {
      if (!validPrepareInput(request.prepareInput) || !validReference(request.attempt)) {
        return recoveryRequired("invalid_identity");
      }

      let attempt: GlobalCapacityLegacyAttemptV1 | null;
      try {
        attempt = await input.store.read(request.attempt);
      } catch {
        return recoveryRequired("attempt_read_failed");
      }
      if (!attempt) return recoveryRequired("attempt_not_found");
      if (!matchesIdentity(input.projectId, request, attempt)) {
        return recoveryRequired("identity_mismatch", attempt);
      }

      switch (attempt.state) {
        case "released":
          return { state: "released", attempt, release: null, replayed: false };
        case "prepared":
          return retryable(attempt, "pre_start_not_started");
        case "withheld":
          return retryable(attempt, "ledger_held");
        case "admitted":
          return retryable(attempt, "admitted_without_work_start");
        case "superseded":
          return retryable(attempt, "pre_start_superseded");
        case "work_started":
          return recoveryRequired("work_started", attempt);
        case "work_finished":
          break;
        default:
          return recoveryRequired("unrecognized_state", attempt);
      }

      let asOf: string;
      try {
        asOf = input.now();
      } catch {
        return { state: "unresolved", phase: "release", attempt };
      }
      if (!canonicalTimestamp(asOf)) return { state: "unresolved", phase: "release", attempt };

      let release: GlobalCapacityLedgerMutationResultV1;
      try {
        release = await input.ledger.release({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId: attempt.projectId,
          resourceKind: attempt.resourceKind,
          resourceId: attempt.resourceId,
          claimId: attempt.claimId,
          operationId: attempt.releaseOperationId,
          holderId: attempt.holderId,
          leaseId: attempt.leaseId,
          fence: attempt.capacityFence,
          asOf,
        });
      } catch {
        return { state: "unresolved", phase: "release", attempt };
      }
      if (!exactReleased(release, attempt)) {
        return { state: "unresolved", phase: "release", attempt, release };
      }

      let released: GlobalCapacityLegacyAttemptV1;
      try {
        released = await input.store.recordRecoveredWorkFinishedRelease({
          ...referenceOf(attempt),
          observedReleaseOperationId: attempt.releaseOperationId,
        });
      } catch {
        return { state: "unresolved", phase: "release_persistence", attempt, release };
      }
      if (
        released.state !== "released"
        || released.id !== attempt.id
        || released.projectId !== attempt.projectId
        || released.resourceKind !== attempt.resourceKind
        || released.resourceId !== attempt.resourceId
        || released.capacityFence !== attempt.capacityFence
      ) {
        return { state: "unresolved", phase: "release_persistence", attempt, release };
      }
      return { state: "released", attempt: released, release, replayed: true };
    },
  });
}
