import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  assertGlobalCapacityLedgerPolicy,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityPolicyAuthorityV1,
} from "@fusion/core";

import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  type RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
  type RecoverDanglingRoomGlobalConcurrencyClaimsResultV1,
  type RoomGlobalConcurrencyAcquireInputV1,
  type RoomGlobalConcurrencyAccountingActionV1,
  type RoomGlobalConcurrencyAccountingReasonV1,
  type RoomGlobalConcurrencyMutationResultV1,
  type RoomGlobalConcurrencyReleaseInputV1,
  type RoomGlobalConcurrencyRenewInputV1,
  type RoomGlobalConcurrencyWorkClassV1,
} from "./room-global-concurrency-accounting.js";
import type { RoomControllerCapacityAdmissionOptionsV1 } from "./room-controller.js";

export interface RoomGlobalConcurrencyControllerAdmissionPolicyV1 {
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  readonly createClaimId?: RoomControllerCapacityAdmissionOptionsV1["createClaimId"];
}

/**
 * A central Room capacity claim must survive several controller reconciliation
 * opportunities. Shorter values would let the shared ledger expire a live Room
 * worker before its next fenced renewal, so the runtime refuses that authority
 * rather than silently constructing an unsafe controller.
 */
export const MIN_ROOM_CAPACITY_LEASE_TTL_MS = 15_000;
const ROOM_CAPACITY_RENEWAL_DIVISOR = 3;

/**
 * The host still chooses which class and how many slots one Room controller
 * consumes. The central policy authority alone owns the global ceiling,
 * reservations, and lease TTL; no Room bundle may carry a second copy.
 */
export interface RoomGlobalConcurrencyVerifiedPolicyV1 {
  readonly controllerAdmission: RoomGlobalConcurrencyControllerAdmissionPolicyV1;
  readonly verifiedAt: string;
  readonly verificationId: string;
}

export interface CreateRoomGlobalConcurrencyRuntimeInputV1 {
  readonly projectId: string;
  /** Read from CentralCore after the backend host layer is attached. */
  readonly globalCapacityAuthority: GlobalCapacityPolicyAuthorityV1;
  /**
   * Production supplies CentralCore's latest-authority reader. It is used only
   * to retry a pre-side-effect acquire after the ledger proves its cached
   * policy is stale; renew and release never invent a new authority.
   */
  readonly refreshGlobalCapacityAuthority?: () => Promise<GlobalCapacityPolicyAuthorityV1>;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
}

export interface RoomGlobalConcurrencyLedgerRecoveryPortV1 {
  recoverDanglingClaims(
    input: RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
  ): Promise<RecoverDanglingRoomGlobalConcurrencyClaimsResultV1>;
}

export interface RoomGlobalConcurrencyRuntimeV1 {
  readonly projectId: string;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
  readonly capacityAdmission: RoomControllerCapacityAdmissionOptionsV1;
  readonly recovery: RoomGlobalConcurrencyLedgerRecoveryPortV1;
}

export type RoomGlobalConcurrencyRuntimeErrorCodeV1 =
  | "invalid_input"
  | "central_authority_invalid"
  | "policy_missing"
  | "policy_invalid";

export class RoomGlobalConcurrencyRuntimeError extends Error {
  public constructor(
    readonly code: RoomGlobalConcurrencyRuntimeErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomGlobalConcurrencyRuntimeError";
  }
}

