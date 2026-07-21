import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  type RoomGlobalConcurrencyAcquireInputV1,
  type RoomGlobalConcurrencyAccountingReasonV1,
  type RoomGlobalConcurrencyMutationResultV1,
  type RoomGlobalConcurrencyReleaseInputV1,
} from "./room-global-concurrency-accounting.js";
import {
  ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
  type RoomProviderBackpressureControllerInputV1,
  type RoomProviderBackpressureControllerResultV1,
  type RoomProviderBackpressurePolicyV1,
  type RoomProviderBackpressureScopeV1,
  type RoomProviderBackpressureStateV1,
  type RoomProviderBackpressureTelemetryV1,
} from "./room-provider-backpressure-controller.js";

export const ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionCapacityPriorityV1 = "evolution_experiment" | "live_recovery" | "critical_control";

export type RoomEvolutionCapacityReservationActionV1 = "reserved" | "queued" | "rejected";

export type RoomEvolutionCapacityReservationReasonV1 =
  | "capacity_reserved"
  | "claim_conflict"
  | "evolution_recovery_reserve_protected"
  | "global_capacity_queue"
  | "global_rejected"
  | "invalid_provider_admission"
  | "invalid_provider_scope"
  | "invalid_request"
  | "provider_backpressure";

export type RoomEvolutionCapacityReleaseActionV1 = "released" | "rejected";

export type RoomEvolutionCapacityReleaseReasonV1 =
  | "invalid_release_timestamp"
  | "invalid_receipt"
  | "release_confirmed"
  | "release_rejected";

export interface RoomEvolutionCapacityReservationFieldsV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly acquireOperationId: string;
  readonly releaseOperationId: string;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface RoomEvolutionCapacityProviderInputV1 {
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly state?: RoomProviderBackpressureStateV1;
  readonly allowHalfOpenProbe: boolean;
}

export interface RoomEvolutionCapacityReservationInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION;
  readonly requestId: string;
  readonly priority: RoomEvolutionCapacityPriorityV1;
  readonly reservation: RoomEvolutionCapacityReservationFieldsV1;
  readonly provider: RoomEvolutionCapacityProviderInputV1;
}

export interface RoomEvolutionCapacityGlobalPortV1 {
  acquire(input: RoomGlobalConcurrencyAcquireInputV1): Promise<RoomGlobalConcurrencyMutationResultV1>;
  release(input: RoomGlobalConcurrencyReleaseInputV1): Promise<RoomGlobalConcurrencyMutationResultV1>;
}

export interface RoomEvolutionCapacityProviderBackpressurePortV1 {
  decide(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1;
}

export interface RoomEvolutionCapacityReservationPortsV1 {
  readonly globalCapacity: RoomEvolutionCapacityGlobalPortV1;
  readonly providerBackpressure: RoomEvolutionCapacityProviderBackpressurePortV1;
}

export interface RoomEvolutionCapacityReleaseResultV1 {
  readonly action: RoomEvolutionCapacityReleaseActionV1;
  readonly reason: RoomEvolutionCapacityReleaseReasonV1;
  readonly replayed: boolean;
  readonly claimId: string | null;
  readonly fence: number | null;
  readonly global: RoomGlobalConcurrencyMutationResultV1 | null;
}

export interface RoomEvolutionCapacityReleaseReceiptV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION;
  readonly reservationId: string;
  readonly priority: RoomEvolutionCapacityPriorityV1;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly fence: number;
  release(asOf: string): Promise<RoomEvolutionCapacityReleaseResultV1>;
}

export interface RoomEvolutionCapacityReservationResultV1 {
  readonly action: RoomEvolutionCapacityReservationActionV1;
  readonly reason: RoomEvolutionCapacityReservationReasonV1;
  readonly replayed: boolean;
  readonly receipt: RoomEvolutionCapacityReleaseReceiptV1 | null;
  readonly provider: RoomProviderBackpressureControllerResultV1 | null;
  readonly global: RoomGlobalConcurrencyMutationResultV1 | null;
}

interface ReceiptRecordV1 {
  readonly key: string;
  readonly identity: string;
  readonly input: RoomEvolutionCapacityReservationInputV1;
  readonly receipt: RoomEvolutionCapacityReleaseReceiptV1;
  releasePromise: Promise<RoomEvolutionCapacityReleaseResultV1> | null;
  releaseResult: RoomEvolutionCapacityReleaseResultV1 | null;
}

const PRIORITIES = new Set<RoomEvolutionCapacityPriorityV1>([
  "evolution_experiment",
  "live_recovery",
  "critical_control",
]);

/**
 * FNXC:RoomEvolutionCapacityReservation 2026-07-19-15:43:
 * Async evolution must obtain a fenced capacity claim before it can start, while live recovery and critical control keep the protected recovery tier.
 * This small adapter intentionally delegates durable capacity and provider telemetry decisions to their existing contracts instead of duplicating scheduler state.
 */
export class RoomEvolutionCapacityReservation {
  private readonly receipts = new Map<string, ReceiptRecordV1>();

