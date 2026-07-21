import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityWorkClassV1,
} from "@fusion/core";

export const GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION = 1 as const;

export type GlobalCapacityLegacyResourceKindV1 = "legacy_task" | "legacy_triage";

export interface GlobalCapacityLegacyLedgerPortV1 {
  acquire: GlobalCapacityLedgerPostgresPortsV1["acquire"];
  renew: GlobalCapacityLedgerPostgresPortsV1["renew"];
  release: GlobalCapacityLedgerPostgresPortsV1["release"];
}

/**
 * A trusted task/triage execution lease, not a task-id-only convenience key.
 * The host must persist these values with the execution attempt so a restart
 * cannot replay a different worker as the same capacity holder.
 */
export interface GlobalCapacityLegacyExecutionLeaseV1 {
  readonly projectId: string;
  readonly resourceKind: GlobalCapacityLegacyResourceKindV1;
  readonly resourceId: string;
  readonly claimId: string;
  readonly acquireOperationId: string;
  readonly releaseOperationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface GlobalCapacityLegacyAdmissionRequestV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION;
  readonly lease: GlobalCapacityLegacyExecutionLeaseV1;
}

export interface GlobalCapacityLegacyRenewalRequestV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION;
  readonly lease: Pick<
    GlobalCapacityLegacyExecutionLeaseV1,
    "projectId" | "resourceKind" | "resourceId" | "claimId" | "holderId" | "leaseId" | "fence"
  >;
  readonly operationId: string;
  readonly asOf: string;
  readonly expiresAt: string;
}

export type GlobalCapacityLegacyAdmissionRunResultV1<T> =
  | {
      readonly state: "withheld";
      readonly admission: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      /**
       * The ledger remembers a prior acquire, but this compatibility adapter
       * has no durable work-start receipt. Running again could duplicate an
       * external task/triage side effect, so a recovery owner must decide.
       */
      readonly state: "recovery_required";
      readonly admission: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "completed";
      readonly value: T;
      readonly admission: GlobalCapacityLedgerMutationResultV1;
      readonly release: GlobalCapacityLedgerMutationResultV1 | null;
      readonly cleanupState: "released" | "release_withheld" | "release_unavailable";
    };

export interface CreateGlobalCapacityLegacyAdmissionInputV1 {
  readonly projectId: string;
  readonly ports: GlobalCapacityLegacyLedgerPortV1;
  readonly now: () => string;
}

export interface GlobalCapacityLegacyAdmissionV1 {
  run<T>(
    request: GlobalCapacityLegacyAdmissionRequestV1,
    work: () => Promise<T>,
  ): Promise<GlobalCapacityLegacyAdmissionRunResultV1<T>>;
  renew(
    request: GlobalCapacityLegacyRenewalRequestV1,
  ): Promise<GlobalCapacityLedgerMutationResultV1>;
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  return canonicalString(value) && Number.isFinite(Date.parse(value));
}

function validWorkClass(value: unknown): value is GlobalCapacityWorkClassV1 {
  return value === "normal" || value === "verifier" || value === "recovery";
}

function rejected(reason: GlobalCapacityLedgerMutationResultV1["reason"]): GlobalCapacityLedgerMutationResultV1 {
  return {
    action: "rejected",
    reason,
    replayed: false,
    claimId: null,
    fence: null,
  };
}

function validLease(value: unknown): value is GlobalCapacityLegacyExecutionLeaseV1 {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<GlobalCapacityLegacyExecutionLeaseV1>;
  return canonicalString(lease.projectId)
    && (lease.resourceKind === "legacy_task" || lease.resourceKind === "legacy_triage")
    && canonicalString(lease.resourceId)
    && canonicalString(lease.claimId)
    && canonicalString(lease.acquireOperationId)
    && canonicalString(lease.releaseOperationId)
    && canonicalString(lease.holderId)
    && canonicalString(lease.leaseId)
    && positiveSafeInteger(lease.fence)
    && validWorkClass(lease.workClass)
    && positiveSafeInteger(lease.slots)
    && canonicalTimestamp(lease.acquiredAt)
    && canonicalTimestamp(lease.expiresAt)
    && Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt);
}