interface ValidatedRuntimeInputV1 {
  readonly projectId: string;
  readonly globalCapacityAuthority: GlobalCapacityPolicyAuthorityV1;
  readonly refreshGlobalCapacityAuthority: (() => Promise<GlobalCapacityPolicyAuthorityV1>) | null;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
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

function isWorkClass(value: unknown): value is RoomGlobalConcurrencyWorkClassV1 {
  return value === "normal" || value === "verifier" || value === "recovery";
}

function normalizeVerifiedPolicy(value: unknown): RoomGlobalConcurrencyVerifiedPolicyV1 {
  if (
    value === undefined
    || value === null
    || (isRecord(value) && (value.controllerAdmission === undefined || value.controllerAdmission === null))
  ) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "policy_missing",
      "Room global concurrency runtime requires an explicitly verified controller admission policy.",
    );
  }
  if (!isRecord(value) || !isRecord(value.controllerAdmission) || Object.hasOwn(value, "policy")) {
    throw new RoomGlobalConcurrencyRuntimeError("policy_invalid", "Room controller admission policy is invalid.");
  }
  const controllerAdmission = value.controllerAdmission;
  if (
    !canonicalTimestamp(value.verifiedAt)
    || !canonicalString(value.verificationId)
    || !isWorkClass(controllerAdmission.workClass)
    || !positiveSafeInteger(controllerAdmission.slots)
    || (controllerAdmission.createClaimId !== undefined && typeof controllerAdmission.createClaimId !== "function")
  ) {
    throw new RoomGlobalConcurrencyRuntimeError("policy_invalid", "Room controller admission policy is unverified or invalid.");
  }
  return Object.freeze({
    controllerAdmission: Object.freeze({
      workClass: controllerAdmission.workClass,
      slots: controllerAdmission.slots,
      ...(controllerAdmission.createClaimId === undefined
        ? {}
        : { createClaimId: controllerAdmission.createClaimId as RoomControllerCapacityAdmissionOptionsV1["createClaimId"] }),
    }),
    verifiedAt: value.verifiedAt,
    verificationId: value.verificationId,
  });
}

function normalizeAuthority(value: unknown): GlobalCapacityPolicyAuthorityV1 {
  if (!isRecord(value) || typeof value.createProjectPorts !== "function") {
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      "Room global concurrency runtime requires the CentralCore global capacity authority.",
    );
  }
  try {
    assertGlobalCapacityLedgerPolicy(value.policy);
  } catch {
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      "Room global concurrency runtime received an invalid central capacity policy.",
    );
  }
  if (value.policy.leaseTtlMs < MIN_ROOM_CAPACITY_LEASE_TTL_MS) {
    /*
    FNXC:RoomCentralCapacityLeaseTiming 2026-07-20-07:42:
    Central capacity must never expire before the controller has a bounded
    chance to renew its matching Room lease. The generic central policy may be
    valid for other resource types at a shorter duration, but it is unsafe for
    a live Room worker and therefore remains withheld at this adapter boundary.
    */
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      `Room central capacity lease TTL must be at least ${MIN_ROOM_CAPACITY_LEASE_TTL_MS}ms.`,
    );
  }
  if (
    value.contractVersion !== 1
    || !canonicalString(value.policyHash)
    || !positiveSafeInteger(value.revision)
    || !canonicalTimestamp(value.updatedAt)
  ) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      "Room global concurrency runtime received an unverifiable central capacity authority.",
    );
  }
  return value as unknown as GlobalCapacityPolicyAuthorityV1;
}

function validateInput(input: unknown): ValidatedRuntimeInputV1 {
  if (!isRecord(input) || !canonicalString(input.projectId)) {
    throw new RoomGlobalConcurrencyRuntimeError("invalid_input", "Room global concurrency runtime requires a canonical project id.");
  }
  if (
    input.refreshGlobalCapacityAuthority !== undefined
    && typeof input.refreshGlobalCapacityAuthority !== "function"
  ) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "invalid_input",
      "Room global concurrency runtime refresh authority reader is invalid.",
    );
  }
  return Object.freeze({
    projectId: input.projectId,
    globalCapacityAuthority: normalizeAuthority(input.globalCapacityAuthority),
    refreshGlobalCapacityAuthority: input.refreshGlobalCapacityAuthority === undefined
      ? null
      : input.refreshGlobalCapacityAuthority as () => Promise<GlobalCapacityPolicyAuthorityV1>,
    verifiedPolicy: normalizeVerifiedPolicy(input.verifiedPolicy),
  });
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

function mapReason(reason: GlobalCapacityLedgerMutationResultV1["reason"]): RoomGlobalConcurrencyAccountingReasonV1 {
  switch (reason) {
    case "capacity_admitted":
    case "global_capacity_exhausted":
    case "legacy_task_triage_reserve_protected":
    case "reserved_capacity_protected":
    case "claim_conflict":
    case "claim_expired":
    case "claim_not_found":
    case "invalid_request":
    case "project_isolation":
    case "renewal_regression":
    case "stale_fence":
    case "store_failure":
      return reason;
    case "capacity_unavailable":
      return "capacity_unknown";
    case "capacity_policy_unavailable":
      return "capacity_policy_unavailable";
    case "policy_mismatch":
      return "policy_mismatch";
    case "idempotency_conflict":
      return "idempotency_conflict";
    case "legacy_room_migration_pending":
      return "legacy_room_migration_pending";
    case "capacity_renewed":
    case "capacity_released":
      return "capacity_admitted";
  }
}