  public constructor(private readonly ports: RoomEvolutionCapacityReservationPortsV1) {}

  public async reserve(input: RoomEvolutionCapacityReservationInputV1): Promise<RoomEvolutionCapacityReservationResultV1> {
    if (!isValidInput(input)) return reservationResult("rejected", "invalid_request", false, null, null, null);
    if (!isProviderScope(input.provider.scope)) {
      return reservationResult("rejected", "invalid_provider_scope", false, null, null, null);
    }

    const key = receiptKey(input.reservation);
    const identity = reservationIdentity(input);
    const existing = this.receipts.get(key);
    if (existing !== undefined) {
      if (existing.identity !== identity) return reservationResult("rejected", "claim_conflict", false, null, null, null);
      return reservationResult("reserved", "capacity_reserved", true, existing.receipt, null, null);
    }

    const provider = this.ports.providerBackpressure.decide(providerInput(input));
    if (provider.decision.action !== "admit") {
      if (provider.decision.reason === "invalid_input" || provider.decision.reason === "scope_state_mismatch") {
        return reservationResult("rejected", "invalid_provider_admission", false, null, provider, null);
      }
      return reservationResult(
        "queued",
        input.priority === "evolution_experiment" && provider.decision.reason === "reserved_capacity"
          ? "evolution_recovery_reserve_protected"
          : "provider_backpressure",
        false,
        null,
        provider,
        null,
      );
    }

    let global: RoomGlobalConcurrencyMutationResultV1;
    try {
      global = await this.ports.globalCapacity.acquire(globalAcquireInput(input));
    } catch {
      return reservationResult("queued", "global_capacity_queue", false, null, provider, null);
    }

    if (global.action !== "acquired") {
      if (global.action === "held") {
        return reservationResult(
          "queued",
          isEvolutionReserveProtection(input.priority, global.reason)
            ? "evolution_recovery_reserve_protected"
            : "global_capacity_queue",
          false,
          null,
          provider,
          global,
        );
      }
      return reservationResult(
        "rejected",
        global.reason === "claim_conflict" ? "claim_conflict" : "global_rejected",
        false,
        null,
        provider,
        global,
      );
    }

    const record = this.createReceiptRecord(key, identity, input);
    this.receipts.set(key, record);
    return reservationResult("reserved", "capacity_reserved", global.replayed, record.receipt, provider, global);
  }

  private createReceiptRecord(
    key: string,
    identity: string,
    input: RoomEvolutionCapacityReservationInputV1,
  ): ReceiptRecordV1 {
    const receipt: RoomEvolutionCapacityReleaseReceiptV1 = Object.freeze({
      contractVersion: ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION,
      reservationId: key,
      priority: input.priority,
      projectId: input.reservation.projectId,
      roomId: input.reservation.roomId,
      claimId: input.reservation.claimId,
      fence: input.reservation.fence,
      release: async (asOf: string) => this.releaseReceipt(key, identity, asOf),
    });
    return {
      key,
      identity,
      input: freezeInput(input),
      receipt,
      releasePromise: null,
      releaseResult: null,
    };
  }

  private async releaseReceipt(
    key: string,
    identity: string,
    asOf: string,
  ): Promise<RoomEvolutionCapacityReleaseResultV1> {
    if (!isTimestamp(asOf)) return releaseResult("rejected", "invalid_release_timestamp", false, null, null, null);

    const record = this.receipts.get(key);
    if (record === undefined || record.identity !== identity) {
      return releaseResult("rejected", "invalid_receipt", false, null, null, null);
    }
    if (record.releaseResult !== null) return { ...record.releaseResult, replayed: true };
    if (record.releasePromise !== null) {
      const result = await record.releasePromise;
      return { ...result, replayed: true };
    }

    record.releasePromise = this.releaseThroughGlobalCapacity(record, asOf);
    const result = await record.releasePromise;
    record.releaseResult = result;
    return result;
  }

  private async releaseThroughGlobalCapacity(
    record: ReceiptRecordV1,
    asOf: string,
  ): Promise<RoomEvolutionCapacityReleaseResultV1> {
    const { reservation } = record.input;
    let global: RoomGlobalConcurrencyMutationResultV1;
    try {
      global = await this.ports.globalCapacity.release({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: reservation.projectId,
        roomId: reservation.roomId,
        claimId: reservation.claimId,
        operationId: reservation.releaseOperationId,
        holderId: reservation.holderId,
        leaseId: reservation.leaseId,
        fence: reservation.fence,
        asOf,
      });
    } catch {
      return releaseResult("rejected", "release_rejected", false, null, null, null);
    }
    if (global.action !== "released") {
      return releaseResult("rejected", "release_rejected", false, null, null, global);
    }
    return releaseResult("released", "release_confirmed", global.replayed, global.claimId, global.fence, global);
  }
}