function validRenewal(value: unknown): value is GlobalCapacityLegacyRenewalRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<GlobalCapacityLegacyRenewalRequestV1>;
  const lease = request.lease;
  return request.contractVersion === GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION
    && canonicalString(request.operationId)
    && canonicalTimestamp(request.asOf)
    && canonicalTimestamp(request.expiresAt)
    && Date.parse(request.expiresAt) > Date.parse(request.asOf)
    && !!lease
    && canonicalString(lease.projectId)
    && (lease.resourceKind === "legacy_task" || lease.resourceKind === "legacy_triage")
    && canonicalString(lease.resourceId)
    && canonicalString(lease.claimId)
    && canonicalString(lease.holderId)
    && canonicalString(lease.leaseId)
    && positiveSafeInteger(lease.fence);
}

function cleanupState(
  result: GlobalCapacityLedgerMutationResultV1 | null,
): "released" | "release_withheld" | "release_unavailable" {
  if (!result) return "release_unavailable";
  return result.action === "released" ? "released" : "release_withheld";
}

/**
 * FNXC:GlobalCapacityLedger 2026-07-20-03:15:
 * Legacy task and triage executions must enter the same durable capacity
 * authority as Room work, but a task id alone is not a crash-safe identity.
 * This adapter accepts only a host-persisted lease/fence/operation bundle,
 * withholds untrusted work before it starts, and records cleanup separately so
 * a successful task is never rewritten as a false capacity-release success.
 */
export function createGlobalCapacityLegacyAdmission(
  input: CreateGlobalCapacityLegacyAdmissionInputV1,
): GlobalCapacityLegacyAdmissionV1 {
  if (!canonicalString(input.projectId) || !input.ports || typeof input.now !== "function") {
    throw new Error("Global capacity legacy admission requires a project-scoped ledger port and clock");
  }

  return Object.freeze({
    async run<T>(
      request: GlobalCapacityLegacyAdmissionRequestV1,
      work: () => Promise<T>,
    ): Promise<GlobalCapacityLegacyAdmissionRunResultV1<T>> {
      if (
        request.contractVersion !== GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION
        || !validLease(request.lease)
      ) {
        return { state: "withheld", admission: rejected("invalid_request") };
      }
      if (request.lease.projectId !== input.projectId) {
        return { state: "withheld", admission: rejected("project_isolation") };
      }

      const admission = await input.ports.acquire({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: request.lease.projectId,
        resourceKind: request.lease.resourceKind,
        resourceId: request.lease.resourceId,
        claimId: request.lease.claimId,
        operationId: request.lease.acquireOperationId,
        workClass: request.lease.workClass,
        slots: request.lease.slots,
        holderId: request.lease.holderId,
        leaseId: request.lease.leaseId,
        fence: request.lease.fence,
        asOf: request.lease.acquiredAt,
        expiresAt: request.lease.expiresAt,
      });
      if (admission.action !== "acquired") {
        return { state: "withheld", admission };
      }
      if (admission.replayed) {
        return { state: "recovery_required", admission };
      }

      let value!: T;
      let workError: unknown;
      let workThrew = false;
      let release: GlobalCapacityLedgerMutationResultV1 | null = null;
      try {
        value = await work();
      } catch (error) {
        workThrew = true;
        workError = error;
      } finally {
        try {
          const releasedAt = input.now();
          if (canonicalTimestamp(releasedAt)) {
            release = await input.ports.release({
              contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
              projectId: request.lease.projectId,
              resourceKind: request.lease.resourceKind,
              resourceId: request.lease.resourceId,
              claimId: request.lease.claimId,
              operationId: request.lease.releaseOperationId,
              holderId: request.lease.holderId,
              leaseId: request.lease.leaseId,
              fence: request.lease.fence,
              asOf: releasedAt,
            });
          }
        } catch {
          release = null;
        }
      }
      if (workThrew) throw workError;
      return {
        state: "completed",
        value,
        admission,
        release,
        cleanupState: cleanupState(release),
      };
    },

    async renew(request: GlobalCapacityLegacyRenewalRequestV1): Promise<GlobalCapacityLedgerMutationResultV1> {
      if (!validRenewal(request)) return rejected("invalid_request");
      if (request.lease.projectId !== input.projectId) return rejected("project_isolation");
      return input.ports.renew({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: request.lease.projectId,
        resourceKind: request.lease.resourceKind,
        resourceId: request.lease.resourceId,
        claimId: request.lease.claimId,
        operationId: request.operationId,
        holderId: request.lease.holderId,
        leaseId: request.lease.leaseId,
        fence: request.lease.fence,
        asOf: request.asOf,
        expiresAt: request.expiresAt,
      });
    },
  });
}