function mapMutation(result: GlobalCapacityLedgerMutationResultV1): RoomGlobalConcurrencyMutationResultV1 {
  return mutation(result.action, mapReason(result.reason), result.replayed, result.claimId, result.fence);
}

function validRecoveryInput(input: unknown, projectId: string): input is RecoverDanglingRoomGlobalConcurrencyClaimsInputV1 {
  if (!isRecord(input)) return false;
  return input.contractVersion === ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION
    && input.projectId === projectId
    && canonicalString(input.recoveryOperationId)
    && canonicalString(input.recovererId)
    && canonicalTimestamp(input.asOf);
}

/**
 * FNXC:RoomCentralCapacityAdapter 2026-07-20-07:09:
 * Room workers used to calculate a second capacity budget from a project task
 * snapshot. This adapter translates only the Room controller's fenced claim
 * identity into the CentralCore-issued ledger ports, so Room, legacy task, and
 * legacy triage work serialize behind the same durable global lock and policy.
 */
class CentralRoomGlobalConcurrencyAccounting {
  private refreshInFlight: Promise<"refreshed" | "failed"> | null = null;

  public constructor(
    private readonly projectId: string,
    private ports: GlobalCapacityLedgerPostgresPortsV1,
    private authority: GlobalCapacityPolicyAuthorityV1,
    private readonly refreshAuthority: (() => Promise<GlobalCapacityPolicyAuthorityV1>) | null,
  ) {}

  public async acquire(input: RoomGlobalConcurrencyAcquireInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (input.projectId !== this.projectId) return mutation("rejected", "project_isolation");
    try {
      let result = await this.ports.acquire(this.acquireInput(input));
      if (result.reason === "policy_mismatch") {
        const refreshed = await this.refreshPortsAfterMismatch();
        if (refreshed === "failed") return mutation("held", "capacity_policy_unavailable");
        if (refreshed === "refreshed") result = await this.ports.acquire(this.acquireInput(input));
      }
      return mapMutation(result);
    } catch {
      return mutation("held", "store_failure");
    }
  }

  public async renew(input: RoomGlobalConcurrencyRenewInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (input.projectId !== this.projectId) return mutation("rejected", "project_isolation");
    try {
      return mapMutation(await this.ports.renew({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: input.projectId,
        resourceKind: "room_worker",
        resourceId: input.roomId,
        claimId: input.claimId,
        operationId: input.operationId,
        holderId: input.holderId,
        leaseId: input.leaseId,
        fence: input.fence,
        asOf: input.asOf,
        expiresAt: input.expiresAt,
      }));
    } catch {
      return mutation("held", "store_failure");
    }
  }

  public async release(input: RoomGlobalConcurrencyReleaseInputV1): Promise<RoomGlobalConcurrencyMutationResultV1> {
    if (input.projectId !== this.projectId) return mutation("rejected", "project_isolation");
    try {
      return mapMutation(await this.ports.release({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: input.projectId,
        resourceKind: "room_worker",
        resourceId: input.roomId,
        claimId: input.claimId,
        operationId: input.operationId,
        holderId: input.holderId,
        leaseId: input.leaseId,
        fence: input.fence,
        asOf: input.asOf,
      }));
    } catch {
      return mutation("rejected", "store_failure");
    }
  }

  private acquireInput(input: RoomGlobalConcurrencyAcquireInputV1) {
    return {
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: input.projectId,
      resourceKind: "room_worker" as const,
      resourceId: input.roomId,
      claimId: input.claimId,
      operationId: input.operationId,
      workClass: input.workClass,
      slots: input.slots,
      holderId: input.holderId,
      leaseId: input.leaseId,
      fence: input.fence,
      asOf: input.asOf,
      expiresAt: input.expiresAt,
    };
  }