function providerInput(input: RoomEvolutionCapacityReservationInputV1): RoomProviderBackpressureControllerInputV1 {
  return {
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    asOf: input.reservation.asOf,
    scope: Object.freeze({ ...input.provider.scope }),
    work: Object.freeze({
      requestId: input.requestId,
      class: priorityToWorkClass(input.priority),
      allowHalfOpenProbe: input.priority === "evolution_experiment" ? false : input.provider.allowHalfOpenProbe,
    }),
    operation: Object.freeze({ kind: "dispatch" }),
    telemetry: Object.freeze({ ...input.provider.telemetry }),
    policy: Object.freeze({ ...input.provider.policy }),
    ...(input.provider.state === undefined ? {} : { state: Object.freeze({ ...input.provider.state }) }),
  };
}

function globalAcquireInput(input: RoomEvolutionCapacityReservationInputV1): RoomGlobalConcurrencyAcquireInputV1 {
  const { reservation } = input;
  return Object.freeze({
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    projectId: reservation.projectId,
    roomId: reservation.roomId,
    claimId: reservation.claimId,
    operationId: reservation.acquireOperationId,
    workClass: priorityToWorkClass(input.priority),
    slots: reservation.slots,
    holderId: reservation.holderId,
    leaseId: reservation.leaseId,
    fence: reservation.fence,
    asOf: reservation.asOf,
    expiresAt: reservation.expiresAt,
  });
}

function priorityToWorkClass(priority: RoomEvolutionCapacityPriorityV1): "normal" | "recovery" {
  return priority === "evolution_experiment" ? "normal" : "recovery";
}

function isEvolutionReserveProtection(
  priority: RoomEvolutionCapacityPriorityV1,
  reason: RoomGlobalConcurrencyAccountingReasonV1,
): boolean {
  return priority === "evolution_experiment" && (
    reason === "reserved_capacity_protected" || reason === "legacy_task_triage_reserve_protected"
  );
}

function reservationResult(
  action: RoomEvolutionCapacityReservationActionV1,
  reason: RoomEvolutionCapacityReservationReasonV1,
  replayed: boolean,
  receipt: RoomEvolutionCapacityReleaseReceiptV1 | null,
  provider: RoomProviderBackpressureControllerResultV1 | null,
  global: RoomGlobalConcurrencyMutationResultV1 | null,
): RoomEvolutionCapacityReservationResultV1 {
  return Object.freeze({ action, reason, replayed, receipt, provider, global });
}

function releaseResult(
  action: RoomEvolutionCapacityReleaseActionV1,
  reason: RoomEvolutionCapacityReleaseReasonV1,
  replayed: boolean,
  claimId: string | null,
  fence: number | null,
  global: RoomGlobalConcurrencyMutationResultV1 | null,
): RoomEvolutionCapacityReleaseResultV1 {
  return Object.freeze({ action, reason, replayed, claimId, fence, global });
}

function receiptKey(reservation: RoomEvolutionCapacityReservationFieldsV1): string {
  return JSON.stringify([reservation.projectId, reservation.claimId]);
}

function reservationIdentity(input: RoomEvolutionCapacityReservationInputV1): string {
  const { reservation } = input;
  return JSON.stringify([
    input.priority,
    reservation.roomId,
    reservation.claimId,
    reservation.acquireOperationId,
    reservation.releaseOperationId,
    reservation.slots,
    reservation.holderId,
    reservation.leaseId,
    reservation.fence,
    reservation.expiresAt,
  ]);
}

function freezeInput(input: RoomEvolutionCapacityReservationInputV1): RoomEvolutionCapacityReservationInputV1 {
  return Object.freeze({
    ...input,
    reservation: Object.freeze({ ...input.reservation }),
    provider: Object.freeze({
      ...input.provider,
      scope: Object.freeze({ ...input.provider.scope }),
      telemetry: Object.freeze({ ...input.provider.telemetry }),
      policy: Object.freeze({ ...input.provider.policy }),
      ...(input.provider.state === undefined ? {} : { state: Object.freeze({ ...input.provider.state }) }),
    }),
  });
}

function isValidInput(input: RoomEvolutionCapacityReservationInputV1): boolean {
  const { reservation } = input;
  return input.contractVersion === ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION
    && canonicalString(input.requestId)
    && PRIORITIES.has(input.priority)
    && canonicalString(reservation.projectId)
    && canonicalString(reservation.roomId)
    && canonicalString(reservation.claimId)
    && canonicalString(reservation.acquireOperationId)
    && canonicalString(reservation.releaseOperationId)
    && positiveSafeInteger(reservation.slots)
    && canonicalString(reservation.holderId)
    && canonicalString(reservation.leaseId)
    && positiveSafeInteger(reservation.fence)
    && isTimestamp(reservation.asOf)
    && isTimestamp(reservation.expiresAt)
    && Date.parse(reservation.expiresAt) > Date.parse(reservation.asOf)
    && typeof input.provider.allowHalfOpenProbe === "boolean";
}

function isProviderScope(scope: RoomProviderBackpressureScopeV1): boolean {
  return nonBlank(scope.providerId)
    && nonBlank(scope.accountId)
    && nonBlank(scope.modelId)
    && nonBlank(scope.connectorId)
    && nonBlank(scope.nodeId);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