  /*
  FNXC:RoomCentralCapacityPolicyRefresh 2026-07-20-07:47:
  A policy update is permitted only with no live central claims, so the sole
  safe automatic rebind point is a new acquire that the old ledger rejects
  before recording any operation. Refresh once, require the immutable Room
  lease TTL to match, and retry that exact idempotency key. Never refresh an
  in-flight renew or release because those have already crossed a fenced
  worker-side effect boundary.
  */
  private async refreshPortsAfterMismatch(): Promise<"refreshed" | "not_configured" | "failed"> {
    const refreshAuthority = this.refreshAuthority;
    if (!refreshAuthority) return "not_configured";
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = (async (): Promise<"refreshed" | "failed"> => {
      try {
        const authority = normalizeAuthority(await refreshAuthority());
        if (
          authority.policyHash === this.authority.policyHash
          || authority.policy.leaseTtlMs !== this.authority.policy.leaseTtlMs
        ) {
          return "failed";
        }
        const ports = authority.createProjectPorts(this.projectId);
        if (
          !ports
          || typeof ports.readSnapshot !== "function"
          || typeof ports.acquire !== "function"
          || typeof ports.renew !== "function"
          || typeof ports.release !== "function"
        ) {
          return "failed";
        }
        this.authority = authority;
        this.ports = ports;
        return "refreshed";
      } catch {
        return "failed";
      }
    })();
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    }
  }
}

function createRecoveryPort(
  projectId: string,
  ports: GlobalCapacityLedgerPostgresPortsV1,
): RoomGlobalConcurrencyLedgerRecoveryPortV1 {
  return Object.freeze({
    async recoverDanglingClaims(
      input: RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
    ): Promise<RecoverDanglingRoomGlobalConcurrencyClaimsResultV1> {
      if (!validRecoveryInput(input, projectId)) {
        return Object.freeze({ action: "held", recoveredClaimIds: [], replayedClaimIds: [], rejected: [] });
      }
      try {
        const snapshot = await ports.readSnapshot({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId,
          asOf: input.asOf,
        });
        if (snapshot.totalSlots === null) {
          return Object.freeze({ action: "held", recoveredClaimIds: [], replayedClaimIds: [], rejected: [] });
        }
        // readSnapshot expires stale central claims under the same ledger lock.
        // It intentionally does not rerun or release an unexpired worker claim.
        return Object.freeze({ action: "recovered", recoveredClaimIds: [], replayedClaimIds: [], rejected: [] });
      } catch {
        return Object.freeze({ action: "held", recoveredClaimIds: [], replayedClaimIds: [], rejected: [] });
      }
    },
  });
}

/**
 * Build the production Room capacity adapter exclusively from CentralCore's
 * verified authority. Legacy Room PostgreSQL accounting remains readable for
 * historical evidence only and is never a production admission path here.
 */
export function createRoomGlobalConcurrencyRuntime(
  input: CreateRoomGlobalConcurrencyRuntimeInputV1,
): RoomGlobalConcurrencyRuntimeV1 {
  const validated = validateInput(input);
  let ports: GlobalCapacityLedgerPostgresPortsV1;
  try {
    ports = validated.globalCapacityAuthority.createProjectPorts(validated.projectId);
  } catch {
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      "Room global concurrency runtime could not create central project capacity ports.",
    );
  }
  if (
    !ports
    || typeof ports.readSnapshot !== "function"
    || typeof ports.acquire !== "function"
    || typeof ports.renew !== "function"
    || typeof ports.release !== "function"
  ) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "central_authority_invalid",
      "Room global concurrency runtime received incomplete central capacity ports.",
    );
  }
  const accounting = new CentralRoomGlobalConcurrencyAccounting(
    validated.projectId,
    ports,
    validated.globalCapacityAuthority,
    validated.refreshGlobalCapacityAuthority,
  );
  const renewalIntervalMs = Math.floor(
    validated.globalCapacityAuthority.policy.leaseTtlMs / ROOM_CAPACITY_RENEWAL_DIVISOR,
  );
  const capacityAdmission: RoomControllerCapacityAdmissionOptionsV1 = Object.freeze({
    globalAccounting: accounting,
    workClass: validated.verifiedPolicy.controllerAdmission.workClass,
    slots: validated.verifiedPolicy.controllerAdmission.slots,
    leaseTtlMs: validated.globalCapacityAuthority.policy.leaseTtlMs,
    renewalIntervalMs,
    ...(validated.verifiedPolicy.controllerAdmission.createClaimId === undefined
      ? {}
      : { createClaimId: validated.verifiedPolicy.controllerAdmission.createClaimId }),
  });
  return Object.freeze({
    projectId: validated.projectId,
    verifiedPolicy: validated.verifiedPolicy,
    capacityAdmission,
    recovery: createRecoveryPort(validated.projectId, ports),
  });
}
